import { ingestRSSFeeds } from '../src/ingest/rss';

// Mock fetch globally
global.fetch = jest.fn();

// Mock the storage module to avoid database calls
jest.mock('../src/storage', () => ({
  addNewsItems: jest.fn(() => Promise.resolve({ added: 0, skipped: 0 })),
  generateArticleHash: jest.fn(() => 'test-hash-123')
}));

// Mock the firestore module
jest.mock('../src/lib/firestore', () => ({
  getDb: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        set: jest.fn(() => Promise.resolve())
      }))
    }))
  }))
}));

describe('RSS Concurrency Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should respect concurrency limit of 5 feeds', async () => {
    // Mock successful responses for all feeds
    const mockResponses = Array(10).fill(null).map(() => 
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(`
          <rss>
            <channel>
              <item>
                <title>Test Article</title>
                <description>Test description</description>
                <link>https://example.com</link>
                <pubDate>2024-01-01T00:00:00Z</pubDate>
              </item>
            </channel>
          </rss>
        `)
      } as Response)
    );

    (global.fetch as jest.Mock).mockImplementation(() => {
      return mockResponses.shift();
    });

    const startTime = Date.now();
    await ingestRSSFeeds();
    const duration = Date.now() - startTime;

    // Should have called fetch 10 times (one for each feed)
    expect(global.fetch).toHaveBeenCalledTimes(10);

    // With concurrency limit of 5, should take at least 2 batches
    // Each batch should take some time, so total should be > 100ms
    expect(duration).toBeGreaterThan(100);
  });

  it('should isolate failures using Promise.allSettled', async () => {
    // Mock some successful and some failed responses
    let callCount = 0;
    (global.fetch as jest.Mock).mockImplementation(() => {
      callCount++;
      // First 5 feeds succeed, next 3 fail, last 2 succeed
      if (callCount <= 5 || callCount > 8) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(`
            <rss>
              <channel>
                <item>
                  <title>Test Article</title>
                  <description>Test description</description>
                  <link>https://example.com</link>
                  <pubDate>2024-01-01T00:00:00Z</pubDate>
                </item>
              </channel>
            </rss>
          `)
        } as Response);
      } else {
        return Promise.reject(new Error('Network error'));
      }
    });

    const result = await ingestRSSFeeds();

    // Should have processed all feeds despite some failures
    expect(global.fetch).toHaveBeenCalledTimes(10);
    
    // Should have some successful results
    expect(result.fetched).toBeGreaterThan(0);
    
    // Should have some errors
    expect(result.errors).toBeGreaterThan(0);
    
    // Total should equal the number of feeds
    expect(result.fetched + result.errors).toBe(10);
  });

  it('should handle empty RSS feeds gracefully', async () => {
    // Mock empty RSS responses
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <rss>
          <channel>
          </channel>
        </rss>
      `)
    });

    const result = await ingestRSSFeeds();

    expect(result.fetched).toBe(0);
    expect(result.errors).toBe(0);
  });
});
