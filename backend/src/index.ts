import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import apiRoutes from './api';
import { startRSSIngestion } from './cron';

const app = express();
const port = process.env.PORT || 4000;

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

// Middleware
app.use(limiter);
app.use(morgan('combined'));
app.use(cors({
  origin: config.allowedOrigins[0] === '*' ? true : config.allowedOrigins
}));
app.use(express.json());

// Routes
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/', apiRoutes);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      code: 'NOT_FOUND'
    }
  });
});

// Start server
app.listen(port, () => {
  const cronStatus = process.env.CRON_SCHEDULE ? 'on' : 'off';
  console.log(`Started backend on :${port} | cron=${cronStatus}`);
  
  // Start RSS ingestion cron job
  startRSSIngestion();
});
