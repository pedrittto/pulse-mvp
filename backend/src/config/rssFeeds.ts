export const DEFAULT_URLS = {
  PRN_RSS_URL: "https://www.prnewswire.com/rss/news-releases-list.rss",
  BW_RSS_URL: "https://www.businesswire.com/portal/site/home/news/subject/?vnsId=31350&rss=1",
  // Leave GNW empty by default; set via ENV when ready
  GNW_RSS_URL: (process.env.GLOBENEWSWIRE_RSS_URL ?? ''),
  // Leave EDGAR Atom empty by default; set via ENV when ready
  EDGAR_ATOM_URL: (process.env.EDGAR_LATEST_ATOM_URL ?? ''),
  SEC_PRESS_URL: "https://www.sec.gov/news/pressreleases.rss",
  NASDAQ_HALTS_URL: "https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts",
  NYSE_NOTICES_URL: "https://www.nyse.com/trader-update/history",
  CME_NOTICES_URL: "https://www.cmegroup.com/notices.html",
  FED_PRESS_URL: "https://www.federalreserve.gov/feeds/press_all.xml",
} as const;


