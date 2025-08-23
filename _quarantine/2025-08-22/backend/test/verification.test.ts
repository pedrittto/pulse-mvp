import { computeVerification, computeVerificationWithDebug, VerificationInputs } from '../src/utils/verification';

describe('Verification System', () => {
  const baseInputs: VerificationInputs = {
    sources: [{ domain: 'reuters.com', isPrimary: false }],
    headline: 'Test headline',
    body: 'Test body',
    published_at: '2024-01-01T12:00:00Z'
  };

  describe('Rule 1: Verified', () => {
    it('should return verified for regulatory content', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'SEC Announces New Regulations',
        body: 'The Securities and Exchange Commission announced new regulations today.'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('verified');
      expect(result.reason).toBe('Regulatory filing or official document');
    });

    it('should return verified for filing content', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Apple Files 8-K Report',
        body: 'Apple Inc. filed an 8-K report with the SEC today.'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('verified');
      expect(result.reason).toBe('Regulatory filing or official document');
    });

    it('should return verified for official livestream with transcript', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Fed Press Conference Live',
        body: 'Federal Reserve Chairman Jerome Powell said during the press conference that...'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('verified');
      expect(result.reason).toBe('Official livestream with transcript');
    });

    it('should return verified for k≥3 sources', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [
          { domain: 'reuters.com', isPrimary: false },
          { domain: 'bloomberg.com', isPrimary: false },
          { domain: 'cnbc.com', isPrimary: false }
        ],
        confirmations_count: 3
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('verified');
      expect(result.reason).toBe('3 independent sources');
    });
  });

  describe('Rule 2: Confirmed', () => {
    it('should return confirmed for Tier-1 source', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [{ domain: 'bloomberg.com', isPrimary: false }] // Tier-1 source
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('confirmed');
      expect(result.reason).toBe('Tier-1 source');
    });

    it('should return confirmed for k≥2 sources', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [
          { domain: 'reuters.com', isPrimary: false },
          { domain: 'cnbc.com', isPrimary: false }
        ],
        confirmations_count: 2
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('confirmed');
      expect(result.reason).toBe('2 independent sources');
    });

    it('should return confirmed for on-record quote', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'CEO Says Company Will Expand',
        body: 'The CEO said during the earnings call that the company will expand operations.'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('confirmed');
      expect(result.reason).toBe('On-record quote');
    });
  });

  describe('Rule 3: Live Event Override', () => {
    it('should return confirmed for Tier-1 source + live event', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [{ domain: 'bloomberg.com', isPrimary: false }], // Tier-1 source
        headline: 'Breaking: Fed Raises Interest Rates',
        body: 'The Federal Reserve just announced a rate hike during the live press conference.'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('confirmed');
      expect(result.reason).toBe('Tier-1 source + live event');
    });

    it('should not override for low-tier source + live event', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [{ domain: 'low-tier-blog.com', isPrimary: false }], // Low-tier source
        headline: 'Breaking: Fed Raises Interest Rates',
        body: 'The Federal Reserve just announced a rate hike during the live press conference.'
      };

      const result = computeVerification(inputs);
      expect(result.status).not.toBe('confirmed');
    });
  });

  describe('Rule 4: Reported', () => {
    it('should return reported for single Tier-1/2 source without denial', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [{ domain: 'forbes.com', isPrimary: false }] // Tier-2 source
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('reported');
      expect(result.reason).toBe('Single reputable source');
    });

    it('should not return reported if denial patterns detected', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Company Denies Merger Rumors',
        body: 'The company denied rumors of a potential merger.'
      };

      const result = computeVerification(inputs);
      expect(result.status).not.toBe('reported');
    });
  });

  describe('Rule 5: Unconfirmed', () => {
    it('should return unconfirmed for low-tier source', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        sources: [{ domain: 'anonymous-blog.com', isPrimary: false }] // Low-tier source
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('unconfirmed');
      expect(result.reason).toBe('Low-tier source');
    });

    it('should return unconfirmed for rumor patterns', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Rumor: Apple to Acquire Tesla',
        body: 'Sources say Apple is considering acquiring Tesla.'
      };

      const result = computeVerification(inputs);
      expect(result.status).toBe('unconfirmed');
      expect(result.reason).toBe('Rumor patterns detected');
    });
  });

  describe('Boundary conditions', () => {
    it('should handle k=1 correctly', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        confirmations_count: 1
      };

      const result = computeVerification(inputs);
      expect(result.k).toBe(1);
    });

    it('should handle k=2 correctly', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        confirmations_count: 2
      };

      const result = computeVerification(inputs);
      expect(result.k).toBe(2);
    });

    it('should handle k=3 correctly', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        confirmations_count: 3
      };

      const result = computeVerification(inputs);
      expect(result.k).toBe(3);
    });
  });

  describe('Debug information', () => {
    it('should return debug information when requested', () => {
      const inputs: VerificationInputs = {
        ...baseInputs,
        headline: 'SEC Announces New Regulations',
        body: 'The Securities and Exchange Commission announced new regulations today.'
      };

      const result = computeVerificationWithDebug(inputs);
      
      expect(result.status).toBe('verified');
      expect(result.matched_rule).toBe('regulatory_filing');
      expect(result.confirmations_count).toBe(1);
      expect(result.source_tiers).toBeDefined();
      expect(result.live_event_override).toBe(false);
      expect(result.inputs).toBeDefined();
    });
  });

  describe('Live event detection', () => {
    it('should detect live events correctly', () => {
      const liveEventInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Live: Fed Press Conference',
        body: 'Breaking news as it happens during the Federal Reserve press conference.'
      };

      const result = computeVerification(liveEventInputs);
      expect(result.is_live_event).toBe(true);
    });

    it('should not detect live events in regular content', () => {
      const regularInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Apple Reports Earnings',
        body: 'Apple reported quarterly earnings yesterday.'
      };

      const result = computeVerification(regularInputs);
      expect(result.is_live_event).toBe(false);
    });
  });

  describe('Regulatory detection', () => {
    it('should detect regulatory content correctly', () => {
      const regulatoryInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Federal Reserve Announces Policy Change',
        body: 'The Federal Reserve announced a new monetary policy today.'
      };

      const result = computeVerification(regulatoryInputs);
      expect(result.status).toBe('verified');
    });

    it('should detect SEC filings correctly', () => {
      const filingInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Company Files 10-K Report',
        body: 'The company filed its annual 10-K report with the SEC.'
      };

      const result = computeVerification(filingInputs);
      expect(result.status).toBe('verified');
    });
  });

  describe('On-record detection', () => {
    it('should detect on-record quotes correctly', () => {
      const onRecordInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'CEO Announces Expansion Plans',
        body: 'The CEO said during the conference call that the company will expand.'
      };

      const result = computeVerification(onRecordInputs);
      expect(result.status).toBe('confirmed');
    });
  });

  describe('Rumor detection', () => {
    it('should detect rumor patterns correctly', () => {
      const rumorInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Rumor: Company Considering Merger',
        body: 'Sources say the company is considering a merger.'
      };

      const result = computeVerification(rumorInputs);
      expect(result.status).toBe('unconfirmed');
    });
  });

  describe('Denial detection', () => {
    it('should detect denial patterns correctly', () => {
      const denialInputs: VerificationInputs = {
        ...baseInputs,
        headline: 'Company Denies Acquisition Rumors',
        body: 'The company denied rumors of a potential acquisition.'
      };

      const result = computeVerification(denialInputs);
      expect(result.status).not.toBe('reported');
    });
  });
});
