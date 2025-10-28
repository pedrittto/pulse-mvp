import { createRequire } from "module";
const require = createRequire(import.meta.url);
const express = require("express");
const cors = require("cors");
import { registerSSE } from "./sse.js";
import { reportTick } from "./ingest/telemetry.js";
import { setupPersistence } from "./persist/firestoreWriter.js";
import { Firestore } from "@google-cloud/firestore";
import { registerAfterEmit } from "./core/emit.js";
import { recordItemMetrics, purgeOldMetrics, getLatencySummary, getCounts1h } from "./metrics/latency.js";
import { clientCount } from "./sse.js";
import { startCentralScheduler } from "./ingest/scheduler.js";

// Boot banners for visibility
console.log('[boot] ingest build OK :: ' + new Date().toISOString());
console.log('[boot] ingest cold-shell :: ' + new Date().toISOString());

// Global error handlers (early visibility)
process.on('unhandledRejection', (e: any) => console.error('[boot] unhandledRejection', e));
process.on('uncaughtException',  (e: any) => console.error('[boot] uncaughtException',  e));

// Minimal Express app and cheap endpoints only
const app = express();

// CORS: strict allow-list with resume-safe defaults
const rawCorsEnv = String(process.env.CORS_ORIGIN || '').trim();
const allowedOrigins = (rawCorsEnv ? rawCorsEnv.split(',') : ['http://localhost:3000']).map(v => v.trim()).filter(Boolean);
if (!rawCorsEnv) {
  try { console.warn('[cors] CORS_ORIGIN not set — allowing http://localhost:3000 (dev)'); } catch {}
}

// Always indicate response varies by Origin
app.use((_req, res, next) => { res.append('Vary', 'Origin'); next(); });

function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // non-CORS requests
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || isOriginAllowed(origin)) return callback(null, true);
    return callback(null, false);
  },
};

// Preflight handling with same allow-list
app.options('/*', (req, res, next) => {
  const origin = String(req.header('Origin') || '');
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ error: 'CORS origin not allowed' });
  }
  return (cors as any)(corsOptions)(req, res, next);
});

// Gate disallowed origins early for all routes; do not emit ACAO
app.use((req, res, next) => {
  const origin = String(req.header('Origin') || '');
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ error: 'CORS origin not allowed' });
  }
  next();
});

// Apply CORS for allowed origins only
app.use(cors(corsOptions));

app.use(express.json());

// Health endpoint
app.get('/health', (_req, res) => res.json({ ok: true }));

// In-memory, tiny rate limiter for /debug/push (5/min per IP)
const __debugPushHits = new Map<string, number>();
function allowDebugPush(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const key = ip || 'unknown';
  // store as packed counter with timestamp suffix to avoid arrays
  const prev = __debugPushHits.get(key) || 0;
  const prevTs = Math.floor(prev / 10);
  const prevCount = prev % 10;
  const within = prevTs > (now - windowMs);
  const count = within ? prevCount + 1 : 1;
  __debugPushHits.set(key, (now * 10) + Math.min(count, 9));
  // trim old entries occasionally (cheap)
  if (__debugPushHits.size > 200) {
    for (const [k, v] of __debugPushHits) { const ts = Math.floor(v / 10); if (ts < now - windowMs) __debugPushHits.delete(k); }
  }
  return count <= 5;
}

// Debug push: increments metrics-summary via telemetry path
app.post('/debug/push', (req, res) => {
  try {
    const expected = (process.env.DEBUG_PUSH_KEY || '63376d93b75b422ab4275a8e0e646ac7').trim();
    const got = String(req.header('x-debug-key') || '').trim();
    if (!expected || got !== expected) return res.status(401).json({ ok: false });
    const ip = String((req as any).ip || (req.headers['x-forwarded-for'] as any) || '').split(',')[0].trim();
    if (!allowDebugPush(ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const body = (req.body && typeof req.body === 'object') ? req.body as any : {};
    const payload = {
      type: String(body.type || 'breaking'),
      title: String(body.title || 'debug'),
      source: String(body.source || 'debug'),
      url: String(body.url || 'https://example.com'),
      published_at_ms: Number(body.published_at_ms || Date.now()),
    };
    // Reuse telemetry path used by scheduler: increments by_source.* and n_total
    try { reportTick(payload.source, { status: 200 }); } catch {}
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

// No direct tick endpoints; scheduling is handled by single ingest scheduler

// (metrics-summary route consolidated below)

// Register SSE routes (enabled or disabled variant based on env)
registerSSE(app);

// Persistence (cold path): non-blocking after-emit hook
setupPersistence();

// Metrics v2: record after-emit, purge timer
try { registerAfterEmit((item: any) => { try { recordItemMetrics(item); } catch {} }); } catch {}
const __purgeT = setInterval(() => { try { purgeOldMetrics(); } catch {} }, 5 * 60 * 1000);
(__purgeT as any)?.unref?.();

// Cold-read hydration: recent items from Firestore
app.get('/api/recent', async (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(String((req.query as any)?.limit || '50'), 10) || 50));
  if (process.env.PERSIST_ENABLED !== '1') return res.json({ items: [] });
  try {
    const fs = new Firestore();
    const col = fs.collection(process.env.FIRESTORE_COLLECTION_NAME || 'pulse_items_v1');
    let snap = await col.orderBy('publisher_seen_at_ms', 'desc').limit(limit).get();
    if (snap.empty) {
      snap = await col.orderBy('visible_at_ms', 'desc').limit(limit).get();
    }
    const items = snap.docs.map(d => d.data());
    return res.json({ items });
  } catch {
    return res.json({ items: [] });
  }
});

// Lightweight metrics
app.get('/metrics-lite', (_req, res) => {
  const counts = getCounts1h();
  const by_source: Record<string, any> = {};
  for (const [src, n] of Object.entries(counts)) by_source[src] = { count_1h: n as number };
  return res.json({ status: 'ok', sse_clients: clientCount(), by_source });
});

// Extend metrics-summary with latency percentiles (merge with existing behavior if needed)
app.get('/metrics-summary', async (_req, res) => {
  try {
    const mod: any = await import('./ingest/telemetry.js');
    const getSummary = (mod as any)?.getMetricsSummary ?? (mod as any)?.default?.getMetricsSummary;
    let base: any = {};
    if (typeof getSummary === 'function') {
      try { base = await getSummary(); } catch {}
    }
    const lat = getLatencySummary();
    // conservative merge
    return res.json({ ...base, window_minutes: lat.window_minutes, global: lat.global, by_source: { ...(base?.by_source || {}), ...(lat.by_source || {}) } });
  } catch (e) {
    const lat = getLatencySummary();
    return res.json({ window_minutes: lat.window_minutes, global: lat.global, by_source: lat.by_source });
  }
});

// Central scheduler (non-blocking; feature-flagged)
try { startCentralScheduler(); } catch {}

// Boot diagnostic
console.log('[boot] routes wired: tick + metrics + sse');

// Bind HTTP FIRST so Cloud Run sees the service alive
const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pulse-web] listening on ${PORT}`);
  
  // Optional: local-only, safe in prod
  import('dotenv/config').catch(() => {});

  // No internal probe/tick loop; a single global scheduler runs the adapters

  // Env gates (never exit; HTTP must stay alive)
  const jobsEnabled = /^(1|true)$/i.test((process.env.JOBS_ENABLED || '').trim());
  const allowProd   = (process.env.ALLOW_PROD_INGEST || '').trim() === '1';
  const isCloudRun  = !!process.env.K_SERVICE;

  if (!jobsEnabled) {
    console.log('[boot] HTTP-only: JOBS_ENABLED not set');
    return;
  }
  if (isCloudRun && !allowProd) {
    console.warn('[guard] HTTP-only: ALLOW_PROD_INGEST!=1 on Cloud Run');
    return;
  }

  // Disable legacy background loop if requested
  if ((process.env.ENABLE_BACKGROUND_LOOP || '').trim() === '0') {
    try { console.log('[sched] background disabled via ENABLE_BACKGROUND_LOOP=0'); } catch {}
    return;
  }

  (async () => {
    // Lazy config load; if it fails, stay HTTP-only
    let config: any | undefined;
    try {
      const cfgMod: any = await import('./config.js');
      const load = (cfgMod as any)?.loadConfig ?? (cfgMod as any)?.default?.loadConfig ?? (cfgMod as any)?.default;
      config = (typeof load === 'function') ? await load() : undefined;
      console.log('[boot] config loaded', { hasConfig: !!config });
    } catch (err) {
      console.error('[boot] config load failed -> HTTP-only', err);
      return;
    }

    // Start legacy ingest scheduler only if central is disabled
    if ((process.env.SCHED_CENTRAL || '1') !== '1') {
      try {
        const sched: any = await import('./ingest/index.js');
        const start = (sched as any)?.startIngestScheduler ?? (sched as any)?.default?.startIngestScheduler;
        if (typeof start === 'function') { start(); console.log('[boot] ingest scheduler started'); }
        else { console.warn('[boot] ingest scheduler start not found'); }
      } catch (err) {
        console.error('[boot] failed to start ingest scheduler', err);
      }
    }
  })();
});



