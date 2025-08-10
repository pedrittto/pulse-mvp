import { Suspense } from 'react'
import FeedPageClient from './FeedPageClient'
import { FeedResponse, Watchlist } from '@/types'
import { API_BASE } from '@/lib/config'

// Server-side data fetching
async function getInitialFeedData(): Promise<FeedResponse | null> {
  try {
    const response = await fetch(`${API_BASE}/feed?limit=20`, {
      next: { revalidate: 60 }, // Revalidate every 60 seconds
    })
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    const data = await response.json()
    return data
  } catch (error) {
    console.error('Failed to fetch initial feed data:', error)
    return null
  }
}

async function getInitialWatchlist(): Promise<Watchlist | null> {
  try {
    const response = await fetch(`${API_BASE}/watchlist/demo`)
    
    if (response.ok) {
      return await response.json()
    } else if (response.status === 404) {
      return null
    } else {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
  } catch (error) {
    console.error('Failed to fetch initial watchlist:', error)
    return null
  }
}

function LoadingState() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex justify-between items-center mb-3">
            <h1 className="text-xl font-semibold text-gray-900">Pulse</h1>
            <div className="flex items-center space-x-2">
              <div className="px-3 py-1 text-sm bg-gray-200 rounded animate-pulse w-20"></div>
              <div className="px-3 py-1 text-sm bg-gray-200 rounded animate-pulse w-16"></div>
            </div>
          </div>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-lg p-4 animate-pulse">
              <div className="flex items-center space-x-3 mb-2">
                <div className="h-4 bg-gray-200 rounded w-16"></div>
                <div className="h-4 bg-gray-200 rounded w-24"></div>
                <div className="h-6 bg-gray-200 rounded w-20"></div>
              </div>
              <div className="h-6 bg-gray-200 rounded w-3/4 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-full mb-1"></div>
              <div className="h-4 bg-gray-200 rounded w-2/3"></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

async function FeedPageContent() {
  // Fetch initial data on server
  const [initialFeed, initialWatchlist] = await Promise.all([
    getInitialFeedData(),
    getInitialWatchlist()
  ])

  return (
    <FeedPageClient 
      initialFeed={initialFeed}
      initialWatchlist={initialWatchlist}
      apiBaseUrl={API_BASE}
    />
  )
}

export default function HomePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <FeedPageContent />
    </Suspense>
  )
}
