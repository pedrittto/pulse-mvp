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

const ADMIN_TOKEN_CANDIDATES = [process.env.ADMIN_TOKEN, 'test-token', 'test-admin-token'].filter(Boolean);

const runMs = 120_000;

function rnd() { return Math.random().toString(36).slice(2); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nearestRank(arr, q) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x,y)=>x-y);
  const rank = Math.max(1, Math.min(a.length, Math.ceil(q * a.length)));
  return a[rank - 1];
}

async function httpJson(base, pathname, init = {}) {
  const url = base + pathname;
  const res = await fetch(url, init);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

async function tryBasesJson(pathname, init) {
  let last;
  for (const b of BASES) {
    last = await httpJson(b, pathname, init);
    if (last.ok) return { base: b, ...last };
  }
  return { base: BASES[0], ...last };
}

async function postQuick(base, body) {
  for (const tok of ADMIN_TOKEN_CANDIDATES) {
    const res = await httpJson(base, '/admin/quick-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': tok ? `Bearer ${tok}` : '' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
  }
  // try X-Admin-Token fallback
  for (const tok of ADMIN_TOKEN_CANDIDATES) {
    const res = await httpJson(base, '/admin/quick-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tok || '' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
  }
  return { ok: false, status: 401, json: { error: 'auth_failed' } };
}

async function main() {
  // T0 metrics (pre-injection)
  const ms0 = await tryBasesJson('/metrics-summary');

  // Open SSE
  const base = ms0.base;
  const sseRes = await fetch(base + '/sse/new-items', { headers: { 'Accept': 'text/event-stream', 'Last-Event-ID': '0' } });
  if (!sseRes.ok || !sseRes.body) {
    console.log(JSON.stringify({ ok: false, error: 'SSE not available', status: sseRes.status }));
    return;
  }
  const reader = sseRes.body.getReader();
  let buffer = '';
  const startMono = performance.now();
  const deadline = startMono + runMs;
  let lastPing = performance.now();
  let missedHeartbeats = 0;
  const events = [];
  const enrichRows = [];

  // Start injections (10 items)
  const injects = [];
  for (let i = 0; i < 10; i++) {
    const uid = `${Date.now()}_${i}_${rnd()}`;
    const body = {
      title: `TEST_LATENCY_${uid}`,
      source: 'Synthetic Test',
      url: `http://localhost/test/${uid}`,
      tags: ['test','latency'],
      transport: 'test',
      breaking: true,
    };
    injects.push(postQuick(base, body));
    await sleep(50);
  }
  // fire and forget; no await here to keep SSE loop responsive

  while (performance.now() < deadline && events.length < 10) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += Buffer.from(value).toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const lines = raw.split('\n');
      let evType = 'message'; let evId = null; let dataLines = [];
      for (const line of lines) {
        if (line.startsWith('id:')) evId = line.slice(3).trim();
        else if (line.startsWith('event:')) evType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (evType === 'ping') {
        const now = performance.now();
        if (now - lastPing > 45_000) missedHeartbeats++;
        lastPing = now; continue;
      }
      if (evType !== 'new') continue;
      const jsonStr = dataLines.join('\n');
      try {
        const obj = JSON.parse(jsonStr);
        const ing = Date.parse(obj.ingested_at);
        if (!Number.isFinite(ing)) continue;
        const nowMonoMs = performance.timeOrigin + performance.now();
        const sseDelivery = Math.max(0, Math.round(nowMonoMs - ing));
        const receivedAtIso = new Date(Math.floor(nowMonoMs)).toISOString();
        events.push({ id: obj.id, source: obj.source || '', ingested_at: obj.ingested_at, received_at: receivedAtIso, sse_delivery_ms: sseDelivery });
        // Enrichment probes for first 5
        if (events.length <= 5) {
          const probes = [500, 1500, 3000, 6000, 10000];
          const baseUrl = base;
          let detected = false; let delay = null; let note = '';
          for (const p of probes) {
            await sleep(p - (p === 500 ? 0 : probes[probes.indexOf(p)-1]));
            const after = encodeURIComponent(obj.ingested_at);
            const res = await httpJson(baseUrl, `/feed/since?after=${after}&limit=50`);
            if (res.ok && res.json && Array.isArray(res.json.items)) {
              const found = res.json.items.find(x => x.id === obj.id);
              if (found) {
                // consider enriched if has fields beyond stub: impact or verification or headline
                if (found.impact || (found.verification && found.verification.state) || found.headline) {
                  detected = true; delay = p; note = 'enriched'; break;
                }
              }
            }
          }
          enrichRows.push({ id: obj.id, detected, enrichment_delay_ms: delay, notes: note || (detected ? 'enriched' : 'N/A') });
        }
      } catch {}
    }
  }

  // End snapshots
  const msEnd = await tryBasesJson('/metrics-summary');
  const healthEnd = await tryBasesJson('/health');

  const deliveries = events.map(e => e.sse_delivery_ms);
  const sseStats = {
    count: deliveries.length,
    min: deliveries.length ? Math.min(...deliveries) : null,
    max: deliveries.length ? Math.max(...deliveries) : null,
    p50: deliveries.length ? nearestRank(deliveries, 0.5) : null,
    p90: deliveries.length ? nearestRank(deliveries, 0.9) : null,
    missed_heartbeats: missedHeartbeats,
    reconnect_catchup: false,
  };

  // Build SLO views
  const t0By = ms0.json?.by_source || {};
  const endBy = msEnd.json?.by_source || {};
  const pulsePer = {};
  const pubPer = {};
  let passCount = 0; let total = 0; const failing = [];
  for (const name of BREAKING_ALLOWLIST) {
    if (endBy[name]) {
      pulsePer[name] = { p50: endBy[name].pulse_p50 ?? null, p90: endBy[name].pulse_p90 ?? null };
    }
    if (t0By[name] && t0By[name].publisher_p50 != null) {
      pubPer[name] = { p50: t0By[name].publisher_p50, p90: t0By[name].publisher_p90 ?? null };
      total++; if (t0By[name].publisher_p50 <= 300000) passCount++; else failing.push({ name, p50: t0By[name].publisher_p50, p90: t0By[name].publisher_p90 ?? null });
    }
  }

  const out = {
    base,
    duration_s: Math.round((performance.now() - startMono)/1000),
    sse: sseStats,
    first10: events.slice(0,10),
    enrichment_rows: enrichRows,
    pulse: { global_p50: msEnd.json?.aggregate?.pulse?.p50 ?? null, per: pulsePer },
    publisher: { pass_rate_pct: total ? Math.round((passCount/total)*100) : null, per: pubPer, failing },
    health_end: { sse_clients: healthEnd.json?.sse?.clients ?? null },
  };
  console.log(JSON.stringify({ ok: true, out }));
}

main().catch(e => { console.log(JSON.stringify({ ok: false, error: e?.message || String(e) })); process.exit(1); });


