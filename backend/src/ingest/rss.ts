import axios from 'axios';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { NewsItem, Impact } from '../types';
import { rssFeeds } from '../config/rssFeeds';
import { addNewsItems, generateArticleHash } from '../storage';

const parseXML = promisify(parseString);

interface RSSItem {
  title?: string[];
  description?: string[];
  link?: string[];
  pubDate?: string[];
  category?: string[];
  'dc:creator'?: string[];
  'content:encoded'?: string[];
}

interface RSSChannel {
  title?: string[];
  description?: string[];
  link?: string[];
  item?: RSSItem[];
}

interface RSSFeed {
  rss?: {
    channel?: RSSChannel[];
  };
}

// Extract primary entity from headline and content
const extractPrimaryEntity = (headline: string, description?: string): string | undefined => {
  // Simple entity extraction - look for common company patterns
  const text = `${headline} ${description || ''}`;
  
  // Common company patterns
  const patterns = [
    /\b(AAPL|Apple)\b/i,
    /\b(GOOGL|Google)\b/i,
    /\b(MSFT|Microsoft)\b/i,
    /\b(TSLA|Tesla)\b/i,
    /\b(AMZN|Amazon)\b/i,
    /\b(META|Facebook)\b/i,
    /\b(NFLX|Netflix)\b/i,
    /\b(NVDA|NVIDIA)\b/i,
    /\b(AMD)\b/i,
    /\b(INTC|Intel)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }

  return undefined;
};

// Generate thread_id from primary entity and date
const generateThreadId = (primaryEntity: string | undefined, pubDate: string): string => {
  const date = new Date(pubDate);
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const entity = primaryEntity || 'general';
  return require('crypto').createHash('sha1').update(`${entity}|${dateStr}`).digest('hex').substring(0, 8);
};

// Normalize RSS item to NewsItem
const normalizeRSSItem = (item: RSSItem, sourceName: string): NewsItem => {
  const headline = item.title?.[0] || '';
  const description = item.description?.[0] || '';
  const link = item.link?.[0] || '';
  const pubDate = item.pubDate?.[0] || new Date().toISOString();
  const primaryEntity = extractPrimaryEntity(headline, description);
  const threadId = generateThreadId(primaryEntity, pubDate);
  const ingestedAt = new Date().toISOString();

  // Ensure all fields have safe values (no undefined)
  return {
    id: generateArticleHash(headline, primaryEntity),
    thread_id: threadId,
    headline: headline || 'Untitled',
    why: description || '',
    sources: [sourceName],
    tickers: primaryEntity ? [primaryEntity] : [],
    published_at: pubDate,
    ingested_at: ingestedAt,
    impact: 'L' as Impact,
    confidence: 50,
    primary_entity: primaryEntity || undefined
  };
};

// Fetch and parse RSS feed
const fetchRSSFeed = async (feed: typeof rssFeeds[0]): Promise<NewsItem[]> => {
  try {
    console.log(`Fetching RSS feed: ${feed.name}`);
    const response = await axios.get(feed.url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Pulse-MVP-RSS-Ingestor/1.0'
      }
    });

    const parsed = await parseXML(response.data) as RSSFeed;
    const channel = parsed.rss?.channel?.[0];
    
    if (!channel?.item) {
      console.log(`No items found in ${feed.name}`);
      return [];
    }

    const items = channel.item.map(item => normalizeRSSItem(item, feed.name));
    console.log(`Parsed ${items.length} items from ${feed.name}`);
    
    return items;
  } catch (error) {
    console.error(`Error fetching ${feed.name}:`, error instanceof Error ? error.message : 'Unknown error');
    return [];
  }
};

// Main RSS ingestion function
export const ingestRSSFeeds = async (): Promise<{ fetched: number; added: number; skipped: number; errors: number }> => {
  console.log('Starting RSS ingestion...');
  const startTime = Date.now();
  
  let totalFetched = 0;
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Fetch all feeds in parallel
  const feedPromises = rssFeeds.map(fetchRSSFeed);
  const results = await Promise.allSettled(feedPromises);

  // Process results
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const feedName = rssFeeds[i].name;

    if (result.status === 'fulfilled') {
      const items = result.value;
      totalFetched += items.length;
      
      const { added, skipped } = await addNewsItems(items);
      totalAdded += added;
      totalSkipped += skipped;
      
      console.log(`${feedName}: ${items.length} fetched, ${added} added, ${skipped} skipped`);
    } else {
      console.error(`${feedName}: Failed to fetch - ${result.reason}`);
      totalErrors++;
    }
  }

  const duration = Date.now() - startTime;
  console.log(`RSS ingestion completed in ${duration}ms: ${totalFetched} fetched, ${totalAdded} added, ${totalSkipped} skipped, ${totalErrors} errors`);
  
  return { fetched: totalFetched, added: totalAdded, skipped: totalSkipped, errors: totalErrors };
};
