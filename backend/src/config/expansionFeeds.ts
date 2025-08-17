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
  // Macro/Economy
  { name: 'Bloomberg Economics', url: 'https://feeds.bloomberg.com/economics/news.rss' },
  { name: 'Reuters World News', url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'AP Top News', url: 'https://feeds.ap.org/apf-topnews' },
  // Tech/business (broad, often market-moving)
  { name: 'The Verge Tech', url: 'https://www.theverge.com/tech/rss/index.xml' },
  { name: 'Ars Technica Business', url: 'https://feeds.arstechnica.com/arstechnica/business' }
];


