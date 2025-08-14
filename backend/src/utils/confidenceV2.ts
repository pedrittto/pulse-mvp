import { getSourceTier } from './sourceTiers';

/**
 * Confidence V2.1 — High-Contrast Scoring System
 * 
 * Weights (sum to 1.0):
 *  W = { P1:0.35, P2:0.25, P3:0.20, P4:0.15, P5:0.05 }
 * 
 * Final computation:
 * 1) Compute five pillars P1..P5 in [0..1], then weighted sum: S = Σ (W_i * P_i)
 * 2) Contrast expansion around 0.5: C = clamp01( 0.5 + 1.6 * (S - 0.5) )
 * 3) Map to 20..95 and round to integer: confidence = clamp( 20 + round(75 * C), 20, 95 )
 */

// Core constants
export const CONF_MIN = 20;
export const CONF_MAX = 95;

// Pillar weights (sum = 1.0)
export const W_P1 = 0.35; // Source + Freshness
export const W_P2 = 0.25; // Cross-source confirmations
export const W_P3 = 0.20; // Macro/Trend fit
export const W_P4 = 0.15; // Legal/Reputational accountability
export const W_P5 = 0.05; // Market reaction proxy

// Freshness half-life (minutes)
export const FRESHNESS_HALF_LIFE = 180; // τ=180 minutes

// Anti-rumor penalty
export const ANTI_RUMOR_PENALTY = 0.30;

// Helper functions
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function contrast(S: number): number {
  return clamp01(0.5 + 1.6 * (S - 0.5));
}

export function toPercent(C: number): number {
  return Math.max(20, Math.min(95, 20 + Math.round(75 * C)));
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Input type for confidence v2.1 scoring
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

// Debug output type
export type ConfidenceDebug = {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  S: number;
  C: number;
  tiers: number[];
  k: number;
  freshness: number;
  penalties: number;
  tagsTaken: string[];
  independenceBonus: number;
};

// Main scoring function
export function scoreConfidenceV2(inputs: PillarInputs): { raw: number; final: number; debug?: ConfidenceDebug } {
  // Pillar 1: Source + Freshness (weight 0.35)
  const pillar1 = computePillar1(inputs);
  
  // Pillar 2: Cross-source confirmations (weight 0.25)
  const pillar2 = computePillar2(inputs);
  
  // Pillar 3: Macro/Trend fit (weight 0.20)
  const pillar3 = computePillar3(inputs);
  
  // Pillar 4: Legal/Reputational accountability (weight 0.15)
  const pillar4 = computePillar4(inputs);
  
  // Pillar 5: Market reaction proxy (weight 0.05)
  const pillar5 = computePillar5(inputs);
  
  // Weighted sum
  const S = W_P1 * pillar1 + W_P2 * pillar2 + W_P3 * pillar3 + W_P4 * pillar4 + W_P5 * pillar5;
  
  // Contrast expansion
  const C = contrast(S);
  
  // Map to final range
  const final = toPercent(C);
  
  // Raw score (before clamp, via C * 100)
  const raw = Math.round(C * 100);
  
  // Debug information
  const debug: ConfidenceDebug = {
    P1: pillar1,
    P2: pillar2,
    P3: pillar3,
    P4: pillar4,
    P5: pillar5,
    S,
    C,
    tiers: inputs.sources.map(s => getSourceTier(s.domain)),
    k: new Set(inputs.sources.map(s => s.domain)).size,
    freshness: computeFreshness(inputs.publishedAt, inputs.now),
    penalties: computeAntiRumorPenalty(inputs.headline, inputs.body),
    tagsTaken: inputs.tags || [],
    independenceBonus: computeIndependenceBonus(inputs.sources)
  };
  
  return { raw, final, debug };
}

/**
 * P1 — Source + Freshness (weight 0.35)
 * - Tier T ∈ {1.0, 0.9, 0.8, 0.6, 0.3, 0.0}
 * - Freshness F = exp( - minutes_since_pub / 180 )
 * - Anti-rumor penalty R = 0.30 if headline/body matches rumor patterns
 * - Formula: P1 = max(0, 0.7*T + 0.3*F − R)
 */
function computePillar1(inputs: PillarInputs): number {
  // Calculate source tier (max among all sources)
  const sourceTiers = inputs.sources.map(s => getSourceTier(s.domain));
  const T = Math.max(...sourceTiers, 0);
  
  // Calculate freshness
  const F = computeFreshness(inputs.publishedAt, inputs.now);
  
  // Calculate anti-rumor penalty
  const R = computeAntiRumorPenalty(inputs.headline, inputs.body);
  
  // Formula: P1 = max(0, 0.7*T + 0.3*F − R)
  return Math.max(0, 0.7 * T + 0.3 * F - R);
}

/**
 * P2 — Cross-source confirmations (weight 0.25)
 * - k = number of UNIQUE domains (dedupe by registered domain)
 * - Base mapping: k=1 → 0.0, k=2 → 0.7, k≥3 → 1.0
 * - Independence bonus +0.10 if confirmations span >1 source class
 * - Formula: P2 = clamp01( base(k) + independence_bonus )
 */
function computePillar2(inputs: PillarInputs): number {
  const uniqueDomains = new Set(inputs.sources.map(s => s.domain));
  const k = uniqueDomains.size;
  
  // Base mapping
  let base = 0.0;
  if (k === 1) base = 0.0;
  else if (k === 2) base = 0.7;
  else if (k >= 3) base = 1.0;
  
  // Independence bonus
  const independenceBonus = computeIndependenceBonus(inputs.sources);
  
  // Formula: P2 = clamp01( base(k) + independence_bonus )
  return clamp01(base + independenceBonus);
}

/**
 * P3 — Macro/Trend fit (weight 0.20)
 * - Use existing tags/keywords. Scoring (choose the max applicable, do NOT sum):
 *   macro fit (CPI/FOMC/OPEC/payrolls) → 0.8
 *   sectoral fit (earnings, M&A, guidance) → 0.6
 *   purely informational w/o hard data → 0.4
 *   opinion/feature → 0.1
 * - Formula: P3 ∈ {0.8, 0.6, 0.4, 0.1}
 */
function computePillar3(inputs: PillarInputs): number {
  const text = `${inputs.headline} ${inputs.body}`.toLowerCase();
  const tags = inputs.tags || [];
  
  // Check for macro keywords
  const macroKeywords = ['cpi', 'fomc', 'opec', 'payrolls', 'fed', 'interest rate', 'ecb', 'boe'];
  const hasMacroKeywords = macroKeywords.some(keyword => text.includes(keyword));
  
  // Check for sectoral keywords
  const sectoralKeywords = ['earnings', 'quarterly', 'annual', 'guidance', 'acquisition', 'merger', 'm&a'];
  const hasSectoralKeywords = sectoralKeywords.some(keyword => text.includes(keyword));
  
  // Check for opinion/feature keywords
  const opinionKeywords = ['opinion', 'op-ed', 'column', 'analysis', 'commentary', 'view'];
  const hasOpinionKeywords = opinionKeywords.some(keyword => text.includes(keyword));
  
  // Choose the max applicable score
  if (hasMacroKeywords) return 0.8;
  if (hasSectoralKeywords) return 0.6;
  if (hasOpinionKeywords) return 0.1;
  return 0.4; // purely informational w/o hard data
}

/**
 * P4 — Legal/Reputational accountability (weight 0.15)
 * - Official named org/channel → 1.0
 * - Journalist + Tier-1 newsroom → 0.8
 * - Signed blog/analysis → 0.5
 * - Anonymous / uncontactable → 0.0
 * - Formula: P4 = accountability_score
 */
function computePillar4(inputs: PillarInputs): number {
  const sourceTiers = inputs.sources.map(s => getSourceTier(s.domain));
  const maxTier = Math.max(...sourceTiers, 0);
  
  // Map tiers to accountability scores
  if (maxTier >= 1.0) return 1.0; // regulator
  if (maxTier >= 0.8) return 0.8; // corporate PR/IR
  if (maxTier >= 0.6) return 0.8; // Tier-1 media
  if (maxTier >= 0.4) return 0.5; // Tier-2 media
  if (maxTier >= 0.2) return 0.5; // signed blog/social
  return 0.0; // anonymous/throwaway social
}

/**
 * P5 — Market reaction proxy (weight 0.05)
 * - If no market data → neutral 0.5 (so P5 doesn't depress the score)
 * - If available: compute percentile of |Δ%| vs last N for the most directly affected instrument
 * - Formula: P5 = 0.2 + 0.8 * pct (small moves≈0.2, very large≈1.0)
 */
function computePillar5(inputs: PillarInputs): number {
  if (!inputs.market) {
    return 0.5; // neutral so P5 doesn't depress the score
  }
  
  const { realizedMoveBps, volumeSpike } = inputs.market;
  
  // For now, use a simple mapping since we don't have percentile data
  // This is a placeholder - in production, you'd compute actual percentiles
  let movePercentile = 0.5; // default neutral
  
  if (realizedMoveBps !== undefined) {
    // Simple mapping: 0bps = 0.2, 30bps = 0.8, 60bps+ = 1.0
    const absMove = Math.abs(realizedMoveBps);
    if (absMove <= 5) movePercentile = 0.2;
    else if (absMove <= 15) movePercentile = 0.4;
    else if (absMove <= 30) movePercentile = 0.6;
    else if (absMove <= 60) movePercentile = 0.8;
    else movePercentile = 1.0;
  }
  
  // Formula: P5 = 0.2 + 0.8 * pct
  return 0.2 + 0.8 * movePercentile;
}

// Helper functions
function computeFreshness(publishedAt: Date, now: Date): number {
  const minutesDiff = (now.getTime() - publishedAt.getTime()) / (1000 * 60);
  return Math.exp(-minutesDiff / FRESHNESS_HALF_LIFE);
}

function computeAntiRumorPenalty(headline: string, body: string): number {
  const text = `${headline} ${body}`.toLowerCase();
  const rumorPattern = /(rumor|opinion|analysis|hearsay|denies|could|might)/i;
  return rumorPattern.test(text) ? ANTI_RUMOR_PENALTY : 0.0;
}

function computeIndependenceBonus(sources: Array<{ domain: string; isPrimary: boolean }>): number {
  if (sources.length < 2) return 0.0;
  
  const sourceTiers = sources.map(s => getSourceTier(s.domain));
  const uniqueTiers = new Set(sourceTiers);
  
  // Check if confirmations span >1 source class
  // Source classes: regulator(1.0), corporate(0.8), tier1(0.6), tier2(0.4), social(0.2), anonymous(0.0)
  const hasRegulator = sourceTiers.some(tier => tier >= 1.0);
  const hasCorporate = sourceTiers.some(tier => tier >= 0.8 && tier < 1.0);
  const hasTier1 = sourceTiers.some(tier => tier >= 0.6 && tier < 0.8);
  const hasTier2 = sourceTiers.some(tier => tier >= 0.4 && tier < 0.6);
  const hasSocial = sourceTiers.some(tier => tier >= 0.2 && tier < 0.4);
  
  const sourceClasses = [hasRegulator, hasCorporate, hasTier1, hasTier2, hasSocial].filter(Boolean);
  
  return sourceClasses.length > 1 ? 0.10 : 0.0;
}

// Legacy function for backward compatibility
export function scoreConfidenceV2Legacy(i: PillarInputs): number {
  const result = scoreConfidenceV2(i);
  return result.final;
}
