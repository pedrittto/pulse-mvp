import { parseString } from 'xml2js';
import { promisify } from 'util';
import { NewsItem, Impact } from '../types';
import { rssFeeds } from '../config/rssFeeds';
import { addNewsItems, generateArticleHash } from '../storage';
// import { sanitizeText } from '../utils/sanitize';
import { scoreNews } from '../utils/scoring';
import { composeHeadline, composeSummary } from '../utils/factComposer';
import { isTradingRelevant } from '../utils/tradingFilter';
import { getDb } from '../lib/firestore';
import { cryptoFeeds } from '../config/cryptoFeeds';
import { expansionFeeds } from '../config/expansionFeeds';

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
  
  // Relaxed: Do not reject purely on length to increase throughput
  
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
const normalizeRSSItem = async (item: RSSItem, sourceName: string): Promise<NewsItem> => {
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
  const newsItem = {
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
    confidence_state: score.confidence_state,
    primary_entity: primaryEntity || '',
    category: score.tags?.includes('Macro') ? 'macro' : undefined
  } as any;

  // Optional trading-only filter (shadow writes on non-relevant)
  if (process.env.TRADING_ONLY_FILTER === '1') {
    try {
      const domain = sourceName.includes('.') ? sourceName.split('.').slice(-2).join('.') : sourceName;
      const gate = isTradingRelevant(headline, description, domain);
      if (!gate.relevant) {
        const db = getDb();
        const doc = db.collection('feeds_shadow').doc('trading_filter').collection('dropped').doc(newsItem.id);
        await doc.set({ ...newsItem, dropped_at: new Date().toISOString(), reason: gate.reason }, { merge: true });
        // Signal to caller to skip persist
        (newsItem as any)._dropped = true;
      } else {
        (newsItem as any)._filter_reason = gate.reason;
      }
    } catch (e) {
      console.error('[filter][trading_only] shadow write failed:', e);
    }
  }

  return newsItem;
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
      console.log(`[filter] Accepted: ${title.substring(0, 80)}...`);
      return true;
    });

    const items = [] as any[];
    for (const raw of filteredItems) {
      const normalized = await normalizeRSSItem(raw, feed.name);
      if (process.env.TRADING_ONLY_FILTER === '1' && (normalized as any)._dropped) {
        continue; // Skip non-relevant in prod path; shadow already captured
      }
      items.push(normalized);
    }
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

  // Feature flag to include crypto_v1 sources in DRY-RUN (shadow) mode
  const sourceSet = process.env.SOURCE_SET;
  const auditMode = process.env.AUDIT_MODE === '1';

  // Fetch all feeds in parallel (base set)
  const feedPromises: Promise<any[]>[] = rssFeeds.map(fetchRSSFeed);

  // Optionally include crypto feeds (read-only ingest)
  if (sourceSet === 'crypto_v1') {
    console.log('[ingest][crypto_v1] Enabled. Fetching crypto feeds...');
    for (const feed of cryptoFeeds) {
      feedPromises.push(fetchRSSFeed({ name: feed.name, url: feed.url } as any));
    }
  }

  // Optionally include expansion feeds under INGEST_EXPANSION
  if (process.env.INGEST_EXPANSION === '1') {
    console.log('[ingest][expansion] Enabled. Fetching expansion feeds...');
    for (const feed of expansionFeeds) {
      feedPromises.push(fetchRSSFeed({ name: feed.name, url: feed.url } as any));
    }
  }
  const results = await Promise.allSettled(feedPromises);

  // Process results with concurrency limit for database operations (tune under expansion)
  const concurrencyLimit = process.env.INGEST_EXPANSION === '1' ? 8 : 5;
  const chunks: PromiseSettledResult<NewsItem[]>[][] = [];
  for (let i = 0; i < results.length; i += concurrencyLimit) {
    chunks.push(results.slice(i, i + concurrencyLimit));
  }

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (result, index) => {
      const actualIndex = chunks.indexOf(chunk) * concurrencyLimit + index;
      const baseLen = rssFeeds.length;
      const isCrypto = sourceSet === 'crypto_v1' && actualIndex >= baseLen;
      const feedName = isCrypto ? cryptoFeeds[actualIndex - baseLen]?.name || 'crypto' : rssFeeds[actualIndex].name;

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
        
        let addedCount = 0;
        let skippedCount = 0;
        if ((sourceSet === 'crypto_v1' || process.env.INGEST_EXPANSION === '1') && auditMode) {
          // Dry-run: write to shadow collection
          try {
            const db = getDb();
            const batch = db.batch();
            const shadowKey = (sourceSet === 'crypto_v1') ? 'crypto_v1' : 'expansion';
            const shadow = db.collection('feeds_shadow').doc(shadowKey);
            const sub = shadow.collection('items');
            items.forEach(item => {
              const ref = sub.doc(item.id);
              batch.set(ref, { ...item, shadow_at: new Date().toISOString(), source_set: shadowKey }, { merge: true });
            });
            await batch.commit();
            addedCount = items.length;
            skippedCount = 0;
            totalAdded += addedCount;
            console.log(`[shadow][${(sourceSet==='crypto_v1')?'crypto_v1':'expansion'}] wrote ${items.length} items to feeds_shadow/${(sourceSet==='crypto_v1')?'crypto_v1':'expansion'}`);
          } catch (e) {
            console.error('[shadow] failed to write shadow items:', e);
            totalErrors++;
          }
        } else {
          const { added, skipped } = await addNewsItems(items);
          addedCount = added;
          skippedCount = skipped;
          totalAdded += addedCount;
          totalSkipped += skippedCount;
        }
        totalFetched += items.length;
        
        console.log(`${feedName}: ${items.length} fetched, ${addedCount} added, ${skippedCount} skipped`);
        return { success: true, feedName, items: items.length, added: addedCount, skipped: skippedCount };
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
