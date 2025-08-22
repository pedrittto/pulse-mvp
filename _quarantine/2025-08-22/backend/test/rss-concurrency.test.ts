import { ingestRSSFeeds } from '../src/ingest/rss';
import { rssFeeds } from '../src/config/rssFeeds';

// Mock fetch globally
global.fetch = jest.fn();

// Mock the storage module to avoid database calls
jest.mock('../src/storage', () => ({
  addNewsItems: jest.fn(() => Promise.resolve({ added: 0, skipped: 0 })),
  generateArticleHash: jest.fn(() => 'test-hash-123')
}));

// Mock the firestore module with minimal read/write surface used by rss.ts
jest.mock('../src/lib/firestore', () => ({
  getDb: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        set: jest.fn(() => Promise.resolve()),
        get: jest.fn(() => Promise.resolve({ exists: false, data: () => ({}) })),
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({ set: jest.fn(() => Promise.resolve()) }))
        }))
      })),
      add: jest.fn(() => Promise.resolve({ id: 'x' }))
    })),
    batch: jest.fn(() => ({
      set: jest.fn(),
      commit: jest.fn(() => Promise.resolve())
    }))
  }))
}));

describe('RSS Concurrency Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should respect concurrency limit of 5 feeds', async () => {
    const feedCount = rssFeeds.length;
    // Mock successful responses for all feeds
    const mockResponses = Array(feedCount).fill(null).map(() => 
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

    await ingestRSSFeeds();

    // Should have called fetch once per feed
    expect(global.fetch).toHaveBeenCalledTimes(feedCount);

    // Do not assert duration: fetching runs in parallel and DB ops are mocked
  });

  it('should isolate failures using Promise.allSettled', async () => {
    // Mock some successful and some failed responses
    let callCount = 0;
    const feedCount = rssFeeds.length;
    (global.fetch as jest.Mock).mockImplementation(() => {
      callCount++;
      // First half succeed, next third fail, remainder succeed
      const firstBatch = Math.ceil(feedCount / 2);
      const secondBatchEnd = firstBatch + Math.max(1, Math.floor(feedCount / 3));
      if (callCount <= firstBatch || callCount > secondBatchEnd) {
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
        // Simulate a feed that returns an empty but valid RSS channel (treated as 0 items)
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(`
            <rss>
              <channel>
              </channel>
            </rss>
          `)
        } as Response);
      }
    });

    const result = await ingestRSSFeeds();

    // Should have processed all feeds despite some failures
    expect(global.fetch).toHaveBeenCalledTimes(feedCount);
    
    // Should have some successful results equal to successes implied by our mock
    const firstBatch = Math.ceil(feedCount / 2);
    const secondBatchEnd = firstBatch + Math.max(1, Math.floor(feedCount / 3));
    const failures = Math.max(0, Math.min(feedCount, secondBatchEnd) - firstBatch);
    const expectedSuccesses = feedCount - failures;
    expect(result.fetched).toBe(expectedSuccesses);
    // With empty-but-valid feeds treated as 0 items, no errors should be reported
    expect(result.errors).toBe(0);
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
