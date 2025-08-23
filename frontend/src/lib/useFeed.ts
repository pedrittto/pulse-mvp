import { useCallback, useEffect, useRef } from 'react'
import useSWR, { mutate } from 'swr'
import { FeedResponse, FilterType } from '@/types'
import { fetcher } from './fetcher'
import { subscribeNewItems } from './sse'

interface UseFeedOptions {
  apiBaseUrl: string
  filter: FilterType
  search?: string
  limit?: number
}

export function useFeed({ apiBaseUrl, filter, search, limit = 20 }: UseFeedOptions) {
  // Build API URL with query parameters
  const buildApiUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: limit.toString() })
    
    if (filter && filter !== 'all') {
      params.set('filter', filter)
    }
    
    if (search) {
      params.set('q', search)
    }
    
    return `${apiBaseUrl}/feed?${params.toString()}`
  }, [apiBaseUrl, filter, search, limit])

  // Get refresh interval from environment variable
  const baseRefreshInterval = parseInt(process.env.NEXT_PUBLIC_FEED_REFRESH_MS || '60000', 10)
  const useSse = String(process.env.NEXT_PUBLIC_USE_SSE || 'true').toLowerCase() === 'true'

  // SWR hook with auto-refresh
  const { data: feedItems, error, isLoading, isValidating } = useSWR<any[]>(
    buildApiUrl(),
    fetcher,
    {
      refreshInterval: useSse ? 0 : baseRefreshInterval,
      keepPreviousData: true, // Keep previous data while fetching new data
      revalidateOnFocus: false, // Don't revalidate when window gains focus
      revalidateOnReconnect: true, // Revalidate when reconnecting to network
      onSuccess: (data) => {
        console.info('FEED_LOADED', data?.length || 0, data?.[0])
      },
      onError: (err) => {
        console.error('Failed to fetch feed data:', err)
      },
      onLoadingSlow: () => {
        console.warn('Feed data loading is taking longer than expected')
      }
    }
  )

  // SSE subscription to trigger immediate refreshes (debounced)
  const sseRef = useRef<{ close: () => void } | null>(null)
  useEffect(() => {
    if (!useSse) return
    let debounceTimer: any = null
    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        mutate(buildApiUrl())
      }, 250)
    }
    // Subscribe to backend SSE for new items
    const sub = subscribeNewItems(apiBaseUrl, () => {
      trigger()
    })
    sseRef.current = sub
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      try { sseRef.current?.close() } catch {}
      sseRef.current = null
    }
    // Intentionally exclude buildApiUrl identity change from deps to avoid resubscribing on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, useSse])

  // Manual refresh function
  const refresh = useCallback(() => {
    mutate(buildApiUrl())
  }, [buildApiUrl])

  return {
    data: feedItems ?? [],
    error,
    isLoading,
    isValidating,
    refresh,
    refreshInterval: useSse ? 0 : baseRefreshInterval
  }
}
