import { NewsItem, Impact } from '../types';
import { getDb } from '../lib/firestore';
import { generateArticleHash } from '../storage';
import { scoreNews } from '../utils/scoring';
import { composeHeadline, composeSummary } from '../utils/factComposer';
import { sanitizeText } from '../utils/sanitize';

export interface BreakingStub {
  id: string;
  title: string;
  source: string;
  arrival_at: string;
  url: string;
  category: string;
  impact: string;
  confidence: number | null;
  why: string;
  tickers: string[];
  published_at?: string;
  thread_id?: string;
  primary_entity?: string;
}

export interface LatencyMetrics {
  source_published_at: string;
  ingested_at: string;
  arrival_at: string;
  t_ingest_ms: number;
  t_publish_ms: number;
}

// Publish a minimal stub immediately for fast-path
export const publishStub = async (item: {
  title: string;
  source: string;
  url: string;
  published_at?: string;
  description?: string;
}): Promise<{ id: string; success: boolean; error?: string }> => {
  const startTime = Date.now();
  
  try {
    const db = getDb();
    const newsCollection = db.collection('news');
    
    // Generate ID from title hash for deduplication
    const id = generateArticleHash(item.title);
    const arrivalAt = new Date().toISOString();
    
    // Create minimal stub
    const stub: BreakingStub = {
      id,
      title: sanitizeText(item.title),
      source: item.source,
      arrival_at: arrivalAt,
      url: item.url,
      category: '',
      impact: '',
      confidence: null,
      why: '',
      tickers: [],
      published_at: item.published_at || arrivalAt,
      thread_id: generateArticleHash(item.title, undefined), // Simple thread ID
      primary_entity: ''
    };
    
    // Check for existing document to avoid duplicates
    const docRef = newsCollection.doc(id);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
      console.log(`[breaking][skip] Duplicate stub already exists: ${id}`);
      return { id, success: false, error: 'duplicate' };
    }
    
    // Write stub immediately
    await docRef.set(stub);
    
    const publishTime = Date.now() - startTime;
    
    console.log(`[breaking][publish] Stub published: ${id} in ${publishTime}ms`, {
      title: item.title.substring(0, 60),
      source: item.source,
      publish_time_ms: publishTime
    });
    
    // Log latency metrics
    await logLatencyMetrics({
      source_published_at: item.published_at || arrivalAt,
      ingested_at: arrivalAt,
      arrival_at: arrivalAt,
      t_ingest_ms: publishTime,
      t_publish_ms: publishTime
    }, item.source);
    
    return { id, success: true };
    
  } catch (error) {
    console.error(`[breaking][error] Failed to publish stub:`, error);
    return { 
      id: generateArticleHash(item.title), 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

// Enrich a stub with full scoring and analysis
export const enrichItem = async (id: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const db = getDb();
    const newsCollection = db.collection('news');
    
    // Get the stub
    const docRef = newsCollection.doc(id);
    const docSnap = await docRef.get();
    
    if (!docSnap.exists) {
      console.log(`[breaking][enrich] Stub not found: ${id}`);
      return { success: false, error: 'stub_not_found' };
    }
    
    const stub = docSnap.data() as BreakingStub;
    
    // Extract primary entity from title
    const primaryEntity = extractPrimaryEntity(stub.title);
    
    // Compose factual content
    const headline = composeHeadline({
      title: stub.title,
      description: stub.why || '',
      source: stub.source,
      tickers: primaryEntity ? [primaryEntity] : []
    });
    
    const description = composeSummary({
      title: stub.title,
      description: stub.why || '',
      source: stub.source,
      tickers: primaryEntity ? [primaryEntity] : []
    });
    
    // Compute scoring
    const score = scoreNews({
      headline: headline,
      description: description,
      sources: [stub.source],
      tickers: primaryEntity ? [primaryEntity] : [],
      published_at: stub.published_at || stub.arrival_at
    });
    
    // Generate thread ID
    const threadId = generateThreadId(primaryEntity, stub.published_at || stub.arrival_at);
    
    // Update with enriched data (preserve arrival_at)
    const enrichedData = {
      headline: headline,
      why: description,
      tickers: primaryEntity ? [primaryEntity] : [],
      impact: score.impact as Impact,
      impact_score: score.impact_score,
      confidence: score.confidence,
      primary_entity: primaryEntity || '',
      category: score.tags?.includes('Macro') ? 'macro' : '',
      thread_id: threadId,
      // Preserve arrival_at exactly as it was
      arrival_at: stub.arrival_at
    };
    
    await docRef.update(enrichedData);
    
    console.log(`[breaking][enrich] Enriched: ${id}`, {
      impact: score.impact,
      confidence: score.confidence,
      primary_entity: primaryEntity
    });
    
    return { success: true };
    
  } catch (error) {
    console.error(`[breaking][enrich] Failed to enrich ${id}:`, error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

// Extract primary entity from headline
const extractPrimaryEntity = (headline: string): string | undefined => {
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
    const match = headline.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }

  return undefined;
};

// Generate thread ID from primary entity and date
const generateThreadId = (primaryEntity: string | undefined, pubDate: string): string => {
  const date = new Date(pubDate);
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const entity = primaryEntity || 'general';
  return require('crypto').createHash('sha1').update(`${entity}|${dateStr}`).digest('hex').substring(0, 8);
};

// Log latency metrics for monitoring
const logLatencyMetrics = async (metrics: LatencyMetrics, source: string): Promise<void> => {
  try {
    const db = getDb();
    const metricsCollection = db.collection('latency_metrics');
    
    const metricDoc = {
      ...metrics,
      source,
      timestamp: new Date().toISOString()
    };
    
    await metricsCollection.add(metricDoc);
  } catch (error) {
    console.error('[breaking][metrics] Failed to log latency metrics:', error);
  }
};

// Get latency statistics for a source
export const getSourceLatencyStats = async (source: string, hours: number = 24): Promise<{
  p50: number;
  p90: number;
  count: number;
  avg_publish_ms: number;
}> => {
  try {
    const db = getDb();
    const metricsCollection = db.collection('latency_metrics');
    
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const snapshot = await metricsCollection
      .where('source', '==', source)
      .where('timestamp', '>=', cutoffTime.toISOString())
      .orderBy('timestamp', 'desc')
      .get();
    
    const publishTimes: number[] = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.t_publish_ms) {
        publishTimes.push(data.t_publish_ms);
      }
    });
    
    if (publishTimes.length === 0) {
      return { p50: 0, p90: 0, count: 0, avg_publish_ms: 0 };
    }
    
    // Sort for percentile calculation
    publishTimes.sort((a, b) => a - b);
    
    const p50 = publishTimes[Math.floor(publishTimes.length * 0.5)];
    const p90 = publishTimes[Math.floor(publishTimes.length * 0.9)];
    const avg = publishTimes.reduce((sum, time) => sum + time, 0) / publishTimes.length;
    
    return {
      p50,
      p90,
      count: publishTimes.length,
      avg_publish_ms: Math.round(avg)
    };
    
  } catch (error) {
    console.error(`[breaking][stats] Failed to get latency stats for ${source}:`, error);
    return { p50: 0, p90: 0, count: 0, avg_publish_ms: 0 };
  }
};
