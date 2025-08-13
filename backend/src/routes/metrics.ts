import { Router } from 'express';
import { getDb } from '../lib/firestore';

const router = Router();

/**
 * Compute confidence distribution metrics from an array of confidence scores
 */
function computeConfidenceMetrics(confidences: number[]) {
  if (confidences.length === 0) {
    return {
      confidence_avg: 0,
      confidence_lt40: 0,
      confidence_40_59: 0,
      confidence_60_79: 0,
      confidence_gte80: 0
    };
  }

  const avg = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  const lt40 = confidences.filter(c => c < 40).length;
  const range40_59 = confidences.filter(c => c >= 40 && c < 60).length;
  const range60_79 = confidences.filter(c => c >= 60 && c < 80).length;
  const gte80 = confidences.filter(c => c >= 80).length;

  return {
    confidence_avg: Math.round(avg * 10) / 10, // Round to 1 decimal
    confidence_lt40: lt40,
    confidence_40_59: range40_59,
    confidence_60_79: range60_79,
    confidence_gte80: gte80
  };
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

    // Get confidence metrics from recent documents (sample last 500 for performance)
    let confidenceMetrics = null;
    let confidenceV2Metrics = null;
    
    try {
      const recentDocs = await db.collection('news')
        .orderBy('published_at', 'desc')
        .limit(500) // Sample last 500 docs for performance
        .get();

      if (!recentDocs.empty) {
        const confidences = recentDocs.docs
          .map(doc => doc.data().confidence)
          .filter((c): c is number => typeof c === 'number' && !isNaN(c));

        confidenceMetrics = computeConfidenceMetrics(confidences);

        // Check for v2 comparison if feature flag is enabled
        if (process.env.CONFIDENCE_V2_COMPARE === '1') {
          const v2Confidences = recentDocs.docs
            .map(doc => doc.data().confidence_v2_preview)
            .filter((c): c is number => typeof c === 'number' && !isNaN(c));

          if (v2Confidences.length > 0) {
            const v2Metrics = computeConfidenceMetrics(v2Confidences);
            confidenceV2Metrics = {
              confidence_avg_v2: v2Metrics.confidence_avg,
              confidence_lt40_v2: v2Metrics.confidence_lt40,
              confidence_40_59_v2: v2Metrics.confidence_40_59,
              confidence_60_79_v2: v2Metrics.confidence_60_79,
              confidence_gte80_v2: v2Metrics.confidence_gte80
            };
          }
        }
      }
    } catch (error) {
      console.error('[metrics] Failed to compute confidence metrics:', error);
      // Continue without confidence metrics
    }
    
    const response = {
      ok: true,
      last_run: ingestStatus?.last_run || null,
      counts: ingestStatus?.counts || { fetched: 0, added: 0, skipped: 0, errors: 0 },
      feed_count: feedCount,
      now: new Date().toISOString(),
      ...(confidenceMetrics && { confidence: confidenceMetrics }),
      ...(confidenceV2Metrics && { confidence_v2: confidenceV2Metrics })
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
