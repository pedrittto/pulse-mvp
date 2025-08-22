"use client"

import { useKpiBreaking } from '@/lib/useKpiBreaking'

function formatMsToSec(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = (ms / 1000)
  return s.toFixed(1)
}

export default function BreakingKPIBar({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { data } = useKpiBreaking(apiBaseUrl, 30)
  const pass = data?.slo?.passes ?? false
  const p50s = formatMsToSec(data?.slo?.breaking_p50_ms)
  const p90s = formatMsToSec(data?.slo?.breaking_p90_ms)
  const eligibleCnt = data ? Object.values(data.sources || {}).filter((s: any) => s?.eligible).length : 0
  const demotedCnt = data?.demoted?.length ?? 0
  const ts = data?.generated_at ? new Date(data.generated_at).toLocaleTimeString() : ''

  return (
    <div className="w-full px-3 py-2 flex items-center gap-3 rounded-xl border">
      <div className={`h-2.5 w-2.5 rounded-full ${pass ? 'bg-green-500' : 'bg-red-500'}`} />
      <div className="text-sm">Breaking SLO: <b>{pass ? 'PASS' : 'FAIL'}</b></div>
      <div className="text-sm">p50: <b>{p50s}s</b></div>
      <div className="text-sm">p90: <b>{p90s}s</b></div>
      <div className="text-sm">eligible: <b>{eligibleCnt}</b></div>
      <div className="text-sm">demoted: <b>{demotedCnt}</b></div>
      <div className="text-xs text-gray-500 ml-auto">updated {ts}</div>
    </div>
  )
}


