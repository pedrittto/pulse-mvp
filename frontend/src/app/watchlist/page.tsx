'use client';

import { useState, useEffect } from 'react';
import { API_BASE } from '../../lib/config';

interface WatchlistData {
  tickers: string[];
  keywords: string[];
  thresholds: Record<string, number>;
  updated_at?: string;
}

export default function WatchlistPage() {
  const [watchlist, setWatchlist] = useState<WatchlistData>({
    tickers: [],
    keywords: [],
    thresholds: {}
  });
  const [tickerInput, setTickerInput] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load watchlist on mount
  useEffect(() => {
    loadWatchlist();
  }, []);

  const loadWatchlist = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/watchlist`);
      if (response.ok) {
        const data = await response.json();
        setWatchlist(data);
      } else {
        setMessage({ type: 'error', text: 'Failed to load watchlist' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to load watchlist' });
    } finally {
      setIsLoading(false);
    }
  };

  const saveWatchlist = async () => {
    setIsSaving(true);
    setMessage(null);
    
    try {
      const response = await fetch(`${API_BASE}/watchlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(watchlist),
      });

      if (response.ok) {
        const data = await response.json();
        setWatchlist(data);
        setMessage({ type: 'success', text: 'Watchlist saved successfully!' });
      } else {
        const errorData = await response.json();
        setMessage({ type: 'error', text: errorData.error?.message || 'Failed to save watchlist' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save watchlist' });
    } finally {
      setIsSaving(false);
    }
  };

  const addTicker = () => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    
    // Validate ticker format
    if (!/^[A-Z0-9.,-]+$/.test(ticker)) {
      setMessage({ type: 'error', text: 'Invalid ticker format. Only A-Z, 0-9, .,- allowed' });
      return;
    }
    
    if (watchlist.tickers.length >= 30) {
      setMessage({ type: 'error', text: 'Maximum 30 tickers allowed' });
      return;
    }
    
    if (watchlist.tickers.includes(ticker)) {
      setMessage({ type: 'error', text: 'Ticker already exists' });
      return;
    }
    
    setWatchlist(prev => ({
      ...prev,
      tickers: [...prev.tickers, ticker]
    }));
    setTickerInput('');
    setMessage(null);
  };

  const removeTicker = (tickerToRemove: string) => {
    setWatchlist(prev => ({
      ...prev,
      tickers: prev.tickers.filter(ticker => ticker !== tickerToRemove)
    }));
  };

  const addKeyword = () => {
    const keyword = keywordInput.trim();
    if (!keyword) return;
    
    // Validate keyword length
    if (keyword.length < 2 || keyword.length > 40) {
      setMessage({ type: 'error', text: 'Keyword must be 2-40 characters' });
      return;
    }
    
    if (watchlist.keywords.length >= 50) {
      setMessage({ type: 'error', text: 'Maximum 50 keywords allowed' });
      return;
    }
    
    if (watchlist.keywords.includes(keyword)) {
      setMessage({ type: 'error', text: 'Keyword already exists' });
      return;
    }
    
    setWatchlist(prev => ({
      ...prev,
      keywords: [...prev.keywords, keyword]
    }));
    setKeywordInput('');
    setMessage(null);
  };

  const removeKeyword = (keywordToRemove: string) => {
    setWatchlist(prev => ({
      ...prev,
      keywords: prev.keywords.filter(keyword => keyword !== keywordToRemove)
    }));
  };

  const handleKeyPress = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      action();
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Loading watchlist...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Watchlist</h1>
          <p className="text-gray-600">Manage your tickers and keywords for personalized news filtering</p>
        </div>

        {/* Message */}
        {message && (
          <div className={`mb-6 p-4 rounded-md ${
            message.type === 'success' 
              ? 'bg-green-50 border border-green-200 text-green-800' 
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {message.text}
          </div>
        )}

        {/* Tickers Section */}
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Tickers</h2>
          <p className="text-sm text-gray-600 mb-4">
            Add stock tickers to filter news (max 30). Format: A-Z, 0-9, .,- only.
          </p>
          
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              onKeyPress={(e) => handleKeyPress(e, addTicker)}
              placeholder="e.g., AAPL, GOOGL"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={addTicker}
              disabled={!tickerInput.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Add
            </button>
          </div>

          {/* Ticker chips */}
          <div className="flex flex-wrap gap-2">
            {watchlist.tickers.map((ticker) => (
              <div
                key={ticker}
                className="flex items-center gap-2 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm"
              >
                <span>{ticker}</span>
                <button
                  onClick={() => removeTicker(ticker)}
                  className="text-blue-600 hover:text-blue-800"
                >
                  ×
                </button>
              </div>
            ))}
            {watchlist.tickers.length === 0 && (
              <p className="text-gray-500 text-sm">No tickers added yet</p>
            )}
          </div>
        </div>

        {/* Keywords Section */}
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Keywords</h2>
          <p className="text-sm text-gray-600 mb-4">
            Add keywords to filter news content (max 50). Length: 2-40 characters.
          </p>
          
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyPress={(e) => handleKeyPress(e, addKeyword)}
              placeholder="e.g., earnings, AI, guidance"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={addKeyword}
              disabled={!keywordInput.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Add
            </button>
          </div>

          {/* Keyword chips */}
          <div className="flex flex-wrap gap-2">
            {watchlist.keywords.map((keyword) => (
              <div
                key={keyword}
                className="flex items-center gap-2 px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm"
              >
                <span>{keyword}</span>
                <button
                  onClick={() => removeKeyword(keyword)}
                  className="text-green-600 hover:text-green-800"
                >
                  ×
                </button>
              </div>
            ))}
            {watchlist.keywords.length === 0 && (
              <p className="text-gray-500 text-sm">No keywords added yet</p>
            )}
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            onClick={saveWatchlist}
            disabled={isSaving}
            className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {isSaving ? 'Saving...' : 'Save Watchlist'}
          </button>
        </div>

        {/* Info */}
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="font-medium text-blue-900 mb-2">How it works</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Tickers and keywords are used to filter news in the "My" tab</li>
            <li>• News items matching any ticker or keyword will appear in your personalized feed</li>
            <li>• Changes are saved immediately and applied to future news filtering</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
