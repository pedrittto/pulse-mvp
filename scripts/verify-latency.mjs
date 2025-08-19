/*
  Verification script: does not modify production code.
  - Starts backend with mock Firestore and dev-only control feed
  - Measures SSE, /feed/since, /metrics-lite, /health
  - Writes ./verification_report.json
*/
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const PORT = process.env.VERIFY_PORT || '4010';
const BASE = `http://localhost:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(500);
  }
  throw new Error('health timeout');
}

async function getMetricsLite() {
  const r = await fetch(`${BASE}/metrics-lite`);
  return await r.json();
}

function startBackend() {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT,
    // Safe flags for local/staging verification
    USE_FAKE_FIRESTORE: '1',
    BREAKING_MODE: '1',
    RSS_TRANSPORT_V2: '1',
    CONTROL_FEED_ENABLED: '1',
    SSE_ENABLED: '1'
  };
  const isWin = process.platform === 'win32';
  let child;
  if (isWin) {
    // Use cmd.exe to run node for better compatibility with .cmd shims
    child = spawn('cmd.exe', ['/c', 'node', 'node_modules/.bin/ts-node', 'src/index.ts'], {
      cwd: './backend', env, stdio: ['ignore', 'pipe', 'pipe']
    });
  } else {
    child = spawn('node', ['node_modules/.bin/ts-node', 'src/index.ts'], {
      cwd: './backend', env, stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  child.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('LISTENING')) {
      console.log(`[backend] ${s.trim()}`);
    }
  });
  child.stderr.on('data', d => {
    process.stderr.write(`[backend-err] ${d.toString()}`);
  });
  return child;
}

async function* sseStream(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield chunk;
    }
  }
}

function parseSSEEvent(block) {
  const lines = block.split(/\r?\n/);
  const out = { event: 'message', data: '', id: '', retry: '' };
  for (const line of lines) {
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trimStart();
    if (k === 'event') out.event = v;
    else if (k === 'data') out.data += (out.data ? '\n' : '') + v;
    else if (k === 'id') out.id = v;
    else if (k === 'retry') out.retry = v;
  }
  return out;
}

async function measureSSENewEvent(timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for await (const block of sseStream(`${BASE}/sse/new-items`, ctrl.signal)) {
      const ev = parseSSEEvent(block);
      if (ev.event === 'new' && ev.data) {
        const payload = JSON.parse(ev.data);
        const elapsed = Date.now() - t0;
        clearTimeout(timer);
        ctrl.abort();
        return { elapsed_ms: elapsed, id: payload.id, ingested_at: payload.ingested_at };
      }
    }
  } catch (e) {
    return { elapsed_ms: null, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function measureFeedSinceAppearance(sinceIso, expectId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE}/feed/since?after=${encodeURIComponent(sinceIso)}&limit=50`);
    if (r.ok) {
      const json = await r.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      if (items.find(x => x.id === expectId)) return Date.now() - start;
    }
    await sleep(1000);
  }
  return null;
}

function computeCoverage(latency, sources) {
  if (!latency) return { coverage: null, total_considered: 0, passing: 0, details: [] };
  const details = [];
  for (const name of sources) {
    const l = latency[name];
    if (!l || l.samples_insufficient || (l.count || 0) < 5) continue;
    details.push({ name, p50_ms: l.p50, p90_ms: l.p90, count: l.count, timeout_count: l.timeout_count || 0, error_count: l.error_count || 0 });
  }
  const total = details.length;
  const passing = details.filter(d => d.p50_ms <= 5*60*1000 && d.p90_ms <= 10*60*1000).length;
  return { coverage: total ? passing / total : null, total_considered: total, passing, details };
}

async function main() {
  console.log('Starting verification...');
  const child = process.env.VERIFY_SKIP_START === '1' ? null : startBackend();
  let report = {
    started_at: new Date().toISOString(),
    base_url: BASE,
    synthetic: {},
    tier1_wires: {},
    backend: {},
    frontend: { sse_used: null, swr_interval_ms: null, direct_backend_calls: null }
  };
  try {
    await waitForHealth(30000);
    console.log('Backend healthy');
    // Give time to ingest control items
    await sleep(25000);
    const metrics = await getMetricsLite();
    const latency = metrics?.latency || null;
    const synth = latency?.SyntheticControl || null;
    if (synth) {
      report.synthetic.metrics = { p50_ms: synth.p50, p90_ms: synth.p90, count: synth.count };
    } else {
      report.synthetic.metrics = { p50_ms: null, p90_ms: null, count: 0, note: 'SyntheticControl not observed' };
    }
    // Measure SSE new event
    console.log('Connecting SSE...');
    const sse = await measureSSENewEvent(30000);
    report.synthetic.sse = sse;
    // Measure feed/since appearance if we have an id
    if (sse?.id && sse?.ingested_at) {
      const since = new Date(new Date(sse.ingested_at).getTime() - 1000).toISOString();
      const feedMs = await measureFeedSinceAppearance(since, sse.id, 15000);
      report.synthetic.feed_since_ms = feedMs;
    }
    // Tier-1 + wires coverage from metrics-lite
    const TIER1 = ['Bloomberg Markets','Reuters Business','AP Business','CNBC','Financial Times'];
    const WIRES = ['PRNewswire','GlobeNewswire','SEC Filings','BLS Releases','BEA News','NASDAQ Trader News','NYSE Notices'];
    const cov = computeCoverage(latency, [...TIER1, ...WIRES]);
    report.tier1_wires = cov;
    // Health snapshot
    const health = await (await fetch(`${BASE}/health`)).json();
    report.backend.health = {
      ok: !!health?.ok,
      uptime: health?.uptime || null,
      node: health?.node || null,
      schedulers: health?.schedulers || null,
      sse_clients: health?.sse?.clients ?? null
    };
  } catch (e) {
    console.error('Verification error:', e?.message || e);
    report.error = String(e?.message || e);
  } finally {
    try { await writeFile('./verification_report.json', JSON.stringify(report, null, 2), 'utf8'); } catch {}
    console.log('Wrote ./verification_report.json');
    if (child && !child.killed) child.kill('SIGINT');
  }
}

main().catch(e => { console.error(e); process.exit(1); });


