const WINDOW_MS = 60 * 60 * 1000; // 60 min sliding window
const MAX_SAMPLES_PER_SRC = Math.max(1, Number(process.env.MAX_SAMPLES_PER_SRC || 10000));

// { [source]: Array<{ at:number, deltaMs:number }> }
const bySource = Object.create(null);

export function recordLatency(source, publishedAtMs, visibleAtMs) {
    try {
        const at = Number(visibleAtMs || Date.now());
        const deltaMs = Math.max(0, Number(visibleAtMs) - Number(publishedAtMs));
        const arr = bySource[source] || (bySource[source] = []);
        arr.push({ at, deltaMs });
        // prune by time
        const cutoff = at - WINDOW_MS;
        while (arr.length && (arr[0].at || 0) < cutoff)
            arr.shift();
        // hard cap (keep newest)
        if (arr.length > MAX_SAMPLES_PER_SRC) {
            arr.splice(0, arr.length - MAX_SAMPLES_PER_SRC);
        }
    }
    catch (_e) {
        // never throw from hot path
    }
}

function percentile(sortedNums, p) {
    const n = sortedNums.length;
    if (n === 0)
        return 0;
    const idx = Math.min(n - 1, Math.floor((p / 100) * (n - 1)));
    return sortedNums[idx];
}

export function getLatencySummary() {
    // never throw; return a pure JSONable POJO
    const out = {
        window_ms: WINDOW_MS,
        max_per_src: MAX_SAMPLES_PER_SRC,
        per_source: Object.create(null),
    };
    for (const [source, arr] of Object.entries(bySource)) {
        if (!Array.isArray(arr) || arr.length === 0) {
            out.per_source[source] = { n: 0, p50_ms: 0, p90_ms: 0, last_sample_at: 0 };
            continue;
        }
        const vals = arr
            .map(x => Number(x.deltaMs || 0))
            .filter(n => Number.isFinite(n))
            .sort((a, b) => a - b);
        const lastAt = Number(arr[arr.length - 1].at || 0);
        out.per_source[source] = {
            n: vals.length,
            p50_ms: percentile(vals, 50),
            p90_ms: percentile(vals, 90),
            last_sample_at: lastAt,
        };
    }
    const allVals = Object.values(out.per_source)
        .flatMap(s => s.n ? [s.p50_ms] : [])
        .sort((a, b) => a - b);
    out.n_total = Object.values(out.per_source).reduce((a, s) => a + s.n, 0);
    out.p50_ms = percentile(allVals, 50);
    out.p90_ms = percentile(allVals, 90);
    return out;
}
