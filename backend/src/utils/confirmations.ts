import { getSourceTier } from './sourceTiers';

// Configuration constants
export const getConfirmationAlpha = () => parseFloat(process.env.CONFIRMATION_ALPHA || '0.9');
export const getConfirmationSoloSafety = () => parseFloat(process.env.CONFIRMATION_SOLO_SAFETY || '0.20');
export const getConfirmationWindowMin = () => parseInt(process.env.CONFIRMATION_WINDOW_MIN || '60');

// Source class definitions
export type SourceClass = 'regulator' | 'corp_pr' | 'tier1' | 'tier2' | 'social_verified' | 'anonymous';

export interface ConfirmationItem {
  domain: string;
  publishedAt: Date;
  title: string;
  titleEmbedding?: number[]; // Optional for now, will be stubbed
}

export interface ConfirmationResult {
  k: number;
  f_k: number;
  diversity_bonus: number;
  P2: number;
  sourceClasses: SourceClass[];
}

/**
 * Get source class based on domain tier
 */
export function getSourceClass(domain: string): SourceClass {
  const tier = getSourceTier(domain);
  
  if (tier >= 1.0) return 'regulator';
  if (tier >= 0.8) return 'corp_pr';
  if (tier >= 0.6) return 'tier1';
  if (tier >= 0.4) return 'tier2';
  if (tier >= 0.2) return 'social_verified';
  return 'anonymous';
}

/**
 * Count unique confirmations with deduplication by title embedding similarity
 * and time proximity
 */
export function countUniqueConfirmations(
  items: ConfirmationItem[],
  windowMinutes?: number
): number {
  const defaultWindow = getConfirmationWindowMin();
  const actualWindow = windowMinutes ?? defaultWindow;
  
  if (items.length === 0) return 0;
  if (items.length === 1) return 1;

  // For now, since we don't have real confirmations from other sources,
  // we'll count unique domains as a proxy for confirmations
  const uniqueDomains = new Set(items.map(item => item.domain));
  return uniqueDomains.size;
}

/**
 * Check if two items have similar titles (stubbed implementation)
 * In production, this would use cosine similarity of title embeddings
 */
function checkTitleSimilarity(item1: ConfirmationItem, item2: ConfirmationItem): boolean {
  // Stubbed implementation - in production would use embedding similarity
  // For now, use simple string similarity as fallback
  const title1 = item1.title.toLowerCase();
  const title2 = item2.title.toLowerCase();
  
  // Simple Jaccard similarity as fallback
  const words1 = new Set(title1.split(/\s+/));
  const words2 = new Set(title2.split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  const similarity = intersection.size / union.size;
  return similarity > 0.85; // Threshold for similarity
}

/**
 * Check if confirmations span multiple source classes
 */
export function hasCrossClassConfirmations(items: ConfirmationItem[]): boolean {
  if (items.length < 2) return false;
  
  const sourceClasses = items.map(item => getSourceClass(item.domain));
  const uniqueClasses = new Set(sourceClasses);
  
  return uniqueClasses.size > 1;
}

/**
 * Compute confirmation function f_k = 1 - exp(-α * max(k-1, 0))
 */
export function computeConfirmationFunction(k: number, alpha?: number): number {
  const actualAlpha = alpha ?? getConfirmationAlpha();
  return 1 - Math.exp(-actualAlpha * Math.max(k - 1, 0));
}

/**
 * Main confirmation scoring function
 */
export function scoreConfirmations(
  items: ConfirmationItem[],
  tier: number,
  fresh: number
): ConfirmationResult {
  const k = countUniqueConfirmations(items);
  const f_k = computeConfirmationFunction(k);
  
  // Apply solo safety for high-tier, fresh content
  let adjusted_f_k = f_k;
  if (k === 1 && tier >= 0.8 && fresh >= 0.7) {
    adjusted_f_k = Math.max(f_k, getConfirmationSoloSafety());
  }
  
  // Check for diversity bonus
  const diversity_bonus = hasCrossClassConfirmations(items) ? 0.10 : 0.0;
  
  // Compute P2
  const P2 = Math.max(0, Math.min(1, adjusted_f_k + diversity_bonus));
  
  const sourceClasses = items.map(item => getSourceClass(item.domain));
  
  return {
    k,
    f_k: adjusted_f_k,
    diversity_bonus,
    P2,
    sourceClasses
  };
}
