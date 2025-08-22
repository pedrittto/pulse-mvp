import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

const BASES = ['http://127.0.0.1:4000', 'http://localhost:4000'];
const BREAKING_ALLOWLIST = [
  'PRNewswire',
  'GlobeNewswire',
  'Business Wire',
  'SEC Filings',
  'NASDAQ Trader News',
  'NASDAQ Trader Halts',
  'NYSE Notices',
];

const runMs = 120_000;
const startMono = performance.now();
const startWall = Date.now();
const tsSafe = new Date(startWall).toISOString().replace(/[:.]/g, '-');
const artifactsDir = path.join(process.cwd(), 'artifacts');
const metricsFile = path.join(artifactsDir, `metrics-summary_${tsSafe}.ndjson`);
const healthFile = path.join(artifactsDir, `health_${tsSafe}.ndjson`);
const sseCsv = path.join(artifactsDir, `sse_events_${tsSafe}.csv`);
const enrichCsv = path.join(artifactsDir, `stub_enrichment_${tsSafe}.csv`);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function fetchJson(base, pathname, init = {}) {
  const url = base + pathname;
  const res = await fetch(url, { ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
  return await res.json();
}

async function tryBases(pathname, init) {
  let lastErr;
  for (const b of BASES) {
    try { return { base: b, json: await fetchJson(b, pathname, init) }; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All bases failed');
}

function nearestRank(arr, q) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x,y)=>x-y);
  const rank = Math.max(1, Math.min(a.length, Math.ceil(q * a.length)));
  return a[rank - 1];
}

async function main() {
  ensureDir(artifactsDir);
  fs.writeFileSync(metricsFile, '');
  fs.writeFileSync(healthFile, '');
  fs.writeFileSync(sseCsv, 'id,source,ingested_at,received_at,sse_delivery_ms\n');
  fs.writeFileSync(enrichCsv, 'id,detected,enrichment_delay_ms,notes\n');

  // Pre-flight health and metrics summary (T0)
  const t0 = new Date().toISOString();
  const ms0 = await tryBases('/metrics-summary');
  fs.appendFileSync(metricsFile, JSON.stringify({ t: t0, base: ms0.base, data: ms0.json }) + '\n');

  const h0 = await tryBases('/health');
  fs.appendFileSync(healthFile, JSON.stringify({ t: t0, base: h0.base, data: h0.json }) + '\n');

  // Open SSE
  const sseBase = h0.base;
  const controller = new AbortController();
  const sseUrl = sseBase + '/sse/new-items';
  let lastEventId = '0';
  let events = [];
  let heartbeats = 0;
  let missedHeartbeats = 0;
  let lastPingAt = performance.now();
  let reconnectCatchup = false; // Not exercised in 120s run

  const sseRes = await fetch(sseUrl, {
    headers: { 'Accept': 'text/event-stream', 'Last-Event-ID': lastEventId },
    signal: controller.signal,
  });
  if (!sseRes.ok) throw new Error(`SSE HTTP ${sseRes.status}`);
  if (!sseRes.body) throw new Error('SSE body missing');

  const reader = sseRes.body.getReader();
  let buffer = '';
  const deadline = performance.now() + runMs;

  while (performance.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      buffer += Buffer.from(value).toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = raw.split('\n');
        let evType = 'message';
        let evId = null;
        let dataLines = [];
        for (const line of lines) {
          if (line.startsWith('id:')) evId = line.slice(3).trim();
          else if (line.startsWith('event:')) evType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (evType === 'ping') {
          heartbeats++;
          const now = performance.now();
          if (now - lastPingAt > 45_000) missedHeartbeats++;
          lastPingAt = now;
          continue;
        }
        if (evType === 'new') {
          lastEventId = evId || lastEventId;
          const jsonStr = dataLines.join('\n');
          try {
            const obj = JSON.parse(jsonStr);
            const ing = Date.parse(obj.ingested_at);
            if (Number.isFinite(ing)) {
              const nowMonoMs = performance.timeOrigin + performance.now();
              const sseDelivery = Math.max(0, Math.round(nowMonoMs - ing));
              const receivedAtIso = new Date(Math.floor(nowMonoMs)).toISOString();
              events.push({ id: obj.id, source: obj.source || '', ingested_at: obj.ingested_at, received_at: receivedAtIso, sse_delivery_ms: sseDelivery });
              fs.appendFileSync(sseCsv, `${obj.id},${obj.source || ''},${obj.ingested_at},${receivedAtIso},${sseDelivery}\n`);
            }
          } catch {}
        }
      }
    }
  }

  try { controller.abort(); } catch {}

  // T+end snapshots
  const tend = new Date().toISOString();
  try { const msEnd = await tryBases('/metrics-summary'); fs.appendFileSync(metricsFile, JSON.stringify({ t: tend, base: msEnd.base, data: msEnd.json }) + '\n'); } catch {}
  try { const hEnd = await tryBases('/health'); fs.appendFileSync(healthFile, JSON.stringify({ t: tend, base: hEnd.base, data: hEnd.json }) + '\n'); } catch {}

  // Compute SSE stats
  const deliveries = events.map(e => e.sse_delivery_ms).filter(n => Number.isFinite(n));
  const sseStats = {
    count: deliveries.length,
    min: deliveries.length ? Math.min(...deliveries) : null,
    max: deliveries.length ? Math.max(...deliveries) : null,
    p50: deliveries.length ? nearestRank(deliveries, 0.5) : null,
    p90: deliveries.length ? nearestRank(deliveries, 0.9) : null,
    missedHeartbeats,
    reconnectCatchup,
  };

  // Load end metrics for SLOs
  let endMetrics;
  try { const data = fs.readFileSync(metricsFile, 'utf8').trim().split('\n'); endMetrics = JSON.parse(data[data.length - 1]).data; } catch {}

  const slo = { pulse: {}, publisher: { passRate: null, failing: [] } };
  if (endMetrics && endMetrics.by_source) {
    const by = endMetrics.by_source;
    const breaking = BREAKING_ALLOWLIST.filter(n => by[n]);
    const perPulse = {};
    let passCount = 0, total = 0;
    for (const name of breaking) {
      const s = by[name];
      perPulse[name] = { p50: s.pulse_p50 ?? null, p90: s.pulse_p90 ?? null };
      if (s.publisher_p50 != null) { total++; if (s.publisher_p50 <= 300000) passCount++; else slo.publisher.failing.push({ name, p50: s.publisher_p50, p90: s.publisher_p90 ?? null }); }
    }
    slo.pulse = { global_p50: endMetrics.aggregate?.pulse?.p50 ?? null, per: perPulse };
    slo.publisher.passRate = total ? Math.round((passCount / total) * 100) : null;
  }

  const first10 = events.slice(0, 10);
  const result = { base: sseBase, duration_s: Math.round((performance.now() - startMono)/1000), sse: sseStats, slo };
  console.log(JSON.stringify({ ok: true, result, first10 }));
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
});


