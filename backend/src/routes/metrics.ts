import express from 'express';
import { getDb } from '../lib/firestore';

const router = express.Router();

// For categorical confidence_state metrics
function computeConfidenceStateMetrics(states: string[]) {
  const counts: Record<string, number> = {
    unconfirmed: 0,
    reported: 0,
    corroborated: 0,
    verified: 0,
    confirmed: 0
  };
  for (const s of states) {
    if (counts[s] !== undefined) counts[s]++;
  }
  return counts;
}

/**
 * GET /metrics-lite
 * Returns lightweight operational metrics
 */
router.get('/metrics-lite', async (_req, res) => {
  try {
    const db = getDb();
    
    // Get ingest status
    const ingestStatusDoc = await db.collection('system').doc('ingest_status').get();
    const ingestStatus = ingestStatusDoc.exists ? ingestStatusDoc.data() : null;
    
    // Get feed count using aggregation
    let feedCount: number | null = null;
    try {
      const feedSnapshot = await db.collection('news').count().get();
      feedCount = feedSnapshot.data().count;
    } catch (error) {
      // Fallback if count() is not supported
      console.log('[metrics] Count aggregation not supported, using fallback');
      try {
        const feedSnapshot = await db.collection('news').get();
        feedCount = feedSnapshot.size;
      } catch (fallbackError) {
        console.error('[metrics] Failed to get feed count:', fallbackError);
        feedCount = null;
      }
    }

    // Get confidence_state metrics from recent documents (sample last 500 for performance)
    let confidenceStateMetrics = null;
    
    try {
      const recentDocs = await db.collection('news')
        .orderBy('published_at', 'desc')
        .limit(500) // Sample last 500 docs for performance
        .get();

      if (!recentDocs.empty) {
        const states = recentDocs.docs
          .map(doc => doc.data().confidence_state)
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        confidenceStateMetrics = computeConfidenceStateMetrics(states);
      }
    } catch (error) {
      console.error('[metrics] Failed to compute confidence_state metrics:', error);
      // Continue without confidence metrics
    }
    
    const response = {
      ok: true,
      last_run: ingestStatus?.last_run || null,
      counts: ingestStatus?.counts || { fetched: 0, added: 0, skipped: 0, errors: 0 },
      feed_count: feedCount,
      now: new Date().toISOString(),
      ...(confidenceStateMetrics && { confidence_state: confidenceStateMetrics })
    };
    
    res.json(response);
  } catch (error) {
    console.error('[metrics] Error:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as metrics };
