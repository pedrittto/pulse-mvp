import { getReady } from './ready.js';
import { sseHub } from '../realtime/sse.js';
import { breakingScheduler } from '../ingest/breakingScheduler.js';
import { getHttpConditionalCounters } from '../ingest/rss.js';
import { getBulkWriterCounters } from '../lib/bulkWriter.js';
import { getSocialCounters } from '../social/scheduler.js';
import { getRenderAgg } from '../realtime/renderAgg.js';
import { getOpsSnapshot } from './runtimeMonitor.js';
import { getDb } from '../lib/firestore.js';
import { getDriftSnapshot } from './driftMonitor.js';
import { getHostForSource } from '../config/rssFeeds.js';
import { getWebhookCounters } from '../ingest/webhookQueue.js';

function h(line: string) { return line + '\n'; }
function escLabel(v: string) { return String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"'); }

function nearestRank(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a,b)=>a-b);
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length-1)];
}

async function computePublisherLatencies(windowMin: number): Promise<{ bySource: Record<string, { p50: number|null; p90: number|null }>; eligibleCount: number; sloP50: number|null; sloP90: number|null; sloP50c: number|null; sloP90c: number|null; }> {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  const snap = await db.collection('latency_metrics').where('timestamp','>=', sinceIso).get();
  const bySource: Record<string, number[]> = {};
  let exposure: number[] = [];
  if (snap && Array.isArray((snap as any).docs)) {
    (snap as any).docs.forEach((d:any) => {
      const data = d.data();
      const s = data?.source; const t = data?.t_publish_ms; const te = data?.t_exposure_ms;
      if (typeof s === 'string' && typeof t === 'number' && t >= 0) { (bySource[s] ||= []).push(t); }
      if (typeof te === 'number' && te >= 0) exposure.push(te);
    });
  } else if (snap && typeof (snap as any).forEach === 'function') {
    (snap as any).forEach((d:any) => { const data = d.data(); const s = data?.source; const t = data?.t_publish_ms; const te = data?.t_exposure_ms; if (typeof s==='string' && typeof t==='number'&&t>=0) (bySource[s] ||= []).push(t); if (typeof te==='number'&&te>=0) exposure.push(te); });
  }
  const out: Record<string, { p50: number|null; p90: number|null }> = {};
  const threshold = parseInt(process.env.BREAKING_DEMOTE_P50_MS || '60000', 10);
  let eligibleSamples: number[] = [];
  const driftEnabled = String(process.env.DRIFT_CORRECT_METRICS || '0') === '1';
  const drift = driftEnabled ? getDriftSnapshot() : null;
  const corrEligible: number[] = [];
  Object.entries(bySource).forEach(([name, arr]) => {
    const p50 = nearestRank(arr, 0.5); const p90 = nearestRank(arr, 0.9);
    out[name] = { p50, p90 };
    if (p50 != null && p50 <= threshold) eligibleSamples.push(...arr);
    if (driftEnabled) {
      try {
        const host = getHostForSource(name);
        const skew = host && (drift as any)?.by_host?.[host]?.p50_ms ? (drift as any).by_host[host].p50_ms as number : 0;
        const corr = arr.map(v => Math.max(0, v - (skew||0)));
        if (p50 != null && p50 <= threshold) corrEligible.push(...corr);
      } catch {}
    }
  });
  const sloP50 = nearestRank(eligibleSamples, 0.5);
  const sloP90 = nearestRank(eligibleSamples, 0.9);
  const sloP50c = driftEnabled ? nearestRank(corrEligible, 0.5) : null;
  const sloP90c = driftEnabled ? nearestRank(corrEligible, 0.9) : null;
  const eligibleCount = Object.values(out).filter(v => typeof v.p50 === 'number' && (v.p50 as number) <= threshold).length;
  return { bySource: out, eligibleCount, sloP50, sloP90, sloP50c, sloP90c };
}

export async function renderPromMetrics(): Promise<string> {
  let text = '';
  // HELP/TYPE lines
  text += h('# HELP pulse_ready Component readiness gauge');
  text += h('# TYPE pulse_ready gauge');
  const ready = getReady();
  text += h(`pulse_ready{component="firestore"} ${ready.firestore?1:0}`);
  text += h(`pulse_ready{component="scheduler"} ${ready.scheduler?1:0}`);
  text += h(`pulse_ready{component="sse"} ${ready.sse?1:0}`);
  text += h(`pulse_ready{component="warmup"} ${ready.warmupDone?1:0}`);

  text += h('# HELP bulkwriter_enabled Firestore BulkWriter enabled');
  text += h('# TYPE bulkwriter_enabled gauge');
  text += h(`bulkwriter_enabled ${process.env.BULKWRITER_ENABLED==='1'?1:0}`);

  // SSE
  text += h('# HELP sse_clients_connected Current SSE clients connected');
  text += h('# TYPE sse_clients_connected gauge');
  try { text += h(`sse_clients_connected ${sseHub.getStats().clients}`); } catch { text += h('sse_clients_connected 0'); }

  // Demotions / breaking eligible
  text += h('# HELP demoted_sources_active Active demoted sources');
  text += h('# TYPE demoted_sources_active gauge');
  try { text += h(`demoted_sources_active ${breakingScheduler.getDemotedSources().length}`); } catch { text += h('demoted_sources_active 0'); }

  // HTTP conditionals
  text += h('# HELP http_conditional_200_total Conditional GET 200 count per source');
  text += h('# TYPE http_conditional_200_total counter');
  text += h('# HELP http_conditional_304_total Conditional GET 304 count per source');
  text += h('# TYPE http_conditional_304_total counter');
  try {
    const counters = getHttpConditionalCounters();
    Object.entries(counters).forEach(([src, v]: any) => {
      text += h(`http_conditional_200_total{source="${escLabel(src)}"} ${v.c200||0}`);
      text += h(`http_conditional_304_total{source="${escLabel(src)}"} ${v.c304||0}`);
    });
  } catch {}

  // Webhook counters
  text += h('# HELP webhook_received_total Webhook payloads received per provider');
  text += h('# TYPE webhook_received_total counter');
  text += h('# HELP webhook_emitted_total Stubs emitted from webhooks per provider');
  text += h('# TYPE webhook_emitted_total counter');
  try {
    const wc = getWebhookCounters();
    Object.entries(wc).forEach(([prov, rec]: any) => {
      text += h(`webhook_received_total{provider="${escLabel(prov)}"} ${(rec.received)||0}`);
      text += h(`webhook_emitted_total{provider="${escLabel(prov)}"} ${(rec.emitted)||0}`);
    });
  } catch {}

  // Social counters
  text += h('# HELP social_posts_seen_total Social provider posts seen');
  text += h('# TYPE social_posts_seen_total counter');
  text += h('# HELP social_emitted_total Social stubs emitted');
  text += h('# TYPE social_emitted_total counter');
  try {
    const sc = getSocialCounters();
    text += h(`social_posts_seen_total ${sc.posts_seen||0}`);
    text += h(`social_emitted_total ${sc.emitted||0}`);
  } catch {}

  // Render telemetry summaries
  text += h('# HELP render_receive_ms Client receive latency (ms) quantiles');
  text += h('# TYPE render_receive_ms summary');
  text += h('# HELP render_paint_ms Client paint latency (ms) quantiles');
  text += h('# TYPE render_paint_ms summary');
  try {
    const r = getRenderAgg();
    if (r.receive_p50_ms != null) text += h(`render_receive_ms{quantile="0.5"} ${r.receive_p50_ms}`);
    if (r.receive_p90_ms != null) text += h(`render_receive_ms{quantile="0.9"} ${r.receive_p90_ms}`);
    if (r.render_p50_ms != null) text += h(`render_paint_ms{quantile="0.5"} ${r.render_p50_ms}`);
    if (r.render_p90_ms != null) text += h(`render_paint_ms{quantile="0.9"} ${r.render_p90_ms}`);
  } catch {}

  // Ops snapshot
  text += h('# HELP eventloop_lag_ms Event loop lag ms');
  text += h('# TYPE eventloop_lag_ms summary');
  text += h('# HELP gc_pause_ms GC pause ms');
  text += h('# TYPE gc_pause_ms summary');
  text += h('# HELP cpu_pct CPU utilization percent');
  text += h('# TYPE cpu_pct summary');
  try {
    const s = getOpsSnapshot();
    if (s.el_lag_p50_ms != null) text += h(`eventloop_lag_ms{stat="p50"} ${s.el_lag_p50_ms}`);
    if (s.el_lag_p95_ms != null) text += h(`eventloop_lag_ms{stat="p95"} ${s.el_lag_p95_ms}`);
    if (s.gc_pause_p50_ms != null) text += h(`gc_pause_ms{stat="p50"} ${s.gc_pause_p50_ms}`);
    if (s.gc_pause_p95_ms != null) text += h(`gc_pause_ms{stat="p95"} ${s.gc_pause_p95_ms}`);
    if (s.cpu_p50_pct != null) text += h(`cpu_pct{stat="p50"} ${s.cpu_p50_pct}`);
    if (s.cpu_p95_pct != null) text += h(`cpu_pct{stat="p95"} ${s.cpu_p95_pct}`);
  } catch {}

  // Publisher per-source and SLO
  text += h('# HELP publisher_latency_ms Publisher latency per source (ms) quantiles');
  text += h('# TYPE publisher_latency_ms summary');
  text += h('# HELP pulse_exposure_ms Exposure latency ms quantiles');
  text += h('# TYPE pulse_exposure_ms summary');
  text += h('# HELP slo_breaking_ms Breaking SLO quantiles');
  text += h('# TYPE slo_breaking_ms summary');
  text += h('# HELP slo_breaking_corrected_ms Breaking SLO corrected quantiles');
  text += h('# TYPE slo_breaking_corrected_ms summary');
  try {
    const windowMin = parseInt(process.env.METRICS_LATENCY_WINDOW_MIN || '30', 10);
    const agg = await computePublisherLatencies(windowMin);
    Object.entries(agg.bySource).forEach(([name, v]) => {
      if (v.p50 != null) text += h(`publisher_latency_ms{source="${escLabel(name)}",quantile="0.5"} ${v.p50}`);
      if (v.p90 != null) text += h(`publisher_latency_ms{source="${escLabel(name)}",quantile="0.9"} ${v.p90}`);
    });
    if (agg.sloP50 != null) text += h(`slo_breaking_ms{stat="p50"} ${agg.sloP50}`);
    if (agg.sloP90 != null) text += h(`slo_breaking_ms{stat="p90"} ${agg.sloP90}`);
    if (agg.sloP50c != null) text += h(`slo_breaking_corrected_ms{stat="p50"} ${agg.sloP50c}`);
    if (agg.sloP90c != null) text += h(`slo_breaking_corrected_ms{stat="p90"} ${agg.sloP90c}`);
    // eligible gauge
    text += h('# HELP breaking_sources_eligible Count of breaking-eligible sources');
    text += h('# TYPE breaking_sources_eligible gauge');
    text += h(`breaking_sources_eligible ${agg.eligibleCount}`);
  } catch {}

  return text;
}


