type Num = number;
type Sample = { ts: Num; val: Num };
const WINDOW_MS = 60 * 60 * 1000;

const e2eGlobal: Sample[] = [];
const procGlobal: Sample[] = [];
const e2eBySource = new Map<string, Sample[]>();
const procBySource = new Map<string, Sample[]>();

function buf(srcMap: Map<string, Sample[]>, key: string) {
  let arr = srcMap.get(key);
  if (!arr) { arr = []; srcMap.set(key, arr); }
  return arr;
}

export function recordItemMetrics(it: any, now = Date.now()) {
  const vis = it?.visible_at_ms ?? it?.visible_at ?? null;
  const pub = it?.publisher_seen_at_ms ?? it?.publisher_seen_at ?? null;
  const fet = it?.fetched_at_ms ?? it?.fetched_at ?? null;
  const src = String(it?.source || 'unknown');

  if (vis && pub) {
    const v = Number(vis) - Number(pub);
    if (v > 0 && v < WINDOW_MS) {
      e2eGlobal.push({ ts: now, val: v });
      buf(e2eBySource, src).push({ ts: now, val: v });
    }
  }
  if (vis && fet) {
    const v = Number(vis) - Number(fet);
    if (v > 0 && v < WINDOW_MS) {
      procGlobal.push({ ts: now, val: v });
      buf(procBySource, src).push({ ts: now, val: v });
    }
  }
}

function pct(sorted: Num[], q: number) {
  if (!sorted.length) return null as Num | null;
  const i = Math.floor(sorted.length * q);
  return sorted[Math.min(Math.max(i, 0), sorted.length - 1)];
}

function stats(samples: Sample[], since: Num) {
  const vals = samples.filter(s => s.ts >= since).map(s => s.val).sort((a,b)=>a-b);
  return { p50: pct(vals, 0.5), p90: pct(vals, 0.9), count: vals.length };
}

export function getLatencySummary(now = Date.now()) {
  const since = now - WINDOW_MS;
  const global = {
    e2e: stats(e2eGlobal, since),
    processing: stats(procGlobal, since),
  };
  const by_source: Record<string, any> = {};
  for (const [src, arr] of e2eBySource.entries()) {
    by_source[src] = by_source[src] || {};
    by_source[src].e2e = stats(arr, since);
  }
  for (const [src, arr] of procBySource.entries()) {
    by_source[src] = by_source[src] || {};
    by_source[src].processing = stats(arr, since);
  }
  return { window_minutes: 60, global, by_source };
}

export function purgeOldMetrics(now = Date.now()) {
  const cutoff = now - WINDOW_MS - 60_000;
  const keep = (arr: Sample[]) => {
    let i = 0; while (i < arr.length && arr[i].ts < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  };
  [e2eGlobal, procGlobal].forEach(keep);
  for (const arr of e2eBySource.values()) keep(arr);
  for (const arr of procBySource.values()) keep(arr);
}

export function getCounts1h(now = Date.now()) {
  const since = now - WINDOW_MS;
  const by_source: Record<string, number> = {};
  for (const [src, arr] of e2eBySource.entries()) {
    by_source[src] = arr.filter(s => s.ts >= since).length;
  }
  return by_source;
}


// Back-compat shims for legacy adapter imports (no-ops)
export const setTimestampSource = (..._args: any[]) => {};
export const recordPublisherLatency = (..._args: any[]) => {};
export const recordPipelineLatency = (..._args: any[]) => {};
