import { NewsItem, Impact } from '../types';
import { getDb } from '../lib/firestore';
import { generateArticleHash } from '../storage';
import { scoreNews } from '../utils/scoring';
import { composeHeadline, composeSummary } from '../utils/factComposer';
import { sanitizeText } from '../utils/sanitize';
import { computeVerification } from '../utils/verification';
import { getConfig } from '../config/env';

// Environment getter functions
const getBreakingLogLevel = () => process.env.BREAKING_LOG_LEVEL || 'info';

// Logging utilities
const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = logLevels[getBreakingLogLevel() as keyof typeof logLevels] ?? 1;

const log = (level: keyof typeof logLevels, message: string, ...args: any[]) => {
  if (logLevels[level] >= currentLogLevel) {
    console.log(`[breaking][${level}] ${message}`, ...args);
  }
};

// Per-source aggregation counters (60-second window)
interface SourceStats {
  fetched: number;
  new: number;
  duplicate: number;
  errors: number;
  lastReset: number;
}

const sourceStats = new Map<string, SourceStats>();

const getOrCreateStats = (source: string): SourceStats => {
  const now = Date.now();
  const stats = sourceStats.get(source);
  
  if (!stats || (now - stats.lastReset) > 60000) {
    const newStats: SourceStats = { fetched: 0, new: 0, duplicate: 0, errors: 0, lastReset: now };
    sourceStats.set(source, newStats);
    return newStats;
  }
  
  return stats;
};

const incrementStats = (source: string, type: keyof Omit<SourceStats, 'lastReset'>) => {
  const stats = getOrCreateStats(source);
  stats[type]++;
};

// Store interval reference for cleanup
let statsInterval: NodeJS.Timeout | null = null;

// Emit summary every minute
const startStatsInterval = (): void => {
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  
  statsInterval = setInterval(() => {
    for (const [source, stats] of sourceStats.entries()) {
      if (stats.fetched > 0) {
        log('info', `${source}: fetched=${stats.fetched} new=${stats.new} duplicate=${stats.duplicate} errors=${stats.errors} interval=60s`);
        // Reset for next window
        stats.fetched = 0;
        stats.new = 0;
        stats.duplicate = 0;
        stats.errors = 0;
        stats.lastReset = Date.now();
      }
    }
  }, 60000);
};

// Cleanup function for intervals
export const cleanupBreakingIngest = (): void => {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
    log('info', 'Cleaned up breaking ingest intervals');
  }
};

// Start the stats interval
startStatsInterval();

export interface BreakingStub {
  id: string;
  title: string;
  source: string;
  arrival_at: string;
  url: string;
  category: string;
  impact: string;
  confidence_state?: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  verification?: string;
  why: string;
  tickers: string[];
  published_at?: string;
  thread_id?: string;
  primary_entity?: string;
  version?: string;
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
      confidence_state: undefined,
      verification: 'reported', // Default verification status
      why: '',
      tickers: [],
      published_at: item.published_at || arrivalAt,
      thread_id: generateArticleHash(item.title, undefined), // Simple thread ID
      primary_entity: '',
      version: 'v2' // Mark as new version
    };
    
    // Check for existing document to avoid duplicates
    const docRef = newsCollection.doc(id);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
      log('debug', `Duplicate stub already exists: ${id}`);
      incrementStats(item.source, 'duplicate');
      return { id, success: false, error: 'duplicate' };
    }
    
    // Write stub immediately
    await docRef.set(stub);
    
    const publishTime = Date.now() - startTime;
    
    log('info', `Stub published: ${id} in ${publishTime}ms`, {
      title: item.title.substring(0, 60),
      source: item.source,
      publish_time_ms: publishTime
    });
    
    incrementStats(item.source, 'new');
    
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
    incrementStats(item.source, 'errors');
    console.error(`[breaking][error] Failed to publish stub:`, error);
    return { 
      id: '', 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

// Enrich stub with full scoring and metadata
export const enrichItem = async (id: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const db = getDb();
    const newsCollection = db.collection('news');
    const docRef = newsCollection.doc(id);
    
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return { success: false, error: 'document not found' };
    }
    
    const stub = docSnap.data() as BreakingStub;
    
    // Extract primary entity from headline
    const primaryEntity = extractPrimaryEntity(stub.title);
    
    // Generate headline and description
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
    
    // Compute verification if enabled
    let verificationV1 = undefined;
    let verificationLegacy = 'reported';
    if (getConfig().verificationMode === 'v1') {
      const verificationResult = computeVerification({
        sources: [{ domain: stub.source, isPrimary: true }],
        headline: headline,
        body: description,
        published_at: stub.published_at || stub.arrival_at
      });
      verificationLegacy = verificationResult.status;
      verificationV1 = {
        state: verificationResult.status,
        evidence: {
          sources: [stub.source],
          confirmations: verificationResult.k,
          max_tier: verificationResult.max_tier,
          reason: verificationResult.reason
        }
      };
    }
    
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
    
    // Build new structure for Impact V3
    const impactV3 = {
      score: score.impact_score,
      category: score.impact,
      drivers: score._impact_debug?.drivers || []
    };
    
    // Update with enriched data (preserve arrival_at)
    const enrichedData = {
      headline: headline,
      why: description,
      tickers: primaryEntity ? [primaryEntity] : [],
      
      // Breaking Mode: mark as breaking for fresh stubs
      breaking: true,
      
      // Impact V3 structure
      impact: impactV3,
      
      // Verification V1 structure
      verification: verificationV1,
      
      // Legacy fields (for backward compatibility)
      impact_score: score.impact_score,
      confidence_state: score.confidence_state,
      verification_legacy: verificationLegacy,
      
      primary_entity: primaryEntity || '',
      category: score.tags?.includes('Macro') ? 'macro' : '',
      thread_id: threadId,
      // Preserve arrival_at exactly as it was
      arrival_at: stub.arrival_at
    };
    
    await docRef.update(enrichedData);
    
    log('info', `Enriched: ${id}`, {
      impact: score.impact,
      confidence_state: score.confidence_state,
      primary_entity: primaryEntity
    });
    
    return { success: true };
    
  } catch (error) {
    console.error(`[breaking][error] Failed to enrich ${id}:`, error);
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
    console.error('[breaking][error] Failed to log latency metrics:', error);
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
    console.error(`[breaking][error] Failed to get latency stats for ${source}:`, error);
    return { p50: 0, p90: 0, count: 0, avg_publish_ms: 0 };
  }
};

// Get current source statistics
export const getCurrentSourceStats = () => {
  const stats: Record<string, { fetched: number; new: number; duplicate: number; errors: number }> = {};
  for (const [source, sourceStat] of sourceStats.entries()) {
    stats[source] = {
      fetched: sourceStat.fetched,
      new: sourceStat.new,
      duplicate: sourceStat.duplicate,
      errors: sourceStat.errors
    };
  }
  return stats;
};

// Reset source statistics (for admin use)
export const resetSourceStats = () => {
  sourceStats.clear();
};
