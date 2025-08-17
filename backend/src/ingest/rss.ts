import { parseString } from 'xml2js';
import { promisify } from 'util';
import { NewsItem, Impact } from '../types';
import { rssFeeds } from '../config/rssFeeds';
import { addNewsItems, generateArticleHash } from '../storage';
// import { sanitizeText } from '../utils/sanitize';
import { scoreNews } from '../utils/scoring';
import { composeHeadline, composeSummary } from '../utils/factComposer';
import { getDb } from '../lib/firestore';

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

// Filtering rules for actionable market news
const shouldRejectArticle = (title: string, description: string, _category?: string): boolean => {
  const combinedText = `${title} ${description}`.toLowerCase();
  
  // Reject patterns - more comprehensive
  const rejectPatterns = [
    /\b(top|things to watch|best|worst|how to|opinion|guide|tips|review|ranking|list)\b/i,
    /\b(cramer|podcast|interview|show|announcement|takeaways)\b/i,
    /\b(lifestyle|culture|travel|education|college|university)\b/i,
    /\b(sports|movie|celebrity|award|entertainment|retirement|smart moves)\b/i,
    /\b(here are|these are|what to|when you|options when)\b/i
  ];
  
  for (const pattern of rejectPatterns) {
    if (pattern.test(combinedText)) {
      return true;
    }
  }
  
  // Reject if headline is too long without financial content
  const hasFinancialContent = /\b(\d+%|\$\d+|[A-Z]{2,4}\b|fed|ecb|boe|treasury|sec)\b/i.test(combinedText);
  const wordCount = title.split(/\s+/).length;
  if (wordCount > 15 && !hasFinancialContent) {
    return true;
  }
  
  // Reject if title starts with common non-actionable patterns
  const titleLower = title.toLowerCase();
  if (titleLower.startsWith('here are') || 
      titleLower.startsWith('these are') || 
      titleLower.startsWith('what to') ||
      titleLower.includes('smart moves') ||
      titleLower.includes('takeaways')) {
    return true;
  }
  
  return false;
};

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
  const rawHeadline = item.title?.[0] || '';
  const rawDescription = item.description?.[0] || '';
  // const _link = item.link?.[0] || '';
  const pubDate = item.pubDate?.[0] || new Date().toISOString();
  
  // Extract primary entity first
  const primaryEntity = extractPrimaryEntity(rawHeadline, rawDescription);
  
  // Compose factual trader-focused content
  const headline = composeHeadline({
    title: rawHeadline,
    description: rawDescription,
    source: sourceName,
    tickers: primaryEntity ? [primaryEntity] : []
  });
  
  const description = composeSummary({
    title: rawHeadline,
    description: rawDescription,
    source: sourceName,
    tickers: primaryEntity ? [primaryEntity] : []
  });
  
  const threadId = generateThreadId(primaryEntity, pubDate);
  const ingestedAt = new Date().toISOString();

  // Compute scoring
  const score = scoreNews({
    headline,
    description,
    sources: [sourceName],
    tickers: primaryEntity ? [primaryEntity] : [],
    published_at: pubDate
  });

  // Ensure all fields have safe values (no undefined)
  return {
    id: generateArticleHash(headline, primaryEntity),
    thread_id: threadId,
    headline: headline,
    why: description,
    sources: [sourceName],
    tickers: primaryEntity ? [primaryEntity] : [],
    published_at: pubDate,
    ingested_at: ingestedAt,
    impact: {
      score: score.impact_score,
      category: score.impact,
      drivers: []
    },
    impact_score: score.impact_score,
    confidence: score.confidence,
    primary_entity: primaryEntity || '',
    category: score.tags?.includes('Macro') ? 'macro' : undefined
  };
};

// Fetch and parse RSS feed
const fetchRSSFeed = async (feed: typeof rssFeeds[0]): Promise<NewsItem[]> => {
  try {
    console.log(`Fetching RSS feed: ${feed.name}`);
    
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Pulse-MVP-RSS-Ingestor/1.0'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const responseText = await response.text();
    const parsed = await parseXML(responseText) as RSSFeed;
    const channel = parsed.rss?.channel?.[0];
    
    if (!channel?.item) {
      console.log(`No items found in ${feed.name}`);
      return [];
    }

    // Filter items before processing
    const filteredItems = channel.item.filter(item => {
      const title = item.title?.[0] || '';
      const description = item.description?.[0] || '';
      const category = item.category?.[0];
      
      if (shouldRejectArticle(title, description, category)) {
        console.log(`[filter] Rejected: ${title.substring(0, 60)}...`);
        return false;
      }
      return true;
    });

    const items = filteredItems.map(item => normalizeRSSItem(item, feed.name));
    console.log(`Parsed ${items.length} items from ${feed.name} (filtered from ${channel.item.length})`);
    
    return items;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error(`Error fetching ${feed.name}: Request timeout`);
      } else {
        console.error(`Error fetching ${feed.name}:`, error.message);
      }
    } else {
      console.error(`Error fetching ${feed.name}: Unknown error`);
    }
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
  let cleanedHeadlines = 0;
  let cleanedDescriptions = 0;
  let scoredItems = 0;
  let highImpactItems = 0;
  let macroItems = 0;

  // Fetch all feeds in parallel
  const feedPromises = rssFeeds.map(fetchRSSFeed);
  const results = await Promise.allSettled(feedPromises);

  // Process results with concurrency limit for database operations
  const concurrencyLimit = 5; // Process up to 5 feeds concurrently
  const chunks: PromiseSettledResult<NewsItem[]>[][] = [];
  for (let i = 0; i < results.length; i += concurrencyLimit) {
    chunks.push(results.slice(i, i + concurrencyLimit));
  }

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (result, index) => {
      const actualIndex = chunks.indexOf(chunk) * concurrencyLimit + index;
      const feedName = rssFeeds[actualIndex].name;

      if (result.status === 'fulfilled') {
        const items = result.value;
        
        // Count sanitized fields and scoring
        items.forEach(item => {
          if (item.headline && item.headline !== 'Untitled') cleanedHeadlines++;
          if (item.why) cleanedDescriptions++;
          scoredItems++;
          if (item.impact?.category === 'H') highImpactItems++;
          if (item.category === 'macro') macroItems++;
        });
        
        const { added, skipped } = await addNewsItems(items);
        totalAdded += added;
        totalSkipped += skipped;
        totalFetched += items.length;
        
        console.log(`${feedName}: ${items.length} fetched, ${added} added, ${skipped} skipped`);
        return { success: true, feedName, items: items.length, added, skipped };
      } else {
        console.error(`${feedName}: Failed to fetch - ${result.reason}`);
        totalErrors++;
        return { success: false, feedName, error: result.reason };
      }
    });

    // Process chunk concurrently
    await Promise.all(chunkPromises);
  }

  const duration = Date.now() - startTime;
  console.log(`RSS ingestion completed in ${duration}ms: ${totalFetched} fetched, ${totalAdded} added, ${totalSkipped} skipped, ${totalErrors} errors`);
  console.log('[sanitize]', { cleaned_headlines: cleanedHeadlines, cleaned_descriptions: cleanedDescriptions });
  console.log('[score]', { added: totalAdded, with_high: highImpactItems, with_macro: macroItems });
  
  // Write metrics to Firestore
  try {
    const db = getDb();
    const metricsData = {
      last_run: new Date().toISOString(),
      counts: { fetched: totalFetched, added: totalAdded, skipped: totalSkipped, errors: totalErrors }
    };
    
    await db.collection('system').doc('ingest_status').set(metricsData, { merge: true });
    console.log('[metrics] Updated ingest_status');
  } catch (error) {
    console.error('[metrics] Failed to update ingest_status:', error);
  }
  
  return { fetched: totalFetched, added: totalAdded, skipped: totalSkipped, errors: totalErrors };
};
