export type WatchdogState = {
	last_run_at?: string;
	last_result?: { passes: boolean; p50: number | null; p90: number | null; window_min: number };
	consecutive_fails: number;
	consecutive_passes: number;
	last_alert_at?: string;
	last_recovery_at?: string;
	alert_active?: boolean;
};

type GetKpiFn = () => Promise<any>;
type PostAlertFn = (payload: any) => Promise<void>;

let globalState: WatchdogState = { consecutive_fails: 0, consecutive_passes: 0, alert_active: false };
let globalStop: (() => void) | null = null;

export function getWatchdogState(): WatchdogState {
	return globalState;
}

export function startWatchdog(getKpi: GetKpiFn, postAlert: PostAlertFn): { getState: () => WatchdogState; stop: () => void } {
	const intervalSec = Math.max(15, parseInt(process.env.WATCHDOG_INTERVAL_SEC || '60', 10));
	const sloP50 = Math.max(1, parseInt(process.env.WATCHDOG_SLO_P50_MS || '60000', 10));
	const sloP90 = Math.max(1, parseInt(process.env.WATCHDOG_SLO_P90_MS || '120000', 10));
	const minFails = Math.max(1, parseInt(process.env.WATCHDOG_MIN_CONSECUTIVE_FAILS || '2', 10));
	const minRecovers = Math.max(1, parseInt(process.env.WATCHDOG_MIN_CONSECUTIVE_RECOVERS || '2', 10));

	let stopped = false;

	async function tick() {
		if (stopped) return;
		try {
			const kpi = await getKpi();
			const p50 = (kpi?.slo?.breaking_p50_ms ?? null) as number | null;
			const p90 = (kpi?.slo?.breaking_p90_ms ?? null) as number | null;
			const windowMin = (kpi?.window_min ?? 30) as number;
			const passes = (typeof p50 === 'number' && typeof p90 === 'number' && p50 <= sloP50 && p90 <= sloP90);
			globalState.last_run_at = new Date().toISOString();
			globalState.last_result = { passes, p50: p50 ?? null, p90: p90 ?? null, window_min: windowMin };
			if (passes) {
				globalState.consecutive_passes = (globalState.consecutive_passes || 0) + 1;
				globalState.consecutive_fails = 0;
				if ((globalState.alert_active === true) && globalState.consecutive_passes >= minRecovers) {
					// Recovery
					const payload = {
						type: 'slo_recovered',
						breaking_p50_ms: p50,
						breaking_p90_ms: p90,
						window_min: windowMin,
						generated_at: new Date().toISOString()
					};
					try { await postAlert(payload); } catch (e) { console.warn('[watchdog][recovery] webhook error', (e as any)?.message || String(e)); }
					globalState.last_recovery_at = new Date().toISOString();
					globalState.alert_active = false;
				}
			} else {
				globalState.consecutive_fails = (globalState.consecutive_fails || 0) + 1;
				globalState.consecutive_passes = 0;
				if (globalState.consecutive_fails >= minFails && globalState.alert_active !== true) {
					const payload = {
						type: 'slo_fail',
						breaking_p50_ms: p50,
						breaking_p90_ms: p90,
						window_min: windowMin,
						generated_at: new Date().toISOString()
					};
					try { await postAlert(payload); } catch (e) { console.warn('[watchdog][fail] webhook error', (e as any)?.message || String(e)); }
					globalState.last_alert_at = new Date().toISOString();
					globalState.alert_active = true;
				}
			}
		} catch (e) {
			console.warn('[watchdog] tick failed', (e as any)?.message || String(e));
		}
	}

	// First immediate tick, then interval
	tick();
	const timer = setInterval(tick, intervalSec * 1000);
	(globalStop as any) = () => { try { clearInterval(timer); } catch {} stopped = true; };

	// Optional ops checks (additive)
	if (String(process.env.WATCHDOG_OPS_ENABLED || '0') === '1') {
		try {
			const opsIntervalSec = Math.max(15, parseInt(process.env.WATCHDOG_OPS_INTERVAL_SEC || '60', 10));
			const elLagP95 = Math.max(1, parseInt(process.env.WATCHDOG_EL_LAG_P95_MS || '200', 10));
			const gcP95 = Math.max(1, parseInt(process.env.WATCHDOG_GC_P95_MS || '150', 10));
			const cpuP95 = Math.max(1, parseInt(process.env.WATCHDOG_CPU_P95_PCT || '85', 10));
			const minConsec = Math.max(1, parseInt(process.env.WATCHDOG_OPS_MIN_CONSECUTIVE || '2', 10));
			const { getOpsSnapshot } = require('../ops/runtimeMonitor');
			let consecLag = 0, consecGc = 0, consecCpu = 0;
			let opsStopped = false;
			async function opsTick() {
				if (opsStopped) return;
				try {
					const s = getOpsSnapshot();
					const lagBad = (typeof s.el_lag_p95_ms === 'number') && s.el_lag_p95_ms > elLagP95;
					const gcBad = (typeof s.gc_pause_p95_ms === 'number') && s.gc_pause_p95_ms > gcP95;
					const cpuBad = (typeof s.cpu_p95_pct === 'number') && s.cpu_p95_pct > cpuP95;
					consecLag = lagBad ? consecLag + 1 : 0;
					consecGc = gcBad ? consecGc + 1 : 0;
					consecCpu = cpuBad ? consecCpu + 1 : 0;
					const anyBad = (consecLag >= minConsec) || (consecGc >= minConsec) || (consecCpu >= minConsec);
					if (anyBad) {
						const payload = {
							type: 'ops_warn',
							el_lag_p95_ms: s.el_lag_p95_ms,
							gc_pause_p95_ms: s.gc_pause_p95_ms,
							cpu_p95_pct: s.cpu_p95_pct,
							rss_mb: s.rss_mb,
							heap_used_mb: s.heap_used_mb,
							window_sec: s.window_sec,
							generated_at: new Date().toISOString()
						};
						try { await postAlert(payload); } catch (e) { console.warn('[watchdog][ops] webhook error', (e as any)?.message || String(e)); }
					}
				} catch (e) {
					console.warn('[watchdog][ops] tick failed', (e as any)?.message || String(e));
				}
			}
			const ot = setInterval(opsTick, opsIntervalSec * 1000);
			const prevStop = globalStop;
			(globalStop as any) = () => { try { clearInterval(timer); clearInterval(ot); } catch {} stopped = true; opsStopped = true; if (prevStop) prevStop(); };
			setTimeout(opsTick, 2000).unref?.();
		} catch (e) {
			console.warn('[watchdog][ops] failed to init', (e as any)?.message || String(e));
		}
	}

	// Optional drift checks (additive)
	try {
		const driftThresh = process.env.DRIFT_ALERT_P95_MS ? Math.max(1, parseInt(process.env.DRIFT_ALERT_P95_MS, 10)) : null;
		if (driftThresh != null) {
			const { getDriftSnapshot } = require('../ops/driftMonitor');
			let consecBad = 0; let consecGood = 0; let driftAlertOn = false;
			const driftIntervalSec = 60;
			async function driftTick() {
				try {
					const snap = getDriftSnapshot();
					const g = snap?.global_p95_ms;
					const bad = (typeof g === 'number' && typeof driftThresh === 'number') && Math.abs(g) > driftThresh;
					if (bad) { consecBad++; consecGood = 0; } else { consecGood++; consecBad = 0; }
					if (!driftAlertOn && consecBad >= 2) {
						driftAlertOn = true;
						const worst = Object.values(snap.by_host || {}).sort((a: any,b: any)=>Math.abs((b?.p95_ms||0))-Math.abs((a?.p95_ms||0))).slice(0,3).map((v: any)=>({ host: v.host, p95_ms: v.p95_ms }));
						try { await postAlert({ type: 'clock_drift_warn', global_p95_ms: g, worst_hosts: worst, generated_at: new Date().toISOString() }); } catch (e) { console.warn('[watchdog][drift] webhook error', (e as any)?.message || String(e)); }
					}
					if (driftAlertOn && consecGood >= 2) {
						driftAlertOn = false;
						try { await postAlert({ type: 'clock_drift_recovered', generated_at: new Date().toISOString() }); } catch (e) { console.warn('[watchdog][drift] recovery webhook error', (e as any)?.message || String(e)); }
					}
				} catch (e) { /* ignore */ }
			}
			const dt = setInterval(driftTick, driftIntervalSec * 1000);
			const prevStop2 = globalStop;
			(globalStop as any) = () => { try { clearInterval(timer); clearInterval(dt); } catch {} stopped = true; if (prevStop2) prevStop2(); };
			setTimeout(driftTick, 5000).unref?.();
		}
	} catch {}

	return {
		getState: () => globalState,
		stop: () => { if (globalStop) { globalStop(); globalStop = null; } }
	};
}


