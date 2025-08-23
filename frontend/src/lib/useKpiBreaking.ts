import useSWR from 'swr'

export type KpiBreaking = {
  ok: boolean;
  window_min: number;
  slo: {
    p50_target_ms: number;
    p90_target_ms: number;
    breaking_p50_ms: number | null;
    breaking_p90_ms: number | null;
    passes: boolean;
  };
  sources: Record<string, {
    publisher_p50: number | null;
    publisher_p90: number | null;
    eligible: boolean;
    samples: number;
  }>;
  demoted: string[];
  generated_at: string;
}

export function useKpiBreaking(apiBaseUrl: string, windowMin: number = 30) {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/kpi-breaking?window_min=${windowMin}`
  const refreshMs = parseInt(process.env.NEXT_PUBLIC_KPI_REFRESH_MS || '15000', 10)
  const { data, error, isLoading } = useSWR<KpiBreaking>(
    url,
    (u) => fetch(u, { cache: 'no-store' }).then(r => r.json()),
    { refreshInterval: refreshMs }
  )
  return { data, error, isLoading }
}


