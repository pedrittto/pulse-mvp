// Configuration constants
export const getContentTrendBonus = () => parseFloat(process.env.CONTENT_TREND_BONUS || '0.10');

export type ContentClass = 'opinion' | 'info' | 'sectoral' | 'macro';

export interface ContentFitResult {
  baseFit: number;
  contentClass: ContentClass;
  trendBonus: number;
  P3: number;
  trendAligned: boolean;
}

/**
 * Classify content based on headline and body text
 */
export function classifyContent(headline: string, body: string): { score: number; class: ContentClass } {
  const text = `${headline} ${body}`.toLowerCase();
  
  // Macro keywords (highest priority)
  const macroKeywords = [
    'cpi', 'fomc', 'opec', 'payrolls', 'fed', 'interest rate', 'ecb', 'boe',
    'federal reserve', 'inflation', 'unemployment', 'gdp', 'monetary policy',
    'quantitative easing', 'tapering', 'dot plot', 'beige book'
  ];
  
  const hasMacroKeywords = macroKeywords.some(keyword => text.includes(keyword));
  if (hasMacroKeywords) {
    return { score: 0.8, class: 'macro' };
  }
  
  // Sectoral keywords
  const sectoralKeywords = [
    'earnings', 'quarterly', 'annual', 'guidance', 'acquisition', 'merger', 'm&a',
    'revenue', 'profit', 'loss', 'dividend', 'stock split', 'ipo', 'secondary offering',
    'ceo', 'cfo', 'executive', 'board', 'shareholder'
  ];
  
  const hasSectoralKeywords = sectoralKeywords.some(keyword => text.includes(keyword));
  if (hasSectoralKeywords) {
    return { score: 0.6, class: 'sectoral' };
  }
  
  // Opinion/feature keywords
  const opinionKeywords = [
    'opinion', 'op-ed', 'column', 'analysis', 'commentary', 'view', 'perspective',
    'think', 'believe', 'suggest', 'recommend', 'predict', 'forecast', 'outlook'
  ];
  
  const hasOpinionKeywords = opinionKeywords.some(keyword => text.includes(keyword));
  if (hasOpinionKeywords) {
    return { score: 0.2, class: 'opinion' };
  }
  
  // Default: purely informational
  return { score: 0.4, class: 'info' };
}

/**
 * Check if content aligns with active trends (stubbed implementation)
 * In production, this would analyze recent market movements and news patterns
 */
export function alignsWithActiveTrend(
  headline: string, 
  body: string, 
  lookbackHours: number = 2
): boolean {
  // Stubbed implementation - in production would analyze recent trends
  // For now, use simple keyword matching as fallback
  
  const text = `${headline} ${body}`.toLowerCase();
  
  // Check for trending topics (stubbed)
  const trendingTopics = [
    'ai', 'artificial intelligence', 'chatgpt', 'openai',
    'crypto', 'bitcoin', 'ethereum', 'blockchain',
    'climate', 'esg', 'sustainability',
    'tech', 'technology', 'innovation'
  ];
  
  return trendingTopics.some(topic => text.includes(topic));
}

/**
 * Main content fit scoring function
 */
export function scoreContentFit(headline: string, body: string): ContentFitResult {
  const classification = classifyContent(headline, body);
  let baseFit = classification.score;
  
  // Check for trend alignment
  const trendAligned = alignsWithActiveTrend(headline, body);
  const trendBonus = trendAligned ? getContentTrendBonus() : 0.0;
  
  // Apply trend bonus
  baseFit += trendBonus;
  
  // Clamp to [0, 1]
  const P3 = Math.max(0, Math.min(1, baseFit));
  
  return {
    baseFit: classification.score,
    contentClass: classification.class,
    trendBonus,
    P3,
    trendAligned
  };
}
