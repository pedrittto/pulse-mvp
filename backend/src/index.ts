if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
}
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
// import { config } from './config/env';
import apiRoutes from './api';
import { startRSSIngestion } from './cron';

const app = express();
const port = Number(process.env.PORT) || 4000;

// Export app for testing
export { app };

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10),
  message: {
    error: {
      message: 'Too many requests from this IP, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED'
    }
  }
});

// CORS configuration
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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
  res.json({ ok: true });
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
  app.listen(port, () => {
    console.log(`listening on ${port}`);
    
    // Start RSS ingestion cron job
    startRSSIngestion();
  });
}
