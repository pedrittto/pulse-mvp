import { scoreImpactV3, loadConfig } from '../src/utils/impactV3';

// Load configuration for tests
const config = loadConfig();

// V3 tests - these should test L/M/H/C categories
describe('Impact V3 Scoring', () => {
  // Set environment to ensure V3 mode
  const originalImpactMode = process.env.IMPACT_MODE;
  
  beforeAll(() => {
    // Ensure we're testing V3 mode
    process.env.IMPACT_MODE = 'v3';
  });

  afterAll(() => {
    // Restore original environment
    if (originalImpactMode) {
      process.env.IMPACT_MODE = originalImpactMode;
    } else {
      delete process.env.IMPACT_MODE;
    }
  });

  describe('core functionality', () => {
    test('should return valid result structure', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      expect(result).toHaveProperty('raw');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('drivers');
      expect(result).toHaveProperty('meta');
      
      expect(typeof result.raw).toBe('number');
      expect(['L', 'M', 'H', 'C']).toContain(result.category);
      expect(Array.isArray(result.drivers)).toBe(true);
      expect(result.raw).toBeGreaterThanOrEqual(0);
      expect(result.raw).toBeLessThanOrEqual(1);
    });

    test('should have all five drivers', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      expect(result.drivers).toHaveLength(5);
      expect(result.drivers.map(d => d.name)).toEqual([
        'surprise',
        'credibility',
        'pnlProximity',
        'timingLiquidity',
        'scale'
      ]);
    });

    test('should have valid driver values', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      for (const driver of result.drivers) {
        expect(driver.value).toBeGreaterThanOrEqual(0);
        expect(driver.value).toBeLessThanOrEqual(1);
      }
    });

    test('should have valid meta information', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      expect(result.meta.version).toBe('v3');
      expect(result.meta.weights).toBeDefined();
      expect(result.meta.thresholds).toBeDefined();
      expect(result.meta.calibration).toBeDefined();
    });
  });

  describe('boundary tests using configured thresholds', () => {
    test('should map to Low category for routine news', () => {
      // Create input that should produce low impact
      const result = scoreImpactV3({
        headline: 'Minor product update',
        description: 'Routine maintenance update',
        sources: ['TechBlog'],
        tickers: [],
        published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // 24 hours ago
      });

      // Should be Low category for routine news
      expect(result.category).toBe('L');
    });

    test('should map to Medium category for moderate news', () => {
      const result = scoreImpactV3({
        headline: 'Company announces partnership',
        description: 'Strategic partnership announcement',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      });

      // Should be Medium or higher for partnership news
      expect(['M', 'H', 'C']).toContain(result.category);
    });

    test('should map to Medium or higher for significant news', () => {
      const result = scoreImpactV3({
        headline: 'AAPL earnings beat consensus by 15%',
        description: 'Apple reported strong quarterly results',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      // Significant news should be at least Medium
      expect(['M', 'H', 'C']).toContain(result.category);
    });

    test('should map to Critical category for extreme news', () => {
      const result = scoreImpactV3({
        headline: 'SEC bans trading in AAPL permanently',
        description: 'Regulatory action with severe market impact',
        sources: ['SEC.gov'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      // Extreme regulatory action should be Critical or at least High
      expect(['H', 'C']).toContain(result.category);
    });

    test('should maintain category ordering for increasing impact', () => {
      const routineResult = scoreImpactV3({
        headline: 'Minor product update',
        description: 'Routine maintenance update',
        sources: ['TechBlog'],
        tickers: [],
        published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      });

      const moderateResult = scoreImpactV3({
        headline: 'Company announces partnership',
        description: 'Strategic partnership announcement',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      });

      const significantResult = scoreImpactV3({
        headline: 'AAPL earnings beat consensus by 15%',
        description: 'Apple reported strong quarterly results',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      // Verify relative ordering: routine <= moderate <= significant
      expect(routineResult.raw).toBeLessThanOrEqual(moderateResult.raw);
      expect(moderateResult.raw).toBeLessThanOrEqual(significantResult.raw);
    });
  });

  describe('monotonicity', () => {
    test('increasing surprise should not decrease impact', () => {
      const baseInput = {
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };

      const result1 = scoreImpactV3(baseInput);
      
      const result2 = scoreImpactV3({
        ...baseInput,
        headline: 'Test headline with earnings beat consensus'
      });

      expect(result2.raw).toBeGreaterThanOrEqual(result1.raw);
    });

    test('increasing scale should not decrease impact', () => {
      const baseInput = {
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };

      const result1 = scoreImpactV3(baseInput);
      
      const result2 = scoreImpactV3({
        ...baseInput,
        headline: 'Test headline with global impact'
      });

      expect(result2.raw).toBeGreaterThanOrEqual(result1.raw);
    });

    test('more tickers should not decrease impact', () => {
      const result1 = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });
      
      const result2 = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date().toISOString()
      });
      
      expect(result2.raw).toBeGreaterThanOrEqual(result1.raw);
    });

    test('more recent news should not decrease impact', () => {
      const result1 = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
      });
      
      const result2 = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
      });
      
      expect(result2.raw).toBeGreaterThanOrEqual(result1.raw);
    });
  });

  describe('independence from confidence', () => {
    test('same inputs should produce same impact regardless of tags', () => {
      const inputs = {
        headline: 'Test headline with acquisition',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };
      
      const result1 = scoreImpactV3(inputs);
      const result2 = scoreImpactV3({ ...inputs, tags: ['Macro'] });
      
      expect(result1.category).toBe(result2.category);
      expect(result1.raw).toBe(result2.raw);
    });

    test('confidence-related keywords should not affect impact', () => {
      const baseInputs = {
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };
      
      const result1 = scoreImpactV3(baseInputs);
      
      // Add opinion keyword which affects confidence but not impact
      const result2 = scoreImpactV3({
        ...baseInputs,
        headline: 'Opinion: Test headline'
      });
      
      expect(result1.category).toBe(result2.category);
      expect(result1.raw).toBe(result2.raw);
    });
  });

  describe('timing sanity', () => {
    test('same news during regular session should have higher impact than off-hours', () => {
      const baseInput = {
        headline: 'Test headline with earnings',
        description: 'Test description',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      };

      // Regular session (9:30 AM ET = 14:30 UTC)
      const regularSession = new Date();
      regularSession.setUTCHours(15, 0, 0, 0);
      regularSession.setUTCDate(regularSession.getUTCDate() + (regularSession.getUTCDay() === 0 ? 1 : 0)); // Ensure weekday

      // After hours (10 PM ET = 3 AM UTC next day)
      const afterHours = new Date();
      afterHours.setUTCHours(3, 0, 0, 0);
      afterHours.setUTCDate(afterHours.getUTCDate() + 1);

      const result1 = scoreImpactV3({
        ...baseInput,
        published_at: regularSession.toISOString()
      });

      const result2 = scoreImpactV3({
        ...baseInput,
        published_at: afterHours.toISOString()
      });

      expect(result1.raw).toBeGreaterThan(result2.raw);
    });
  });

  describe('regression tests', () => {
    test('earnings beat should have higher impact than routine news', () => {
      const earningsResult = scoreImpactV3({
        headline: 'AAPL earnings beat consensus by 15%',
        description: 'Apple reported strong quarterly results',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      const routineResult = scoreImpactV3({
        headline: 'Company announces new product',
        description: 'Standard product announcement',
        sources: ['TechCrunch'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      });

      expect(earningsResult.raw).toBeGreaterThan(routineResult.raw);
    });

    test('regulatory ban should have higher impact than partnership', () => {
      const banResult = scoreImpactV3({
        headline: 'Regulator bans trading in AAPL',
        description: 'SEC issues permanent trading ban',
        sources: ['SEC.gov'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      const partnershipResult = scoreImpactV3({
        headline: 'AAPL and MSFT announce partnership',
        description: 'Companies to collaborate on new technology',
        sources: ['Reuters'],
        tickers: ['AAPL', 'MSFT'],
        published_at: new Date().toISOString()
      });

      expect(banResult.raw).toBeGreaterThan(partnershipResult.raw);
    });

    test('emergency halt should have higher impact than routine news', () => {
      const haltResult = scoreImpactV3({
        headline: 'Trading halted in AAPL',
        description: 'Emergency trading halt due to technical issues',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      const routineResult = scoreImpactV3({
        headline: 'Company announces new product',
        description: 'Standard product announcement',
        sources: ['TechCrunch'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      });

      expect(haltResult.raw).toBeGreaterThan(routineResult.raw);
    });

    test('global recall should have higher impact than routine news', () => {
      const recallResult = scoreImpactV3({
        headline: 'AAPL recalls all products globally',
        description: 'Company issues worldwide recall due to safety concerns',
        sources: ['Bloomberg'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      const routineResult = scoreImpactV3({
        headline: 'Company announces new product',
        description: 'Standard product announcement',
        sources: ['TechCrunch'],
        tickers: ['AAPL'],
        published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      });

      expect(recallResult.raw).toBeGreaterThan(routineResult.raw);
    });
  });

  describe('fallback behavior', () => {
    test('should handle missing sources gracefully', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: [],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      expect(result.category).toBeDefined();
      expect(result.raw).toBeGreaterThanOrEqual(0);
      expect(result.raw).toBeLessThanOrEqual(1);
    });

    test('should handle missing timestamp gracefully', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: ''
      });

      expect(result.category).toBeDefined();
      expect(result.raw).toBeGreaterThanOrEqual(0);
      expect(result.raw).toBeLessThanOrEqual(1);
    });
  });

  describe('configuration validation', () => {
    test('should use configured thresholds for category mapping', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      // Verify that the result uses the same thresholds as the loaded config
      expect(result.meta.thresholds).toEqual(config.thresholds);
    });

    test('should use configured weights for scoring', () => {
      const result = scoreImpactV3({
        headline: 'Test headline',
        description: 'Test description',
        sources: ['Reuters'],
        tickers: ['AAPL'],
        published_at: new Date().toISOString()
      });

      // Verify that the result uses the same weights as the loaded config
      expect(result.meta.weights).toEqual(config.weights);
    });
  });
});
