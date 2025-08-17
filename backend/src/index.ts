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

  res.json({ 
    ok: true,
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
    breaking: breakingSnapshot
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
  const server = app.listen(port, () => {
    console.log(`[server] listening on ${port}`);
    
    // Log admin diagnostics
    logAdminDiagnostics();
    
    // Start RSS ingestion cron job
    startRSSIngestion();
    
    // Start breaking news scheduler if enabled
    if (getConfig().breakingMode) {
      console.log('[breaking] Starting breaking news scheduler');
      breakingScheduler.start();
    } else {
      console.log('[breaking] Breaking mode disabled (set BREAKING_MODE=1 to enable)');
    }
  });

  // Handle port conflicts
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${port} already in use. Is another server running?`);
      console.error(`[server] To kill the process using port ${port}, run: npm run kill:4000`);
      process.exit(1);
    } else {
      console.error('[server] Failed to start server:', err);
      process.exit(1);
    }
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
}
