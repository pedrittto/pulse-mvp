import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
// import { config } from './config/env';
import apiRoutes from './api';
import { startRSSIngestion } from './cron';
import { breakingScheduler } from './ingest/breakingScheduler';
import { getCurrentSourceStats } from './ingest/breakingIngest';
import { logAdminDiagnostics } from './middleware/admin';

// Environment getter functions
const getPort = () => Number(process.env.PORT) || 4000;
const getRateLimitPerMinute = () => parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10);
const getAllowedOrigins = () => (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const getNodeEnv = () => process.env.NODE_ENV;
const getBreakingMode = () => process.env.BREAKING_MODE;
const getVerificationMode = () => process.env.VERIFICATION_MODE;
const getImpactMode = () => process.env.IMPACT_MODE;
const getConfidenceMode = () => process.env.CONFIDENCE_MODE;
const getSourceRequestTimeoutMs = () => process.env.SOURCE_REQUEST_TIMEOUT_MS;
const getFirebaseProjectId = () => process.env.FIREBASE_PROJECT_ID;
const getBreakingSourcesJson = () => process.env.BREAKING_SOURCES_JSON;
const getEventWindowsJson = () => process.env.EVENT_WINDOWS_JSON;

const app = express();
const port = getPort();

// Export app for testing (without starting the server)
export { app };

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: getRateLimitPerMinute(),
  message: {
    error: {
      message: 'Too many requests from this IP, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED'
    }
  }
});

// CORS configuration
const allowed = getAllowedOrigins();

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
  const breakingMode = getBreakingMode() === '1';
  
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
      NODE_ENV: getNodeEnv(),
      BREAKING_MODE: getBreakingMode(),
      VERIFICATION_MODE: getVerificationMode(),
      IMPACT_MODE: getImpactMode(),
      CONFIDENCE_MODE: getConfidenceMode(),
      SOURCE_REQUEST_TIMEOUT_MS: getSourceRequestTimeoutMs(),
      // Redact sensitive values
      FIREBASE_PROJECT_ID: getFirebaseProjectId() ? '***' : undefined,
      ADMIN_TOKEN: process.env.ADMIN_TOKEN ? '***' : undefined,
      ADMIN_ALLOW_PURGE: process.env.ADMIN_ALLOW_PURGE === '1'
    },
    config: {
      breakingMode: getBreakingMode() === '1',
      verificationMode: getVerificationMode() || 'v1',
      impactMode: getImpactMode() || 'v3',
      breakingSourcesJson: getBreakingSourcesJson() ? 'configured' : 'not configured',
      eventWindowsJson: getEventWindowsJson() ? 'configured' : 'not configured'
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
    if (getBreakingMode() === '1') {
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
}
