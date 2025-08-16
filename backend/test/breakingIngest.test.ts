import { publishStub, enrichItem, getSourceLatencyStats } from '../src/ingest/breakingIngest';
import { getDb } from '../src/lib/firestore';

// Mock Firestore
jest.mock('../src/lib/firestore');
const mockDb = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  get: jest.fn(),
  set: jest.fn(),
  update: jest.fn(),
  add: jest.fn(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis()
};

(getDb as jest.Mock).mockReturnValue(mockDb);

describe('Breaking Ingest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('publishStub', () => {
    it('should publish a stub immediately', async () => {
      const mockDocSnap = {
        exists: false
      };
      mockDb.get.mockResolvedValue(mockDocSnap);
      mockDb.set.mockResolvedValue(undefined);
      mockDb.add.mockResolvedValue(undefined);

      const result = await publishStub({
        title: 'Test Breaking News',
        source: 'Reuters Business',
        url: 'https://example.com/test',
        published_at: '2024-01-01T12:00:00Z'
      });

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Breaking News',
        source: 'Reuters Business',
        url: 'https://example.com/test',
        category: '',
        impact: '',
        confidence: null,
        why: '',
        tickers: []
      }));
    });

    it('should skip duplicate stubs', async () => {
      const mockDocSnap = {
        exists: true
      };
      mockDb.get.mockResolvedValue(mockDocSnap);

      const result = await publishStub({
        title: 'Test Breaking News',
        source: 'Reuters Business',
        url: 'https://example.com/test'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('duplicate');
      expect(mockDb.set).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockDb.get.mockRejectedValue(new Error('Database error'));

      const result = await publishStub({
        title: 'Test Breaking News',
        source: 'Reuters Business',
        url: 'https://example.com/test'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
    });
  });

  describe('enrichItem', () => {
    it('should enrich a stub with scoring and analysis', async () => {
      const mockStub = {
        id: 'test-id',
        title: 'Apple Reports Strong Q4 Earnings',
        source: 'Reuters Business',
        arrival_at: '2024-01-01T12:00:00Z',
        published_at: '2024-01-01T12:00:00Z',
        why: '',
        tickers: []
      };

      const mockDocSnap = {
        exists: true,
        data: () => mockStub
      };

      mockDb.get.mockResolvedValue(mockDocSnap);
      mockDb.update.mockResolvedValue(undefined);

      const result = await enrichItem('test-id');

      expect(result.success).toBe(true);
      expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({
        headline: expect.stringContaining('Apple'),
        why: expect.any(String),
        tickers: expect.arrayContaining([expect.stringMatching(/Apple|AAPL/)]),
        impact: expect.stringMatching(/[LMHC]/),
        confidence: expect.any(Number),
        primary_entity: expect.stringMatching(/Apple|AAPL/),
        // Preserve arrival_at exactly
        arrival_at: '2024-01-01T12:00:00Z'
      }));
    });

    it('should handle missing stub', async () => {
      const mockDocSnap = {
        exists: false
      };
      mockDb.get.mockResolvedValue(mockDocSnap);

      const result = await enrichItem('non-existent-id');

      expect(result.success).toBe(false);
      expect(result.error).toBe('stub_not_found');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('should preserve arrival_at during enrichment', async () => {
      const originalArrivalAt = '2024-01-01T12:00:00Z';
      const mockStub = {
        id: 'test-id',
        title: 'Test News',
        source: 'Reuters Business',
        arrival_at: originalArrivalAt,
        published_at: '2024-01-01T12:00:00Z',
        why: '',
        tickers: []
      };

      const mockDocSnap = {
        exists: true,
        data: () => mockStub
      };

      mockDb.get.mockResolvedValue(mockDocSnap);
      mockDb.update.mockResolvedValue(undefined);

      await enrichItem('test-id');

      expect(mockDb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          arrival_at: originalArrivalAt
        })
      );
    });
  });

  describe('getSourceLatencyStats', () => {
    it('should return latency statistics for a source', async () => {
      const mockDocs = [
        { data: () => ({ t_publish_ms: 100 }) },
        { data: () => ({ t_publish_ms: 200 }) },
        { data: () => ({ t_publish_ms: 300 }) },
        { data: () => ({ t_publish_ms: 400 }) },
        { data: () => ({ t_publish_ms: 500 }) }
      ];

      const mockSnapshot = {
        forEach: (callback: (doc: any) => void) => {
          mockDocs.forEach(callback);
        }
      };

      mockDb.where.mockReturnThis();
      mockDb.orderBy.mockReturnThis();
      mockDb.get.mockResolvedValue(mockSnapshot);

      const stats = await getSourceLatencyStats('Reuters Business', 24);

      expect(stats.count).toBe(5);
      expect(stats.p50).toBe(300);
      expect(stats.p90).toBe(500);
      expect(stats.avg_publish_ms).toBe(300);
    });

    it('should handle empty results', async () => {
      const mockSnapshot = {
        forEach: (callback: (doc: any) => void) => {
          // No documents
        }
      };

      mockDb.where.mockReturnThis();
      mockDb.orderBy.mockReturnThis();
      mockDb.get.mockResolvedValue(mockSnapshot);

      const stats = await getSourceLatencyStats('Reuters Business', 24);

      expect(stats.count).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p90).toBe(0);
      expect(stats.avg_publish_ms).toBe(0);
    });
  });
});
