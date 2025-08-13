'use client';

import { useState, useEffect } from 'react';
import { API_BASE, isUsingProxy } from '@/lib/config';

interface ApiTestResult {
  endpoint: string;
  status: number | null;
  error: string | null;
  response: any;
}

export default function DebugEnvPage() {
  const [apiTests, setApiTests] = useState<ApiTestResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const testEndpoint = async (endpoint: string): Promise<ApiTestResult> => {
    const url = `${API_BASE}${endpoint}`;
    
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      
      return {
        endpoint,
        status: response.status,
        error: null,
        response: data
      };
    } catch (error) {
      return {
        endpoint,
        status: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        response: null
      };
    }
  };

  const runTests = async () => {
    setIsLoading(true);
    setApiTests([]);

    const endpoints = ['/health', '/metrics-lite'];
    const results: ApiTestResult[] = [];

    for (const endpoint of endpoints) {
      const result = await testEndpoint(endpoint);
      results.push(result);
      setApiTests([...results]); // Update state after each test
    }

    setIsLoading(false);
  };

  useEffect(() => {
    runTests();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Environment Debug</h1>
          <p className="text-gray-600">Debug environment variables and API connectivity</p>
        </div>

        {/* Environment Variables */}
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Environment Variables</h2>
          <div className="space-y-3">
            <div>
              <span className="font-medium text-gray-700">NEXT_PUBLIC_API_BASE_URL:</span>
              <code className="ml-2 px-2 py-1 bg-gray-100 rounded text-blue-600">
                {process.env.NEXT_PUBLIC_API_BASE_URL || 'Not set'}
              </code>
            </div>
            <div>
              <span className="font-medium text-gray-700">API_BASE (resolved):</span>
              <code className="ml-2 px-2 py-1 bg-gray-100 rounded text-blue-600">
                {API_BASE}
              </code>
              {isUsingProxy && (
                <span className="ml-2 px-2 py-1 bg-yellow-100 text-yellow-800 rounded text-xs">
                  Using proxy
                </span>
              )}
            </div>
            <div>
              <span className="font-medium text-gray-700">NODE_ENV:</span>
              <code className="ml-2 px-2 py-1 bg-gray-100 rounded text-blue-600">
                {process.env.NODE_ENV || 'Not set'}
              </code>
            </div>
          </div>
        </div>

        {/* API Tests */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-900">API Endpoint Tests</h2>
            <button
              onClick={runTests}
              disabled={isLoading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Testing...' : 'Run Tests'}
            </button>
          </div>

          {apiTests.length === 0 && !isLoading && (
            <p className="text-gray-500">No tests run yet. Click "Run Tests" to start.</p>
          )}

          {isLoading && (
            <div className="text-center py-4">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              <p className="mt-2 text-gray-600">Testing endpoints...</p>
            </div>
          )}

          {apiTests.length > 0 && (
            <div className="space-y-4">
              {apiTests.map((test, index) => (
                <div
                  key={index}
                  className={`border rounded-lg p-4 ${
                    test.error 
                      ? 'border-red-200 bg-red-50' 
                      : test.status && test.status >= 400
                      ? 'border-yellow-200 bg-yellow-50'
                      : 'border-green-200 bg-green-50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-gray-900">
                      {test.endpoint}
                    </h3>
                    <div className="flex items-center gap-2">
                      {test.status && (
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          test.status >= 200 && test.status < 300
                            ? 'bg-green-100 text-green-800'
                            : test.status >= 400 && test.status < 500
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {test.status}
                        </span>
                      )}
                      {test.error && (
                        <span className="px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">
                          Error
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-sm">
                    <div className="mb-1">
                      <span className="font-medium text-gray-700">URL:</span>
                      <code className="ml-2 px-1 py-0.5 bg-gray-100 rounded text-gray-600">
                        {API_BASE}{test.endpoint}
                      </code>
                    </div>
                    
                    {test.error && (
                      <div className="mb-1">
                        <span className="font-medium text-red-700">Error:</span>
                        <div className="mt-1 px-2 py-1 bg-red-100 rounded text-red-600 text-xs">
                          {test.error}
                        </div>
                      </div>
                    )}
                    
                    {test.response && (
                      <div>
                        <span className="font-medium text-gray-700">Response:</span>
                        <pre className="mt-1 px-2 py-1 bg-gray-100 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(test.response, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="font-medium text-blue-900 mb-2">How to use this page</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Check that NEXT_PUBLIC_API_BASE_URL is set correctly</li>
            <li>• Verify that the backend server is running</li>
            <li>• Test API connectivity with the endpoint tests</li>
            <li>• Use the error messages to debug connection issues</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
