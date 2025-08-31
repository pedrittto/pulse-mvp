const WINDOW_MS = 60 * 60 * 1000; // 60 min sliding window
const bySource = Object.create(null);
export function recordLatency(source, publishedAtMs, visibleAtMs) {
    const delta = Math.max(0, visibleAtMs - publishedAtMs);
    const arr = (bySource[source] ||= []);
    arr.push({ at: visibleAtMs, deltaMs: delta });
    // prune old
    const cutoff = visibleAtMs - WINDOW_MS;
    while (arr.length && arr[0].at < cutoff)
        arr.shift();
}
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
    return sorted[idx];
}
export function getLatencySummary() {
    const out = {};
    for (const [source, samples] of Object.entries(bySource)) {
        const vals = samples.map(s => s.deltaMs).sort((a, b) => a - b);
        out[source] = {
            samples: vals.length,
            p50_ms: percentile(vals, 50),
            p90_ms: percentile(vals, 90),
            last_sample_at: samples.length ? samples[samples.length - 1].at : 0,
        };
    }
    return out;
}
