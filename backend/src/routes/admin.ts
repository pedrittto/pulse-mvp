import express from 'express';
import { publishStub, enrichItem, getSourceLatencyStats, getCurrentSourceStats, resetSourceStats } from '../ingest/breakingIngest';
import { breakingScheduler } from '../ingest/breakingScheduler';
import { getDb } from '../lib/firestore';
import { requireAdmin, requireAdminPurge } from '../middleware/admin';

const router = express.Router();

// Quick post endpoint for manual breaking news insertion
router.post('/quick-post', requireAdmin, async (req, res) => {
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
router.get('/latency', requireAdmin, async (req, res) => {
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

// Get breaking news status
router.get('/breaking-status', requireAdmin, async (_req, res) => {
  try {
    const stats = await getSourceLatencyStats('CNBC Breaking', 24);
    const breakingStatus = breakingScheduler.getStatus();
    const sourceStats = getCurrentSourceStats();
    
    res.json({
      breaking_mode_enabled: process.env.BREAKING_MODE === '1',
      scheduler_running: breakingScheduler.getStatus().isRunning,
      source_stats: stats,
      sources: breakingStatus.sources.map(source => {
        const stats = sourceStats[source.name] || { fetched: 0, new: 0, duplicate: 0, errors: 0 };
        return {
          name: source.name,
          interval_ms: source.interval_ms,
          nextPoll: 0, // Would need to track next poll time
          inEventWindow: source.inEventWindow,
          lastFetchAt: source.lastFetchAt,
          lastOkAt: source.lastOkAt,
          backoffState: source.backoffState,
          currentStats: {
            fetched: stats.fetched,
            new: stats.new,
            duplicate: stats.duplicate,
            errors: stats.errors
          }
        };
      })
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
router.post('/breaking-control', requireAdmin, async (req, res) => {
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

// Purge feed data (requires ADMIN_ALLOW_PURGE)
router.post('/purge-feed', requireAdminPurge, async (req, res) => {
  try {
    const { all, olderThanHours, confirm } = req.body;
    
    if (confirm !== 'PURGE') {
      return res.status(400).json({
        error: 'Must include confirm: "PURGE" to proceed',
        code: 'CONFIRMATION_REQUIRED'
      });
    }
    
    const db = getDb();
    const newsCollection = db.collection('news');
    
    let deleteCount = 0;
    
    if (all) {
      // Delete all documents
      const snapshot = await newsCollection.get();
      const batch = db.batch();
      
      snapshot.docs.forEach((doc: any) => {
        batch.delete(doc.ref);
        deleteCount++;
      });
      
      await batch.commit();
      
    } else if (olderThanHours && typeof olderThanHours === 'number') {
      // Delete documents older than specified hours
      const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
      
      const snapshot = await newsCollection
        .where('published_at', '<', cutoffTime.toISOString())
        .get();
      
      const batch = db.batch();
      
      snapshot.docs.forEach((doc: any) => {
        batch.delete(doc.ref);
        deleteCount++;
      });
      
      await batch.commit();
      
    } else {
      return res.status(400).json({
        error: 'Must specify either "all": true or "olderThanHours": number',
        code: 'INVALID_PARAMETERS'
      });
    }
    
    res.json({
      success: true,
      deleted: deleteCount,
      collections: ['news'],
      message: `Deleted ${deleteCount} documents from news collection`
    });
    
  } catch (error) {
    console.error('[admin][purge-feed] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Force re-ingest for specific sources
router.post('/reingest', requireAdmin, async (req, res) => {
  try {
    const { sources, all, force } = req.body;
    
    if (!force) {
      return res.status(400).json({
        error: 'Must include force: true to proceed',
        code: 'FORCE_REQUIRED'
      });
    }
    
    let sourceList: string[] = [];
    
    if (all) {
      // Get all configured sources
      const breakingStatus = breakingScheduler.getStatus();
      sourceList = breakingStatus.sources.map(s => s.name);
    } else if (sources && Array.isArray(sources)) {
      sourceList = sources;
    } else {
      return res.status(400).json({
        error: 'Must specify either "all": true or "sources": ["source1", "source2"]',
        code: 'INVALID_PARAMETERS'
      });
    }
    
    // Force immediate fetch for specified sources
    const result = await breakingScheduler.forceFetch(sourceList);
    
    res.json({
      success: true,
      ...result,
      message: `Scheduled immediate fetch for ${result.scheduled.length} sources`
    });
    
  } catch (error) {
    console.error('[admin][reingest] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Reset breaking state (in-memory only)
router.post('/reset-breaking-state', requireAdmin, async (req, res) => {
  try {
    // Reset scheduler state
    breakingScheduler.resetState();
    
    // Reset source statistics
    resetSourceStats();
    
    res.json({
      success: true,
      message: 'Reset in-memory breaking state and source statistics'
    });
    
  } catch (error) {
    console.error('[admin][reset-breaking-state] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

export { router as adminRoutes };
