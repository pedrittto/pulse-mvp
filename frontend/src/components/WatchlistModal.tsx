'use client'

import { useState, useEffect } from 'react'
import { API_BASE } from '@/lib/config'
import { Watchlist, Impact } from '@/types'

interface WatchlistModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: () => void
}

export default function WatchlistModal({ isOpen, onClose, onSave }: WatchlistModalProps) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToast, setShowToast] = useState(false)
  
  const [formData, setFormData] = useState({
    tickers: '',
    keywords: '',
    min_confidence: 50,
    min_impact: 'M' as Impact,
  })

  // Load existing watchlist when modal opens
  useEffect(() => {
    if (isOpen) {
      loadWatchlist()
    }
  }, [isOpen])

  // Show toast effect
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [showToast])

  const loadWatchlist = async () => {
    setLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`${API_BASE}/watchlist/demo`)
      
      if (response.ok) {
        const watchlist: Watchlist = await response.json()
        setFormData({
          tickers: watchlist.tickers.join(', '),
          keywords: watchlist.keywords.join(', '),
          min_confidence: watchlist.min_confidence,
          min_impact: watchlist.min_impact,
        })
      } else if (response.status === 404) {
        // No existing watchlist, keep defaults
        setFormData({
          tickers: '',
          keywords: '',
          min_confidence: 50,
          min_impact: 'M',
        })
      } else {
        throw new Error(`Failed to load watchlist: ${response.statusText}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load watchlist')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)

    // Basic validation
    const tickers = formData.tickers.split(',').map(t => t.trim()).filter(Boolean)
    const keywords = formData.keywords.split(',').map(k => k.trim()).filter(Boolean)

    if (tickers.length === 0 && keywords.length === 0) {
      setError('Please enter at least one ticker or keyword')
      setSaving(false)
      return
    }

    try {
      const watchlistData: Watchlist = {
        user_id: 'demo',
        tickers,
        keywords,
        min_confidence: formData.min_confidence,
        min_impact: formData.min_impact,
      }

      const response = await fetch(`${API_BASE}/watchlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(watchlistData),
      })

      if (!response.ok) {
        throw new Error(`Failed to save watchlist: ${response.statusText}`)
      }

      setShowToast(true)
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save watchlist')
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    setError(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50 z-40" onClick={handleClose} />
      
      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
          <div className="p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Watchlist Settings</h2>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Loading state */}
            {loading && (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="text-sm text-gray-600 mt-2">Loading watchlist...</p>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {error}
              </div>
            )}

            {/* Form */}
            {!loading && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tickers (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formData.tickers}
                    onChange={(e) => setFormData(prev => ({ ...prev, tickers: e.target.value }))}
                    placeholder="AAPL, GOOGL, MSFT"
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Keywords (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formData.keywords}
                    onChange={(e) => setFormData(prev => ({ ...prev, keywords: e.target.value }))}
                    placeholder="earnings, merger, acquisition"
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Min Confidence ({formData.min_confidence}%)
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={formData.min_confidence}
                    onChange={(e) => setFormData(prev => ({ ...prev, min_confidence: parseInt(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Min Impact
                  </label>
                  <select
                    value={formData.min_impact}
                    onChange={(e) => setFormData(prev => ({ ...prev, min_impact: e.target.value as Impact }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="L">Low</option>
                    <option value="M">Medium</option>
                    <option value="H">High</option>
                  </select>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end space-x-3 mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || loading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-4 right-4 z-60 bg-green-600 text-white px-4 py-2 rounded shadow-lg">
          Saved
        </div>
      )}
    </>
  )
}
