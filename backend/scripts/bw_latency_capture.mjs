#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const baseUrl = process.argv[2] || process.env.BW_HOST || '';
const debugKey = process.argv[3] || process.env.DEBUG_PUSH_KEY || 'canary-debug';
if (!baseUrl) {
  console.error('[bw-capture] missing base URL');
  process.exit(2);
}

async function httpJson(method, path, body, headers = {}) {
  const url = `${baseUrl}${path}`;
  const opts = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined && body !== null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

function extractMetrics(ms) {
  const by = (ms && ms.by_source) || {};
  const bw = by.businesswire || {};
  const publisher_p50_ms = (bw.publisher_p50_ms ?? bw.p50_ms ?? null);
  const publisher_p90_ms = (bw.publisher_p90_ms ?? bw.p90_ms ?? null);
  const pulse_p50_ms = (bw.pulse_p50_ms ?? null);
  const pulse_p90_ms = (bw.pulse_p90_ms ?? null);
  return { publisher_p50_ms, publisher_p90_ms, pulse_p50_ms, pulse_p90_ms };
}

async function captureFirstSSE(outSamplePath, outLivePath, maxLiveMs = 180000) {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/sse/breaking`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`sse-status:${res.status}`);
  const reader = res.body.getReader();
  let buf = '';
  let sampleSaved = false;
  let liveSaved = false;
  const t0 = Date.now();
  const deadline = t0 + maxLiveMs;
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = raw.split('\n').filter(l => l.startsWith('data:'));
      if (!dataLines.length) continue;
      const data = dataLines.map(l => l.replace(/^data:\s?/, '')).join('\n');
      try {
        const json = JSON.parse(data);
        if (json && json.source === 'businesswire') {
          if (!sampleSaved) {
            writeFileSync(outSamplePath, JSON.stringify(json, null, 2));
            sampleSaved = true;
          }
          if (!liveSaved && json.timestamp_source && String(json.timestamp_source) !== 'fixture') {
            writeFileSync(outLivePath, JSON.stringify(json, null, 2));
            liveSaved = true;
          }
          if (sampleSaved && (liveSaved || Date.now() > deadline)) {
            try { ctrl.abort(); } catch {}
            return { sampleSaved, liveSaved };
          }
        }
      } catch {}
    }
    if (Date.now() > deadline && sampleSaved) {
      try { ctrl.abort(); } catch {}
      return { sampleSaved, liveSaved };
    }
  }
  return { sampleSaved, liveSaved };
}

// Flow
const before = await httpJson('GET', '/metrics-summary');
const beforeSel = extractMetrics(before.json || {});
writeFileSync('ARTIFACTS/bw_metrics_before.json', JSON.stringify(beforeSel, null, 2));

// Start SSE first, then trigger replay to ensure we capture fixture event
const ssePromise = captureFirstSSE('ARTIFACTS/bw_sse_sample.json', 'ARTIFACTS/bw_sse_live.json', 180000);
await httpJson('POST', '/_debug/ingest/replay?source=businesswire&n=5', null, { 'x-debug-key': debugKey });
await ssePromise.catch(() => ({ sampleSaved: false, liveSaved: false }));

const after = await httpJson('GET', '/metrics-summary');
const afterSel = extractMetrics(after.json || {});
writeFileSync('ARTIFACTS/bw_metrics_after.json', JSON.stringify(afterSel, null, 2));

console.log('[ARTIFACTS] wrote: bw_metrics_before.json, bw_metrics_after.json, bw_sse_sample.json (and bw_sse_live.json if captured)');

