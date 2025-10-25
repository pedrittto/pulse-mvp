import express from "express";
import cors from "cors";
import { registerSSE } from "./sse.js";
import { reportTick } from "./ingest/telemetry.js";

// Boot banners for visibility
console.log('[boot] ingest build OK :: ' + new Date().toISOString());
console.log('[boot] ingest cold-shell :: ' + new Date().toISOString());

// Global error handlers (early visibility)
process.on('unhandledRejection', (e: any) => console.error('[boot] unhandledRejection', e));
process.on('uncaughtException',  (e: any) => console.error('[boot] uncaughtException',  e));

// Minimal Express app and cheap endpoints only
const app = express();
app.use(cors());
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

// Lazy metrics endpoint
app.get('/metrics-summary', async (_req, res) => {
  try {
    const mod: any = await import('./ingest/telemetry.js');
    const getSummary = (mod as any)?.getMetricsSummary ?? (mod as any)?.default?.getMetricsSummary;
    if (typeof getSummary === 'function') {
      const data = await getSummary();
      return res.json(data);
    }
  } catch (e) {
    try { console.warn('[metrics] fallback response', e as any); } catch {}
  }
  return res.json({ n_total: 0, by_source: {}, backoffFailMs: 30000 });
});

// Register SSE routes (enabled or disabled variant based on env)
registerSSE(app);

// Boot diagnostic
console.log('[boot] routes wired: tick + metrics + sse');

// Bind HTTP FIRST so Cloud Run sees the service alive
const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log('[boot] http listening', { port, host });
  
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

    // Start single global ingest scheduler (no fan-out)
    try {
      const sched: any = await import('./ingest/index.js');
      const start = (sched as any)?.startIngestScheduler ?? (sched as any)?.default?.startIngestScheduler;
      if (typeof start === 'function') { start(); console.log('[boot] ingest scheduler started'); }
      else { console.warn('[boot] ingest scheduler start not found'); }
    } catch (err) {
      console.error('[boot] failed to start ingest scheduler', err);
    }
  })();
});



