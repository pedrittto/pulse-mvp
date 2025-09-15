import "dotenv/config";import express from "express";
import cors from "cors";
import { registerSSE, getSSEStats, broadcastBreaking, getRecentBreaking } from "./sse.js";
import { startIngests, startIngestsOnce, getIngestDebug, enableAdapter, runProbeOnce, listRegisteredSources, resolveActive, getNextDueAt, isRegistered } from "./ingest/index.js";
import { getSchedulerSnapshot } from './ingest/telemetry.js';
import { startFastlaneIfEnabled } from './fastlane.js';
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

// Safe fallback: keep v2 shape even if metrics module is missing
let getLatencySummary: () => Record<string, unknown> = () => ({} as Record<string, unknown>);
let getSpecV1Summary: (() => { n_total: number; by_source: Record<string, any> }) | null = null;
let recordLatencyFn: ((src: string, publishedAtMs: number, visibleAtMs?: number) => void) | null = null;
let recordPipelineFn: ((src: string, firstSeenAtMs: number, ingestedAtMs?: number) => void) | null = null;
let setTsSourceFn: ((src: string, label: string) => void) | null = null;
try {
  // Will resolve to dist/metrics/latency.js at runtime after build
  const mod = require("./metrics/latency.js");
  if (mod && typeof mod.getLatencySummary === "function") {
    console.log('[metrics] using REAL latency summary');
    getLatencySummary = mod.getLatencySummary as () => Record<string, unknown>;
    if (typeof mod.recordPublisherLatency === 'function') recordLatencyFn = mod.recordPublisherLatency as (src: string, p: number, v?: number) => void;
    else if (typeof mod.recordLatency === 'function') recordLatencyFn = mod.recordLatency as (src: string, p: number, v?: number) => void;
    if (typeof mod.recordPipelineLatency === 'function') recordPipelineFn = mod.recordPipelineLatency as (src: string, a: number, b?: number) => void;
    if (typeof mod.setTimestampSource === 'function') setTsSourceFn = mod.setTimestampSource as (src: string, lbl: string) => void;
    if (typeof mod.getSpecV1Summary === 'function') {
      getSpecV1Summary = mod.getSpecV1Summary as () => { n_total: number; by_source: Record<string, any> };
    }
  } else {
    console.log('[metrics] latency module missing export; using FALLBACK');
  }
} catch (e) {
  console.log('[metrics] using FALLBACK latency summary:', (e as Error).message);
}

const app = express();
const __bootTs = Date.now();
app.use((req, res, next) => {
  res.on('finish', () => {
    if (Date.now() - __bootTs < 30000) {
      console.log('[probe]', req.method, req.url, '→', res.statusCode);
    }
  });
  next();
});
const JOBS_DISABLED = ['1','true','yes'].includes((process.env.DISABLE_JOBS ?? '').toLowerCase());
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
const PORT = Number(process.env.PORT || 4000);

// Ensure scheduler boot happens early and deterministically when jobs are enabled
if (!JOBS_DISABLED) {
  try {
    console.log('[scheduler] started');
    startIngestsOnce?.();
  } catch {}
}

// Build allow-list from env
const ALLOWED = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Fast-path health probes before any other middleware
app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.head('/health', (_req, res) => res.status(200).end());

// Root probe for platforms expecting GET /
app.get('/', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.head('/', (_req, res) => res.status(200).end());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

registerSSE(app);

// Optional tiny scheduler dump
app.get('/_debug/scheduler', (_req, res) => {
  try {
    const ACTIVE = resolveActive?.(process.env.INGEST_SOURCES) || [];
    const snap = getSchedulerSnapshot?.() || {} as any;
    const out = ACTIVE.map((id: string) => ({
      id,
      ticks_total: Number(snap[id]?.ticks_total ?? 0),
      last_tick_at: snap[id]?.last_tick_at ? Number(snap[id].last_tick_at) : undefined,
      last_http_status: snap[id]?.last_http_status ? Number(snap[id].last_http_status) : undefined,
      consecutive_failures: Number(snap[id]?.consecutive_failures ?? 0),
      last_error: snap[id]?.last_error ? String(snap[id].last_error) : undefined,
      is_registered: isRegistered?.(id) ?? undefined,
      next_due_at: getNextDueAt?.(id) ?? undefined,
    }));
    res.status(200).json({ adapters: out });
  } catch (e) {
    res.status(500).json({ error: String(e as any) });
  }
});

function parseEnvSources(raw?: string): string[] {
  const ALIASES: Record<string,string> = {
    'sec-press':'sec_press', 'sec_press':'sec_press',
    'nyse-notices':'nyse_notices', 'cme-notices':'cme_notices', 'nasdaq-halts':'nasdaq_halts',
  };
  const t = raw ?? '';
  if (!t) return [];
  try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map(v=>String(v)).map(s=>s.trim()).filter(Boolean).map(s=>ALIASES[s]||s.replace(/-/g,'_')); } catch {}
  return t.split(',').map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/-/g,'_')).map(s=>ALIASES[s]||s);
}

if (DEBUG_INGEST) {
  const sources = parseEnvSources(process.env.INGEST_SOURCES || "businesswire");
  app.get("/debug/enabled-sources", (_req, res) => {
    res.json({ sources, disable_jobs: JOBS_DISABLED, now: Date.now() });
  });
}

app.get("/_debug/env", (_req, res) => {
  res.json({ allowed: ALLOWED, raw: process.env.CORS_ORIGIN });
});

const entryPath = fileURLToPath(import.meta.url);
console.log("[boot]", { entry: entryPath, node: process.version, pid: process.pid });
console.log("[env] INGEST_SOURCES=", JSON.stringify(process.env.INGEST_SOURCES || ""));
console.log("[env] CORS_ORIGIN allow-list:", ALLOWED);
if (DEBUG_INGEST) {
  console.log('[BOOT env]', {
    disable_jobs: JOBS_DISABLED,
    spec_v1: process.env.SPEC_V1 === '1',
    ingest_sources: (process.env.INGEST_SOURCES || '').split(',').map(s=>s.trim()).filter(Boolean),
    cpu_always: process.env.NO_CPU_THROTTLING === '1' || undefined,
    min_instances: process.env.MIN_INSTANCES || undefined,
  });
  console.log('[scheduler] started');
  try { startIngestsOnce?.(); } catch {}
}
app.get("/metrics-lite", (_req, res) => res.json({ service: "backend", version: "v2", ts: Date.now() }));

app.post("/_debug/push", express.json(), (req, res) => {
  const key = req.get("x-debug-key");
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: "UNAUTHORIZED" });
  }
  const sent = broadcastBreaking({ ts: Date.now(), ...req.body });
  return res.json({ ok: true, sent });
});

// API v0: recent items snapshot, supports filters
app.get('/api/v0/items', (req, res) => {
  try {
    const limit = Number((req.query as any)?.limit || 10);
    const sources = String((req.query as any)?.sources || '').split(',').map(s=>s.trim()).filter(Boolean);
    const data = getRecentBreaking(limit, sources.length ? sources : undefined);
    res.status(200).json({ items: data, limit, sources: sources.length ? sources : undefined });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// Secure on-demand ingest probe (dry-run, no publish)
app.post('/_debug/ingest/runOnce', express.json(), async (req, res) => {
  const key = req.get('x-debug-key');
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  const q = String((req.query as any)?.source || '').trim();
  const sources = q
    ? [q]
    : (Array.isArray(req.body?.sources) && req.body.sources.length)
      ? req.body.sources
      : parseEnvSources(process.env.INGEST_SOURCES) /* default to configured sources */;
  const startedAt = Date.now();
  try {
    const tasks = sources.map((s: string) => runProbeOnce(s));
    const results = await Promise.all(tasks);
    return res.status(200).json({ ok: true, startedAt, finishedAt: Date.now(), results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e as any) });
  }
});

// Deterministic replay via adapters: /_debug/ingest/replay?source=businesswire&n=5
app.post('/_debug/ingest/replay', async (req, res) => {
  const key = req.get('x-debug-key');
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  const source = String((req.query as any)?.source || '').trim();
  const n = Number((req.query as any)?.n || 5);
  try {
    if (source === 'businesswire') {
      const mod = await import('./ingest/businesswire.js');
      const out = await (mod as any).replayFixture?.(n);
      return res.json(out || { ok: false, reason: 'NO_REPLAY' });
    }
    return res.json({ ok: false, reason: 'UNSUPPORTED_SOURCE' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e as any) });
  }
});

// Optional: perform a single adapter tick (no schedule change)
app.post('/_debug/pollOnce', async (req, res) => {
  const key = req.get('x-debug-key');
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  const source = String((req.query as any)?.source || '').trim();
  try {
    if (source === 'businesswire') {
      const mod = await import('./ingest/businesswire.js');
      const out = await (mod as any).tick?.();
      return res.json({ ok: true, source, result: out });
    }
    return res.json({ ok: false, reason: 'UNSUPPORTED_SOURCE' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e as any) });
  }
});

// Internal: record latency samples directly (from real fetched items). Guarded.
app.post('/_debug/ingest/recordLatency', express.json(), (req, res) => {
  const key = req.get('x-debug-key');
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  if (!recordLatencyFn) {
    return res.status(500).json({ ok: false, reason: 'NO_RECORD_FN' });
  }
  const source = String(req.body?.source || '').trim();
  const list = Array.isArray(req.body?.published_at_list) ? req.body.published_at_list : [];
  const mode = String(req.body?.mode || 'publisher');
  const tsLabel = String(req.body?.timestamp_source || 'feed');
  let count = 0;
  const now = Date.now();
  for (const t of list) {
    const ms = Number(t);
    if (Number.isFinite(ms) && ms > 0) {
      try {
        if (mode === 'pipeline' && recordPipelineFn) { recordPipelineFn(source, ms, now); }
        else { recordLatencyFn(source, ms, now); }
        count++;
      } catch {}
    }
  }
  try { setTsSourceFn?.(source, tsLabel); } catch {}
  return res.json({ ok: true, source, recorded: count });
});

// Synchronous, ESM-safe ingest debug (always responds JSON)
app.get('/debug/ingest', (_req, res) => {
  try {
    const info = (typeof getIngestDebug === 'function') ? getIngestDebug() : { error: 'no-debug-fn' } as any;
    const safe = {
      started: !!(info as any)?.started,
      enabled: Array.isArray((info as any)?.enabled) ? (info as any).enabled.map((x: any) => String(x)) : [],
      adapters: Array.isArray((info as any)?.adapters)
        ? (info as any).adapters.map((a: any) => ({
            name: String(a?.name ?? ''),
            timers: Number(a?.timers ?? 0),
            state: (a as any)?.state ?? undefined,
            nextInMs: (typeof (a as any)?.nextInMs === 'number') ? (a as any).nextInMs : undefined,
            // passthrough limiter stats when available
            inFlight: (a as any)?.inFlight,
            deferred: (a as any)?.deferred,
            overlapsPrevented: (a as any)?.overlapsPrevented,
            respTooLarge: (a as any)?.respTooLarge,
          }))
        : []
    };
    res.status(200).type('application/json').send(JSON.stringify(safe));
  } catch (e) {
    try { console.error('[debug/ingest] error', e); } catch {}
    res.status(500).type('application/json').send(JSON.stringify({ error: String(e as any) }));
  }
});

// Metrics summary snapshot (cached)
const REFRESH_TIMEOUT_MS   = Number(process.env.REFRESH_TIMEOUT_MS || 2000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.METRICS_SNAPSHOT_INTERVAL_MS || 15_000);
const SNAPSHOT_MAX_AGE_MS  = Number(process.env.METRICS_SNAPSHOT_MAX_AGE_MS  || 5 * 60_000);
const METRICS_WINDOW_HOURS = Number(process.env.METRICS_WINDOW_HOURS || 24);

type PerSource = { samples: number; p50_ms: number|null; p90_ms: number|null; last_sample_at: number; };
let metricsSnapshot: { generatedAt: number; stale: boolean; sse: { p50_ms: number|null; p90_ms: number|null }; by_source: Record<string, any> } = {
  generatedAt: 0,
  stale: true,
  sse: { p50_ms: null, p90_ms: null },
  by_source: {}
};
let metricsSnapshotString = JSON.stringify({ ...metricsSnapshot, stale: true });

function computeSnapshot() {
  // Use existing latency provider; transform to desired diagnostics-rich shape
  const raw = getLatencySummary() as Record<string, PerSource>;
  const by_source: Record<string, any> = {};
  let totalSamples = 0;
  let wP50 = 0;
  let wP90 = 0;
  for (const [src, v] of Object.entries(raw)) {
    const samples = v?.samples ?? 0;
    const p50_ms = v?.p50_ms ?? null;
    const p90_ms = v?.p90_ms ?? null;
    const last = (v as any)?.last_sample_at ?? 0;
    by_source[src] = {
      samples,
      p50_ms,
      p90_ms,
      last_sample_at: last || null,
      units: "ms",
      window_hours: METRICS_WINDOW_HOURS,
      ...(samples < 5 ? { low_sample: true } : {})
    };
    if (samples && typeof p50_ms === 'number') { wP50 += p50_ms * samples; totalSamples += samples; }
    if (samples && typeof p90_ms === 'number') { wP90 += p90_ms * samples; }
  }
  const sse = {
    p50_ms: totalSamples ? Math.round(wP50 / totalSamples) : null,
    p90_ms: totalSamples ? Math.round(wP90 / totalSamples) : null,
  };
  metricsSnapshot = { generatedAt: Date.now(), stale: false, sse, by_source };
  metricsSnapshotString = JSON.stringify(metricsSnapshot);
}

function withTimeout<T>(p: Promise<T>, ms = REFRESH_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('refresh-timeout')), ms)),
  ]);
}

async function refreshMetricsSnapshot() {
  try {
    await withTimeout(Promise.resolve().then(() => computeSnapshot()), REFRESH_TIMEOUT_MS);
  } catch (e) {
    const age = Date.now() - (metricsSnapshot.generatedAt || 0);
    metricsSnapshot = { ...metricsSnapshot, stale: age > SNAPSHOT_MAX_AGE_MS };
    console.warn('[metrics] refresh failed:', (e as Error)?.message || e);
  }
}

refreshMetricsSnapshot();
setInterval(refreshMetricsSnapshot, SNAPSHOT_INTERVAL_MS).unref?.();

const SPEC_V1 = process.env.SPEC_V1 === '1';

app.get('/metrics-summary', (_req, res) => {
  try {
    if (SPEC_V1 && typeof getSpecV1Summary === 'function') {
      const base = getSpecV1Summary();
      // attach scheduler telemetry for ACTIVE sources (union with base)
      const ACTIVE = resolveActive?.(process.env.INGEST_SOURCES) || [];
      const snap = getSchedulerSnapshot?.() || {} as any;
      const schedMap: Record<string, any> = Object.fromEntries(
        ACTIVE.map((k: string) => [k, {
          ticks_total: Number(snap[k]?.ticks_total ?? 0),
          last_tick_at: snap[k]?.last_tick_at ? Number(snap[k].last_tick_at) : undefined,
          last_http_status: snap[k]?.last_http_status ? Number(snap[k].last_http_status) : undefined,
          consecutive_failures: Number(snap[k]?.consecutive_failures ?? 0),
          last_error: snap[k]?.last_error ? String(snap[k].last_error) : undefined,
        }])
      );
      const by_source: Record<string, any> = {};
      const keys = new Set<string>([...Object.keys(base.by_source || {}), ...ACTIVE]);
      for (const k of keys) {
        const v = (base.by_source as any)?.[k] || { samples: 0, publisher_p50_ms: 0, publisher_p90_ms: 0, pulse_p50_ms: 0, pulse_p90_ms: 0, last_sample_at: 0, timestamp_source: 'unknown', window_ms: (base as any)?.window_ms };
        by_source[k] = { ...(v as any), scheduler: schedMap[k] || { ticks_total: 0, consecutive_failures: 0 } };
      }
      return res.status(200).json({ n_total: base.n_total, by_source });
    }

    // Legacy stable summary
    const raw = (typeof getLatencySummary === 'function' ? getLatencySummary() : {}) as any;
    const per = raw?.per_source || raw?.perSource || raw || {};
    const by_source: Record<string, any> = {};
    let n_total = 0;
    for (const [k, v] of Object.entries(per)) {
      const samples = Number((v as any)?.n ?? (v as any)?.samples ?? 0) || 0;
      const p50 = Number((v as any)?.p50_ms ?? 0) || 0;
      const p90 = Number((v as any)?.p90_ms ?? 0) || 0;
      const last = Number((v as any)?.last_sample_at ?? 0) || 0;
      by_source[k] = { samples, p50_ms: p50, p90_ms: p90, last_sample_at: last };
      n_total += samples;
    }
    res.status(200).json({ n_total, by_source });
  } catch (e) {
    console.error('[metrics] summary error', e);
    res.status(200).type('application/json').send(JSON.stringify({ fallback: true, error: String(e) }));
  }
});

// --- Event loop lag monitor (diagnostic) ---
setInterval(() => {
  const t0 = process.hrtime.bigint();
  setImmediate(() => {
    const lagMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (lagMs > 200) console.warn('[loop-lag]', Math.round(lagMs), 'ms');
  });
}, 1000).unref?.();

// Global error handler to ensure JSON 500s instead of proxy 502s
app.use((err: any, _req: any, res: any, _next: any) => {
  try { console.error('[express] unhandled', err); } catch {}
  if (!res.headersSent) {
    res.status(500).type('application/json').send(JSON.stringify({ error: 'internal' }));
  }
});

// Listen first, then start ingest asynchronously
app.listen(PORT, () => {
  console.log('[listen] port', PORT);
  setImmediate(() => {
    console.log(`[sched] ${JOBS_DISABLED ? 'disabled' : 'enabled'} (DISABLE_JOBS=${process.env.DISABLE_JOBS ?? '<unset>'})`);
    try {
      if (!JOBS_DISABLED) {
        // Phase 1: Start what ENV specified (RSS expected)
        startIngests();
        // Canary-only fastlane
        try { startFastlaneIfEnabled(app); } catch {}
        // Phase 2: staged enables (idempotent, no ENV mutation)
        setTimeout(() => { try { enableAdapter('nyse_notices'); } catch {} }, 120_000).unref?.();
        setTimeout(() => { try { enableAdapter('cme_notices'); } catch {} }, 180_000).unref?.();
        setTimeout(() => { try { enableAdapter('nasdaq_halts'); } catch {} }, 240_000).unref?.();
      } else {
        // leave ingest off; nothing else to do
      }
    } catch (e) {
      console.error('[sched] startIngests threw', e);
    }
  });
});

// Runtime diagnostics: capture termination and error signals for root-cause analysis
process.on('SIGTERM', () => console.error('[proc] SIGTERM'));
process.on('SIGINT',  () => console.error('[proc] SIGINT'));
process.on('beforeExit', (code) => console.error('[proc] beforeExit', code));
process.on('exit',      (code) => console.error('[proc] exit', code));
process.on('uncaughtException', (err) => console.error('[proc] uncaughtException', (err as any)?.stack || String(err)));
process.on('unhandledRejection', (r) => console.error('[proc] unhandledRejection', r as any));

// mem-watch removed from runtime



