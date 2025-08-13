'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { mutate } from 'swr'
import Topbar from '@/components/Topbar'
import FeedItem from '@/components/FeedItem'
import { NewsItem, FeedResponse, FilterType, Watchlist } from '@/types'
import { fetcher } from '@/lib/fetcher'
import { API_BASE, isUsingProxy } from '@/lib/config'

interface FeedPageClientProps {
  apiBaseUrl: string
}

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

  // Proxy banner
  const ProxyBanner = () => {
    if (!isUsingProxy) return null;
    
    return (
      <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-sm text-yellow-800">
            Using proxy /api → http://localhost:4000 (dev). Set NEXT_PUBLIC_API_BASE_URL for prod.
          </p>
        </div>
      </div>
    );
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ProxyBanner />
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
    const requestUrl = buildApiUrl();
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return (
      <div className="min-h-screen bg-gray-50">
        <ProxyBanner />
        <Topbar 
          onFilterChange={handleFilterChange}
          onWatchlistUpdate={handleWatchlistUpdate}
          onRefresh={handleRefresh}
        />
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <div className="text-red-600 mb-4 text-center">
              <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-red-800 mb-4 text-center">Failed to load feed</h3>
            
            {/* Debug Information */}
            <div className="bg-white border border-red-200 rounded p-4 mb-4">
              <h4 className="font-medium text-red-800 mb-2">Debug Information:</h4>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-medium text-gray-700">API Base URL:</span>
                  <code className="ml-2 px-2 py-1 bg-gray-100 rounded text-red-600">
                    {API_BASE}
                  </code>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Request URL:</span>
                  <code className="ml-2 px-2 py-1 bg-gray-100 rounded text-red-600 break-all">
                    {requestUrl}
                  </code>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Error Message:</span>
                  <div className="mt-1 px-2 py-1 bg-gray-100 rounded text-red-600 break-words">
                    {errorMessage}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="text-center">
              <p className="text-red-600 mb-4">
                Unable to connect to the news feed. Please check your connection and use the Refresh button to try again.
              </p>
              <button
                onClick={handleRefresh}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (!feedData.items || feedData.items.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ProxyBanner />
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
            <h3 className="text-lg font-medium text-gray-800 mb-2">
              {currentFilter === 'my' ? 'No personalized items' : 'No items yet'}
            </h3>
            <p className="text-gray-600 mb-4">
              {currentFilter === 'my' 
                ? 'No news items match your watchlist. Add tickers and keywords to see personalized content.'
                : 'The news feed is empty. Check back later for updates.'
              }
            </p>
            {currentFilter === 'my' && (
              <div className="flex justify-center gap-3">
                <button
                  onClick={() => handleFilterChange('all')}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  View All News
                </button>
                <button
                  onClick={() => router.push('/watchlist')}
                  className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors"
                >
                  Manage Watchlist
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Success state - map backend items to UI format
  return (
    <div className="min-h-screen bg-gray-50">
      <ProxyBanner />
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
