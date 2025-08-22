export type OriginLabel = 'REGULATORY' | 'EXCHANGE' | 'WIRE' | 'COMPANY_NEWSROOM';

export type OriginHost = {
  domain: string;
  label: OriginLabel;
  paths: string[];
  supportsH2?: boolean;
  preferHEAD?: boolean;
  clampFloorMs?: number;
  notes?: string;
};

export const ORIGINS_HOSTS: OriginHost[] = [
  { domain: 'prnewswire.com', label: 'WIRE', paths: ['/rss/'], supportsH2: true },
  { domain: 'businesswire.com', label: 'WIRE', paths: ['/portal/site/home/news/'], supportsH2: true },
  { domain: 'globenewswire.com', label: 'WIRE', paths: ['/newsroom/'], supportsH2: true },

  { domain: 'nasdaqtrader.com', label: 'EXCHANGE', paths: ['/TraderNews.aspx','/TraderNewsRSS.aspx'], notes: 'RSS often minute-cadence; prefer live page if allowed' },
  { domain: 'nyse.com', label: 'EXCHANGE', paths: ['/trading-halts','/market-notices'] },
  { domain: 'cboe.com', label: 'EXCHANGE', paths: ['/trade/market-status/halts'] },
  { domain: 'sec.gov', label: 'REGULATORY', paths: ['/cgi-bin/browse-edgar','/Archives/edgar'], notes: 'RSS can be coarse; prefer structured/index endpoints if allowed' },
  { domain: 'londonstockexchange.com', label: 'EXCHANGE', paths: ['/news/rns','/news/'], notes: 'RNS (PIP) primary channel' },
  { domain: 'asx.com.au', label: 'EXCHANGE', paths: ['/asx/share-market-news/'], supportsH2: true },
  { domain: 'sgx.com', label: 'EXCHANGE', paths: ['/securities/company-announcements'], supportsH2: true },
  { domain: 'hkexnews.hk', label: 'EXCHANGE', paths: ['/hkexnews/di/di.htm','/hkexnews/Announcement/'] },

  { domain: '*', label: 'COMPANY_NEWSROOM', paths: ['/news-sitemap.xml','/sitemap.xml','/rss','/atom.xml'], notes: 'Enable ETag/IMS; whitelist curated list' }
];

export function isOriginDomain(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  for (const o of ORIGINS_HOSTS) {
    if (o.domain === '*') continue;
    if (h === o.domain || h.endsWith('.' + o.domain)) return true;
  }
  return false;
}


