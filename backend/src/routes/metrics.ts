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
    const ingestStatus = ingestStatusDoc.exists ? ingestStatusDoc.data() as any : null;

    // Derive lightweight metrics for the last 60m/24h using shadow counters if present
    const last_rss_poll = ingestStatus?.last_rss_poll || ingestStatus?.last_rss_run || null;
    const last_breaking_run = ingestStatus?.last_breaking_run || null;
    const last_enrichment_run = ingestStatus?.last_enrichment_run || null;

    const items_written_last_60m = ingestStatus?.items_written_last_60m ?? null;
    const items_written_last_24h = ingestStatus?.items_written_last_24h ?? null;
    const dropped_last_60m = ingestStatus?.dropped_last_60m ?? null;

    const per_source = ingestStatus?.per_source ?? null;

    // Optional scheduler diagnostics if stored by scheduler
    const scheduler_uptime_sec = ingestStatus?.scheduler_uptime_sec ?? null;
    const last_scheduler_tick = ingestStatus?.last_scheduler_tick ?? null;
    const next_poll_in_sec = ingestStatus?.next_poll_in_sec ?? null;
    const enrichment_queue_size = ingestStatus?.enrichment_queue_size ?? null;
    const stubs_waiting_gt_120s = ingestStatus?.stubs_waiting_gt_120s ?? null;

    const flags = {
      TRADING_ONLY_FILTER: process.env.TRADING_ONLY_FILTER || '0',
      SOURCE_SET: process.env.SOURCE_SET || '',
      INGEST_EXPANSION: process.env.INGEST_EXPANSION || '0',
      IMPACT_MODE: process.env.IMPACT_MODE || '',
      VERIFICATION_MODE: process.env.VERIFICATION_MODE || '',
      BREAKING_MODE: process.env.BREAKING_MODE || '',
      CONFIDENCE_CATEGORICAL_ONLY: process.env.CONFIDENCE_CATEGORICAL_ONLY || '0'
    };

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
      last_rss_poll,
      last_breaking_run,
      last_enrichment_run,
      scheduler_uptime_sec,
      last_scheduler_tick,
      next_poll_in_sec,
      enrichment_queue_size,
      stubs_waiting_gt_120s,
      items_written_last_60m,
      items_written_last_24h,
      dropped_last_60m,
      per_source,
      flags,
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
