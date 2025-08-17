import { addNewsItems, getNewsItems } from '../src/storage';
import { NewsItem } from '../src/types';

describe('Storage functions', () => {
  describe('arrival_at immutability', () => {
    test('should set arrival_at on first insert and never modify it', async () => {
      // Create a test item with a specific arrival_at timestamp
      const originalTimestamp = '2025-01-15T20:17:33.123Z';
      const testItem: NewsItem = {
        id: 'test-immutable-arrival',
        thread_id: 'test-thread-1',
        headline: 'Test headline for arrival immutability',
        why: 'Test description',
        sources: ['test.com'],
        tickers: ['TEST'],
        published_at: '2025-01-15T20:10:00Z',
        ingested_at: '2025-01-15T20:15:00Z',
        arrival_at: originalTimestamp,
        impact: { score: 20, category: 'L' },
        confidence_state: 'reported'
      };

      // First, add the item
      const result1 = await addNewsItems([testItem]);
      expect(result1.added).toBe(1);
      expect(result1.skipped).toBe(0);

      // Try to add the same item again (should be skipped)
      const result2 = await addNewsItems([testItem]);
      expect(result2.added).toBe(0);
      expect(result2.skipped).toBe(1);

      // Fetch the item and verify arrival_at is unchanged
      const items = await getNewsItems(100);
      const fetchedItem = items.find(item => item.id === 'test-immutable-arrival');
      
      expect(fetchedItem).toBeDefined();
      expect(fetchedItem?.arrival_at).toBe(originalTimestamp);
    });

    test('should preserve arrival_at when item is fetched multiple times', async () => {
      // Create a test item
      const originalTimestamp = '2025-01-15T20:17:33.123Z';
      const testItem: NewsItem = {
        id: 'test-fetch-arrival-consistency',
        thread_id: 'test-thread-2',
        headline: 'Test headline for fetch consistency',
        why: 'Test description',
        sources: ['test.com'],
        tickers: ['TEST'],
        published_at: '2025-01-15T20:10:00Z',
        ingested_at: '2025-01-15T20:15:00Z',
        arrival_at: originalTimestamp,
        impact: { score: 20, category: 'L' },
        confidence_state: 'reported'
      };

      // Add the item
      await addNewsItems([testItem]);

      // Fetch the item multiple times
      const fetch1 = await getNewsItems(100);
      const item1 = fetch1.find(item => item.id === 'test-fetch-arrival-consistency');
      
      const fetch2 = await getNewsItems(100);
      const item2 = fetch2.find(item => item.id === 'test-fetch-arrival-consistency');
      
      const fetch3 = await getNewsItems(100);
      const item3 = fetch3.find(item => item.id === 'test-fetch-arrival-consistency');

      // Verify all fetches return the same arrival_at
      expect(item1?.arrival_at).toBe(originalTimestamp);
      expect(item2?.arrival_at).toBe(originalTimestamp);
      expect(item3?.arrival_at).toBe(originalTimestamp);
    });

    test('should set arrival_at to current time if not provided', async () => {
      // Create a test item without arrival_at
      const testItem: NewsItem = {
        id: 'test-auto-arrival',
        thread_id: 'test-thread-3',
        headline: 'Test headline for auto arrival',
        why: 'Test description',
        sources: ['test.com'],
        tickers: ['TEST'],
        published_at: '2025-01-15T20:10:00Z',
        ingested_at: '2025-01-15T20:15:00Z',
        impact: { score: 20, category: 'L' },
        confidence_state: 'reported'
      };

      // Add the item
      const result = await addNewsItems([testItem]);
      expect(result.added).toBe(1);

      // Fetch the item and verify arrival_at was set
      const items = await getNewsItems(100);
      const fetchedItem = items.find(item => item.id === 'test-auto-arrival');
      
      expect(fetchedItem).toBeDefined();
      expect(fetchedItem?.arrival_at).toBeDefined();
      expect(typeof fetchedItem?.arrival_at).toBe('string');
      
      // Verify it's a valid ISO string
      if (fetchedItem?.arrival_at) {
        const arrivalDate = new Date(fetchedItem.arrival_at);
        expect(arrivalDate.toISOString()).toBe(fetchedItem.arrival_at);
      }
    });
  });
});
