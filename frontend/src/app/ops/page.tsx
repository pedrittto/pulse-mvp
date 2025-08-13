'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { API_BASE } from '../../lib/config';
import { fetcher } from '../../lib/fetcher';

interface MetricsData {
  ok: boolean;
  last_run: string | null;
  counts: {
    fetched: number;
    added: number;
    skipped: number;
    errors: number;
  };
  feed_count: number | null;
  now: string;
}



function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default function OpsPage() {
  const [refreshInterval, setRefreshInterval] = useState(30000); // 30 seconds
  
  const { data, error, isLoading, mutate } = useSWR<MetricsData>(
    `${API_BASE}/metrics-lite`,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: false,
    }
  );

  const handleRefresh = () => {
    mutate();
  };

  const toggleAutoRefresh = () => {
    setRefreshInterval(prev => prev === 0 ? 30000 : 0);
  };

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h1 className="text-xl font-semibold text-red-800 mb-2">Error Loading Metrics</h1>
            <p className="text-red-600">Failed to load operational metrics. Please try again.</p>
            <button
              onClick={handleRefresh}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
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
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Operations Dashboard</h1>
          <p className="text-gray-600">Real-time system metrics and status</p>
        </div>

        {/* Controls */}
        <div className="mb-6 flex gap-3">
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={toggleAutoRefresh}
            className={`px-4 py-2 rounded-md transition-colors ${
              refreshInterval > 0 
                ? 'bg-green-600 text-white hover:bg-green-700' 
                : 'bg-gray-600 text-white hover:bg-gray-700'
            }`}
          >
            {refreshInterval > 0 ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
          </button>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Last Run */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Last Run
            </h3>
            <div className="space-y-1">
              <p className="text-2xl font-bold text-gray-900">
                {data?.last_run ? formatRelativeTime(data.last_run) : 'Never'}
              </p>
              <p className="text-xs text-gray-500">
                {data?.last_run || 'No data available'}
              </p>
            </div>
          </div>

          {/* Feed Count */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Feed Count
            </h3>
            <p className="text-2xl font-bold text-gray-900">
              {data?.feed_count !== null && data?.feed_count !== undefined ? data.feed_count.toLocaleString() : 'N/A'}
            </p>
          </div>

          {/* Fetched */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Fetched
            </h3>
            <p className="text-2xl font-bold text-blue-600">
              {data?.counts?.fetched?.toLocaleString() || '0'}
            </p>
          </div>

          {/* Added */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Added
            </h3>
            <p className="text-2xl font-bold text-green-600">
              {data?.counts?.added?.toLocaleString() || '0'}
            </p>
          </div>

          {/* Skipped */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Skipped
            </h3>
            <p className="text-2xl font-bold text-yellow-600">
              {data?.counts?.skipped?.toLocaleString() || '0'}
            </p>
          </div>

          {/* Errors */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Errors
            </h3>
            <p className="text-2xl font-bold text-red-600">
              {data?.counts?.errors?.toLocaleString() || '0'}
            </p>
          </div>

          {/* Status */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Status
            </h3>
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${data?.ok ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="font-medium text-gray-900">
                {data?.ok ? 'Healthy' : 'Error'}
              </span>
            </div>
          </div>

          {/* Last Updated */}
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
              Last Updated
            </h3>
            <p className="text-sm text-gray-900">
              {data?.now ? new Date(data.now).toLocaleTimeString() : 'N/A'}
            </p>
          </div>
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="mt-6 text-center">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Loading metrics...</p>
          </div>
        )}
      </div>
    </div>
  );
}
