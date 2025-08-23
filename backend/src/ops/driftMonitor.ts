export type HostDrift = { host: string; samples: number; p50_ms: number | null; p95_ms: number | null; last_ms: number | null; updated_at: string };
export type DriftSnapshot = { window_sec: number; global_p50_ms: number | null; global_p95_ms: number | null; by_host: Record<string, HostDrift> };

const WINDOW_MIN = Math.max(1, parseInt(process.env.DRIFT_WINDOW_MIN || '10', 10));
type Sample = { ms: number; at: number };

const byHost: Map<string, Sample[]> = new Map();

export function recordHttpDateSkew(host: string, upstreamDateHeader: string | null, localNowMs?: number): void {
  if (!host) return;
  const local = (typeof localNowMs === 'number') ? localNowMs : Date.now();
  const upstream = Date.parse(upstreamDateHeader || '');
  if (!Number.isFinite(upstream)) return;
  const skewMs = local - upstream; // positive => local clock ahead
  const arr = byHost.get(host) || [];
  arr.push({ ms: skewMs, at: local });
  // Cap per-host samples (~600 for 10 min at ~1s cadence; we sample per fetch so keep it bounded)
  if (arr.length > 1200) arr.shift();
  byHost.set(host, arr);
}

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

export function getDriftSnapshot(): DriftSnapshot {
  const cutoff = Date.now() - WINDOW_MIN * 60 * 1000;
  const out: Record<string, HostDrift> = {};
  const all: number[] = [];
  for (const [host, samples] of byHost.entries()) {
    const recent = samples.filter(s => s.at >= cutoff);
    if (!recent.length) continue;
    const vals = recent.map(s => s.ms);
    const p50 = pct(vals, 0.5);
    const p95 = pct(vals, 0.9);
    const last = recent[recent.length - 1]?.ms ?? null;
    out[host] = { host, samples: recent.length, p50_ms: p50, p95_ms: p95, last_ms: last, updated_at: new Date(recent[recent.length - 1].at).toISOString() };
    all.push(...vals);
  }
  return { window_sec: WINDOW_MIN * 60, global_p50_ms: pct(all, 0.5), global_p95_ms: pct(all, 0.9), by_host: out };
}


