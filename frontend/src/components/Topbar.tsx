'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useCallback } from 'react'
import { FilterType } from '@/types'
import WatchlistModal from './WatchlistModal'

interface FilterPillProps {
  filter: FilterType
  label: string
  active: boolean
  onClick: (filter: FilterType) => void
}

function FilterPill({ filter, label, active, onClick }: FilterPillProps) {
  return (
    <button
      onClick={() => onClick(filter)}
      className={`px-3 py-1 text-sm rounded-full transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  )
}

interface TopbarProps {
  onFilterChange: (filter: FilterType, search?: string) => void
  onWatchlistUpdate: () => void
  onRefresh: () => void
}

export default function Topbar({ onFilterChange, onWatchlistUpdate, onRefresh }: TopbarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isWatchlistOpen, setIsWatchlistOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')

  const currentFilter = (searchParams.get('f') as FilterType) || 'all'

  const handleFilterChange = useCallback((filter: FilterType) => {
    const params = new URLSearchParams(searchParams)
    if (filter === 'all') {
      params.delete('f')
    } else {
      params.set('f', filter)
    }
    
    const newUrl = params.toString() ? `?${params.toString()}` : '/'
    router.push(newUrl)
    onFilterChange(filter, searchValue || undefined)
  }, [router, searchParams, onFilterChange, searchValue])

  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value)
    
    // Debounce search
    const timeoutId = setTimeout(() => {
      const params = new URLSearchParams(searchParams)
      if (value.trim()) {
        params.set('q', value.trim())
      } else {
        params.delete('q')
      }
      
      const newUrl = params.toString() ? `?${params.toString()}` : '/'
      router.push(newUrl)
      onFilterChange(currentFilter, value.trim() || undefined)
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [router, searchParams, onFilterChange, currentFilter])

  const handleWatchlistSave = () => {
    onWatchlistUpdate()
    setIsWatchlistOpen(false)
  }

  const filters: { filter: FilterType; label: string }[] = [
    { filter: 'all', label: 'All' },
    { filter: 'market-moving', label: 'Market-moving' },
    { filter: 'macro', label: 'Macro' },
    { filter: 'my', label: 'My' },
  ]

  return (
    <>
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          {/* Top row: Title and buttons */}
          <div className="flex justify-between items-center mb-3">
            <h1 className="text-xl font-semibold text-gray-900">Pulse</h1>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setIsWatchlistOpen(true)}
                className="px-3 py-1 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
              >
                Watchlist
              </button>
              <button
                onClick={onRefresh}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
          
          {/* Bottom row: Filters and search */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {filters.map(({ filter, label }) => (
                <FilterPill
                  key={filter}
                  filter={filter}
                  label={label}
                  active={currentFilter === filter}
                  onClick={handleFilterChange}
                />
              ))}
            </div>
            
            <input
              type="text"
              placeholder="Search..."
              value={searchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="px-3 py-1 text-sm border border-gray-300 rounded w-48 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </div>

      <WatchlistModal
        isOpen={isWatchlistOpen}
        onClose={() => setIsWatchlistOpen(false)}
        onSave={handleWatchlistSave}
      />
    </>
  )
}
