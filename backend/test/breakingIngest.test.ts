import { publishStub, enrichItem, getCurrentSourceStats, resetSourceStats } from '../src/ingest/breakingIngest';
import { getDb } from '../src/lib/firestore';
import { snapshotEnv, setTestEnv, restoreEnv } from './helpers/env';

// Mock Firestore
jest.mock('../src/lib/firestore', () => ({
  getDb: jest.fn()
}));

describe('Breaking Ingest', () => {
  let mockDb: any;
  let mockCollection: any;
  let mockDoc: any;
  let mockDocSnap: any;

  beforeEach(() => {
    // Reset source stats before each test
    resetSourceStats();
    snapshotEnv();
    setTestEnv({ FIREBASE_PROJECT_ID: 'test-project' });
    
    mockDocSnap = {
      exists: false,
      data: jest.fn(),
      get: jest.fn()
    };

    mockDoc = {
      get: jest.fn().mockResolvedValue(mockDocSnap),
      set: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined)
    };

    mockCollection = {
      doc: jest.fn().mockReturnValue(mockDoc)
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    };

    (getDb as jest.Mock).mockReturnValue(mockDb);
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('Duplicate aggregation', () => {
    it('should track duplicate counts correctly', async () => {
      // First call - document doesn't exist, should succeed
      mockDocSnap.exists = false;
      
      const result1 = await publishStub({
        title: 'Test Article',
        source: 'Test Source',
        url: 'https://example.com/test1'
      });
      
      expect(result1.success).toBe(true);
      
      // Second call with same title - should be duplicate
      mockDocSnap.exists = true;
      
      const result2 = await publishStub({
        title: 'Test Article',
        source: 'Test Source',
        url: 'https://example.com/test2'
      });
      
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('duplicate');
      
      // Check source stats
      const stats = getCurrentSourceStats();
      expect(stats['Test Source']).toBeDefined();
      expect(stats['Test Source'].new).toBe(1);
      expect(stats['Test Source'].duplicate).toBe(1);
    });

    it('should not spam logs at info level for duplicates', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      // Set up duplicate scenario
      mockDocSnap.exists = true;
      
      await publishStub({
        title: 'Duplicate Article',
        source: 'Test Source',
        url: 'https://example.com/duplicate'
      });
      
      // Check that no duplicate log was printed (debug level)
      const duplicateLogs = consoleSpy.mock.calls.filter(call => 
        call[0]?.includes('Duplicate stub already exists')
      );
      expect(duplicateLogs.length).toBe(0);
      
      consoleSpy.mockRestore();
    });
  });

  describe('arrival_at immutability', () => {
    it('should preserve arrival_at during enrichment', async () => {
      const originalArrivalAt = '2025-08-16T14:00:00.000Z';
      
      // Mock existing document with arrival_at
      mockDocSnap.exists = true;
      mockDocSnap.data.mockReturnValue({
        id: 'test-id',
        title: 'Test Article',
        source: 'Test Source',
        arrival_at: originalArrivalAt,
        url: 'https://example.com/test',
        category: '',
        impact: '',
        confidence_state: undefined,
        why: '',
        tickers: [],
        published_at: originalArrivalAt,
        thread_id: 'test-thread',
        primary_entity: '',
        version: 'v2'
      });
      
      // Mock scoring functions
      jest.doMock('../src/utils/scoring', () => ({
        scoreNews: jest.fn().mockReturnValue({
          impact: 'L',
          impact_score: 20,
          confidence_state: 'reported',
          tags: []
        })
      }));
      
      jest.doMock('../src/utils/factComposer', () => ({
        composeHeadline: jest.fn().mockReturnValue('Test Article'),
        composeSummary: jest.fn().mockReturnValue('Test summary')
      }));
      
      jest.doMock('../src/utils/verification', () => ({
        computeVerification: jest.fn().mockReturnValue({
          status: 'reported'
        })
      }));
      
      await enrichItem('test-id');
      
      // Verify that update was called with arrival_at preserved
      expect(mockDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({
          arrival_at: originalArrivalAt
        })
      );
    });
  });

  describe('Source statistics', () => {
    it('should track statistics per source', async () => {
      // Publish multiple items from different sources
      mockDocSnap.exists = false;
      
      await publishStub({
        title: 'Article 1',
        source: 'Source A',
        url: 'https://example.com/1'
      });
      
      await publishStub({
        title: 'Article 2',
        source: 'Source B',
        url: 'https://example.com/2'
      });
      
      await publishStub({
        title: 'Article 3',
        source: 'Source A',
        url: 'https://example.com/3'
      });
      
      const stats = getCurrentSourceStats();
      
      expect(stats['Source A']).toBeDefined();
      expect(stats['Source A'].new).toBe(2);
      expect(stats['Source A'].fetched).toBe(2);
      
      expect(stats['Source B']).toBeDefined();
      expect(stats['Source B'].new).toBe(1);
      expect(stats['Source B'].fetched).toBe(1);
    });

    it('should reset statistics when resetSourceStats is called', async () => {
      mockDocSnap.exists = false;
      
      await publishStub({
        title: 'Test Article',
        source: 'Test Source',
        url: 'https://example.com/test'
      });
      
      let stats = getCurrentSourceStats();
      expect(stats['Test Source'].new).toBe(1);
      
      resetSourceStats();
      
      stats = getCurrentSourceStats();
      expect(Object.keys(stats)).toHaveLength(0);
    });
  });
});
