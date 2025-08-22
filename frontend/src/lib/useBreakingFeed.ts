import { useEffect, useRef } from 'react'
import useSWR, { mutate } from 'swr'
import { fetcher } from './fetcher'
import { subscribeNewItems } from './sse'

export function useBreakingFeed(apiBaseUrl: string, limit: number = 100) {
  const useSse = String(process.env.NEXT_PUBLIC_USE_SSE || 'true').toLowerCase() === 'true'
  const refreshInterval = useSse ? 0 : parseInt(process.env.NEXT_PUBLIC_FEED_REFRESH_MS || '60000', 10)

  const url = `${apiBaseUrl.replace(/\/$/, '')}/breaking-feed?limit=${limit}`

  const { data, error, isLoading, isValidating } = useSWR<any[]>(
    url,
    fetcher,
    {
      refreshInterval,
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateOnReconnect: true
    }
  )

  // SSE subscription with debounce to avoid stampedes
  const sseRef = useRef<{ close: () => void } | null>(null)
  useEffect(() => {
    if (!useSse) return
    let debounceTimer: any = null
    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        mutate(url)
      }, 250)
    }
    const sub = subscribeNewItems(apiBaseUrl, () => {
      trigger()
    })
    sseRef.current = sub
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      try { sseRef.current?.close() } catch {}
      sseRef.current = null
    }
  }, [apiBaseUrl, url, useSse])

  return { data: data ?? [], error, isLoading, isValidating }
}


