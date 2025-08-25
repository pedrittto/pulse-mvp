import { getSourceTier } from './sourceTiers.js';

export type ConfidenceState = 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';

export interface ConfidenceStateInputs {
  sources: Array<{ domain: string; isPrimary?: boolean }>;
  headline: string;
  body?: string;
  published_at?: string;
}

function toLower(text: string | undefined): string {
  return (text || '').toLowerCase();
}

function detectOfficialCommunication(headline: string, body: string, domains: string[]): boolean {
  const text = `${headline} ${body}`.toLowerCase();
  const patterns = [
    /\b(press release|official statement|official announcement)\b/i,
    /\b(sec filing|regulatory filing|8\s*-?k|10\s*-?q|10\s*-?k|form\s*4)\b/i,
    /\b(government|regulator|ministry|authority|commission)\b/i,
    /\b(company announced|the company announced|board approved)\b/i
  ];
  const domainHints = [/\.gov$/i, /sec\.gov$/i, /federalreserve\.gov$/i, /ecb\.europa\.eu$/i];
  const hasDomainHint = domains.some(d => domainHints.some(rx => rx.test(d)));
  return hasDomainHint || patterns.some(rx => rx.test(text));
}

function detectRumor(text: string): boolean {
  const patterns = [
    /\b(rumor|rumour|hearsay|unconfirmed)\b/i,
    /\b(speculation|allegedly|reportedly)\b/i,
    /\b(sources say|anonymous|unnamed)\b/i,
    /\b(leak|leaked|insider)\b/i
  ];
  return patterns.some(rx => rx.test(text));
}

export function computeConfidenceState(inputs: ConfidenceStateInputs): ConfidenceState {
  const headline = toLower(inputs.headline);
  const body = toLower(inputs.body);
  const domains = (inputs.sources || []).map(s => s.domain);
  const uniqueDomains = Array.from(new Set(domains));
  const k = uniqueDomains.length;
  const tiers = uniqueDomains.map(d => getSourceTier(d));
  const maxTier = tiers.length > 0 ? Math.max(...tiers) : 0;
  const numTier1 = tiers.filter(t => t >= 0.8).length;
  const hasTier1 = numTier1 > 0;
  const rumorLike = detectRumor(`${headline} ${body}`);

  // Rule precedence
  if (detectOfficialCommunication(headline, body, uniqueDomains)) {
    return 'confirmed';
  }

  if (hasTier1 || (k >= 3 && hasTier1)) {
    // Tier-1 outlet(s) OR 3+ sources with at least 1 Tier-1
    return 'verified';
  }

  if (k >= 2) {
    // At least 2 independent outlets
    return 'corroborated';
  }

  // Reported: one solid outlet OR multiple weak outlets
  if (k === 1 && maxTier >= 0.6) {
    return 'reported';
  }

  if (k >= 2) {
    return 'reported';
  }

  // Unconfirmed: rumor, single weak source
  if (k <= 1 && (maxTier < 0.6 || rumorLike)) {
    return 'unconfirmed';
  }

  // Fallback
  return 'reported';
}


