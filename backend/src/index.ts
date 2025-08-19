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

const app = express();
const port = getConfig().port;

// Export app for testing (without starting the server)
export { app };

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

// Routes
app.get('/health', (_req, res) => {
  const breakingStatus = breakingScheduler.getStatus();
  const sourceStats = getCurrentSourceStats();
  
  // Get breaking mode status
  const breakingMode = getConfig().breakingMode;
  
  // Build breaking snapshot
  const breakingSnapshot = {
    mode: breakingMode ? 'on' : 'off',
    version: '1.0.0', // TODO: Get from package.json or git
    sources: breakingStatus.sources.map(source => {
      const stats = sourceStats[source.name] || { fetched: 0, new: 0, duplicate: 0, errors: 0 };
      return {
        name: source.name,
        intervalMs: source.interval_ms,
        lastFetchAt: source.lastFetchAt,
        lastOkAt: source.lastOkAt,
        newInLast1m: stats.new,
        duplicatesInLast1m: stats.duplicate,
        errorsInLast5m: stats.errors,
        inEventWindow: source.inEventWindow,
        backoffState: source.backoffState ? {
          currentInterval: source.backoffState.currentInterval,
          attempt: source.backoffState.attempt,
          lastError: source.backoffState.lastError
        } : null
      };
    })
  };

  const minMax = breakingScheduler.getMinMaxNextPollMs();
  res.json({ 
    ok: true,
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.0.0',
    node: process.version,
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: getConfig().nodeEnv,
      BREAKING_MODE: getConfig().breakingMode ? '1' : '0',
      VERIFICATION_MODE: getConfig().verificationMode,
      IMPACT_MODE: getConfig().impactMode,
      // confidence numeric mode removed
      SOURCE_REQUEST_TIMEOUT_MS: getConfig().sourceRequestTimeoutMs,
      // Redact sensitive values
      FIREBASE_PROJECT_ID: getConfig().firebaseProjectId ? '***' : undefined,
      ADMIN_TOKEN: getConfig().adminToken ? '***' : undefined,
      ADMIN_ALLOW_PURGE: getConfig().adminAllowPurge
    },
    config: {
      breakingMode: getConfig().breakingMode,
      verificationMode: getConfig().verificationMode,
      impactMode: getConfig().impactMode,
      breakingSourcesJson: getConfig().breakingSourcesJson ? 'configured' : 'not configured',
      eventWindowsJson: getConfig().eventWindowsJson ? 'configured' : 'not configured'
    },
    breaking: breakingSnapshot,
    schedulers: {
      adaptive: {
        enabled: true,
        running: breakingScheduler.getStatus().isRunning,
        sources: breakingScheduler.getStatus().sources.length,
        min_next_poll_ms: minMax.min,
        max_next_poll_ms: minMax.max,
        state_persisted: false
      },
      breaking: {
        enabled: false,
        running: false,
        sources: 0,
        min_next_poll_ms: null,
        max_next_poll_ms: null,
        state_persisted: false
      }
    },
    sse: { clients: (process.env.SSE_ENABLED === '1') ? require('./realtime/sse').sseHub.getStats().clients : 0 },
    breaking_demoted_sources: breakingScheduler.getDemotedSources(),
    latency_alerts_active: breakingScheduler.isLatencyAlertActive()
  });
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
    
    // Start RSS ingestion cron job
    startRSSIngestion();
    // Start control synthetic feed for dev/CI only
    startControlFeed();
    if (process.env.SOURCE_SET === 'crypto_v1') {
      console.log('[server] SOURCE_SET=crypto_v1 enabled. AUDIT_MODE=%s', process.env.AUDIT_MODE === '1' ? 'ON' : 'OFF');
    }
    
    // Start breaking news scheduler if enabled
    if (getConfig().breakingMode) {
      console.log('[breaking] Starting breaking news scheduler');
      breakingScheduler.start();
    } else {
      console.log('[breaking] Breaking mode disabled (set BREAKING_MODE=1 to enable)');
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
  process.on('SIGINT', () => { try { sseHub.shutdown(); } catch {} });
}
