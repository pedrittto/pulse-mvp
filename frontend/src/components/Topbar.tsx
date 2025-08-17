'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useCallback } from 'react'
import { FilterType } from '@/types'

interface FilterPillProps {
  filter: FilterType
  label: string
  active: boolean
  onClick: (filter: FilterType) => void
}

function FilterPill({ filter, label, active, onClick }: FilterPillProps) {
  const base = 'inline-flex items-center rounded-full px-3 py-1 text-sm transition-colors';
  const unselected = 'border border-neutral-800 bg-neutral-900/70 text-neutral-300 hover:bg-neutral-900';
  const selected = 'border border-neutral-700 bg-neutral-800 text-neutral-100';
  return (
    <button
      onClick={() => onClick(filter)}
      className={`${base} ${active ? selected : unselected}`}
    >
      {label}
    </button>
  )
}

interface TopbarProps {
  onFilterChange: (filter: FilterType, search?: string) => void
  onWatchlistUpdate: () => void
  onRefresh: () => void
  isValidating?: boolean
}

export default function Topbar({ onFilterChange, onWatchlistUpdate, onRefresh, isValidating }: TopbarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
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



  const filters: { filter: FilterType; label: string }[] = [
    { filter: 'all', label: 'All' },
    { filter: 'market-moving', label: 'Market-moving' },
    { filter: 'macro', label: 'Macro' },
    { filter: 'my', label: 'My' },
  ]

  return (
    <>
      <div className="border-b border-neutral-900/60 px-4 py-3 bg-neutral-950/60 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/40">
        <div className="max-w-4xl mx-auto">
          {/* Top row: Title and buttons */}
          <div className="flex justify-between items-center mb-3">
            <h1 className="text-xl font-semibold text-neutral-200">Pulse</h1>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => router.push('/watchlist')}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-850"
              >
                Watchlist
              </button>
              <button
                onClick={onRefresh}
                disabled={isValidating}
                className={`rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-750 active:bg-neutral-700 flex items-center gap-2 ${isValidating ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                {isValidating && (
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                )}
                Refresh
              </button>
            </div>
          </div>
          
          {/* Bottom row: Filters and search */}
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-2 items-center">
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
              className="w-full md:w-72 rounded-md border border-neutral-800 bg-neutral-900/80 px-3 py-2 text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-600 focus:border-neutral-600"
            />
          </div>
        </div>
      </div>
    </>
  )
}
