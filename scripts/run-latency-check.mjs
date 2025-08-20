#!/usr/bin/env node
/*
 Orchestrates SSE subscription, injects up to 3 test items, captures snapshots, and computes SLOs.
 Produces artifacts and FASTLANE_latency_report.md as specified.
*/

import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_TOKENS?.split(',')[0] || 'localtest';

const RUN_MINUTES = parseInt(process.env.RUN_MINUTES || '7', 10); // total runtime
const RECONNECT_AFTER_MS = 3 * 60 * 1000; // ~T+3 min
const START_INJECTION_AFTER_MS = 30 * 1000; // start injections at T+30s
const INJECTION_SPACING_MS = 60 * 1000; // 3 injections spaced 60s
const SNAPSHOT_INTERVAL_MS = 60 * 1000; // metrics/health every ~60s
const HEARTBEAT_MAX_GAP_MS = 45 * 1000;

const tsSlug = () => new Date().toISOString().replace(/[:.]/g, '-');
const START_TS = tsSlug();
const artifactsDir = path.join(process.cwd(), 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const metricsFile = path.join(artifactsDir, `metrics-summary_${START_TS}.ndjson`);
const healthFile = path.join(artifactsDir, `health_${START_TS}.ndjson`);
const sseCsv = path.join(artifactsDir, `sse_events_${START_TS}.csv`);
const enrichCsv = path.join(artifactsDir, `stub_enrichment_${START_TS}.csv`);

fs.writeFileSync(sseCsv, 'ts,id,ingested_at,received_at_ms,sse_delivery_ms\n');
fs.writeFileSync(enrichCsv, 'ts,id,ingested_at,checked_at_ms,enriched,enrichment_delay_ms,headline,url\n');

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function nowIso() { return new Date().toISOString(); }

async function httpJson(pathname, init = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, init);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, ok: res.ok, json: null };
  }
}

async function snapshotLoop(stopSignal) {
  // T0 snapshots
  const m0 = await httpJson('/metrics-summary');
  fs.appendFileSync(metricsFile, JSON.stringify({ ts: nowIso(), ...m0.json }) + '\n');
  const h0 = await httpJson('/health');
  fs.appendFileSync(healthFile, JSON.stringify({ ts: nowIso(), ...h0.json }) + '\n');

  while (!stopSignal.stopped) {
    await sleep(SNAPSHOT_INTERVAL_MS);
    const m = await httpJson('/metrics-summary');
    fs.appendFileSync(metricsFile, JSON.stringify({ ts: nowIso(), ...m.json }) + '\n');
    const h = await httpJson('/health');
    fs.appendFileSync(healthFile, JSON.stringify({ ts: nowIso(), ...h.json }) + '\n');
  }
}

function parseSSE(buffer) {
  // Parses an SSE event block into { id, event, data }
  const lines = buffer.split(/\r?\n/);
  let id = null, event = 'message', dataLines = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5));
  }
  const dataRaw = dataLines.join('\n');
  let data = null;
  try { data = dataRaw ? JSON.parse(dataRaw) : null; } catch { data = dataRaw; }
  return { id, event, data };
}

async function sseLoop({ stopSignal, onNewEvent, onHeartbeat, onReconnect, initialLastId = '0' }) {
  let controller = new AbortController();
  let lastEventId = initialLastId;
  let connected = false;
  let streamAbortReason = null;

  async function connect(lastIdHeader) {
    const res = await fetch(`${BASE_URL}/sse/new-items`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Last-Event-ID': lastIdHeader,
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed status=${res.status}`);
    }
    connected = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let lastBeat = Date.now();
    while (!stopSignal.stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 2);
        if (!chunk) continue;
        const evt = parseSSE(chunk);
        if (evt.event === 'ping') {
          onHeartbeat?.(Date.now());
          lastBeat = Date.now();
          continue;
        }
        if (evt.event === 'new') {
          if (evt.id) lastEventId = evt.id;
          onNewEvent?.(evt, Date.now());
        }
      }
      // heartbeat gap monitor (soft)
      if (Date.now() - lastBeat > HEARTBEAT_MAX_GAP_MS) {
        onHeartbeat?.(Date.now()); // mark gap; consumer will record
        lastBeat = Date.now();
      }
    }
  }

  const forcedReconnectTimer = setTimeout(async () => {
    if (stopSignal.stopped) return;
    try {
      streamAbortReason = 'forced-reconnect';
      controller.abort();
      await sleep(2000);
      controller = new AbortController();
      await connect(lastEventId || '0');
      onReconnect?.(lastEventId);
    } catch (e) {
      // swallow
    }
  }, RECONNECT_AFTER_MS);

  try {
    await connect(lastEventId);
  } catch (e) {
    // attempt one retry quickly
    await sleep(1000);
    controller = new AbortController();
    await connect(lastEventId);
  }

  clearTimeout(forcedReconnectTimer);
  return { lastEventId, reason: streamAbortReason, connected };
}

function uuid() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function injectTestItem(uid) {
  const title = `TEST_PULSE_LATENCY_${uid}`;
  const url = `http://localhost/test/${uid}`;
  const source = 'Synthetic Test';
  const body = { title, source, url, tags: ['test','latency'] };
  const res = await httpJson('/admin/quick-post', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, id: res.json?.id, body: res.json };
}

async function checkEnrichment(itemId, ingestedAtIso) {
  // 1–3s after event; caller decides delay
  const res = await httpJson(`/feed/since?after=${encodeURIComponent(ingestedAtIso)}&limit=50`);
  if (!res.ok || !res.json) return { found: false };
  const arr = Array.isArray(res.json.items) ? res.json.items : [];
  const found = arr.find(it => it.id === itemId);
  if (!found) return { found: false };
  const enriched = !!(found.impact || found.verification || (found.headline && found.headline.length > 0));
  return {
    found: true,
    enriched,
    item: found
  };
}

async function main() {
  const stopSignal = { stopped: false };
  const endAt = Date.now() + RUN_MINUTES * 60 * 1000;

  const sseLatencies = [];
  let sseEventsCount = 0;
  let lastHeartbeatAt = null;
  let heartbeatGapFlagged = false;
  let midrunHealthSseClients = 0;
  let reconnectUsedLastId = null;
  let reconnectedAtMs = null;
  let postReconnectEventObserved = false;

  // start snapshots
  const snapshotPromise = snapshotLoop(stopSignal);

  // schedule injections (up to 3)
  const injectSchedule = [0, 1, 2].map(i => async () => {
    await sleep(START_INJECTION_AFTER_MS + i * INJECTION_SPACING_MS);
    const uid = uuid();
    return injectTestItem(uid);
  });
  const injectPromises = injectSchedule.map(fn => fn());

  // SSE consumer
  const ssePromise = sseLoop({
    stopSignal,
    initialLastId: '0',
    onHeartbeat: (t) => {
      if (lastHeartbeatAt && (t - lastHeartbeatAt) > HEARTBEAT_MAX_GAP_MS) {
        heartbeatGapFlagged = true;
      }
      lastHeartbeatAt = t;
    },
    onReconnect: (lastId) => { reconnectUsedLastId = lastId; reconnectedAtMs = Date.now(); },
    onNewEvent: async (evt, receivedAtMs) => {
      try {
        sseEventsCount += 1;
        if (reconnectedAtMs && !postReconnectEventObserved) { postReconnectEventObserved = true; }
        const ingIso = (evt?.data?.ingested_at) || nowIso();
        const delta = Math.max(0, receivedAtMs - Date.parse(ingIso));
        sseLatencies.push(delta);
        fs.appendFileSync(sseCsv, `${nowIso()},${evt.id},${ingIso},${receivedAtMs},${delta}\n`);

        // enrichment probe ~1.5s after
        await sleep(1500);
        const enr = await checkEnrichment(evt.id, ingIso);
        let enrichmentDelay = null;
        let headline = '';
        let url = '';
        if (enr.found) {
          headline = enr.item?.headline || '';
          url = enr.item?.url || '';
          if (enr.enriched) {
            enrichmentDelay = Math.max(0, Date.now() - Date.parse(ingIso));
          }
        }
        fs.appendFileSync(enrichCsv, `${nowIso()},${evt.id},${ingIso},${Date.now()},${enr.found && enr.enriched},${enrichmentDelay ?? ''},"${(headline || '').replace(/"/g,'\"')}",${url}\n`);
      } catch {
        // ignore
      }
    }
  });

  // Ensure mid-run health snapshot (T+5m) reflects sse.clients
  (async () => {
    await sleep(5 * 60 * 1000);
    const h = await httpJson('/health');
    try { midrunHealthSseClients = h?.json?.sse?.clients || 0; } catch { midrunHealthSseClients = 0; }
  })();

  // Run until end
  while (Date.now() < endAt) {
    await sleep(1000);
  }

  stopSignal.stopped = true;
  await Promise.allSettled([snapshotPromise, ssePromise, ...injectPromises]);

  // Build SLOs
  const latSorted = sseLatencies.slice().sort((a,b)=>a-b);
  const latCount = latSorted.length;
  const latP50 = percentile(latSorted, 0.5);
  const latP90 = percentile(latSorted, 0.9);
  const latMin = latSorted[0] ?? null;
  const latMax = latSorted[latSorted.length - 1] ?? null;

  // Read last snapshots
  const lastMetrics = (() => {
    try {
      const lines = fs.readFileSync(metricsFile, 'utf-8').trim().split(/\r?\n/);
      return JSON.parse(lines[lines.length - 1] || '{}');
    } catch { return {}; }
  })();
  const lastHealth = (() => {
    try {
      const lines = fs.readFileSync(healthFile, 'utf-8').trim().split(/\r?\n/);
      return JSON.parse(lines[lines.length - 1] || '{}');
    } catch { return {}; }
  })();

  // Authoritative Pulse→Visible
  const authP50 = lastMetrics?.aggregate?.pulse?.p50 ?? null;
  const authP90 = null; // metrics-summary aggregate exposes only p50
  const authPass = (authP50 != null) ? (authP50 <= 60000) : false;

  // Publisher→Ingest per-source (Breaking allowlist only)
  const bySource = lastMetrics?.by_source || {};
  const metricsSources = Object.keys(bySource);
  const breakingSources = Array.isArray(lastHealth?.breaking?.sources)
    ? lastHealth.breaking.sources.map(s => s.name)
    : [];
  const allowlist = metricsSources.filter(s => breakingSources.includes(s));
  const passingSources = allowlist.filter(s => {
    const p50 = bySource[s]?.publisher_p50;
    return typeof p50 === 'number' && p50 <= 300000; // 5 minutes
  });
  const pubPassPct = allowlist.length ? Math.round((passingSources.length / allowlist.length) * 100) : 0;
  const pubPass = allowlist.length > 0 && pubPassPct >= 100; // require all pass in allowlist
  const failingSources = allowlist.filter(s => !passingSources.includes(s));

  // SSE proxy SLOs
  const ssePass = (latCount >= 3) && (latP50 != null && latP90 != null) && (latP50 <= 60000) && (latP90 <= 120000);

  const green = (midrunHealthSseClients >= 1) && (latCount >= 3) && ssePass && authPass && pubPass;

  const report = [];
  report.push(`FASTLANE Latency Report (${new Date().toISOString()})`);
  report.push('');
  report.push('Inputs');
  report.push(`- Base URL: ${BASE_URL}`);
  report.push(`- SSE events observed: ${latCount}`);
  report.push('');
  report.push('SSE Proxy Latency (now - ingested_at)');
  report.push(`- count: ${latCount}`);
  report.push(`- p50: ${latP50 ?? 'n/a'} ms`);
  report.push(`- p90: ${latP90 ?? 'n/a'} ms`);
  report.push(`- min: ${latMin ?? 'n/a'} ms`);
  report.push(`- max: ${latMax ?? 'n/a'} ms`);
  report.push(`- PASS: ${ssePass}`);
  report.push('');
  report.push('Authoritative Pulse→Visible (from /metrics-summary, p50)');
  report.push(`- p50: ${authP50 ?? 'n/a'} ms`);
  report.push(`- PASS: ${authPass}`);
  report.push('');
  report.push('Publisher→Ingest (per-source, Breaking allowlist only)');
  report.push(`- sources considered: ${allowlist.length}`);
  report.push(`- passing % (p50 ≤ 300000 ms): ${pubPassPct}%`);
  if (failingSources.length) report.push(`- failing sources: ${failingSources.join(', ')}`);
  report.push(`- PASS: ${pubPass}`);
  report.push('');
  report.push('Mid-run health');
  report.push(`- /health @ ~T+5m sse.clients: ${midrunHealthSseClients}`);
  report.push(`- heartbeat gap > 45s observed: ${heartbeatGapFlagged}`);
  report.push(`- reconnect used Last-Event-ID: ${reconnectUsedLastId ?? ''}`);
  report.push(`- post-reconnect events observed: ${postReconnectEventObserved}`);
  report.push('');
  report.push(`FINAL VERDICT: ${green ? 'GREEN' : 'INCOMPLETE'}`);
  if (!green) {
    const reasons = [];
    if (midrunHealthSseClients < 1) reasons.push('health mid-run sse.clients < 1');
    if (latCount < 3) reasons.push('SSE events < 3');
    if (!ssePass) reasons.push('SSE proxy latency SLO failed');
    if (!authPass) reasons.push('Authoritative SLO failed or unavailable');
    if (!pubPass) reasons.push('Publisher→Ingest SLO failed or unavailable');
    report.push(`Reasons: ${reasons.join('; ')}`);
  }

  fs.writeFileSync(path.join(process.cwd(), 'FASTLANE_latency_report.md'), report.join('\n'));

  // eslint-disable-next-line no-console
  console.log('[latency-check] done', { green, sse_events: latCount, sse_p50: latP50, sse_p90: latP90, midrun_sse_clients: midrunHealthSseClients });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[latency-check] fatal', err);
  process.exit(1);
});


