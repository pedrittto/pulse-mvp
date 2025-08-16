import express from 'express';
import { publishStub, enrichItem } from '../ingest/breakingIngest';
import { getSourceLatencyStats } from '../ingest/breakingIngest';
import { breakingScheduler } from '../ingest/breakingScheduler';

const router = express.Router();

// Middleware to check admin token
const requireAdminToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.ADMIN_QUICKPOST_TOKEN;
  
  if (!expectedToken) {
    console.error('[admin] ADMIN_QUICKPOST_TOKEN not configured');
    return res.status(500).json({
      error: 'Admin token not configured',
      code: 'ADMIN_TOKEN_MISSING'
    });
  }
  
  if (token !== expectedToken) {
    console.warn('[admin] Invalid admin token attempt');
    return res.status(401).json({
      error: 'Invalid admin token',
      code: 'INVALID_TOKEN'
    });
  }
  
  next();
};

// Quick post endpoint for manual breaking news insertion
router.post('/quick-post', requireAdminToken, async (req, res) => {
  try {
    const { title, source, url, tags } = req.body;
    
    // Validate required fields
    if (!title || !source || !url) {
      return res.status(400).json({
        error: 'Missing required fields: title, source, url',
        code: 'MISSING_FIELDS'
      });
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid URL format',
        code: 'INVALID_URL'
      });
    }
    
    console.log(`[admin][quick-post] Manual post: ${title.substring(0, 60)}...`);
    
    // Publish stub immediately
    const result = await publishStub({
      title,
      source,
      url,
      description: tags ? `Tags: ${tags.join(', ')}` : undefined
    });
    
    if (!result.success) {
      if (result.error === 'duplicate') {
        return res.status(409).json({
          error: 'Article already exists',
          code: 'DUPLICATE_ARTICLE',
          id: result.id
        });
      }
      
      return res.status(500).json({
        error: 'Failed to publish stub',
        code: 'PUBLISH_FAILED',
        details: result.error
      });
    }
    
    // Schedule enrichment asynchronously
    setTimeout(async () => {
      await enrichItem(result.id);
    }, 1000);
    
    res.json({
      success: true,
      id: result.id,
      message: 'Article published successfully'
    });
    
  } catch (error) {
    console.error('[admin][quick-post] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Latency metrics endpoint
router.get('/latency', requireAdminToken, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    
    // Get all breaking sources from scheduler
    const status = breakingScheduler.getStatus();
    const sources = status.sources.map(s => s.name);
    
    // Get latency stats for each source
    const latencyStats: Record<string, any> = {};
    
    for (const source of sources) {
      const stats = await getSourceLatencyStats(source, hours);
      latencyStats[source] = {
        p50_ms: stats.p50,
        p90_ms: stats.p90,
        count: stats.count,
        avg_publish_ms: stats.avg_publish_ms
      };
    }
    
    // Calculate overall stats
    const allStats = Object.values(latencyStats);
    const totalCount = allStats.reduce((sum, stat) => sum + stat.count, 0);
    const avgP50 = allStats.length > 0 ? 
      allStats.reduce((sum, stat) => sum + stat.p50_ms, 0) / allStats.length : 0;
    const avgP90 = allStats.length > 0 ? 
      allStats.reduce((sum, stat) => sum + stat.p90_ms, 0) / allStats.length : 0;
    
    res.json({
      success: true,
      hours,
      overall: {
        total_articles: totalCount,
        avg_p50_ms: Math.round(avgP50),
        avg_p90_ms: Math.round(avgP90)
      },
      sources: latencyStats
    });
    
  } catch (error) {
    console.error('[admin][latency] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Breaking scheduler status endpoint
router.get('/breaking-status', requireAdminToken, async (req, res) => {
  try {
    const status = breakingScheduler.getStatus();
    
    res.json({
      success: true,
      breaking_mode_enabled: process.env.BREAKING_MODE === '1',
      scheduler: status
    });
    
  } catch (error) {
    console.error('[admin][breaking-status] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Control breaking scheduler
router.post('/breaking-control', requireAdminToken, async (req, res) => {
  try {
    const { action } = req.body;
    
    if (action === 'start') {
      breakingScheduler.start();
      res.json({
        success: true,
        message: 'Breaking scheduler started'
      });
    } else if (action === 'stop') {
      breakingScheduler.stop();
      res.json({
        success: true,
        message: 'Breaking scheduler stopped'
      });
    } else {
      res.status(400).json({
        error: 'Invalid action. Use "start" or "stop"',
        code: 'INVALID_ACTION'
      });
    }
    
  } catch (error) {
    console.error('[admin][breaking-control] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

export { router as adminRoutes };
