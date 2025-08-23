import './http/transport';
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { getConfig } from './config/env';
import apiRoutes from './api';
import { startRSSIngestion, stopRSSIngestion } from './cron';
import { breakingScheduler } from './ingest/breakingScheduler';
import { getCurrentSourceStats, cleanupBreakingIngest } from './ingest/breakingIngest';
import { logAdminDiagnostics } from './middleware/admin';
import { sseHub } from './realtime/sse';
import { startControlFeed, stopControlFeed } from './dev/controlFeed';
import { initHttpValidators } from './ingest/rss';
import { runWarmupIfEnabled } from './bootstrap/warmup';
import { flushAndClose as flushBulkWriter } from './lib/bulkWriter';
import { startWatchdog, getWatchdogState } from './watchdog/sloWatchdog';
import { startRuntimeMonitor, getOpsSnapshot } from './ops/runtimeMonitor';
import { startSocialLane } from './social/scheduler';
import { startPollController } from './ingest/pollController';
import { getReady, isReady, setReady } from './ops/ready';
import { getDb } from './lib/firestore';

const app = express();
const port = getConfig().port;

// Export app for testing (without starting the server)
export { app };

// Lightweight request logger
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      const dt = Date.now() - t0;
      console.log(`[http] ${req.method} ${req.url} -> ${res.statusCode} ${dt}ms`);
    } catch {}
  });
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: getConfig().rateLimitPerMinute,
  message: {
    error: {
      message: 'Too many requests from this IP, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED'
    }
  }
});

// CORS configuration
const allowed = getConfig().allowedOrigins;

// CORS middleware
app.use(cors({
  origin: function (origin, cb) {
    // allow no-origin (curl/health) and exact matches
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Token'],
  credentials: false,
  maxAge: 86400,
}));

// Important: handle OPTIONS early
app.options('*', cors({
  origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Token'],
  credentials: false,
  maxAge: 86400,
}));

// Middleware
app.use(limiter);
app.use(morgan('combined'));
app.use(express.json());

// Start runtime monitor early
startRuntimeMonitor();
// Mark Firestore readiness once first listCollections succeeds (best-effort)
try { getDb().listCollections().then(()=> setReady('firestore', true)).catch(()=>{}); } catch {}

// Routes
app.get('/health', (_req, res) => {
  try {
    const data: any = { ok: true, ts: new Date().toISOString() };
    try {
      const ready = require('./ops/ready')?.getReady?.();
      if (ready) data.ready = ready;
    } catch {}
    try {
      const sseStats = require('./realtime/sse')?.sseHub?.getStats?.();
      if (sseStats) data.sse = { clients: sseStats.clients, seq: sseStats.seq };
    } catch {}
    try {
      const hb = (require('./ingest/breakingScheduler').breakingScheduler)?.getHeartbeat?.();
      if (hb) data.scheduler = hb;
    } catch {}
    try {
      const cfg = require('./config/rssFeeds');
      const list = (cfg?.rssFeeds || []).map((s: any) => ({ name: s.name, enabled: s.enabled !== false, fastlane: s.fastlane !== false }));
      data.sources = list;
    } catch {}
    res.status(200).json(data);
  } catch {
    res.status(200).json({ ok: true, ts: new Date().toISOString() });
  }
});
app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));

// Liveness and Readiness probes
app.get('/livez', (_req, res) => { res.status(200).json({ ok: true }); });
app.get('/readyz', (_req, res) => {
  if (isReady()) return res.status(200).json({ ready: true });
  const s = getReady();
  const reason = Object.entries(s).filter(([k,v])=>!v && (k!=='warmupDone' || process.env.WARMUP_TIER1==='1')).map(([k])=>k).join(',') || 'initializing';
  return res.status(503).json({ ready: false, reason, state: s });
});

// CORS test endpoint
app.get('/cors-test', (_req, res) => {
  res.json({ ok: true });
});

app.use('/', apiRoutes);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }
  });
});

// 404 handler
app.use('*', (_req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      code: 'NOT_FOUND'
    }
  });
});

// Start server only if this is the main module (not when imported for testing)
if (require.main === module) {
  // Allow forcing SSE on in non-production via an env override for verification
  if (process.env.FORCE_SSE === '1') {
    process.env.SSE_ENABLED = '1';
  }
  // Global error handlers to avoid silent failures
  process.on('unhandledRejection', (reason: any) => {
    console.error('[server] UNHANDLED_REJECTION', reason instanceof Error ? reason.stack || reason.message : reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err: any) => {
    console.error('[server] UNCAUGHT_EXCEPTION', err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });

  const host = '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`[boot][listen] host=${host} port=${port} env=${process.env.NODE_ENV || ''} pid=${process.pid}`);
    console.log('[flags]', {
      adaptive_default: true,
      transport_v2: process.env.RSS_TRANSPORT_V2 !== '0',
      sse: process.env.SSE_ENABLED === '1'
    });
    
    // Log admin diagnostics
    logAdminDiagnostics();
    
    // Seed HTTP validators from persistence before starting ingestion
    (async () => { try { await initHttpValidators(); await runWarmupIfEnabled(); } catch {} })();
    // Start RSS ingestion cron job
    startRSSIngestion();
    // Start control synthetic feed for dev/CI only
    startControlFeed();
    if (process.env.SOURCE_SET === 'crypto_v1') {
      console.log('[server] SOURCE_SET=crypto_v1 enabled. AUDIT_MODE=%s', process.env.AUDIT_MODE === '1' ? 'ON' : 'OFF');
    }
    
    // Start breaking news scheduler (unless explicitly disabled)
    const DISABLE_INGEST = process.env.DISABLE_INGEST === '1';
    console.log('[boot] flags', {
      FASTLANE_ENABLED: process.env.FASTLANE_ENABLED,
      RSS_TRANSPORT_V2: process.env.RSS_TRANSPORT_V2,
      USE_FAKE_FIRESTORE: process.env.USE_FAKE_FIRESTORE,
      WARMUP_TIER1: process.env.WARMUP_TIER1
    });
    if (!DISABLE_INGEST) {
      console.log('[boot] starting breaking scheduler…');
      breakingScheduler.start();
      console.log('[boot] breaking scheduler started. sources=', (breakingScheduler as any).getStatus?.().sources?.length ?? 'n/a');
    } else {
      console.log('[boot] DISABLE_INGEST=1 → scheduler not started');
    }
    // Internal readiness probe to /health
    const readyTimeout = setTimeout(() => {
      console.error('[boot][ready][fail] timeout waiting for /health');
      process.exit(1);
    }, 3000);
    (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          console.log('[boot][ready]');
          clearTimeout(readyTimeout);
          // Mark SSE ready then start social lane (if enabled)
          try { setReady('sse', true); } catch {}
          try { await startSocialLane(); } catch (e) { console.warn('[social] failed to start', (e as any)?.message || String(e)); }
          // Start adaptive poll controller if enabled
          if (String(process.env.CTRL_ENABLED || '0') === '1') {
            try {
              const ctl = startPollController(async () => {
                // Assemble per-source p50 + http 200/304 and host mapping from rssFeeds
                const stats: any = {};
                try {
                  const db = require('./lib/firestore').getDb();
                  const windowMin = Math.max(5, parseInt(process.env.CTRL_EVAL_WINDOW_MIN || '15', 10));
                  const sinceIso = new Date(Date.now() - windowMin*60*1000).toISOString();
                  const snap = await db.collection('latency_metrics').where('timestamp','>=', sinceIso).get();
                  const m: Record<string, number[]> = {};
                  if (snap && Array.isArray((snap as any).docs)) {
                    (snap as any).docs.forEach((d:any)=>{ const s=d.data()?.source; const t=d.data()?.t_publish_ms; if (typeof s==='string' && typeof t==='number' && t>=0) (m[s] ||= []).push(t); });
                  } else if (snap && typeof (snap as any).forEach==='function') {
                    (snap as any).forEach((d:any)=>{ const s=d.data()?.source; const t=d.data()?.t_publish_ms; if (typeof s==='string' && typeof t==='number' && t>=0) (m[s] ||= []).push(t); });
                  }
                  const counters = require('./ingest/rss').getHttpConditionalCounters?.() || {};
                  const feeds = require('./config/rssFeeds').rssFeeds || [];
                  const hostMap: Record<string,string> = {}; feeds.forEach((f:any)=>{ try { hostMap[f.name] = new URL(f.url).host; } catch {} });
                  const p50 = (arr:number[]) => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : null;
                  for (const [name, arr] of Object.entries(m)) {
                    const c = counters[name] || { c200:0, c304:0 };
                    stats[name] = { p50: p50(arr as number[]), samples: (arr as number[]).length, http200: c.c200||0, http304: c.c304||0, host: hostMap[name]||'unknown' };
                  }
                } catch {}
                return stats;
              }, (changes: Record<string, number>) => {
                try { (breakingScheduler as any).applyOverrides(changes); } catch {}
              });
              (app as any)._ctl = ctl;
            } catch (e) { console.warn('[controller] failed to start', (e as any)?.message || String(e)); }
          }
          // Start SLO watchdog if enabled
          if (process.env.WATCHDOG_ENABLED === '1') {
            try {
              const getKpi = async () => {
                const windowMin = Math.max(5, parseInt(process.env.WATCHDOG_WINDOW_MIN || '30', 10));
                try {
                  // Prefer in-process function via local fetch
                  const r = await fetch(`http://127.0.0.1:${port}/kpi-breaking?window_min=${windowMin}`, { headers: { 'cache-control': 'no-store' } });
                  const j = await r.json();
                  return j;
                } catch (e) {
                  throw e;
                }
              };
              const postAlert = async (payload: any) => {
                const url = process.env.WATCHDOG_WEBHOOK_URL;
                if (!url) return;
                try {
                  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                } catch (e) { console.warn('[watchdog] webhook post failed', (e as any)?.message || String(e)); }
              };
              startWatchdog(getKpi, postAlert);
              console.log('[watchdog] started');
            } catch (e) {
              console.warn('[watchdog] failed to start', (e as any)?.message || String(e));
            }
          }
        } else {
          console.error('[boot][ready][fail] status=' + res.status);
          clearTimeout(readyTimeout);
          process.exit(1);
        }
      } catch (e: any) {
        console.error('[boot][ready][fail] error=' + (e?.message || String(e)));
        clearTimeout(readyTimeout);
        process.exit(1);
      }
    })();
  });

  // Handle port errors
  server.on('error', (err: any) => {
    const code = err && err.code ? String(err.code) : 'UNKNOWN';
    console.error('[boot][listen][error]', { code, message: err?.message, stack: err?.stack });
    process.exit(1);
  });

  // Graceful shutdown handling
  const gracefulShutdown = (signal: string) => {
    console.log(`[server] Received ${signal}, starting graceful shutdown...`);
    
    // Stop accepting new connections
    server.close(() => {
      console.log('[server] HTTP server closed');
      
      // Cleanup all intervals and cron jobs
      cleanupBreakingIngest();
      stopRSSIngestion();
      stopControlFeed();
      
      if (getConfig().breakingMode) {
        breakingScheduler.stop();
      }
      
      try { require('./realtime/sse').sseHub.stopAccepting(); } catch {}
      try {
        const ms = parseInt(process.env.DRAIN_SSE_CLOSE_MS || '2000', 10);
        require('./realtime/sse').sseHub.announceAndCloseAll(ms);
      } catch {}
      try { const { flushAndClose } = require('./lib/bulkWriter'); flushAndClose().catch(()=>{}); } catch {}
      
      console.log('[server] Graceful shutdown completed');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('[server] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  // Register shutdown handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGTERM', () => { try { sseHub.shutdown(); } catch {} });
  process.on('SIGINT', async () => { try { await flushBulkWriter(); } catch {} });
  process.on('SIGTERM', async () => { try { await flushBulkWriter(); } catch {} });
  process.on('SIGINT', () => { try { sseHub.shutdown(); } catch {} });
}
