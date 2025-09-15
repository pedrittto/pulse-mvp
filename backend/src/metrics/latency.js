const WINDOW_MS = 60 * 60 * 1000; // 60 min sliding window
const MAX_SAMPLES_PER_SRC = Math.max(1, Number(process.env.MAX_SAMPLES_PER_SRC || 10000));

// publisher→Pulse samples: { [source]: Array<{ at:number, deltaMs:number }> }
const bySourcePublisher = Object.create(null);
// pipeline (first_seen→ingested) samples
const bySourcePipeline = Object.create(null);
// timestamp source per source ('feed','http-date','inferred', etc.)
const tsSource = Object.create(null);

function pushSample(store, source, at, deltaMs) {
  const arr = store[source] || (store[source] = []);
  arr.push({ at, deltaMs });
  const cutoff = at - WINDOW_MS;
  while (arr.length && (arr[0].at || 0) < cutoff) arr.shift();
  if (arr.length > MAX_SAMPLES_PER_SRC) arr.splice(0, arr.length - MAX_SAMPLES_PER_SRC);
}

export function recordLatency(source, publishedAtMs, visibleAtMs) {
  // Back-compat: treat as publisher latency
  try {
    const at = Number(visibleAtMs || Date.now());
    const deltaMs = Math.max(0, Number(visibleAtMs) - Number(publishedAtMs));
    pushSample(bySourcePublisher, source, at, deltaMs);
  } catch {}
}

export function recordPublisherLatency(source, publishedAtMs, visibleAtMs) {
  try {
    const at = Number(visibleAtMs || Date.now());
    const deltaMs = Math.max(0, Number(visibleAtMs) - Number(publishedAtMs));
    pushSample(bySourcePublisher, source, at, deltaMs);
  } catch {}
}

export function recordPipelineLatency(source, firstSeenAtMs, ingestedAtMs) {
  try {
    const at = Number(ingestedAtMs || Date.now());
    const deltaMs = Math.max(0, Number(ingestedAtMs) - Number(firstSeenAtMs));
    pushSample(bySourcePipeline, source, at, deltaMs);
  } catch {}
}

export function setTimestampSource(source, sourceLabel) {
  try { tsSource[source] = String(sourceLabel || 'unknown'); } catch {}
}

function percentile(sortedNums, p) {
    const n = sortedNums.length;
    if (n === 0)
        return 0;
    const idx = Math.min(n - 1, Math.floor((p / 100) * (n - 1)));
    return sortedNums[idx];
}

export function getLatencySummary() {
  // Legacy single-latency summary (publisher)
  const out = { window_ms: WINDOW_MS, max_per_src: MAX_SAMPLES_PER_SRC, per_source: Object.create(null) };
  for (const [source, arr] of Object.entries(bySourcePublisher)) {
    if (!Array.isArray(arr) || arr.length === 0) { out.per_source[source] = { n: 0, p50_ms: 0, p90_ms: 0, last_sample_at: 0 }; continue; }
    const vals = arr.map(x => Number(x.deltaMs || 0)).filter(Number.isFinite).sort((a,b)=>a-b);
    const lastAt = Number(arr[arr.length - 1].at || 0);
    out.per_source[source] = { n: vals.length, p50_ms: percentile(vals,50), p90_ms: percentile(vals,90), last_sample_at: lastAt };
  }
  const allVals = Object.values(out.per_source).flatMap(s => s.n ? [s.p50_ms] : []).sort((a,b)=>a-b);
  out.n_total = Object.values(out.per_source).reduce((a,s)=>a + s.n, 0);
  out.p50_ms = percentile(allVals,50);
  out.p90_ms = percentile(allVals,90);
  return out;
}

export function getSpecV1Summary() {
  const by_source = Object.create(null);
  const sources = new Set([...Object.keys(bySourcePublisher), ...Object.keys(bySourcePipeline)]);
  let n_total = 0;
  for (const s of sources) {
    const pubArr = bySourcePublisher[s] || [];
    const pipArr = bySourcePipeline[s] || [];
    const pubVals = pubArr.map(x=>x.deltaMs).filter(Number.isFinite).sort((a,b)=>a-b);
    const pipVals = pipArr.map(x=>x.deltaMs).filter(Number.isFinite).sort((a,b)=>a-b);
    const samples = Math.max(pubVals.length, pipVals.length);
    n_total += samples;
    by_source[s] = {
      samples,
      publisher_p50_ms: pubVals.length ? percentile(pubVals,50) : 0,
      publisher_p90_ms: pubVals.length ? percentile(pubVals,90) : 0,
      pulse_p50_ms: pipVals.length ? percentile(pipVals,50) : 0,
      pulse_p90_ms: pipVals.length ? percentile(pipVals,90) : 0,
      last_sample_at: (pubArr.length ? pubArr[pubArr.length-1].at : (pipArr.length ? pipArr[pipArr.length-1].at : 0)) || 0,
      timestamp_source: tsSource[s] || 'unknown',
      window_ms: WINDOW_MS,
    };
  }
  return { n_total, by_source };
}
