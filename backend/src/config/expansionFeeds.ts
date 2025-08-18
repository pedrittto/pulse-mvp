export type ExpansionFeed = {
  name: string;
  url: string;
  category?: string;
};

// Additional general/trading/markets/macro sources for ingestion expansion
export const expansionFeeds: ExpansionFeed[] = [
  // Markets/trading
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml' },
  { name: 'Investing.com Markets', url: 'https://www.investing.com/rss/news_301.rss' },
  { name: 'MarketWatch Top Stories', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  // Wires and filings
  { name: 'PRNewswire', url: 'https://www.prnewswire.com/rss/all-news-releases-list.rss' },
  { name: 'GlobeNewswire', url: 'https://www.globenewswire.com/Rss/Index' },
  { name: 'SEC Filings', url: 'https://www.sec.gov/Archives/edgar/usgaap.rss.xml' },
  // Macro calendars (best-effort public feeds)
  { name: 'BLS Releases', url: 'https://www.bls.gov/feed/news_release.rss' },
  { name: 'BEA News', url: 'https://www.bea.gov/rss.xml' },
  // Exchange notices
  { name: 'NASDAQ Trader News', url: 'http://www.nasdaqtrader.com/rss.aspx?feed=Headlines' },
  { name: 'NYSE Notices', url: 'https://www.nyse.com/api/announcements/rss' },
  // Macro/Economy
  { name: 'Bloomberg Economics', url: 'https://feeds.bloomberg.com/economics/news.rss' },
  { name: 'Reuters World News', url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'AP Top News', url: 'https://feeds.ap.org/apf-topnews' },
  // Tech/business (broad, often market-moving)
  { name: 'The Verge Tech', url: 'https://www.theverge.com/tech/rss/index.xml' },
  { name: 'Ars Technica Business', url: 'https://feeds.arstechnica.com/arstechnica/business' }
];


