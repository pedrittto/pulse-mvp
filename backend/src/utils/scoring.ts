import { scoreImpactV3, logImpactComparison, ImpactV3Result } from './impactV3';
import { computeVerification, computeVerificationWithDebug, VerificationInputs, VerificationStatus } from './verification';
import { computeConfidenceState } from './confidenceState';

// Environment getter functions
const getImpactMode = () => process.env.IMPACT_MODE;
const getVerificationMode = () => process.env.VERIFICATION_MODE;
const getImpactV3Compare = () => process.env.IMPACT_V3_COMPARE;

export type Score = { 
  impact_score: number; 
  impact: 'L'|'M'|'H'|'C'; 
  confidence_state: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  verification?: VerificationStatus; // New verification status
  verification_result?: any; // Full verification result object
  tags?: string[];
  _impact_debug?: ImpactV3Result; // Impact V3 debug information when requested
  _verification_debug?: any; // Verification debug information when requested
};

// Main scoring function
export function scoreNews(item: {
  headline?: string; 
  description?: string; 
  sources?: string[]; 
  tickers?: string[]; 
  published_at?: string;
  debug?: boolean; // Add debug flag
}): Score {
  // Check if Impact V3 is enabled
  const impactMode = getImpactMode();
  
  if (impactMode === 'v3') {
    return scoreNewsV3(item);
  }
  
  // Legacy V2 scoring
  return scoreNewsV2(item);
}

// Legacy V2 scoring function
function scoreNewsV2(item: {
  headline?: string; 
  description?: string; 
  sources?: string[]; 
  tickers?: string[]; 
  published_at?: string;
  debug?: boolean;
}): Score {
  // Start with base values
  let impact_score = 20;
  const tags: string[] = [];

  const headline = (item.headline || '').toLowerCase();
  const description = (item.description || '').toLowerCase();
  const text = `${headline} ${description}`;
  const sources = item.sources || [];
  const tickers = item.tickers || [];
  const published_at = item.published_at;

  // Recency boost (based on published_at, now in UTC)
  if (published_at) {
    const published = new Date(published_at);
    const now = new Date();
    const hoursDiff = (now.getTime() - published.getTime()) / (1000 * 60 * 60);
    
    if (hoursDiff < 1) {
      impact_score += 15;
    } else if (hoursDiff < 6) {
      impact_score += 10;
    } else if (hoursDiff < 24) {
      impact_score += 5;
    }
  }

  // Ticker signal
  if (tickers.length === 1) {
    impact_score += 10;
  } else if (tickers.length >= 2) {
    impact_score += 15;
  }

  // HIGH_IMPACT keywords
  const HIGH_IMPACT = [
    'acquisition', 'merger', 'lawsuit', 'guidance', 'earnings', 'downgrade', 
    'upgrade', 'layoffs', 'ceo resigns', 'investigation', 'ban', 'tariff', 
    'sanction', 'data breach', 'hack', 'halt', 'bankrupt', 'chapter 11'
  ];
  
  for (const keyword of HIGH_IMPACT) {
    if (text.includes(keyword)) {
      impact_score += 15;
      break; // Only count once
    }
  }

  // MEDIUM_IMPACT keywords
  const MEDIUM_IMPACT = [
    'partnership', 'license', 'contract', 'redirect', 'price cut', 
    'price increase', 'expansion', 'plant', 'facility', 'chip', 'ai model'
  ];
  
  for (const keyword of MEDIUM_IMPACT) {
    if (text.includes(keyword)) {
      impact_score += 8;
      break; // Only count once
    }
  }

  // Macro keywords (affects impact only)
  const MACRO_KEYWORDS = [
    'fed', 'interest rate', 'cpi', 'ppi', 'jobs report', 'opec', 
    'oil cut', 'war', 'geopolitics', 'tariff', 'sanctions', 
    'treasury', 'ecb'
  ];
  
  for (const keyword of MACRO_KEYWORDS) {
    if (text.includes(keyword)) {
      impact_score += 12;
      tags.push('Macro');
      break; // Only count once
    }
  }

  // Source weight (first source only, case-insensitive)
  const SOURCE_W: { [key: string]: number } = { 
    'bloomberg': 6, 'reuters': 6, 'wsj': 5, 'ft': 5, 'cnbc': 3, 
    'marketwatch': 3, 'techcrunch': 2 
  };
  
  if (sources.length > 0) {
    const firstSource = sources[0].toLowerCase();
    for (const [source, weight] of Object.entries(SOURCE_W)) {
      if (firstSource.includes(source)) {
        impact_score += weight;
        break;
      }
    }
  }

  // Opinion/rumor dampeners (in headline)
  const OPINION_KEYWORDS = [
    'opinion', 'op-ed', 'column', 'rumor', 'reportedly', 'sources say'
  ];
  
  for (const keyword of OPINION_KEYWORDS) {
    if (headline.includes(keyword)) {
      break; // Only count once
    }
  }

  // Cap & floor
  impact_score = Math.max(0, Math.min(100, impact_score));
  
  // Compute categorical confidence state
  const sourceDomains = sources.map(source => {
    const sourceMappings: { [key: string]: string } = {
      'Bloomberg Markets': 'bloomberg.com',
      'Bloomberg': 'bloomberg.com',
      'Financial Times': 'ft.com',
      'FT': 'ft.com',
      'Reuters': 'reuters.com',
      'CNBC': 'cnbc.com',
      'MarketWatch': 'marketwatch.com',
      'TechCrunch': 'techcrunch.com',
      'The Verge': 'theverge.com',
      'Ars Technica': 'arstechnica.com',
      'BBC Business': 'bbc.com',
      'AP Business': 'apnews.com'
    };
    if (sourceMappings[source]) {
      return { domain: sourceMappings[source], isPrimary: false };
    }
    const domain = source.includes('.') ? source.split('.').slice(-2).join('.') : source;
    return { domain, isPrimary: false };
  });
  const confidence_state = computeConfidenceState({
    sources: sourceDomains,
    headline: item.headline || '',
    body: item.description || '',
    published_at: published_at
  });

  // Compute verification status if enabled
  let verification: VerificationStatus | undefined;
  let verificationDebug: any;
  
  if (getVerificationMode() === 'v1') {
    try {
      // Extract domain from source name (same logic as confidence)
      const sourceDomains = sources.map(source => {
        const sourceMappings: { [key: string]: string } = {
          'Bloomberg Markets': 'bloomberg.com',
          'Bloomberg': 'bloomberg.com',
          'Financial Times': 'ft.com',
          'FT': 'ft.com',
          'Reuters': 'reuters.com',
          'CNBC': 'cnbc.com',
          'MarketWatch': 'marketwatch.com',
          'TechCrunch': 'techcrunch.com',
          'The Verge': 'theverge.com',
          'Ars Technica': 'arstechnica.com',
          'BBC Business': 'bbc.com',
          'AP Business': 'apnews.com'
        };
        
        if (sourceMappings[source]) {
          return { domain: sourceMappings[source], isPrimary: false };
        }
        
        const domain = source.includes('.') ? source.split('.').slice(-2).join('.') : source;
        return { domain, isPrimary: false };
      });
      
      const verificationInputs: VerificationInputs = {
        sources: sourceDomains,
        headline: item.headline || '',
        body: item.description || '',
        published_at: published_at || new Date().toISOString()
      };
      
      if (item.debug) {
        const debugResult = computeVerificationWithDebug(verificationInputs);
        verification = debugResult.status;
        verificationDebug = debugResult;
      } else {
        const result = computeVerification(verificationInputs);
        verification = result.status;
      }
      
      // Log verification for metrics
      if (getVerificationMode() === 'v1') {
        console.log(JSON.stringify({
          type: 'verification_computed',
          headline: item.headline?.substring(0, 50),
          verification,
          sources: sources
        }));
      }
    } catch (error) {
      console.error('Error computing verification, skipping:', error);
      verification = undefined;
      verificationDebug = undefined;
    }
  }

  // Label
  const impact: 'L'|'M'|'H' = impact_score >= 70 ? 'H' : impact_score >= 45 ? 'M' : 'L';

  return {
    impact_score: Math.round(impact_score),
    impact,
    confidence_state,
    ...(verification && { verification }),
    tags: tags.length > 0 ? tags : undefined,
    ...(verificationDebug && { _verification_debug: verificationDebug })
  };
}

// Impact V3 scoring function
function scoreNewsV3(item: {
  headline?: string; 
  description?: string; 
  sources?: string[]; 
  tickers?: string[]; 
  published_at?: string;
  debug?: boolean;
}): Score {
  const tags: string[] = [];

  const headline = (item.headline || '').toLowerCase();
  const description = (item.description || '').toLowerCase();
  const text = `${headline} ${description}`;
  const sources = item.sources || [];
  const tickers = item.tickers || [];
  const published_at = item.published_at;

  // Macro keywords (for tags only)
  const MACRO_KEYWORDS = [
    'fed', 'interest rate', 'cpi', 'ppi', 'jobs report', 'opec', 
    'oil cut', 'war', 'geopolitics', 'tariff', 'sanctions', 
    'treasury', 'ecb'
  ];
  
  for (const keyword of MACRO_KEYWORDS) {
    if (text.includes(keyword)) {
      tags.push('Macro');
      break; // Only count once
    }
  }

  // Source weight (first source only, case-insensitive)
  const SOURCE_W: { [key: string]: number } = { 
    'bloomberg': 6, 'reuters': 6, 'wsj': 5, 'ft': 5, 'cnbc': 3, 
    'marketwatch': 3, 'techcrunch': 2 
  };
  
  // Source weights not used for confidence_state

  // Opinion/rumor dampeners (in headline)
  const OPINION_KEYWORDS = [
    'opinion', 'op-ed', 'column', 'rumor', 'reportedly', 'sources say'
  ];
  
  // Opinion keywords do not directly affect impact V3 nor confidence_state here

  // Compute categorical confidence state
  const sourceDomains = sources.map(source => {
    const sourceMappings: { [key: string]: string } = {
      'Bloomberg Markets': 'bloomberg.com',
      'Bloomberg': 'bloomberg.com',
      'Financial Times': 'ft.com',
      'FT': 'ft.com',
      'Reuters': 'reuters.com',
      'CNBC': 'cnbc.com',
      'MarketWatch': 'marketwatch.com',
      'TechCrunch': 'techcrunch.com',
      'The Verge': 'theverge.com',
      'Ars Technica': 'arstechnica.com',
      'BBC Business': 'bbc.com',
      'AP Business': 'apnews.com'
    };
    if (sourceMappings[source]) {
      return { domain: sourceMappings[source], isPrimary: false };
    }
    const domain = source.includes('.') ? source.split('.').slice(-2).join('.') : source;
    return { domain, isPrimary: false };
  });
  const confidence_state = computeConfidenceState({
    sources: sourceDomains,
    headline: item.headline || '',
    body: item.description || '',
    published_at: published_at || new Date().toISOString()
  });

  // Compute Impact V3
  const impactV3Input = {
    headline: item.headline || '',
    description: item.description || '',
    sources: sources,
    tickers: tickers,
    published_at: published_at || new Date().toISOString(),
    tags: tags.length > 0 ? tags : undefined
  };

  const impactV3Result = scoreImpactV3(impactV3Input);

  // Compute verification status if enabled (same logic as V2)
  let verification: VerificationStatus | undefined;
  let verificationDebug: any;
  let verificationResult: any;
  
  if (getVerificationMode() === 'v1') {
    try {
      // Extract domain from source name (same logic as confidence)
      const sourceDomains = sources.map(source => {
        const sourceMappings: { [key: string]: string } = {
          'Bloomberg Markets': 'bloomberg.com',
          'Bloomberg': 'bloomberg.com',
          'Financial Times': 'ft.com',
          'FT': 'ft.com',
          'Reuters': 'reuters.com',
          'CNBC': 'cnbc.com',
          'MarketWatch': 'marketwatch.com',
          'TechCrunch': 'techcrunch.com',
          'The Verge': 'theverge.com',
          'Ars Technica': 'arstechnica.com',
          'BBC Business': 'bbc.com',
          'AP Business': 'apnews.com'
        };
        
        if (sourceMappings[source]) {
          return { domain: sourceMappings[source], isPrimary: false };
        }
        
        const domain = source.includes('.') ? source.split('.').slice(-2).join('.') : source;
        return { domain, isPrimary: false };
      });
      
      const verificationInputs: VerificationInputs = {
        sources: sourceDomains,
        headline: item.headline || '',
        body: item.description || '',
        published_at: published_at || new Date().toISOString()
      };
      
      // Always compute full verification result for V1 mode
      verificationResult = computeVerification(verificationInputs);
      verification = verificationResult.status;
      
      // Store full result for debug if requested
      if (item.debug) {
        verificationDebug = computeVerificationWithDebug(verificationInputs);
      }
      
      // Log verification for metrics
      if (getVerificationMode() === 'v1') {
        console.log(JSON.stringify({
          type: 'verification_computed',
          headline: item.headline?.substring(0, 50),
          verification,
          sources: sources
        }));
      }
    } catch (error) {
      console.error('Error computing verification, skipping:', error);
      verification = undefined;
      verificationDebug = undefined;
      verificationResult = undefined;
    }
  }

  // Log comparison if enabled
  if (getImpactV3Compare() === '1') {
    // For comparison, we need to compute V2 impact score
    let v2ImpactScore = 20;
    
    // Recency boost
    if (published_at) {
      const published = new Date(published_at);
      const now = new Date();
      const hoursDiff = (now.getTime() - published.getTime()) / (1000 * 60 * 60);
      
      if (hoursDiff < 1) {
        v2ImpactScore += 15;
      } else if (hoursDiff < 6) {
        v2ImpactScore += 10;
      } else if (hoursDiff < 24) {
        v2ImpactScore += 5;
      }
    }

    // Ticker signal
    if (tickers.length === 1) {
      v2ImpactScore += 10;
    } else if (tickers.length >= 2) {
      v2ImpactScore += 15;
    }

    // HIGH_IMPACT keywords
    const HIGH_IMPACT = [
      'acquisition', 'merger', 'lawsuit', 'guidance', 'earnings', 'downgrade', 
      'upgrade', 'layoffs', 'ceo resigns', 'investigation', 'ban', 'tariff', 
      'sanction', 'data breach', 'hack', 'halt', 'bankrupt', 'chapter 11'
    ];
    
    for (const keyword of HIGH_IMPACT) {
      if (text.includes(keyword)) {
        v2ImpactScore += 15;
        break;
      }
    }

    // MEDIUM_IMPACT keywords
    const MEDIUM_IMPACT = [
      'partnership', 'license', 'contract', 'redirect', 'price cut', 
      'price increase', 'expansion', 'plant', 'facility', 'chip', 'ai model'
    ];
    
    for (const keyword of MEDIUM_IMPACT) {
      if (text.includes(keyword)) {
        v2ImpactScore += 8;
        break;
      }
    }

    // MACRO_KEYWORDS
    for (const keyword of MACRO_KEYWORDS) {
      if (text.includes(keyword)) {
        v2ImpactScore += 12;
        break;
      }
    }

    // Source weight
    if (sources.length > 0) {
      const firstSource = sources[0].toLowerCase();
      for (const [source, weight] of Object.entries(SOURCE_W)) {
        if (firstSource.includes(source)) {
          v2ImpactScore += weight;
          break;
        }
      }
    }

    v2ImpactScore = Math.max(0, Math.min(100, v2ImpactScore));
    const v2Category = v2ImpactScore >= 70 ? 'H' : v2ImpactScore >= 45 ? 'M' : 'L';

    logImpactComparison(impactV3Input, v2ImpactScore, v2Category, impactV3Result);
  }

  return {
    impact_score: Math.round(impactV3Result.raw * 100), // Convert 0-1 to 0-100 for API compatibility
    impact: impactV3Result.category,
    confidence_state,
    ...(verification && { verification }),
    ...(verificationResult && { verification_result: verificationResult }), // Include full verification result
    tags: tags.length > 0 ? tags : undefined,
    ...(verificationDebug && { _verification_debug: verificationDebug }),
    ...(item.debug && { _impact_debug: impactV3Result })
  };
}
