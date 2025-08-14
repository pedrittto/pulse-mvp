/**
 * Source Tier Mapping for Confidence V2.1
 * Maps domains and URLs to source credibility tiers
 * 
 * Tier values:
 * 1.0 - regulator (SEC, ECB, etc.)
 * 0.9 - corporate PR/IR (official newsroom/8-K)
 * 0.8 - Tier-1 media (Bloomberg/FT/WSJ/Reuters/CNBC)
 * 0.6 - Tier-2 media / quality trade press
 * 0.3 - signed blog/social (named account)
 * 0.0 - anonymous/throwaway social
 */

// Regulator domains (highest credibility)
export const REGULATORS = [
  'sec.gov',
  'ecb.europa.eu',
  'ecb.int',
  'federalreserve.gov',
  'esma.europa.eu',
  'boe.org.uk',
  'boe.uk',
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
  'federalregister.gov',
  'bis.org'
];

// Tier 1 media (high credibility) - 0.8
export const TIER1_MEDIA = [
  'bloomberg.com',
  'bloomberglaw.com',
  'reuters.com',
  'ft.com',
  'financialtimes.com',
  'wsj.com',
  'cnbc.com',
  'apnews.com',
  'marketwatch.com',
  'economist.com',
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk'
];

// Tier 2 media (medium credibility) - 0.6
export const TIER2_MEDIA = [
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  'forbes.com',
  'fortune.com',
  'businessinsider.com',
  'seekingalpha.com',
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
 * Extract registered domain from URL
 * @param url - Full URL
 * @returns Registered domain (e.g., 'bloomberg.com' from 'https://www.bloomberg.com/news/...')
 */
export function getRegisteredDomain(url: string): string {
  try {
    // Simple regex to extract domain
    const domainMatch = url.match(/https?:\/\/(?:www\.)?([^\/]+)/i);
    if (domainMatch) {
      return domainMatch[1].toLowerCase();
    }
  } catch (error) {
    // Fallback to simple parsing
  }
  
  // Fallback: try to extract domain from the URL
  const urlParts = url.toLowerCase().split('/');
  if (urlParts.length >= 3) {
    const domainPart = urlParts[2];
    if (domainPart.includes('.')) {
      return domainPart;
    }
  }
  
  return url.toLowerCase();
}

/**
 * Get source tier based on domain and URL
 * @param domain - The registrable domain (e.g., 'bloomberg.com')
 * @param url - Full URL for additional context
 * @returns Tier value (1.0, 0.9, 0.8, 0.6, 0.3, 0.0)
 */
export function getSourceTier(domain: string, url?: string): number {
  const domainLower = domain.toLowerCase();
  const urlLower = url?.toLowerCase() || '';

  // Check regulators first (highest priority) - Tier 1.0
  if (REGULATORS.some(reg => domainLower.includes(reg))) {
    return 1.0;
  }

  // Check primary corporate communications - Tier 0.9
  if (PRIMARY_CORP_HINTS.some(hint => urlLower.includes(hint))) {
    return 0.9;
  }

  // Check tier 1 media - Tier 0.8
  if (TIER1_MEDIA.some(media => domainLower.includes(media))) {
    return 0.8;
  }

  // Check tier 2 media - Tier 0.6
  if (TIER2_MEDIA.some(media => domainLower.includes(media))) {
    return 0.6;
  }

  // Check social media (verified accounts) - Tier 0.3
  if (SOCIAL_VERIFIED.some(social => domainLower.includes(social))) {
    return 0.3;
  }

  // Default to anonymous social/unknown - Tier 0.0
  return 0.0;
}
