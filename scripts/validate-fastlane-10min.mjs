#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { execSync } from 'child_process';

const BASES = ['http://127.0.0.1:4000', 'http://localhost:4000'];
const RUN_MINUTES = 10;
const SSE_TIMEOUT_MS = 12 * 60 * 1000;
const METRICS_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_MISS_THRESHOLD_MS = 45000;

function ts() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function nearestRank(values, p) {
	if (!values.length) return null;
	const arr = [...values].sort((a,b)=>a-b);
	const rank = Math.ceil(p * arr.length);
	return arr[Math.max(0, Math.min(arr.length - 1, rank - 1))];
}

async function httpGetJson(base, pathName) {
	const res = await fetch(`${base}${pathName}`, { headers: { 'Accept': 'application/json' } });
	if (!res.ok) throw new Error(`GET ${pathName} ${res.status}`);
	return await res.json();
}

async function preflight() {
	for (const b of BASES) {
		try {
			await httpGetJson(b, '/metrics-summary');
			return b;
		} catch {}
	}
	throw new Error('metrics-summary unreachable on both 127.0.0.1 and localhost');
}

async function sseConnect(base, onEvent, onPing, lastEventIdRef) {
	const controller = new AbortController();
	const headers = { 'Accept': 'text/event-stream' };
	if (lastEventIdRef.id) headers['Last-Event-ID'] = lastEventIdRef.id;
	const res = await fetch(`${base}/sse/new-items`, { headers, signal: controller.signal });
	if (!res.ok) throw new Error(`SSE ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	let alive = true;
	const timeout = setTimeout(() => { try { controller.abort(); } catch {} }, SSE_TIMEOUT_MS);
	(async () => {
		while (alive) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const lines = raw.split('\n');
				let ev = 'message';
				let id = null;
				let dataLines = [];
				for (const line of lines) {
					if (line.startsWith('event:')) ev = line.slice(6).trim();
					else if (line.startsWith('id:')) id = line.slice(3).trim();
					else if (line.startsWith('data:')) dataLines.push(line.slice(5));
				}
				if (id) lastEventIdRef.id = id;
				if (ev === 'ping') { onPing(); continue; }
				if (ev === 'new' || ev === 'init' || ev === 'message') {
					const data = dataLines.join('\n');
					try { onEvent(id, ev, data); } catch {}
				}
			}
		}
		clearTimeout(timeout);
	})();
	return { close: () => { alive = false; try { controller.abort(); } catch {} } };
}

function writeFileSyncSafe(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function tryGit() {
	try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return 'unknown'; }
}

(async () => {
	const base = await preflight();
	const startedAt = Date.now();
	const stamp = ts();
	const artifactsDir = path.join('artifacts');
	const metricsNdjson = path.join(artifactsDir, `metrics-summary_${stamp}.ndjson`);
	const healthStartPath = path.join(artifactsDir, `health_start_${stamp}.json`);
	const healthEndPath = path.join(artifactsDir, `health_end_${stamp}.json`);
	const sseCsv = path.join(artifactsDir, `sse_events_${stamp}.csv`);
	const reportPath = 'FASTLANE_10min_report.md';

	const gitCommit = tryGit();

	const healthStart = await httpGetJson(base, '/health');
	writeFileSyncSafe(healthStartPath, JSON.stringify(healthStart));

	const metrics = [];
	async function pullMetrics() {
		try {
			const m = await httpGetJson(base, '/metrics-summary');
			metrics.push({ t: Date.now(), m });
			writeFileSyncSafe(metricsNdjson, metrics.map(x => JSON.stringify(x.m)).join('\n'));
		} catch {}
	}
	await pullMetrics();

	const sseEvents = [];
	let sseDisconnects = 0;
	let lastHeartbeatAt = Date.now();
	let missedHeartbeats = 0;
	let lastEventIdRef = { id: '' };
	writeFileSyncSafe(sseCsv, 'id,source,sse_delivery_ms\n');

	function handleEvent(id, ev, data) {
		if (ev === 'new') {
			try {
				const obj = JSON.parse(data);
				const ing = obj.ingested_at ? Date.parse(obj.ingested_at) : Date.now();
				if (!Number.isFinite(ing)) return;
				const now = Date.now();
				const delivery = Math.max(0, now - ing);
				sseEvents.push({ id: obj.id || id || '', source: obj.source || '', sse_delivery_ms: delivery });
				fs.appendFileSync(sseCsv, `${obj.id || id || ''},${(obj.source || '').replaceAll(',', ' ')},${delivery}\n`);
				lastHeartbeatAt = now;
			} catch {}
		} else if (ev === 'init') {
			lastHeartbeatAt = Date.now();
		}
	}
	function handlePing() {
		const now = Date.now();
		if (now - lastHeartbeatAt > HEARTBEAT_MISS_THRESHOLD_MS) missedHeartbeats++;
		lastHeartbeatAt = now;
	}

	let sse; 
	async function runSSEWindow() {
		try {
			sse = await sseConnect(base, handleEvent, handlePing, lastEventIdRef);
		} catch {
			sseDisconnects++;
			await new Promise(r => setTimeout(r, 2000));
			return runSSEWindow();
		}
	}
	await runSSEWindow();

	let stopped = false;
	async function scheduleMetricsLoop() {
		while (!stopped) {
			await new Promise(r => setTimeout(r, METRICS_INTERVAL_MS + Math.floor((Math.random()*6000)-3000)));
			await pullMetrics();
		}
	}
	scheduleMetricsLoop();

	await new Promise(r => setTimeout(r, RUN_MINUTES * 60 * 1000));
	stopped = true;
	try { sse?.close(); } catch {}

	await pullMetrics();
	const healthEnd = await httpGetJson(base, '/health');
	writeFileSyncSafe(healthEndPath, JSON.stringify(healthEnd));

	const sseDeliveries = sseEvents.map(e => e.sse_delivery_ms).filter(n => Number.isFinite(n));
	const sseMin = sseDeliveries.length ? Math.min(...sseDeliveries) : null;
	const sseMax = sseDeliveries.length ? Math.max(...sseDeliveries) : null;
	const sseP50 = nearestRank(sseDeliveries, 0.5);
	const sseP90 = nearestRank(sseDeliveries, 0.9);

	const lastMetrics = metrics.length ? metrics[metrics.length - 1].m : null;
	const agg = lastMetrics?.aggregate || {};
	const by = lastMetrics?.by_source || {};

	const breakingWireNames = ['PRNewswire','GlobeNewswire','Business Wire','SEC Filings','NASDAQ Trader News','NYSE Notices'];
	const presentWires = breakingWireNames.filter(n => by[n]);
	let passCount = 0;
	for (const n of presentWires) {
		const p50 = by[n]?.publisher_p50;
		if (typeof p50 === 'number' && p50 <= 300000) passCount++;
	}
	const pubPassPct = presentWires.length ? Math.round((passCount / presentWires.length) * 100) : null;

	const pulseP50 = agg?.pulse?.p50 ?? null;
	const pulseP90 = agg?.pulse?.p90 ?? null;
	const authorPulsePass = (pulseP50 != null && pulseP90 != null) ? (pulseP50 <= 60000 && pulseP90 <= 120000) : null;
	const proxyPulsePass = (sseP50 != null && sseP90 != null) ? (sseP50 <= 60000 && sseP90 <= 120000) : null;
	const pubPass = pubPassPct != null ? (pubPassPct >= 80) : null;

	const demoted = Array.isArray(healthEnd?.breaking_demoted_sources) ? healthEnd.breaking_demoted_sources : [];
	const alertsActive = !!healthEnd?.latency_alerts_active;
	const sseClientsEnd = healthEnd?.sse?.clients ?? null;

	const report = [];
	report.push(`# FASTLANE 10-minute Validation`);
	report.push(`- Timestamp: ${new Date(startedAt).toISOString()} − ${new Date().toISOString()}`);
	report.push(`- Host: ${base}`);
	report.push(`- Duration: ${RUN_MINUTES} minutes`);
	report.push(`- Commit: ${gitCommit}`);
	report.push('');
	report.push(`## SLO Verdicts`);
	report.push(`- Pulse→Visible (authoritative from /metrics-summary): p50=${pulseP50 ?? 'n/a'} ms, p90=${pulseP90 ?? 'n/a'} ms → ${authorPulsePass === null ? 'n/a' : (authorPulsePass ? 'PASS' : 'FAIL')}`);
	report.push(`- Pulse→Visible (client SSE proxy): count=${sseDeliveries.length}, p50=${sseP50 ?? 'n/a'} ms, p90=${sseP90 ?? 'n/a'} ms → ${proxyPulsePass === null ? 'n/a' : (proxyPulsePass ? 'PASS' : 'FAIL')}`);
	report.push(`- Publisher→Ingest: ${pubPassPct ?? 'n/a'}% of Breaking wires within 5 min → ${pubPass === null ? 'n/a' : (pubPass ? 'PASS' : 'FAIL')}`);
	report.push('');
	report.push(`## Key Numbers`);
	report.push(`- SSE events: count=${sseDeliveries.length}, min=${sseMin ?? 'n/a'} ms, p50=${sseP50 ?? 'n/a'} ms, p90=${sseP90 ?? 'n/a'} ms, max=${sseMax ?? 'n/a'} ms`);
	report.push(`- Global pulse latency: p50=${pulseP50 ?? 'n/a'} ms, p90=${pulseP90 ?? 'n/a'} ms`);
	report.push(`- Publisher pass rate: ${pubPassPct ?? 'n/a'}% among [${presentWires.join(', ')}]`);
	report.push('');
	report.push(`## Health`);
	report.push(`- sse.clients (end): ${sseClientsEnd}`);
	report.push(`- breaking_demoted_sources: ${JSON.stringify(demoted)}`);
	report.push(`- latency_alerts_active: ${alertsActive}`);
	report.push('');
	report.push(`## Stability`);
	report.push(`- SSE disconnects: ${sseDisconnects}`);
	report.push(`- Missed heartbeats (>45s gap): ${missedHeartbeats}`);
	report.push(`- Last-Event-ID used: ${lastEventIdRef.id ? 'yes' : 'no'}`);
	report.push('');
	report.push(`## Artifacts`);
	report.push(`- ${metricsNdjson}`);
	report.push(`- ${healthStartPath}, ${healthEndPath}`);
	report.push(`- ${sseCsv}`);

	writeFileSyncSafe(reportPath, report.join('\n'));
	console.log(JSON.stringify({
		pulse_authoritative: { p50: pulseP50, p90: pulseP90, pass: authorPulsePass },
		pulse_proxy: { count: sseDeliveries.length, p50: sseP50, p90: sseP90, pass: proxyPulsePass },
		publisher_pass_pct: pubPassPct, pass: pubPass,
		alerts_active: alertsActive, demoted_count: demoted.length,
		artifacts: { metricsNdjson, healthStartPath, healthEndPath, sseCsv, reportPath }
	}, null, 2));
})();

