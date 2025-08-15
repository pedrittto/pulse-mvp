import { addNewsItems, getNewsItems } from '../src/storage';
import { NewsItem } from '../src/types';

describe('Storage functions', () => {
  describe('ingested_at immutability', () => {
    test('should not modify ingested_at when document already exists', async () => {
      // Create a test item with a specific ingested_at timestamp
      const originalTimestamp = '2025-01-15T20:17:33.123Z';
      const testItem: NewsItem = {
        id: 'test-immutable-timestamp',
        thread_id: 'test-thread-1',
        headline: 'Test headline for timestamp immutability',
        why: 'Test description',
        sources: ['test.com'],
        tickers: ['TEST'],
        published_at: '2025-01-15T20:10:00Z',
        ingested_at: originalTimestamp,
        impact: 'L',
        impact_score: 20,
        confidence: 50
      };

      // First, add the item
      const result1 = await addNewsItems([testItem]);
      expect(result1.added).toBe(1);
      expect(result1.skipped).toBe(0);

      // Try to add the same item again (should be skipped)
      const result2 = await addNewsItems([testItem]);
      expect(result2.added).toBe(0);
      expect(result2.skipped).toBe(1);

      // Fetch the item and verify ingested_at is unchanged
      const items = await getNewsItems(100);
      const fetchedItem = items.find(item => item.id === 'test-immutable-timestamp');
      
      expect(fetchedItem).toBeDefined();
      expect(fetchedItem?.ingested_at).toBe(originalTimestamp);
      expect(fetchedItem?.arrival_at).toBe(originalTimestamp);
    });

    test('should preserve ingested_at when item is fetched multiple times', async () => {
      // Create a test item
      const originalTimestamp = '2025-01-15T20:17:33.123Z';
      const testItem: NewsItem = {
        id: 'test-fetch-consistency',
        thread_id: 'test-thread-2',
        headline: 'Test headline for fetch consistency',
        why: 'Test description',
        sources: ['test.com'],
        tickers: ['TEST'],
        published_at: '2025-01-15T20:10:00Z',
        ingested_at: originalTimestamp,
        impact: 'L',
        impact_score: 20,
        confidence: 50
      };

      // Add the item
      await addNewsItems([testItem]);

      // Fetch the item multiple times
      const fetch1 = await getNewsItems(100);
      const item1 = fetch1.find(item => item.id === 'test-fetch-consistency');
      
      const fetch2 = await getNewsItems(100);
      const item2 = fetch2.find(item => item.id === 'test-fetch-consistency');
      
      const fetch3 = await getNewsItems(100);
      const item3 = fetch3.find(item => item.id === 'test-fetch-consistency');

      // Verify all fetches return the same ingested_at
      expect(item1?.ingested_at).toBe(originalTimestamp);
      expect(item2?.ingested_at).toBe(originalTimestamp);
      expect(item3?.ingested_at).toBe(originalTimestamp);
      
      expect(item1?.arrival_at).toBe(originalTimestamp);
      expect(item2?.arrival_at).toBe(originalTimestamp);
      expect(item3?.arrival_at).toBe(originalTimestamp);
    });
  });
});
