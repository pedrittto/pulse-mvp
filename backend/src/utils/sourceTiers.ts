/**
 * Source Tier Mapping
 * Maps domains and URLs to source credibility tiers
 */

// Regulator domains (highest credibility)
export const REGULATORS = [
  'sec.gov',
  'ecb.europa.eu',
  'federalreserve.gov',
  'esma.europa.eu',
  'boe.org.uk',
  'bankofcanada.ca',
  'rba.gov.au',
  'boj.or.jp',
  'snb.ch',
  'riksbank.se',
  'norges-bank.no',
  'danmarksnationalbank.dk',
  'europarl.europa.eu',
  'europa.eu',
  'whitehouse.gov',
  'treasury.gov',
  'irs.gov',
  'cftc.gov',
  'fdic.gov',
  'federalregister.gov'
];

// Tier 1 media (high credibility)
export const TIER1_MEDIA = [
  'bloomberg.com',
  'reuters.com',
  'ft.com',
  'wsj.com',
  'apnews.com',
  'cnbc.com',
  'marketwatch.com',
  'financialtimes.com',
  'economist.com',
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk'
];

// Tier 2 media (medium credibility)
export const TIER2_MEDIA = [
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  'forbes.com',
  'fortune.com',
  'businessinsider.com',
  'cnn.com',
  'usatoday.com',
  'latimes.com',
  'chicagotribune.com',
  'bostonglobe.com',
  'sfgate.com'
];

// Primary corporate communication hints
export const PRIMARY_CORP_HINTS = [
  'ir.',
  'investors.',
  '/press/',
  '/newsroom/',
  '/media/',
  'sec.gov/ixviewer',
  '/earnings/',
  '/quarterly/',
  '/annual/',
  'prnewswire.com',
  'globenewswire.com',
  'businesswire.com'
];

// Social media verified accounts
export const SOCIAL_VERIFIED = [
  'twitter.com',
  'x.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com'
];

/**
 * Get source tier based on domain and URL
 * @param domain - The registrable domain (e.g., 'bloomberg.com')
 * @param url - Full URL for additional context
 * @returns Tier value (1.0, 0.8, 0.6, 0.4, 0.2, 0.0)
 */
export function getSourceTier(domain: string, url?: string): number {
  const domainLower = domain.toLowerCase();
  const urlLower = url?.toLowerCase() || '';

  // Check regulators first (highest priority)
  if (REGULATORS.some(reg => domainLower.includes(reg))) {
    return 1.0;
  }

  // Check primary corporate communications
  if (PRIMARY_CORP_HINTS.some(hint => urlLower.includes(hint))) {
    return 0.8;
  }

  // Check tier 1 media
  if (TIER1_MEDIA.some(media => domainLower.includes(media))) {
    return 0.6;
  }

  // Check tier 2 media
  if (TIER2_MEDIA.some(media => domainLower.includes(media))) {
    return 0.4;
  }

  // Check social media (verified accounts)
  if (SOCIAL_VERIFIED.some(social => domainLower.includes(social))) {
    return 0.2;
  }

  // Default to anonymous social/unknown
  return 0.0;
}
