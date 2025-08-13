export type Score = { 
  impact_score: number; 
  impact: 'L'|'M'|'H'; 
  confidence: number; 
  tags?: string[] 
};

export function scoreNews(item: {
  headline?: string; 
  description?: string; 
  sources?: string[]; 
  tickers?: string[]; 
  published_at?: string;
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
  confidence = Math.max(20, Math.min(95, confidence));

  // Label
  const impact: 'L'|'M'|'H' = impact_score >= 70 ? 'H' : impact_score >= 45 ? 'M' : 'L';

  return {
    impact_score: Math.round(impact_score),
    impact,
    confidence: Math.round(confidence),
    tags: tags.length > 0 ? tags : undefined
  };
}
