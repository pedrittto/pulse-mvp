import { scoreNews } from '../src/utils/scoring';

describe('Impact Scoring', () => {
  describe('threshold boundaries', () => {
    test('Low impact boundary (score 44)', () => {
      const score = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['TechCrunch'],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() // 48 hours ago
      });
      expect(score.impact).toBe('L');
      expect(score.impact_score).toBeLessThan(45);
    });

    test('Medium impact lower boundary (score 45)', () => {
      const score = scoreNews({
        headline: 'Test headline with partnership',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() // 4 hours ago
      });
      expect(score.impact).toBe('M');
      expect(score.impact_score).toBeGreaterThanOrEqual(45);
      expect(score.impact_score).toBeLessThan(70);
    });

    test('Medium impact upper boundary (score 69)', () => {
      const score = scoreNews({
        headline: 'Test headline with acquisition',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
      });
      expect(score.impact).toBe('M');
      expect(score.impact_score).toBeGreaterThanOrEqual(45);
      expect(score.impact_score).toBeLessThan(70);
    });

    test('High impact boundary (score 70)', () => {
      const score = scoreNews({
        headline: 'Test headline with lawsuit',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 minutes ago
      });
      expect(score.impact).toBe('H');
      expect(score.impact_score).toBeGreaterThanOrEqual(70);
    });

    test('Critical impact boundary (score 80)', () => {
      const score = scoreNews({
        headline: 'Test headline with lawsuit and acquisition',
        description: 'Test description with multiple high impact keywords',
        sources: ['Bloomberg'],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date().toISOString() // Recent
      });
      expect(score.impact).toBe('H'); // V2 doesn't support Critical category
      expect(score.impact_score).toBeGreaterThanOrEqual(70);
    });
  });

  describe('monotonicity', () => {
    test('more tickers should not decrease impact', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date().toISOString()
      });
      
      expect(score2.impact_score).toBeGreaterThanOrEqual(score1.impact_score);
    });

    test('more recent news should not decrease impact', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() // 12 hours ago
      });
      
      const score2 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 minutes ago
      });
      
      expect(score2.impact_score).toBeGreaterThanOrEqual(score1.impact_score);
    });

    test('high impact keywords should not decrease impact', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline with lawsuit',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });
      
      expect(score2.impact_score).toBeGreaterThanOrEqual(score1.impact_score);
    });
  });

  describe('independence from confidence', () => {
    test('same inputs should produce same impact regardless of debug flag', () => {
      const inputs = {
        headline: 'Test headline with acquisition',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };
      
      const score1 = scoreNews({ ...inputs, debug: false });
      const score2 = scoreNews({ ...inputs, debug: true });
      
      expect(score1.impact).toBe(score2.impact);
      expect(score1.impact_score).toBe(score2.impact_score);
    });

    test('confidence changes should not affect impact', () => {
      const baseInputs = {
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };
      
      const score1 = scoreNews(baseInputs);
      
      // Add opinion keyword which affects confidence but not impact
      const score2 = scoreNews({
        ...baseInputs,
        headline: 'Opinion: Test headline'
      });
      
      expect(score1.impact).toBe(score2.impact);
      expect(score1.impact_score).toBe(score2.impact_score);
    });
  });

  describe('feature contributions', () => {
    test('base score should be 20', () => {
      const score = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() // Old news
      });
      
      expect(score.impact_score).toBe(20);
    });

    test('recency boost should be applied correctly', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 minutes ago
      });
      
      const score2 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() // 4 hours ago
      });
      
      const score3 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() // 12 hours ago
      });
      
      expect(score1.impact_score).toBe(35); // 20 + 15
      expect(score2.impact_score).toBe(30); // 20 + 10
      expect(score3.impact_score).toBe(25); // 20 + 5
    });

    test('ticker boost should be applied correctly', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      expect(score1.impact_score).toBe(30); // 20 + 10
      expect(score2.impact_score).toBe(35); // 20 + 15
    });

    test('keyword boost should be applied correctly', () => {
      const score1 = scoreNews({
        headline: 'Test headline with acquisition',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline with partnership',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      const score3 = scoreNews({
        headline: 'Test headline with fed rate hike',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      expect(score1.impact_score).toBe(35); // 20 + 15 (high impact)
      expect(score2.impact_score).toBe(28); // 20 + 8 (medium impact)
      expect(score3.impact_score).toBe(32); // 20 + 12 (macro)
    });

    test('source boost should be applied correctly', () => {
      const score1 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['TechCrunch'],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      expect(score1.impact_score).toBe(26); // 20 + 6 (bloomberg)
      expect(score2.impact_score).toBe(22); // 20 + 2 (techcrunch)
    });
  });

  describe('clipping behavior', () => {
    test('score should not go below 0', () => {
      // This would require negative contributions which aren't possible with current algorithm
      const score = scoreNews({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      expect(score.impact_score).toBeGreaterThanOrEqual(0);
    });

    test('score should not exceed 100', () => {
      const score = scoreNews({
        headline: 'Test headline with lawsuit and acquisition and merger',
        description: 'Test description with multiple high impact keywords',
        sources: ['Bloomberg'],
        tickers: ['AAPL', 'MSFT', 'GOOGL'],
        published_at: new Date().toISOString()
      });
      
      expect(score.impact_score).toBeLessThanOrEqual(100);
    });
  });

  describe('keyword matching', () => {
    test('only first high impact keyword should be counted', () => {
      const score = scoreNews({
        headline: 'Test headline with lawsuit and acquisition',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      // Should only get +15 for first keyword, not +30 for both
      expect(score.impact_score).toBe(35); // 20 + 15
    });

    test('keyword matching should be case insensitive', () => {
      const score1 = scoreNews({
        headline: 'Test headline with LAWSUIT',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      const score2 = scoreNews({
        headline: 'Test headline with lawsuit',
        description: 'Test description',
        sources: [],
        tickers: [],
        published_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      });
      
      expect(score1.impact_score).toBe(score2.impact_score);
    });
  });
});
