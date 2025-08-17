import { useCallback } from 'react'
import useSWR, { mutate } from 'swr'
import { FeedResponse, FilterType } from '@/types'
import { fetcher } from './fetcher'

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
  const refreshInterval = parseInt(process.env.NEXT_PUBLIC_FEED_REFRESH_MS || '60000', 10)

  // SWR hook with auto-refresh
  const { data: feedItems, error, isLoading, isValidating } = useSWR<any[]>(
    buildApiUrl(),
    fetcher,
    {
      refreshInterval,
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
    refreshInterval
  }
}
