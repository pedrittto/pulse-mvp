export const rssFeeds = [
  {
    name: 'Reuters Business',
    url: 'https://feeds.reuters.com/reuters/businessNews',
    alternates: [
      'https://www.reuters.com/markets/companies/rss',
      'https://www.reuters.com/markets/rss',
      'https://www.reuters.com/markets/asia/rss'
    ] as any,
    category: 'business'
  },
  {
    name: 'AP Business',
    url: 'https://feeds.ap.org/ap/business',
    alternates: [
      'https://feeds.ap.org/apf-business',
      'https://apnews.com/hub/apf-business?output=atom'
    ] as any,
    category: 'business'
  },
  {
    name: 'BBC Business',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    category: 'business',
    enabled: true,
    fastlane: true
  },
  {
    name: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    category: 'business',
    enabled: true,
    fastlane: true
  },
  {
    name: 'Bloomberg Markets',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
    category: 'business',
    enabled: true,
    fastlane: true
  },
  {
    name: 'Business Wire',
    url: 'https://www.businesswire.com/portal/site/home/news',
    category: 'business',
    enabled: true,
    fastlane: false
  },
  {
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    category: 'tech'
  },
  {
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'tech'
  },
  {
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    category: 'tech'
  },
  {
    name: 'MarketWatch',
    url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/',
    category: 'business'
  },
  {
    name: 'Financial Times',
    url: 'https://www.ft.com/rss/home',
    category: 'business',
    enabled: true,
    fastlane: true
  },
  // Wire-speed fallbacks and notices (add to base set for reliability)
  { name: 'PRNewswire', url: 'https://www.prnewswire.com/rss/all-news-releases-list.rss', category: 'business', enabled: true, fastlane: true },
  { name: 'GlobeNewswire', url: 'https://www.globenewswire.com/Rss/Index', category: 'business', enabled: true, fastlane: false },
  { name: 'SEC Filings', url: 'https://www.sec.gov/Archives/edgar/usgaap.rss.xml', category: 'business', enabled: true, fastlane: false },
  { name: 'BLS Releases', url: 'https://www.bls.gov/feed/news_release.rss', category: 'macro' },
  { name: 'BEA News', url: 'https://www.bea.gov/rss.xml', category: 'macro' },
  { name: 'NASDAQ Trader News', url: 'https://www.nasdaqtrader.com/rss.aspx?feed=Headlines', category: 'markets', enabled: true, fastlane: true },
  { name: 'NYSE Notices', url: 'https://www.nyse.com/api/announcements/rss', category: 'markets', enabled: false }
];

export function getHostForSource(name: string): string | null {
  try {
    const f = (rssFeeds as any[]).find((x: any) => String(x.name) === String(name));
    if (!f || !f.url) return null;
    return new URL(f.url).host;
  } catch { return null; }
}

export function getRssSources() {
  return rssFeeds as any[];
}