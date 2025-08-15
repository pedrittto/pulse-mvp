export interface MarketData {
  realizedMoveBps?: number;
  volumeSpike?: number;
  timestamp?: Date;
}

export interface MarketProxyResult {
  percentile: number | null;
  P5: number;
  fallbackUsed: boolean;
  sentimentScore: number;
  assetClass: string;
}

/**
 * Get market percentile for a given item (stubbed implementation)
 * In production, this would query market data and compute actual percentiles
 */
export function getMarketPercentile(
  item: { headline: string; body: string; tickers?: string[] },
  window: { start: Date; end: Date }
): number | null {
  // Stubbed implementation - in production would query market data
  // For now, return null to trigger fallback
  return null;
}

/**
 * Compute sentiment volatility fallback score
 * Deterministic 0.45..0.55 based on headline sentiment + asset class
 */
export function sentimentVolatilityFallback(
  headline: string,
  body: string,
  tickers?: string[]
): number {
  const text = `${headline} ${body}`.toLowerCase();
  
  // Simple sentiment analysis (stubbed)
  const positiveWords = [
    'surge', 'jump', 'rise', 'gain', 'up', 'positive', 'beat', 'exceed',
    'strong', 'growth', 'profit', 'revenue', 'earnings', 'success'
  ];
  
  const negativeWords = [
    'drop', 'fall', 'decline', 'down', 'negative', 'miss', 'below',
    'weak', 'loss', 'debt', 'bankruptcy', 'layoff', 'cut'
  ];
  
  const positiveCount = positiveWords.filter(word => text.includes(word)).length;
  const negativeCount = negativeWords.filter(word => text.includes(word)).length;
  
  // Base sentiment score
  let sentimentScore = 0.5; // neutral
  if (positiveCount > negativeCount) {
    sentimentScore = 0.5 + Math.min(0.05, (positiveCount - negativeCount) * 0.01);
  } else if (negativeCount > positiveCount) {
    sentimentScore = 0.5 - Math.min(0.05, (negativeCount - positiveCount) * 0.01);
  }
  
  // Asset class adjustment
  const assetClass = getAssetClass(tickers);
  let assetAdjustment = 0.0;
  
  switch (assetClass) {
    case 'crypto':
      assetAdjustment = 0.02; // Higher volatility
      break;
    case 'commodities':
      assetAdjustment = 0.01; // Moderate volatility
      break;
    case 'forex':
      assetAdjustment = 0.015; // High volatility
      break;
    case 'equities':
    default:
      assetAdjustment = 0.0; // Standard volatility
      break;
  }
  
  // Final score in [0.45, 0.55] range
  const finalScore = Math.max(0.45, Math.min(0.55, sentimentScore + assetAdjustment));
  
  return finalScore;
}

/**
 * Determine asset class from tickers
 */
function getAssetClass(tickers?: string[]): string {
  if (!tickers || tickers.length === 0) return 'equities';
  
  const ticker = tickers[0].toUpperCase();
  
  // Crypto
  if (['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK'].includes(ticker)) {
    return 'crypto';
  }
  
  // Commodities
  if (['GC', 'SI', 'CL', 'NG', 'ZC', 'ZS'].includes(ticker)) {
    return 'commodities';
  }
  
  // Forex
  if (['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF'].includes(ticker)) {
    return 'forex';
  }
  
  // Default to equities
  return 'equities';
}

/**
 * Main market proxy scoring function
 */
export function scoreMarketProxy(
  item: { headline: string; body: string; tickers?: string[] },
  marketData?: MarketData
): MarketProxyResult {
  // Try to get market percentile
  const now = new Date();
  const window = {
    start: new Date(now.getTime() - 10 * 60 * 1000), // 10 minutes ago
    end: new Date(now.getTime() + 10 * 60 * 1000)   // 10 minutes from now
  };
  
  const percentile = getMarketPercentile(item, window);
  
  let P5: number;
  let fallbackUsed = false;
  
  if (percentile !== null) {
    // Use market percentile: P5 = 0.2 + 0.8 * pct
    P5 = 0.2 + 0.8 * percentile;
  } else {
    // Use sentiment volatility fallback
    P5 = sentimentVolatilityFallback(item.headline, item.body, item.tickers);
    fallbackUsed = true;
  }
  
  const assetClass = getAssetClass(item.tickers);
  
  // Simple sentiment score for debug
  const text = `${item.headline} ${item.body}`.toLowerCase();
  const positiveWords = ['surge', 'jump', 'rise', 'gain', 'up', 'positive', 'beat', 'exceed'];
  const negativeWords = ['drop', 'fall', 'decline', 'down', 'negative', 'miss', 'below'];
  const positiveCount = positiveWords.filter(word => text.includes(word)).length;
  const negativeCount = negativeWords.filter(word => text.includes(word)).length;
  const sentimentScore = positiveCount > negativeCount ? 0.6 : negativeCount > positiveCount ? 0.4 : 0.5;
  
  return {
    percentile,
    P5,
    fallbackUsed,
    sentimentScore,
    assetClass
  };
}
