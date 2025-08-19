import express from 'express';
import { getDb } from '../lib/firestore';
import { sseHub } from '../realtime/sse';

const router = express.Router();

// --- helpers ---
const isFiniteNumber = (x: any): x is number => typeof x === 'number' && Number.isFinite(x);
const pct = (arr: number[], p: number): number | undefined => {
  if (!arr.length) return undefined;
  const idx = Math.floor(arr.length * p);
  return arr[Math.min(idx, arr.length - 1)];
};
const median = (arr: number[]): number | undefined => pct(arr, 0.5);

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

    // Compute latency percentiles per source: publisher and pulse exposure
    // Exclusions: transport="stub" by default, null published_at, samples older than LAT_METRIC_MAX_AGE_MIN
    let latency: Record<string, { p50: number; p90: number; count: number; p50_h: string; p90_h: string; samples_insufficient: boolean; last_200_age: number | null; last_sample_age_min?: number | null; timeout_count?: number; error_count?: number; transport_mix?: Record<string, number>; publisher_p50?: number; publisher_p90?: number; pulse_p50?: number; pulse_p90?: number; dropped_by_date?: number; }> | null = null;
    try {
      if (process.env.METRICS_LATENCY_SUMMARY !== '0') {
        latency = {};
        // Build list of sources to summarize: prefer ingestStatus.per_source; otherwise derive from recent latency_metrics
        let names: string[] = [];
        if (per_source) {
          names = Object.keys(per_source);
        } else {
          try {
            const windowMin = parseInt(process.env.METRICS_LATENCY_WINDOW_MIN || '60', 10);
            const cutoffTs = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
            const snap = await db.collection('latency_metrics')
              .where('timestamp', '>=', cutoffTs)
              .orderBy('timestamp', 'desc')
              .limit(200)
              .get();
            const set = new Set<string>();
            if (snap && Array.isArray((snap as any).docs)) {
              (snap as any).docs.forEach((d: any) => { const s = d.data()?.source; if (s) set.add(s); });
            } else if (snap && typeof (snap as any).forEach === 'function') {
              (snap as any).forEach((d: any) => { const s = d.data()?.source; if (s) set.add(s); });
            }
            names = Array.from(set);
          } catch {}
        }
        for (const name of names) {
          const rec = per_source ? (per_source as any)[name] : undefined;
          const publishSamples: number[] = [];
          const exposureSamples: number[] = [];
          const transports: Record<string, number> = {};
          let publisherTimes: number[] = [];
          let exposureTimes: number[] = [];
          let droppedByDate = 0;
          const maxAgeMin = parseInt(process.env.LAT_METRIC_MAX_AGE_MIN || '360', 10);
          // Try to read recent latency_metrics docs for this source (fast path best-effort)
          try {
            const windowMin = parseInt(process.env.METRICS_LATENCY_WINDOW_MIN || '60', 10);
            const cutoffTs = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
            const snapshot = await db.collection('latency_metrics')
              .where('source', '==', name)
              .where('timestamp', '>=', cutoffTs)
              .orderBy('timestamp', 'desc')
              .limit(200)
              .get();
            const nowMs = Date.now();
            const spCutoffMs = nowMs - windowMin * 60 * 1000;
            let newestPublishMs: number | null = null;
            snapshot.forEach((d: any) => {
              const data = d.data();
              const t = data.t_publish_ms;
              const te = data.t_exposure_ms;
              const tp = data.transport as string | undefined;
              const sp = data.source_published_at as string | undefined;
              if (typeof t !== 'number' || t < 0) return;
              if (tp === 'stub' && process.env.METRICS_INCLUDE_STUB !== '1') return;
              if (!sp) return;
              const pubMs = Date.parse(sp);
              if (!Number.isFinite(pubMs)) return;
              // Enforce windowing by source_published_at (publisher window)
              if (pubMs < spCutoffMs) return;
              // Exclude future >60s or older than 24h from publisher percentiles
              const futureMs = pubMs - nowMs;
              const ageMs = nowMs - pubMs;
              if (futureMs > 60000) { droppedByDate++; return; }
              if (ageMs > 24 * 60 * 60 * 1000) { droppedByDate++; return; }
              const ageMin = (nowMs - pubMs) / 60000;
              if (ageMin > maxAgeMin) return;
              publishSamples.push(t);
              if (typeof te === 'number' && te >= 0) exposureSamples.push(te);
              publisherTimes.push(t);
              const key = tp || 'unknown';
              transports[key] = (transports[key] || 0) + 1;
              if (newestPublishMs == null || pubMs > newestPublishMs) newestPublishMs = pubMs;
              if (typeof data.t_exposure_ms === 'number' && data.t_exposure_ms >= 0) {
                exposureTimes.push(data.t_exposure_ms);
              }
            });
            // last_200_age in minutes for newest sample (how fresh recent window is)
            var last200AgeMin: number | null = null;
            if (newestPublishMs != null) {
              last200AgeMin = Math.max(0, Math.round((nowMs - newestPublishMs) / 60000));
            }
            (transports as any)._last200AgeMin = last200AgeMin; // temp attach for use below
          } catch (_e) {
            // Silent: collection may not exist; rely on per_source.last_item
          }
          if (!publishSamples.length && rec?.last_item?.publish_to_ingest_ms) {
            publishSamples.push(rec.last_item.publish_to_ingest_ms);
          }
          if (publishSamples.length) {
            publishSamples.sort((a, b) => a - b);
            const p50 = publishSamples[Math.floor(publishSamples.length * 0.5)];
            const p90 = publishSamples[Math.floor(publishSamples.length * 0.9)];
            const fmt = (ms: number) => {
              if (!Number.isFinite(ms) || ms < 0) return 'n/a';
              const s = Math.floor(ms / 1000);
              const m = Math.floor(s / 60);
              const r = s % 60;
              return `${m}m${r}s`;
            };
            const insufficient = publishSamples.length < 5;
            const last200AgeMin = (transports as any)._last200AgeMin ?? null;
            delete (transports as any)._last200AgeMin;
            const pub_p50 = median(publisherTimes);
            const pub_p90 = pct(publisherTimes, 0.9);
            const exp_p50 = median(exposureTimes);
            const exp_p90 = pct(exposureTimes, 0.9);
            latency[name] = { p50, p90, count: publishSamples.length, p50_h: fmt(p50), p90_h: fmt(p90), samples_insufficient: insufficient, last_200_age: last200AgeMin, last_sample_age_min: last200AgeMin, timeout_count: rec?.timeout_count ?? 0, error_count: rec?.error_count ?? 0, transport_mix: transports, publisher_p50: pub_p50, publisher_p90: pub_p90, pulse_p50: exp_p50, pulse_p90: exp_p90, dropped_by_date: droppedByDate };
          }
        }
      }
    } catch (e) {
      console.error('[metrics] latency summary failed:', e);
    }

    // Compute accepted_24h per source from latency_metrics
    let perSourceWithAccepted: any = per_source;
    try {
      if (per_source) {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const out: Record<string, any> = {};
        for (const [name, rec] of Object.entries<any>(per_source)) {
          let count24h = 0;
          try {
            const snap = await db.collection('latency_metrics')
              .where('source', '==', name)
              .where('timestamp', '>=', cutoff)
              .get();
            // Mock and native both support forEach or docs
            if (Array.isArray((snap as any).docs)) count24h = (snap as any).docs.length;
            else if (typeof (snap as any).forEach === 'function') {
              let c = 0; (snap as any).forEach((_d: any) => { c++; }); count24h = c;
            }
          } catch (_e) {
            count24h = 0;
          }
          out[name] = { ...(rec as any), accepted_24h: count24h };
        }
        perSourceWithAccepted = out;
      }
    } catch (e) {
      console.error('[metrics] accepted_24h computation failed:', e);
    }

    // Optional scheduler diagnostics if stored by scheduler
    const scheduler_uptime_sec = ingestStatus?.scheduler_uptime_sec ?? null;
    const last_scheduler_tick = ingestStatus?.last_scheduler_tick ?? null;
    const next_poll_in_sec = ingestStatus?.next_poll_in_sec ?? null;
    const enrichment_queue_size = ingestStatus?.enrichment_queue_size ?? null;
    const stubs_waiting_gt_120s = ingestStatus?.stubs_waiting_gt_120s ?? null;
    // Global aggregates (publisher and pulse) and top lists
    let globalPublisher: any = null;
    let globalPulse: any = null;
    let top: any = null;
    try {
      if (latency) {
        const entries = Object.entries(latency).filter(([, v]: any) => !v.samples_insufficient);
        if (entries.length) {
          const byPub = entries.map(([k, v]: any) => ({ name: k, p50: v.publisher_p50 ?? v.p50, p90: v.publisher_p90 ?? v.p90 }));
          const byPulse = entries.map(([k, v]: any) => ({ name: k, p50: v.pulse_p50 ?? null, p90: v.pulse_p90 ?? null })).filter(e => e.p50 != null);
          const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / (arr.length || 1));
          globalPublisher = { p50: avg(byPub.map(e => e.p50 || 0)), p90: avg(byPub.map(e => e.p90 || 0)) };
          globalPulse = byPulse.length ? { p50: avg(byPulse.map(e => e.p50 || 0)), p90: avg(byPulse.map(e => e.p90 || 0)) } : null;
          const sortAsc = (arr: any[], key: string) => arr.slice().sort((a, b) => (a[key] ?? 1e12) - (b[key] ?? 1e12));
          const sortDesc = (arr: any[], key: string) => arr.slice().sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
          top = {
            publisher_best: sortAsc(byPub, 'p50').slice(0, 5),
            publisher_worst: sortDesc(byPub, 'p50').slice(0, 5),
            pulse_best: sortAsc(byPulse, 'p50').slice(0, 5),
            pulse_worst: sortDesc(byPulse, 'p50').slice(0, 5)
          };
        }
      }
    } catch (e) {
      console.error('[metrics] global aggregates failed:', e);
    }

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
          .map((doc: any) => doc.data().confidence_state)
          .filter((s: any): s is string => typeof s === 'string' && s.length > 0);
        confidenceStateMetrics = computeConfidenceStateMetrics(states);
      }
    } catch (error) {
      console.error('[metrics] Failed to compute confidence_state metrics:', error);
      // Continue without confidence metrics
    }
    
    // Build response. If any sources have samples_insufficient=true, they remain in per-source but are excluded from any future global aggregates (not implemented here to keep it light).
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
      per_source: perSourceWithAccepted,
      flags,
      feed_count: feedCount,
      now: new Date().toISOString(),
      ...(confidenceStateMetrics && { confidence_state: confidenceStateMetrics }),
      ...(latency && { latency }),
      ...(globalPublisher && { global_publisher: globalPublisher }),
      ...(globalPulse && { global_pulse: globalPulse }),
      ...(top && { top }),
      sse_clients: process.env.SSE_ENABLED === '1' ? sseHub.getStats().clients : 0,
      sse_broadcast_ms: process.env.SSE_ENABLED === '1' ? sseHub.getStats().broadcast_ms : 0,
      sse_dropped: process.env.SSE_ENABLED === '1' ? sseHub.getStats().dropped : 0
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

// Helper for tests/consumers: compute a global aggregate from per-source latency
// Excludes sources with samples_insufficient=true as required
export function computeGlobalLatencyAggregate(latency: Record<string, { p50: number; p90: number; count: number; samples_insufficient: boolean; }> | null | undefined) {
  if (!latency) return null;
  const entries = Object.values(latency).filter((e) => !e.samples_insufficient && Number.isFinite(e.p50) && Number.isFinite(e.p90) && (e.count || 0) >= 1);
  if (entries.length === 0) return null;
  const totalCount = entries.reduce((sum, e) => sum + (e.count || 0), 0) || entries.length;
  const p50 = Math.round(entries.reduce((sum, e) => sum + (e.p50 * (e.count || 1)), 0) / totalCount);
  const p90 = Math.round(entries.reduce((sum, e) => sum + (e.p90 * (e.count || 1)), 0) / totalCount);
  return { p50, p90, sources_included: entries.length, total_samples: totalCount };
}
