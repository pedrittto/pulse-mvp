'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { mutate } from 'swr'
import Topbar from '@/components/Topbar'
import FeedItem from '@/components/FeedItem'
import { NewsItem, FeedResponse, FilterType, Watchlist } from '@/types'

interface FeedPageClientProps {
  apiBaseUrl: string
}

// SWR fetcher function
const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function FeedPageClient({ apiBaseUrl }: FeedPageClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  // URL state
  const currentFilter = (searchParams.get('f') as FilterType) || 'all'
  const currentSearch = searchParams.get('q') || ''

  // Build API URL with query parameters
  const buildApiUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: '20' })
    
    if (currentFilter && currentFilter !== 'all') {
      params.set('filter', currentFilter)
    }
    
    if (currentSearch) {
      params.set('q', currentSearch)
    }
    
    return `${apiBaseUrl}/feed?${params.toString()}`
  }, [apiBaseUrl, currentFilter, currentSearch])

  // SWR hook for data fetching
  const { data: feedData, error, isLoading } = useSWR<FeedResponse>(
    buildApiUrl(),
    fetcher,
    {
      onSuccess: (data) => {
        console.info('FEED_LOADED', data.items?.length || 0, data.items?.[0])
      },
      onError: (err) => {
        console.error('Failed to fetch feed data:', err)
      }
    }
  )

  // Handle filter change
  const handleFilterChange = useCallback((filter: FilterType, search?: string) => {
    const params = new URLSearchParams(searchParams)
    if (filter === 'all') {
      params.delete('f')
    } else {
      params.set('f', filter)
    }
    
    if (search) {
      params.set('q', search)
    } else {
      params.delete('q')
    }
    
    const newUrl = params.toString() ? `?${params.toString()}` : '/'
    router.push(newUrl)
  }, [router, searchParams])

  // Handle watchlist update
  const handleWatchlistUpdate = useCallback(() => {
    // Refresh the feed if we're on the "My" filter
    if (currentFilter === 'my') {
      mutate(buildApiUrl())
    }
  }, [currentFilter, buildApiUrl])

  // Handle refresh
  const handleRefresh = useCallback(() => {
    mutate(buildApiUrl())
  }, [buildApiUrl])

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Topbar 
          onFilterChange={handleFilterChange}
          onWatchlistUpdate={handleWatchlistUpdate}
          onRefresh={handleRefresh}
        />
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="text-center py-8">
            <div className="text-gray-600">Loading…</div>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !feedData) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Topbar 
          onFilterChange={handleFilterChange}
          onWatchlistUpdate={handleWatchlistUpdate}
          onRefresh={handleRefresh}
        />
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
            <div className="text-red-600 mb-4">
              <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-red-800 mb-2">Failed to load feed</h3>
            <p className="text-red-600 mb-4">
              Unable to connect to the news feed. Please check your connection and use the Refresh button to try again.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (!feedData.items || feedData.items.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Topbar 
          onFilterChange={handleFilterChange}
          onWatchlistUpdate={handleWatchlistUpdate}
          onRefresh={handleRefresh}
        />
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
            <div className="text-gray-400 mb-4">
              <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-800 mb-2">No items yet</h3>
            <p className="text-gray-600">
              The news feed is empty. Check back later for updates.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Success state - map backend items to UI format
  return (
    <div className="min-h-screen bg-gray-50">
      <Topbar 
        onFilterChange={handleFilterChange}
        onWatchlistUpdate={handleWatchlistUpdate}
        onRefresh={handleRefresh}
      />
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-4">
          {feedData.items.map((item: NewsItem) => {
            // Map backend item to UI item format
            const uiItem = {
              title: item.headline,
              summary: item.description ?? '',
              publishedAt: item.published_at ?? '',
              imageUrl: item.image_url,
              source: item.sources?.[0],
              ticker: item.primary_entity,
              // Keep original fields for existing FeedItem component
              ...item
            }
            
            return <FeedItem key={item.id} item={uiItem} />
          })}
        </div>
      </div>
    </div>
  )
}
