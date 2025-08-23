import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

export type OpsSnapshot = {
	window_sec: number;
	samples: number;
	el_lag_p50_ms: number | null; el_lag_p95_ms: number | null;
	gc_pause_p50_ms: number | null; gc_pause_p95_ms: number | null;
	cpu_p50_pct: number | null; cpu_p95_pct: number | null;
	rss_mb: number; heap_used_mb: number; heap_total_mb: number;
	last_sample_at: string | null;
};

type Monitor = {
	getSnapshot(): OpsSnapshot;
};

let singleton: Monitor | null = null;

function percentile(arr: number[], p: number): number | null {
	if (!arr.length) return null;
	const sorted = arr.slice().sort((a, b) => a - b);
	const idx = Math.floor(sorted.length * p);
	return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

export function startRuntimeMonitor(): Monitor {
	if (singleton) return singleton;
	const windowSec = 300; // 5 minutes
	const tickMs = 5000; // 5s
	const cap = Math.ceil(windowSec * 1000 / tickMs) + 2;
	const elLagSamples: number[] = [];
	const gcPauseSamples: number[] = [];
	const cpuPctSamples: number[] = [];
	let lastSampleAt: string | null = null;
	let rssMb = 0, heapUsedMb = 0, heapTotalMb = 0;

	// Event loop delay histogram
	let h: any = null;
	try { h = monitorEventLoopDelay({ resolution: 10 }); h.enable(); } catch { h = null; }

	// GC performance observer
	let gcPauseSinceLastTickMs = 0;
	try {
		const obs = new PerformanceObserver((list) => {
			try {
				for (const entry of list.getEntries()) {
					gcPauseSinceLastTickMs += (entry.duration || 0);
				}
			} catch {}
		});
		obs.observe({ entryTypes: ['gc'], buffered: true } as any);
	} catch {}

	// CPU usage baseline
	let lastCpu = process.cpuUsage();
	let lastHr = process.hrtime.bigint();

	function takeSample() {
		// Event loop lag sample
		let elLagMs: number = 0;
		try {
			if (h && typeof h.mean === 'number') {
				const p95ns = typeof h.percentile === 'function' ? Number(h.percentile(95)) : 0;
				const meanMs = Number(h.mean) / 1e6;
				const p95Ms = p95ns ? (p95ns / 1e6) : meanMs;
				elLagMs = Math.min(5000, Math.max(0, p95Ms));
				h.reset?.();
			}
		} catch {}
		if (!Number.isFinite(elLagMs)) elLagMs = 0;

		// GC pauses (since last tick)
		const gcMs = Math.max(0, gcPauseSinceLastTickMs || 0);
		gcPauseSinceLastTickMs = 0;

		// CPU% over interval
		let cpuPct = 0;
		try {
			const nowHr = process.hrtime.bigint();
			const diffHrMs = Number(nowHr - lastHr) / 1e6; // ms
			lastHr = nowHr;
			const curCpu = process.cpuUsage();
			const du = curCpu.user - lastCpu.user;
			const ds = curCpu.system - lastCpu.system;
			lastCpu = curCpu;
			const usedUs = Math.max(0, du + ds);
			cpuPct = Math.min(100, Math.max(0, (usedUs / 1000) / (diffHrMs || 1) * 100));
		} catch {}

		// Memory
		try {
			const mem = process.memoryUsage();
			rssMb = Math.round((mem.rss || 0) / (1024 * 1024));
			heapUsedMb = Math.round((mem.heapUsed || 0) / (1024 * 1024));
			heapTotalMb = Math.round((mem.heapTotal || 0) / (1024 * 1024));
		} catch {}

		// Push samples and cap window
		elLagSamples.push(elLagMs);
		gcPauseSamples.push(gcMs);
		cpuPctSamples.push(cpuPct);
		if (elLagSamples.length > cap) elLagSamples.shift();
		if (gcPauseSamples.length > cap) gcPauseSamples.shift();
		if (cpuPctSamples.length > cap) cpuPctSamples.shift();
		lastSampleAt = new Date().toISOString();
	}

	// Start ticking
	setInterval(takeSample, tickMs).unref();
	// Take an immediate initial sample after slight delay to collect GC entries
	setTimeout(takeSample, 1000).unref();

	singleton = {
		getSnapshot(): OpsSnapshot {
			return {
				window_sec: windowSec,
				samples: Math.min(elLagSamples.length, gcPauseSamples.length, cpuPctSamples.length),
				el_lag_p50_ms: percentile(elLagSamples, 0.5),
				el_lag_p95_ms: percentile(elLagSamples, 0.9),
				gc_pause_p50_ms: percentile(gcPauseSamples, 0.5),
				gc_pause_p95_ms: percentile(gcPauseSamples, 0.9),
				cpu_p50_pct: percentile(cpuPctSamples, 0.5),
				cpu_p95_pct: percentile(cpuPctSamples, 0.9),
				rss_mb: rssMb,
				heap_used_mb: heapUsedMb,
				heap_total_mb: heapTotalMb,
				last_sample_at: lastSampleAt
			};
		}
	};
	return singleton;
}

export function getOpsSnapshot(): OpsSnapshot {
	return (singleton || startRuntimeMonitor()).getSnapshot();
}


