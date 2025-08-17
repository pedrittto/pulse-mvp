export type CryptoFeed = {
  name: string;
  url: string;
  category?: string;
};

// RSS feeds for crypto/trading news (best-effort; some sites may rate-limit)
export const cryptoFeeds: CryptoFeed[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', url: 'https://www.theblock.co/rss' },
  { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/' },
  { name: 'CoinGape', url: 'https://coingape.com/feed/' },
  { name: 'Blockworks', url: 'https://blockworks.co/feed' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss' },
  { name: 'U.Today', url: 'https://u.today/rss' },
  { name: 'Bankless', url: 'https://www.bankless.com/feed' },
  { name: 'Investing.com Crypto', url: 'https://www.investing.com/rss/crypto_news.rss' }
];


