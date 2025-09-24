import express from "express";
import cors from "cors";

// Boot banners for visibility
console.log('[boot] ingest build OK :: ' + new Date().toISOString());
console.log('[boot] ingest cold-shell :: ' + new Date().toISOString());

// Global error handlers (early visibility)
process.on('unhandledRejection', (e: any) => console.error('[boot] unhandledRejection', e));
process.on('uncaughtException',  (e: any) => console.error('[boot] uncaughtException',  e));

// Minimal Express app and cheap endpoints only
const app = express();
app.use(cors());

// Health endpoint
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== Tick-by-request implementation =====
let tickRunning = false;
function log(level: 'info' | 'warn', msg: string, extra: Record<string, unknown> = {}) {
  const line = `[tick] ${msg} ${JSON.stringify(extra)}`;
  if (level === 'warn') { try { console.warn(line); } catch {} } else { try { console.info(line); } catch {} }
}

async function runOneCycle(): Promise<{ n: number; t_ms: number }> {
  const startedAt = Date.now();
  // Lazy import ingest orchestrator to avoid side-effects on cold boot
  const ingest: any = await import('./ingest/index.js');
  const sources: string[] = Array.isArray(ingest.resolveActive?.(process.env.INGEST_SOURCES))
    ? ingest.resolveActive(process.env.INGEST_SOURCES)
    : String(process.env.INGEST_SOURCES || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

  let n = 0;
  for (const src of sources) {
    const t0 = Date.now();
    try {
      if (typeof ingest.runProbeOnce === 'function') {
        await ingest.runProbeOnce(src);
      } else if (ingest && ingest[src] && typeof ingest[src].probeOnce === 'function') {
        await ingest[src].probeOnce();
      }
      n++;
      log('info', 'source_ok', { src, ms: Date.now() - t0 });
    } catch (e: any) {
      log('warn', 'source_err', { src, ms: Date.now() - t0, err: String(e?.message || e) });
    }
  }

  const t_ms = Date.now() - startedAt;
  log('info', 'cycle_done', { n, ms: t_ms });
  return { n, t_ms };
}

function requireTickKey(req: any, res: any, next: any) {
  const key = process.env.TICK_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'tick_key_not_set' });
  if (req.header('X-Tick-Key') !== key) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.post('/_internal/tick', requireTickKey, async (req, res) => {
  if (tickRunning) return res.status(429).json({ ok: false, error: 'tick_in_progress' });
  tickRunning = true;
  try {
    const out = await runOneCycle();
    return res.json({ ok: true, ...out });
  } catch (e: any) {
    log('warn', 'cycle_err', { err: String(e?.message || e) });
    return res.status(500).json({ ok: false, error: 'cycle_failed' });
  } finally {
    tickRunning = false;
  }
});

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

// Bind HTTP FIRST so Cloud Run sees the service alive
const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log('[boot] http listening', { port, host });
  
  // Optional: local-only, safe in prod
  import('dotenv/config').catch(() => {});

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

    // Start scheduler (dynamic import)
    try {
      const reg: any = await import('./ingest/registry.js');
      const start = (reg as any)?.startIngests ?? (reg as any)?.default?.startIngests;
      if (typeof start === 'function') {
        try { (start as any).length ? (start as any)(config) : (start as any)(); } catch { (start as any)(); }
        console.log('[boot] startIngests() launched');
      } else {
        console.warn('[boot] startIngests not found on module');
      }
    } catch (err) {
      console.error('[boot] failed to start ingests', err);
    }
  })();
});



