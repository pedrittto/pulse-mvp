import { getSourceTier } from './sourceTiers';

/**
 * Verification System V1 - Deterministic 4-State Verification Status
 * 
 * Replaces percent-based confidence with clear verification states:
 * - Verified: Regulatory/filing OR official livestream+transcript OR k≥3 within 30m
 * - Confirmed: Tier-1 OR k≥2 OR on_record quote
 * - Reported: Single Tier-1/2 without denial
 * - Unconfirmed: Only low-tier/anon/social OR rumor-lexicon triggers
 * 
 * Live Event Override: if is_live_event AND source tier≥0.8 → min status Confirmed even at k=1
 */

export type VerificationStatus = 'verified' | 'confirmed' | 'reported' | 'unconfirmed';

export interface VerificationInputs {
  sources: Array<{ domain: string; isPrimary: boolean }>;
  headline: string;
  body: string;
  published_at: string;
  // Optional flags
  is_regulatory?: boolean;
  is_filing?: boolean;
  is_official_livestream?: boolean;
  is_on_record?: boolean;
  is_live_event?: boolean;
  // Cross-source confirmations within 30m window
  confirmations_count?: number; // k - number of unique sources
  confirmations_tiers?: number[]; // tiers of confirming sources
}

export interface VerificationResult {
  status: VerificationStatus;
  reason: string;
  k: number;
  max_tier: number;
  is_live_event: boolean;
  debug?: {
    matched_rule: string;
    confirmations_count: number;
    source_tiers: number[];
    live_event_override: boolean;
  };
}

export interface VerificationDebug {
  status: VerificationStatus;
  reason: string;
  k: number;
  max_tier: number;
  is_live_event: boolean;
  matched_rule: string;
  confirmations_count: number;
  source_tiers: number[];
  live_event_override: boolean;
  inputs: {
    is_regulatory: boolean;
    is_filing: boolean;
    is_official_livestream: boolean;
    is_on_record: boolean;
    is_live_event: boolean;
  };
}

/**
 * Main verification function
 */
export function computeVerification(inputs: VerificationInputs, debug: boolean = false): VerificationResult {
  const sources = inputs.sources || [];
  const headline = inputs.headline || '';
  const body = inputs.body || '';
  
  // Calculate source tiers
  const sourceTiers = sources.map(s => getSourceTier(s.domain));
  const maxTier = Math.max(...sourceTiers, 0);
  
  // Get confirmation count (k)
  const k = inputs.confirmations_count || new Set(sources.map(s => s.domain)).size;
  
  // Check for live event
  const isLiveEvent = inputs.is_live_event || detectLiveEvent(headline, body);
  
  // Check for regulatory/filing content
  const isRegulatory = inputs.is_regulatory || detectRegulatory(headline, body);
  const isFiling = inputs.is_filing || detectFiling(headline, body);
  
  // Check for official livestream
  const isOfficialLivestream = inputs.is_official_livestream || detectOfficialLivestream(headline, body);
  
  // Check for on-record quotes
  const isOnRecord = inputs.is_on_record || detectOnRecord(headline, body);
  
  // Check for rumor/denial patterns
  const hasRumorPatterns = detectRumorPatterns(headline, body);
  const hasDenialPatterns = detectDenialPatterns(headline, body);
  
  // Apply verification rules in order of precedence
  let status: VerificationStatus;
  let reason: string;
  let matchedRule: string;
  let liveEventOverride = false;
  
  // Rule 1: Verified - Regulatory/filing OR official livestream+transcript OR k≥3 within 30m
  if (isRegulatory || isFiling) {
    status = 'verified';
    reason = 'Regulatory filing or official document';
    matchedRule = 'regulatory_filing';
  } else if (isOfficialLivestream && hasTranscript(headline, body)) {
    status = 'verified';
    reason = 'Official livestream with transcript';
    matchedRule = 'official_livestream_transcript';
  } else if (k >= 3) {
    status = 'verified';
    reason = `${k} independent sources`;
    matchedRule = 'k_ge_3';
  }
  // Rule 2: Confirmed - k≥2 OR on_record quote OR Tier-1 (with live event override)
  else if (k >= 2) {
    status = 'confirmed';
    reason = `${k} independent sources`;
    matchedRule = 'k_ge_2';
  } else if (isOnRecord) {
    status = 'confirmed';
    reason = 'On-record quote';
    matchedRule = 'on_record_quote';
  }
  // Rule 3: Unconfirmed - Rumor patterns (check before Tier-1 to avoid false positives)
  else if (hasRumorPatterns) {
    status = 'unconfirmed';
    reason = 'Rumor patterns detected';
    matchedRule = 'rumor_patterns';
  } else if (maxTier >= 0.8) {
    // Check for live event override first
    if (isLiveEvent) {
      status = 'confirmed';
      reason = 'Tier-1 source + live event';
      matchedRule = 'live_event_override';
      liveEventOverride = true;
    } else {
      status = 'confirmed';
      reason = 'Tier-1 source';
      matchedRule = 'tier_1_source';
    }
  }
  // Rule 4: Reported - Single Tier-1/2 without denial
  else if (maxTier >= 0.6 && !hasDenialPatterns) {
    status = 'reported';
    reason = 'Single reputable source';
    matchedRule = 'single_reputable_source';
  }
  // Rule 5: Unconfirmed - Low-tier sources
  else if (maxTier < 0.6) {
    status = 'unconfirmed';
    reason = 'Low-tier source';
    matchedRule = 'low_tier_source';
  } else {
    // Fallback
    status = 'reported';
    reason = 'Single source';
    matchedRule = 'fallback_single_source';
  }
  
  const result: VerificationResult = {
    status,
    reason,
    k,
    max_tier: maxTier,
    is_live_event: isLiveEvent
  };
  
  if (debug) {
    result.debug = {
      matched_rule: matchedRule,
      confirmations_count: k,
      source_tiers: sourceTiers,
      live_event_override: liveEventOverride
    };
  }
  
  return result;
}

/**
 * Detect live event patterns
 */
function detectLiveEvent(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const liveEventPatterns = [
    /\b(live|breaking|developing|just in|as it happens)\b/i,
    /\b(press conference|earnings call|fomc meeting|fed meeting)\b/i,
    /\b(conference call|webcast|streaming|broadcast)\b/i,
    /\b(real.?time|live.?coverage|live.?blog)\b/i,
    /\b(announcement|statement|release)\b/i
  ];
  
  return liveEventPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect regulatory content
 */
function detectRegulatory(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const regulatoryPatterns = [
    /\b(sec announces|federal reserve announces|fed announces|ecb announces|boe announces|treasury announces)\b/i,
    /\b(regulatory announcement|regulation change|compliance update)\b/i,
    /\b(official announcement|government announcement|authority announcement)\b/i
  ];
  
  return regulatoryPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect filing content
 */
function detectFiling(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const filingPatterns = [
    /\b(8.?k|10.?k|form 4|form 13f)\b/i,
    /\b(quarterly report|annual report|earnings release)\b/i,
    /\b(sec filing|regulatory filing)\b/i,
    /\b(financial results|financial report)\b/i
  ];
  
  return filingPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect official livestream
 */
function detectOfficialLivestream(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const livestreamPatterns = [
    /\b(official livestream|official stream)\b/i,
    /\b(fed press conference|federal reserve press conference)\b/i,
    /\b(ecb press conference|european central bank press conference)\b/i,
    /\b(boe press conference|bank of england press conference)\b/i,
    /\b(government press conference|official press conference)\b/i
  ];
  
  return livestreamPatterns.some(pattern => pattern.test(text));
}

/**
 * Check if content has transcript
 */
function hasTranscript(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const transcriptPatterns = [
    /\b(transcript|transcribed|full text)\b/i,
    /\b(complete|full|entire)\b/i,
    /\b(quote|quoted|said)\b/i
  ];
  
  return transcriptPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect on-record quotes
 */
function detectOnRecord(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const onRecordPatterns = [
    /\b(ceo said|ceo stated|ceo announced|ceo confirmed)\b/i,
    /\b(cfo said|cfo stated|cfo announced)\b/i,
    /\b(spokesperson said|spokesman said|spokeswoman said)\b/i,
    /\b(executive said|official said)\b/i,
    /\b(quote|quoted|according to)\b/i,
    /\b(said during|stated during|announced during)\b/i
  ];
  
  return onRecordPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect rumor patterns
 */
function detectRumorPatterns(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const rumorPatterns = [
    /\b(rumor|rumour|hearsay|unconfirmed)\b/i,
    /\b(speculation|allegedly|reportedly)\b/i,
    /\b(sources say|anonymous|unnamed)\b/i,
    /\b(leak|leaked|insider)\b/i
  ];
  
  return rumorPatterns.some(pattern => pattern.test(text));
}

/**
 * Detect denial patterns
 */
function detectDenialPatterns(headline: string, body: string): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  
  const denialPatterns = [
    /\b(deny|denied|denies|denial)\b/i,
    /\b(false|untrue|incorrect|wrong)\b/i,
    /\b(no comment|decline to comment)\b/i,
    /\b(refute|refuted|refutes)\b/i
  ];
  
  return denialPatterns.some(pattern => pattern.test(text));
}

/**
 * Get verification status with full debug information
 */
export function computeVerificationWithDebug(inputs: VerificationInputs): VerificationDebug {
  const result = computeVerification(inputs, true);
  
  return {
    status: result.status,
    reason: result.reason,
    k: result.k,
    max_tier: result.max_tier,
    is_live_event: result.is_live_event,
    matched_rule: result.debug!.matched_rule,
    confirmations_count: result.debug!.confirmations_count,
    source_tiers: result.debug!.source_tiers,
    live_event_override: result.debug!.live_event_override,
    inputs: {
      is_regulatory: inputs.is_regulatory || false,
      is_filing: inputs.is_filing || false,
      is_official_livestream: inputs.is_official_livestream || false,
      is_on_record: inputs.is_on_record || false,
      is_live_event: inputs.is_live_event || false
    }
  };
}
