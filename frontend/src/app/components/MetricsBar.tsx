"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export type MetricsBarProps = {
  base?: string;
  path: string;
};

type SourceMetric = {
  name: string;
  p50_ms?: number;
  p90_ms?: number;
  samples?: number;
};

type SourceStats = {
  samples: number;
  p50_ms: number;
  p90_ms: number;
  last_sample_at?: string;
  units?: string;
  window_hours?: number;
  low_sample?: boolean;
};

type MetricsSummary = {
  sse?: { p50_ms: number; p90_ms: number };
  by_source?: Record<string, SourceStats>;
  // allow unknown extra fields for tolerance
  [key: string]: unknown;
};

export default function MetricsBar({ base, path }: MetricsBarProps) {
  const [data, setData] = useState<MetricsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endpoint = base ? `${base}${path}` : undefined;

  useEffect(() => {
    if (!endpoint) return;
    let dead = false;
    const fetchMetrics = async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store" });
        const j = await res.json();
        if (dead) return;
        setError(null);
        setData(j as MetricsSummary);
      } catch {
        if (dead) return;
        setError("metrics fetch failed");
      }
    };
    fetchMetrics();
    const t = setInterval(fetchMetrics, 30000);
    return () => { dead = true; clearInterval(t); };
  }, [endpoint]);

  const sseSummary = useMemo(() => {
    const d = (data as Record<string, unknown>) || {};
    const sse = (d.sse as { p50_ms?: number; p90_ms?: number } | undefined) || undefined;
    const p50 = (d.sse_p50_ms as number | undefined) ?? sse?.p50_ms ?? (d.p50_ms as number | undefined) ?? undefined;
    const p90 = (d.sse_p90_ms as number | undefined) ?? sse?.p90_ms ?? (d.p90_ms as number | undefined) ?? undefined;
    return { p50, p90 } as { p50?: number; p90?: number };
  }, [data]);

  const topSources = useMemo<SourceMetric[]>(() => {
    const d = (data as Record<string, unknown>) || {};
    let list: SourceMetric[] = [];

    // Common shapes: array under `sources`
    const arr = d.sources as unknown;
    if (Array.isArray(arr)) {
      list = arr
        .map((s: unknown) => {
          const o = (s as Record<string, unknown>) || {};
          const name = String((o.name as string) ?? (o.source as string) ?? (o.publisher as string) ?? "unknown");
          const p50_ms = (o.p50_ms as number | undefined) ?? (o.p50 as number | undefined) ?? undefined;
          const p90_ms = (o.p90_ms as number | undefined) ?? (o.p90 as number | undefined) ?? undefined;
          const samples = (o.samples as number | undefined) ?? (o.count as number | undefined) ?? undefined;
          return { name, p50_ms, p90_ms, samples };
        })
        .filter((x: SourceMetric) => !!x.name);
    }

    // Object map shapes: by_source / per_source / publishers
    const candidateMaps: Array<unknown> = [d.by_source, d.per_source, d.publishers, d.sources_map].filter(Boolean);
    for (const m of candidateMaps) {
      if (m && typeof m === "object" && !Array.isArray(m)) {
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
          const o = (v as Record<string, unknown>) || {};
          list.push({
            name: String(k),
            p50_ms: (o.p50_ms as number | undefined) ?? (o.p50 as number | undefined) ?? undefined,
            p90_ms: (o.p90_ms as number | undefined) ?? (o.p90 as number | undefined) ?? undefined,
            samples: (o.samples as number | undefined) ?? (o.count as number | undefined) ?? undefined,
          });
        }
      }
    }

    // De-dup by name
    const seen = new Set<string>();
    const deduped = list.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
    return deduped.slice(0, 4);
  }, [data]);

  const barStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 0",
    borderTop: "1px solid #e5e5e5",
    borderBottom: "1px solid #e5e5e5",
    margin: "8px 0",
  };

  const muted: React.CSSProperties = { color: "#666", fontSize: 12 };

  return (
    <div style={barStyle}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={muted}>
          SSE p50/p90: {sseSummary.p50 ?? "–"} / {sseSummary.p90 ?? "–"} ms
        </span>
        {topSources.map((s) => (
          <span key={s.name} style={muted}>
            {s.name}: {s.p50_ms ?? "–"}/{s.p90_ms ?? "–"} ms ({s.samples ?? "–"})
          </span>
        ))}
        {error && <span style={{ ...muted, color: "#a00" }}>metrics: {error}</span>}
      </div>
      <div>
        {endpoint ? (
          <a href={endpoint} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>metrics</a>
        ) : (
          <span style={muted}>set API base to see metrics</span>
        )}
      </div>
    </div>
  );
}


