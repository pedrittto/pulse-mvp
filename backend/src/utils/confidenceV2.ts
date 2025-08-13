import { getSourceTier } from './sourceTiers';

/**
 * Confidence V2 - Five Pillar Scoring System
 * 
 * Pillars:
 * 1. Source+Time (30%) - Source credibility + freshness
 * 2. Cross-source confirmations (25%) - Multiple independent sources
 * 3. Macro/Trend fit (20%) - Alignment with market trends
 * 4. Legal/Reputational cost (15%) - Source accountability
 * 5. Early market reaction proxy (10%) - Market response signals
 */

// Core constants
export const CONF_MIN = 20;
export const CONF_MAX = 95;

// Pillar weights (sum = 1.0)
export const W_SOURCE_TIME = 0.30;
export const W_CONFIRM = 0.25;
export const W_TREND_FIT = 0.20;
export const W_LEGAL_RISK = 0.15;
export const W_MARKET_RX = 0.10;

// Source+Time sub-weights and thresholds
export const FRESH_MIN = 0;
export const FRESH_MAX_MINUTES = 120; // full credit if <=5 min, linear decay to 0 by 120 min

// Confirmation thresholds
export const CONFIRM_MIN = 1;
export const CONFIRM_GOOD = 2;
export const CONFIRM_STRONG = 3; // distinct independent sources

// Trend/Macro fit
export const TREND_ALIGN_BOOST = 1;
export const TREND_CONTRA_FLAG = -1; // heuristic sign

// Source tiers (legal/reputational cost proxies)
export const SOURCE_TIERS = {
  regulator: 1.0, // SEC, ESMA, central banks, gov gazettes
  primary_corp: 0.8, // official company PR/8-K/etc.
  tier1_media: 0.6, // Bloomberg, Reuters, FT, WSJ
  tier2_media: 0.4,
  social_verified: 0.2,
  anon_social: 0.0
} as const;

// Helper functions
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function linMap(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

// Input type for confidence v2 scoring
export type PillarInputs = {
  publishedAt: Date;
  now: Date; // for freshness
  sources: Array<{ domain: string; isPrimary: boolean }>; // deduped by registrable domain
  headline: string;
  body: string;
  tags?: string[];
  impact_score?: number;
  // optional adapters (may be null → then pillar=0)
  market?: { realizedMoveBps?: number; volumeSpike?: number }; // relative to baseline (z-score or ratio)
};

/**
 * Score confidence using the five-pillar system
 * @param i - Pillar inputs
 * @returns Confidence score (0-100 before clamp)
 */
export function scoreConfidenceV2(i: PillarInputs): number {
  // Pillar 1: Source+Time (30%)
  const pillar1 = computeSourceTimePillar(i);
  
  // Pillar 2: Cross-source confirmations (25%)
  const pillar2 = computeConfirmationPillar(i);
  
  // Pillar 3: Macro/Trend fit (20%)
  const pillar3 = computeTrendFitPillar(i);
  
  // Pillar 4: Legal/Reputational risk (15%)
  const pillar4 = computeLegalRiskPillar(i);
  
  // Pillar 5: Market reaction proxy (10%)
  const pillar5 = computeMarketReactionPillar(i);
  
  // Aggregate weighted score
  const raw = 100 * (
    W_SOURCE_TIME * pillar1 +
    W_CONFIRM * pillar2 +
    W_TREND_FIT * pillar3 +
    W_LEGAL_RISK * pillar4 +
    W_MARKET_RX * pillar5
  );
  
  return Math.round(raw);
}

/**
 * Pillar 1: Source+Time (30%)
 * freshnessScore = linear 1.0 → 0.0 between 0–120 min (cap at 0).
 * sourceTier = max tier among sources using domain mapping lists.
 * pillar = 100 * (0.6*sourceTier + 0.4*freshnessScore).
 */
function computeSourceTimePillar(i: PillarInputs): number {
  // Calculate freshness score
  const minutesDiff = (i.now.getTime() - i.publishedAt.getTime()) / (1000 * 60);
  const freshnessScore = minutesDiff <= 5 ? 1.0 : 
    minutesDiff >= FRESH_MAX_MINUTES ? 0.0 :
    linMap(minutesDiff, 5, FRESH_MAX_MINUTES, 1.0, 0.0);
  
  // Calculate source tier (max among all sources)
  const sourceTiers = i.sources.map(s => getSourceTier(s.domain));
  const maxSourceTier = Math.max(...sourceTiers, 0);
  
  // Combine: 60% source tier + 40% freshness
  return 0.6 * maxSourceTier + 0.4 * freshnessScore;
}

/**
 * Pillar 2: Cross-source confirmations (25%)
 * k = count of independent sources (unique registrable domains) with non-trivial mention.
 * map: k=1 → 0.0, k=2 → 0.7, k≥3 → 1.0.
 */
function computeConfirmationPillar(i: PillarInputs): number {
  const uniqueDomains = new Set(i.sources.map(s => s.domain));
  const k = uniqueDomains.size;
  
  if (k >= CONFIRM_STRONG) return 1.0;
  if (k === CONFIRM_GOOD) return 0.7;
  if (k === CONFIRM_MIN) return 0.0; // Fixed: k=1 should return 0.0, not 0.25
  return 0.0;
}

/**
 * Pillar 3: Macro/Trend fit (20%)
 * Use existing heuristics: macro keywords, impact_score, and a simple align metric:
 * align = +1 if macro/impact_score≥60 and headline lacks "rumor/opinion"; 
 * -1 if it contains contra words (e.g., "denies", "rumor", "opinion"), else 0.
 * pillar = (align>0 ? 1.0 : align<0 ? 0.0 : 0.5).
 */
function computeTrendFitPillar(i: PillarInputs): number {
  const isMacro = i.tags?.includes('Macro') || false;
  const hasHighImpact = (i.impact_score || 0) >= 60;
  const text = `${i.headline} ${i.body}`.toLowerCase();
  
  // Check for contra words
  const contraWords = ['denies', 'rumor', 'opinion', 'op-ed', 'column', 'reportedly', 'sources say'];
  const hasContraWords = contraWords.some(word => text.includes(word));
  
  let align = 0;
  if (isMacro && hasHighImpact && !hasContraWords) {
    align = TREND_ALIGN_BOOST;
  } else if (hasContraWords) {
    align = TREND_CONTRA_FLAG;
  }
  
  if (align > 0) return 1.0;
  if (align < 0) return 0.0;
  return 0.5;
}

/**
 * Pillar 4: Legal/Reputational risk (15%)
 * pillar = top sourceTier (same as above). If none matched → 0.2 baseline.
 */
function computeLegalRiskPillar(i: PillarInputs): number {
  const sourceTiers = i.sources.map(s => getSourceTier(s.domain));
  const maxSourceTier = Math.max(...sourceTiers, 0);
  
  return maxSourceTier > 0 ? maxSourceTier : 0.2; // baseline if no tier matched
}

/**
 * Pillar 5: Market reaction proxy (10%)
 * If market exists: normalize realizedMoveBps (0→0, 30bps→1.0 clipped) and 
 * volumeSpike (1.0→0, ≥2.0→1.0 clipped), average them. Else 0.
 */
function computeMarketReactionPillar(i: PillarInputs): number {
  if (!i.market) return 0.0;
  
  const { realizedMoveBps, volumeSpike } = i.market;
  
  let moveScore = 0.0;
  if (realizedMoveBps !== undefined) {
    moveScore = clamp(realizedMoveBps / 30, 0, 1); // normalize to 30bps = 1.0
  }
  
  let volumeScore = 0.0;
  if (volumeSpike !== undefined) {
    volumeScore = clamp((volumeSpike - 1.0) / 1.0, 0, 1); // normalize: 1.0→0, 2.0→1.0
  }
  
  return (moveScore + volumeScore) / 2;
}
