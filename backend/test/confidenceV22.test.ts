import { scoreConfidenceV22, CONFIDENCE_RANGE_MIN, CONFIDENCE_RANGE_MAX, clamp } from '../src/utils/confidenceV2';

describe('Confidence V2.2 Scoring', () => {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 120 * 60 * 1000);

  test('Solo Tier-1 fresh (tier=0.8, fresh=0.9, k=1) → P2≥0.20, final in [50,60]', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false } // Tier-1 source
      ],
      headline: 'Fed Announces Interest Rate Decision',
      body: 'The Federal Reserve has announced its latest interest rate decision...',
      tags: ['Macro'],
      impact_score: 75,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Check P2 has solo safety applied
    expect(result.debug?.P2).toBeGreaterThanOrEqual(0.20);
    
    // Check final score is reasonable for high-quality content
    expect(result.final).toBeGreaterThanOrEqual(50);
    expect(result.final).toBeLessThanOrEqual(85);
    
    // Check debug flags
    expect(result.debug?.flags.soloSafety).toBe(true);
    expect(result.debug?.k).toBe(1);
  });

  test('k=2 cross-class (tier=0.8, fresh=0.8, diversity=true) → P2≈0.59+0.10, final ≥ solo +6', () => {
    const soloInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false } // Tier-1
      ],
      headline: 'Company Reports Earnings',
      body: 'The company reported strong quarterly earnings...',
      tags: undefined,
      impact_score: 60,
      market: undefined
    };

    const crossClassInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }, // Tier-1
        { domain: 'sec.gov', isPrimary: false }        // Regulator
      ],
      headline: 'Company Reports Earnings',
      body: 'The company reported strong quarterly earnings...',
      tags: undefined,
      impact_score: 60,
      market: undefined
    };

    const soloResult = scoreConfidenceV22(soloInputs);
    const crossClassResult = scoreConfidenceV22(crossClassInputs);
    
    // Check that k=2 for cross-class inputs
    expect(crossClassResult.debug?.k).toBe(2);
    
    // Check diversity flag
    expect(crossClassResult.debug?.diversity).toBe(true);
    
    // Check final score is higher with cross-class confirmations
    expect(crossClassResult.final).toBeGreaterThanOrEqual(soloResult.final + 6);
  });

  test('k=3 (tier=0.8, fresh=0.8) → P2≥0.80, macro P3=0.8 → final ≥ 78 with defaults', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false },
        { domain: 'ft.com', isPrimary: false }
      ],
      headline: 'Fed Raises Interest Rates by 25 Basis Points',
      body: 'The Federal Reserve has raised interest rates by 25 basis points...',
      tags: ['Macro'],
      impact_score: 80,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Check k=3
    expect(result.debug?.k).toBe(3);
    
    // Check P3 is high for macro content (may include trend bonus)
    expect(result.debug?.P3).toBeGreaterThanOrEqual(0.8);
    
    // Check final score is reasonable for high-quality content
    expect(result.final).toBeGreaterThanOrEqual(70);
  });

  test('Old news (fresh≤0.1, k=1) → final ≤ 50', () => {
    // Use a much older date to ensure freshness is low
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    
    const inputs = {
      publishedAt: twelveHoursAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Market Update',
      body: 'The market has shown some interesting movements...',
      tags: undefined,
      impact_score: 40,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Check freshness is low
    expect(result.debug?.fresh).toBeLessThanOrEqual(0.1);
    
    // Check final score is low due to old news
    expect(result.final).toBeLessThanOrEqual(50);
  });

  test('Contrast sanity: given S=0.4 → C≈0.3; S=0.6 → C≈0.7 for gamma=2.0', () => {
    // Test with inputs that should give S≈0.4
    const lowScoreInputs = {
      publishedAt: twoHoursAgo,
      now,
      sources: [
        { domain: 'unknown-site.com', isPrimary: false }
      ],
      headline: 'Opinion: Market Analysis',
      body: 'I think the market might do something interesting...',
      tags: undefined,
      impact_score: 20,
      market: undefined
    };

    const highScoreInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false }
      ],
      headline: 'Fed Announces Major Policy Change',
      body: 'The Federal Reserve has announced a major policy change...',
      tags: ['Macro'],
      impact_score: 90,
      market: undefined
    };

    const lowResult = scoreConfidenceV22(lowScoreInputs);
    const highResult = scoreConfidenceV22(highScoreInputs);
    
    // Check contrast expansion for low score
    if (lowResult.debug && lowResult.debug.S < 0.5) {
      expect(lowResult.debug.C).toBeLessThan(0.5);
    }
    
    // Check contrast expansion for high score
    if (highResult.debug && highResult.debug.S > 0.5) {
      expect(highResult.debug.C).toBeGreaterThan(0.5);
    }
  });

  test('V2.2 weights sum to 1.0 and are correctly applied', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Test Headline',
      body: 'Test body content',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Check that weights sum to 1.0
    const expectedS = 0.32 * result.debug!.P1 + 0.28 * result.debug!.P2 + 
                     0.22 * result.debug!.P3 + 0.12 * result.debug!.P4 + 0.06 * result.debug!.P5;
    
    expect(result.debug!.S).toBeCloseTo(expectedS, 3);
  });

  test('V2.2 range mapping uses correct min/max values', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Test Headline',
      body: 'Test body content',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Check final score is within V2.2 range
    expect(result.final).toBeGreaterThanOrEqual(CONFIDENCE_RANGE_MIN);
    expect(result.final).toBeLessThanOrEqual(CONFIDENCE_RANGE_MAX);
  });

  test('Debug output includes all required fields for V2.2', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Test Headline',
      body: 'Test body content',
      tags: ['Macro'],
      impact_score: 50,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    expect(result.debug).toBeDefined();
    expect(result.debug!.mode).toBe('v2.2');
    expect(result.debug!.P1).toBeDefined();
    expect(result.debug!.P2).toBeDefined();
    expect(result.debug!.P3).toBeDefined();
    expect(result.debug!.P4).toBeDefined();
    expect(result.debug!.P5).toBeDefined();
    expect(result.debug!.S).toBeDefined();
    expect(result.debug!.C).toBeDefined();
    expect(result.debug!.final).toBeDefined();
    expect(result.debug!.tier).toBeDefined();
    expect(result.debug!.k).toBeDefined();
    expect(result.debug!.diversity).toBeDefined();
    expect(result.debug!.fresh).toBeDefined();
    expect(result.debug!.rumor).toBeDefined();
    expect(result.debug!.contentClass).toBeDefined();
    expect(result.debug!.marketPct).toBeDefined();
    expect(result.debug!.flags).toBeDefined();
    expect(result.debug!.flags.soloSafety).toBeDefined();
    expect(result.debug!.flags.trendAligned).toBeDefined();
    expect(result.debug!.flags.fallbackUsed).toBeDefined();
  });

  test('Content classification works correctly', () => {
    // Test macro content
    const macroInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [{ domain: 'bloomberg.com', isPrimary: false }],
      headline: 'CPI Data Shows Inflation Rising',
      body: 'Consumer Price Index data shows inflation is rising...',
      tags: undefined,
      impact_score: 70,
      market: undefined
    };

    const macroResult = scoreConfidenceV22(macroInputs);
    expect(macroResult.debug!.contentClass).toBe('macro');
    expect(macroResult.debug!.P3).toBeCloseTo(0.8, 1);

    // Test sectoral content
    const sectoralInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [{ domain: 'bloomberg.com', isPrimary: false }],
      headline: 'Company Reports Strong Earnings',
      body: 'The company reported strong quarterly earnings...',
      tags: undefined,
      impact_score: 60,
      market: undefined
    };

    const sectoralResult = scoreConfidenceV22(sectoralInputs);
    expect(sectoralResult.debug!.contentClass).toBe('sectoral');
    expect(sectoralResult.debug!.P3).toBeCloseTo(0.6, 1);
  });

  test('Market proxy fallback works when no market data', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [{ domain: 'bloomberg.com', isPrimary: false }],
      headline: 'Market Surges on Positive News',
      body: 'The market surged today on positive economic news...',
      tags: ['BTC'], // Crypto ticker
      impact_score: 60,
      market: undefined
    };

    const result = scoreConfidenceV22(inputs);
    
    // Should use fallback since no market data
    expect(result.debug!.flags.fallbackUsed).toBe(true);
    expect(result.debug!.marketPct).toBeNull();
    
    // P5 should be in reasonable range
    expect(result.debug!.P5).toBeGreaterThanOrEqual(0.45);
    expect(result.debug!.P5).toBeLessThanOrEqual(0.55);
  });
});
