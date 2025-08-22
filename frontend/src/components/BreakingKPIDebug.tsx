"use client"

import { useKpiBreaking } from '@/lib/useKpiBreaking'

function fmt(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return (ms / 1000).toFixed(1)
}

export default function BreakingKPIDebug({ apiBaseUrl }: { apiBaseUrl: string }) {
  if (String(process.env.NEXT_PUBLIC_SHOW_KPI_DEBUG).toLowerCase() !== 'true') return null as any
  const { data } = useKpiBreaking(apiBaseUrl, 30)
  const entries = data ? Object.entries(data.sources || {}) : []
  return (
    <div className="mt-3 border rounded-xl overflow-hidden">
      <div className="px-3 py-2 text-sm font-medium bg-gray-50">Breaking KPI Debug (last {data?.window_min ?? 30} min)</div>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">p50 (s)</th>
              <th className="text-left px-3 py-2">p90 (s)</th>
              <th className="text-left px-3 py-2">Eligible</th>
              <th className="text-left px-3 py-2">Samples</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, v]: any) => (
              <tr key={name} className="border-t">
                <td className="px-3 py-2">{name}</td>
                <td className="px-3 py-2">{fmt(v?.publisher_p50)}</td>
                <td className="px-3 py-2">{fmt(v?.publisher_p90)}</td>
                <td className="px-3 py-2">{v?.eligible ? 'true' : 'false'}</td>
                <td className="px-3 py-2">{v?.samples ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


