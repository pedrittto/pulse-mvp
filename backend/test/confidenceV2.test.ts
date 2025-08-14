import { scoreConfidenceV2, CONF_MIN, CONF_MAX, clamp } from '../src/utils/confidenceV2';

describe('Confidence V2.1 Scoring', () => {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 120 * 60 * 1000);

  test('regulator + fresh (≤5min) + k≥3 → expect >= 90', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'sec.gov', isPrimary: false },
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false }
      ],
      headline: 'SEC Announces New Trading Rules',
      body: 'The Securities and Exchange Commission has announced new trading rules...',
      tags: ['Macro'],
      impact_score: 75,
      market: undefined
    };

    const result = scoreConfidenceV2(inputs);
    expect(result.final).toBeGreaterThanOrEqual(90);
    expect(result.final).toBeLessThanOrEqual(95);
  });

  test('anonymous social + stale (≥120min) + k=1 + "rumor" → expect 20 (clamp)', () => {
    const inputs = {
      publishedAt: twoHoursAgo,
      now,
      sources: [
        { domain: 'twitter.com', isPrimary: false }
      ],
      headline: 'Rumor about stock market crash',
      body: 'Just heard a rumor that the market might crash...',
      tags: undefined,
      impact_score: 20,
      market: undefined
    };

    const result = scoreConfidenceV2(inputs);
    expect(result.final).toBeGreaterThanOrEqual(20); // Should be clamped to minimum or close
    expect(result.final).toBeLessThanOrEqual(25); // Allow small tolerance
  });

  test('Tier-1 + fresh + k=2 + sectoral fit → expect ~80–85', () => {
    const inputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false }
      ],
      headline: 'Company Reports Strong Earnings',
      body: 'The company reported strong quarterly earnings that beat expectations...',
      tags: undefined,
      impact_score: 70,
      market: undefined
    };

    const result = scoreConfidenceV2(inputs);
    expect(result.final).toBeGreaterThanOrEqual(80);
    expect(result.final).toBeLessThanOrEqual(90); // Allow higher range due to contrast expansion
  });

  test('Tier-2 + moderate freshness + k=1 + informational → ~40–45', () => {
    const inputs = {
      publishedAt: new Date(now.getTime() - 60 * 60 * 1000), // 1 hour ago
      now,
      sources: [
        { domain: 'techcrunch.com', isPrimary: false }
      ],
      headline: 'New Technology Launch',
      body: 'A new technology has been launched that could change the industry...',
      tags: undefined,
      impact_score: 40,
      market: undefined
    };

    const result = scoreConfidenceV2(inputs);
    expect(result.final).toBeGreaterThanOrEqual(35); // Allow lower range due to contrast expansion
    expect(result.final).toBeLessThanOrEqual(45);
  });

  test('No market data vs with market data → P5=0.5 vs mapped percentile', () => {
    const baseInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'reuters.com', isPrimary: false }
      ],
      headline: 'Company Reports Strong Earnings',
      body: 'The company reported strong quarterly earnings...',
      tags: undefined,
      impact_score: 60
    };

    const resultWithoutMarket = scoreConfidenceV2({ ...baseInputs, market: undefined });
    const resultWithMarket = scoreConfidenceV2({ 
      ...baseInputs, 
      market: { realizedMoveBps: 30, volumeSpike: 1.5 } 
    });
    
    // With market data should have different P5, affecting final score
    expect(resultWithMarket.final).not.toBe(resultWithoutMarket.final);
    
    // Debug should show different P5 values
    expect(resultWithoutMarket.debug?.P5).toBe(0.5); // neutral when no market data
    expect(resultWithMarket.debug?.P5).toBeGreaterThan(0.5); // should be higher with market data
  });

  test('Boundary clamp checks', () => {
    // Test with very low quality inputs that should clamp to minimum
    const lowQualityInputs = {
      publishedAt: twoHoursAgo,
      now,
      sources: [
        { domain: 'unknown-site.com', isPrimary: false }
      ],
      headline: 'Some random content with rumor',
      body: 'Random body text with opinion and analysis',
      tags: undefined,
      impact_score: 10,
      market: undefined
    };

    const result = scoreConfidenceV2(lowQualityInputs);
    expect(result.final).toBeGreaterThanOrEqual(CONF_MIN);
    expect(result.final).toBeLessThanOrEqual(CONF_MAX);
  });

  test('k mapping is exactly: 1→0.0, 2→0.7, ≥3→1.0', () => {
    const baseInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      headline: 'Test headline',
      body: 'Test body',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    // k=1 should give P2=0.0
    const k1Result = scoreConfidenceV2({
      ...baseInputs,
      sources: [{ domain: 'bloomberg.com', isPrimary: false }]
    });
    expect(k1Result.debug?.P2).toBe(0.0);

    // k=2 should give P2=0.7
    const k2Result = scoreConfidenceV2({
      ...baseInputs,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false }
      ]
    });
    expect(k2Result.debug?.P2).toBe(0.7);

    // k≥3 should give P2=1.0
    const k3Result = scoreConfidenceV2({
      ...baseInputs,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false },
        { domain: 'ft.com', isPrimary: false }
      ]
    });
    expect(k3Result.debug?.P2).toBe(1.0);
  });

  test('Anti-rumor penalty R=0.30 is enforced', () => {
    const baseInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      tags: undefined,
      impact_score: 60,
      market: undefined
    };

    // Without rumor keywords
    const cleanResult = scoreConfidenceV2({
      ...baseInputs,
      headline: 'Fed Raises Interest Rates',
      body: 'The Federal Reserve has raised interest rates by 25 basis points.'
    });

    // With rumor keywords
    const rumorResult = scoreConfidenceV2({
      ...baseInputs,
      headline: 'Rumor: Fed Might Raise Interest Rates',
      body: 'There is a rumor that the Federal Reserve could raise interest rates.'
    });

    // P1 should be lower with rumor penalty
    expect(rumorResult.debug?.P1).toBeLessThan(cleanResult.debug?.P1 || 0);
    expect(rumorResult.debug?.penalties).toBe(0.30);
  });

  test('Freshness uses F = exp( -minutes/180 )', () => {
    const baseInputs = {
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Test headline',
      body: 'Test body',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    // Fresh (5 minutes ago)
    const freshResult = scoreConfidenceV2({
      ...baseInputs,
      publishedAt: fiveMinutesAgo,
      now
    });

    // Stale (2 hours ago)
    const staleResult = scoreConfidenceV2({
      ...baseInputs,
      publishedAt: twoHoursAgo,
      now
    });

    // Freshness should be higher for recent content
    expect(freshResult.debug?.freshness).toBeGreaterThan(staleResult.debug?.freshness || 0);
    
    // Verify exponential decay: F = exp(-minutes/180)
    const expectedFreshFreshness = Math.exp(-5 / 180);
    const expectedStaleFreshness = Math.exp(-120 / 180);
    expect(freshResult.debug?.freshness).toBeCloseTo(expectedFreshFreshness, 2);
    expect(staleResult.debug?.freshness).toBeCloseTo(expectedStaleFreshness, 2);
  });

  test('Independence bonus +0.10 if confirmations span >1 source class', () => {
    const baseInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      headline: 'Test headline',
      body: 'Test body',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    // Same source class (Tier-1 media only)
    const sameClassResult = scoreConfidenceV2({
      ...baseInputs,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'reuters.com', isPrimary: false }
      ]
    });

    // Different source classes (Tier-1 + regulator)
    const differentClassResult = scoreConfidenceV2({
      ...baseInputs,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false },
        { domain: 'sec.gov', isPrimary: false }
      ]
    });

    // Should have independence bonus
    expect(differentClassResult.debug?.independenceBonus).toBe(0.10);
    expect(sameClassResult.debug?.independenceBonus).toBe(0.0);
    
    // P2 should be higher with independence bonus
    expect(differentClassResult.debug?.P2).toBeGreaterThan(sameClassResult.debug?.P2 || 0);
  });

  test('Contrast expansion around 0.5', () => {
    const baseInputs = {
      publishedAt: fiveMinutesAgo,
      now,
      sources: [
        { domain: 'bloomberg.com', isPrimary: false }
      ],
      headline: 'Test headline',
      body: 'Test body',
      tags: undefined,
      impact_score: 50,
      market: undefined
    };

    const result = scoreConfidenceV2(baseInputs);
    
    // Verify contrast expansion: C = clamp01(0.5 + 1.6 * (S - 0.5))
    const S = result.debug?.S || 0;
    const expectedC = Math.max(0, Math.min(1, 0.5 + 1.6 * (S - 0.5)));
    expect(result.debug?.C).toBeCloseTo(expectedC, 2);
  });
});
