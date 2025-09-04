import "dotenv/config";import express from "express";
import cors from "cors";
import { registerSSE, getSSEStats, broadcastBreaking } from "./sse.js";
import { startIngests, getIngestDebug } from "./ingest/index.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

// Safe fallback: keep v2 shape even if metrics module is missing
let getLatencySummary: () => Record<string, unknown> = () => ({} as Record<string, unknown>);
try {
  // Will resolve to dist/metrics/latency.js at runtime after build
  const mod = require("./metrics/latency.js");
  if (mod && typeof mod.getLatencySummary === "function") {
    console.log('[metrics] using REAL latency summary');
    getLatencySummary = mod.getLatencySummary as () => Record<string, unknown>;
  } else {
    console.log('[metrics] latency module missing export; using FALLBACK');
  }
} catch (e) {
  console.log('[metrics] using FALLBACK latency summary:', (e as Error).message);
}

const app = express();
const JOBS_DISABLED = /^(1|true)$/i.test(process.env.DISABLE_JOBS ?? "");
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
const PORT = Number(process.env.PORT || 4000);
const DISABLE_JOBS = process.env.DISABLE_JOBS === "1";

// Build allow-list from env
const ALLOWED = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Fast-path health probes before any other middleware
app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.head('/health', (_req, res) => res.status(200).end());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

registerSSE(app);

if (DEBUG_INGEST) {
  const sources = (process.env.INGEST_SOURCES || "businesswire")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
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

app.get('/metrics-summary', (_req, res) => {
  try {
    const data = typeof getLatencySummary === 'function' ? getLatencySummary() : {};
    res.status(200).type('application/json').send(JSON.stringify(data ?? {}));
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
    if (String(process.env.DISABLE_JOBS) === '1') {
      console.warn('[sched] disabled (DISABLE_JOBS=1)');
      return;
    }
    try {
      startIngests();
    } catch (e) {
      console.error('[sched] startIngests threw', e);
    }
  });
});

// mem-watch removed from runtime



