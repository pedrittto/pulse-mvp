import { scoreConfidenceV2, CONF_MIN, CONF_MAX, clamp } from './confidenceV2';

export type Score = { 
  impact_score: number; 
  impact: 'L'|'M'|'H'; 
  confidence: number; 
  tags?: string[];
  _confidence_debug?: any; // Debug information when requested
};

export function scoreNews(item: {
  headline?: string; 
  description?: string; 
  sources?: string[]; 
  tickers?: string[]; 
  published_at?: string;
  debug?: boolean; // Add debug flag
}): Score {
  // Start with base values
  let impact_score = 20;
  let confidence = 50;
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

  // Macro keywords
  const MACRO_KEYWORDS = [
    'fed', 'interest rate', 'cpi', 'ppi', 'jobs report', 'opec', 
    'oil cut', 'war', 'geopolitics', 'tariff', 'sanctions', 
    'treasury', 'ecb'
  ];
  
  for (const keyword of MACRO_KEYWORDS) {
    if (text.includes(keyword)) {
      impact_score += 12;
      confidence += 5;
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
        confidence += weight;
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
      confidence -= 8;
      break; // Only count once
    }
  }

  // Cap & floor
  impact_score = Math.max(0, Math.min(100, impact_score));
  
  // Compute confidence using v1 or v2.1 based on feature flag
  let finalConfidence: number;
  let debugInfo: any; // Declare debugInfo here
  
  if (process.env.CONFIDENCE_V2 === 'true') {
    // Use confidence v2.1 with five pillars
    try {
      // Extract domain from source name (fallback to source name if no domain)
      const sourceDomains = sources.map(source => {
        // Map common source names to domains
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
        
        // Check if source name has a mapping
        if (sourceMappings[source]) {
          return { domain: sourceMappings[source], isPrimary: false };
        }
        
        // Simple domain extraction - in real implementation, this would be more robust
        const domain = source.includes('.') ? source.split('.').slice(-2).join('.') : source;
        return { domain, isPrimary: false };
      });
      
      const v2Inputs = {
        publishedAt: published_at ? new Date(published_at) : new Date(),
        now: new Date(),
        sources: sourceDomains,
        headline: item.headline || '',
        body: item.description || '',
        tags: tags.length > 0 ? tags : undefined,
        impact_score: Math.round(impact_score),
        market: undefined // No market data available in current implementation
      };
      
      const v2Result = scoreConfidenceV2(v2Inputs);
      
      // Use contrast mode based on feature flag
      if (process.env.CONFIDENCE_V2_CONTRAST === '0') {
        // Non-contrast mode: use raw score directly
        finalConfidence = v2Result.raw;
      } else {
        // Default contrast mode: use final score
        finalConfidence = v2Result.final;
      }
      
      // Include debug information if requested
      debugInfo = item.debug ? v2Result.debug : undefined;
      
      // Log comparison if enabled
      if (process.env.CONFIDENCE_V2_COMPARE === '1') {
        console.log(JSON.stringify({
          type: 'confidence_compare',
          headline: item.headline?.substring(0, 50),
          v1: Math.round(confidence),
          v2_raw: v2Result.raw,
          v2_final: v2Result.final,
          sources: sources
        }));
      }
    } catch (error) {
      console.error('Error computing confidence v2.1, falling back to v1:', error);
      finalConfidence = confidence;
      debugInfo = undefined; // Ensure debugInfo is undefined on error
    }
  } else {
    // Use original v1 confidence
    finalConfidence = confidence;
    debugInfo = undefined; // Ensure debugInfo is undefined for v1
  }

  // Label
  const impact: 'L'|'M'|'H' = impact_score >= 70 ? 'H' : impact_score >= 45 ? 'M' : 'L';

  // Apply clamp once, right before serializing to API response
  const clampedConfidence = clamp(finalConfidence, CONF_MIN, CONF_MAX);

  return {
    impact_score: Math.round(impact_score),
    impact,
    confidence: Math.round(clampedConfidence),
    tags: tags.length > 0 ? tags : undefined,
    ...(debugInfo && { _confidence_debug: debugInfo })
  };
}
