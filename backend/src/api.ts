import express from 'express';
import rateLimit from 'express-rate-limit';
// import { Watchlist } from './types';
import { getNewsItems } from './storage';
import { getDb } from './lib/firestore';
import { ingestRSSFeeds } from './ingest/rss';
import { metrics } from './routes/metrics';
import { adminRoutes } from './routes/admin';
import { scoreNews } from './utils/scoring';
import { getConfig } from './config/env';
import { sseHub } from './realtime/sse';

// Environment getter functions
const getNodeEnv = () => process.env.NODE_ENV;
const getFirebaseProjectId = () => process.env.FIREBASE_PROJECT_ID;
const getFirebaseClientEmail = () => process.env.FIREBASE_CLIENT_EMAIL;
const getFirebasePrivateKey = () => process.env.FIREBASE_PRIVATE_KEY;
const getImpactMode = () => process.env.IMPACT_MODE;
const getVerificationMode = () => process.env.VERIFICATION_MODE;
const getImpactV3Compare = () => process.env.IMPACT_V3_COMPARE;

// Type for watchlist data structure
type WatchlistData = { 
  tickers: string[]; 
  keywords: string[]; 
  thresholds?: Record<string, number>;
  updated_at?: string;
};

// Helper function to get Firestore database instance
export const getDbInstance = () => getDb();

const router = express.Router();
// SSE endpoint: emits minimal payload on new item writes (behind flag)
router.get('/sse/new-items', (req, res) => {
  if (process.env.SSE_ENABLED !== '1') {
    return res.status(404).json({ ok: false, error: 'SSE disabled' });
  }
  // Disable compression for this route if a compression middleware is present
  (res as any).set && res.set('Content-Encoding', 'identity');
  sseHub.addClient(req, res);
});

// GET /feed/since?after=<ISO>&limit=50 - items with ingested_at > after (desc)
router.get('/feed/since', async (req, res) => {
  if (process.env.SSE_ENABLED !== '1') {
    // Still allow when SSE disabled to support SWR fallback
  }
  try {
    const after = String(req.query.after || '');
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    if (!after || isNaN(Date.parse(after))) {
      return res.status(400).json({ ok: false, error: 'Invalid after param' });
    }
    const db = getDb();
    const snap = await db.collection('news')
      .orderBy('ingested_at', 'desc')
      .limit(500)
      .get();
    const items: any[] = [];
    snap.forEach((doc: any) => {
      const data = doc.data();
      if (data && data.ingested_at && Date.parse(data.ingested_at) > Date.parse(after)) {
        items.push({ id: doc.id, ...data });
      }
    });
    items.sort((a, b) => (Date.parse(b.ingested_at) - Date.parse(a.ingested_at)));
    const limited = items.slice(0, limit);
    return res.json({ items: limited, total: limited.length });
  } catch (e) {
    console.error('[api][feed/since] error', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// Rate limiter for watchlist endpoint
const watchlistLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute for watchlist updates
  message: {
    error: {
      message: 'Too many watchlist updates, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED'
    }
  }
});

// Debug endpoint for Firestore access verification
router.get('/debug/firestore', async (_req, res) => {
  // Environment guard - only allow in non-production
  if (getNodeEnv() === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const testData = {
      ts: new Date().toISOString()
    };

    // Write test document
    const debugCollection = getDb().collection('debug');
    const docRef = debugCollection.doc('conn');
    await docRef.set(testData, { merge: true });

    // Read the document back
    const docSnap = await docRef.get();
    const readBack = docSnap.data();

    res.json({
      ok: true,
      wroteAt: testData.ts,
      readBack
    });
    return;
  } catch (error) {
    console.error('Firestore debug endpoint error:', error);
    console.error('Full stack trace:', error instanceof Error ? error.stack : 'No stack trace available');
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return;
  }
});

// Debug endpoint for Firebase credentials verification
router.get('/debug/creds', async (_req, res) => {
  // Environment guard - only allow in non-production
  if (getNodeEnv() === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const projectId = getFirebaseProjectId();
    const clientEmail = getFirebaseClientEmail();
    const usesADC = !getFirebasePrivateKey(); // If no private key, likely using ADC

    // Test if we can list collections (harmless permission probe)
    let canList = false;
    let listErrorCode = null;
    
    try {
      await getDb().listCollections();
      canList = true;
    } catch (error: any) {
      canList = false;
      listErrorCode = error.code || 'UNKNOWN';
      console.error('Permission probe failed:', error.message);
    }

    res.json({
      ok: true,
      projectId,
      clientEmail,
      usesADC,
      canList,
      listErrorCode
    });
    return;
  } catch (error) {
    console.error('Creds debug endpoint error:', error);
    console.error('Full stack trace:', error instanceof Error ? error.stack : 'No stack trace available');
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return;
  }
});

// Debug endpoint for listing Firestore collections
router.get('/debug/firestore-list', async (_req, res) => {
  // Environment guard - only allow in non-production
  if (getNodeEnv() === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const { col = 'news', limit = 5 } = _req.query;
    const collectionName = col as string;
    const limitNum = Math.min(parseInt(limit as string) || 5, 100); // Cap at 100

    const collection = getDb().collection(collectionName);
    
    // Try to order by ingested_at first, fallback to published_at
    let snapshot;
    try {
      snapshot = await collection
        .orderBy('ingested_at', 'desc')
        .limit(limitNum)
        .get();
    } catch (error) {
      // If ingested_at doesn't exist, try published_at
      snapshot = await collection
        .orderBy('published_at', 'desc')
        .limit(limitNum)
        .get();
    }

    const items: any[] = [];
    snapshot.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      items.push({
        id: doc.id,
        ...data
      });
    });

    res.json({
      ok: true,
      col: collectionName,
      count: items.length,
      items
    });
    return;
  } catch (error) {
    console.error('Firestore list debug endpoint error:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return;
  }
});

// Admin endpoint for manual ingestion
router.post('/admin/ingest-now', async (_req, res) => {
  // Environment guard - only allow in non-production
  if (getNodeEnv() === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Admin endpoint not available in production',
      code: 'ADMIN_DISABLED'
    });
  }

  try {
    console.log('[admin] Manual ingestion requested');
    const startTime = Date.now();
    
    const result = await ingestRSSFeeds();
    
    const duration = Date.now() - startTime;
    console.log(`[admin] Manual ingestion completed in ${duration}ms:`, result);
    
    res.json({
      ok: true,
      ...result,
      duration
    });
    return;
  } catch (error) {
    console.error('[admin] Manual ingestion failed:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return;
  }
});

// Helper function to purge a collection
const purgeCollection = async (collectionName: string, limit: number = 500): Promise<number> => {
  const db = getDb();
  const collection = db.collection(collectionName);
  let totalDeleted = 0;
  
  while (true) {
    const snapshot = await collection.limit(limit).get();
    
    if (snapshot.empty) {
      break;
    }
    
    const batch = db.batch();
    snapshot.docs.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    totalDeleted += snapshot.docs.length;
    
    // If we got fewer docs than the limit, we're done
    if (snapshot.docs.length < limit) {
      break;
    }
  }
  
  return totalDeleted;
};

// Debug endpoint for Impact explanation
router.get('/admin/impact-explain', async (req, res) => {
  // Environment guard - only allow in non-production
  if (getNodeEnv() === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const { id } = req.query;
    
    if (!id || typeof id !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing or invalid id parameter',
        code: 'INVALID_ID'
      });
    }

    // Fetch item from Firestore
    const newsCollection = getDb().collection('news');
    const docSnap = await newsCollection.doc(id).get();
    
    if (!docSnap.exists) {
      return res.status(404).json({
        ok: false,
        error: 'News item not found',
        code: 'ITEM_NOT_FOUND'
      });
    }

    const item = docSnap.data() as any;
    
    // Check if Impact V3 is enabled
    const impactMode = getImpactMode();
    
    if (impactMode === 'v3') {
      // Use Impact V3
      const score = scoreNews({
        headline: item.headline,
        description: item.why,
        sources: item.sources,
        tickers: item.tickers,
        published_at: item.published_at,
        debug: true
      });

      res.json({
        ok: true,
        id: id,
        features: {
          headline: item.headline,
          description: item.why,
          tickers: item.tickers,
          published_at: item.published_at,
          sources: item.sources
        },
        raw: score.impact_score,
        category: score.impact,
        drivers: score._impact_debug?.drivers || [],
        meta: score._impact_debug?.meta || {},
        flags: {
          has_macro_tag: score.tags?.includes('Macro') || false,
          version: 'v3'
        }
      });
    } else {
      // Use legacy V2
      const score = scoreNews({
        headline: item.headline,
        description: item.why,
        sources: item.sources,
        tickers: item.tickers,
        published_at: item.published_at,
        debug: true
      });

      // Calculate detailed breakdown
      const breakdown = calculateImpactBreakdown({
        headline: item.headline,
        description: item.why,
        sources: item.sources,
        tickers: item.tickers,
        published_at: item.published_at
      });

      res.json({
        ok: true,
        id: id,
        features: {
          headline: item.headline,
          description: item.why,
          tickers: item.tickers,
          published_at: item.published_at,
          sources: item.sources
        },
        intermediates: breakdown.intermediates,
        raw: score.impact_score,
        category: score.impact,
        drivers: breakdown.drivers,
        flags: {
          has_macro_tag: score.tags?.includes('Macro') || false,
          has_opinion_keywords: breakdown.flags.has_opinion_keywords
        },
        version: 'v2.0'
      });
    }
    return;
  } catch (error) {
    console.error('Impact explain endpoint error:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return;
  }
});

// Dev-only helper: seed latency_metrics for metrics/demotion/alerts sanity checks
router.post('/admin/seed-latency', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'Forbidden in production' });
    }
    const {
      source = 'CNBC Breaking',
      count = 10,
      pubMs = 60000,
      pulseMs = 1000,
      ageMin = 1,
      futureSec = 0
    } = (req.body || {});

    const db = getDb();
    const coll = db.collection('latency_metrics');
    const now = Date.now();
    for (let i = 0; i < Number(count); i++) {
      const ts = new Date(now).toISOString();
      let sp: string;
      if (Number(futureSec) > 0) sp = new Date(now + Number(futureSec) * 1000).toISOString();
      else sp = new Date(now - Number(ageMin) * 60 * 1000).toISOString();
      const doc: any = {
        source: String(source),
        timestamp: ts,
        source_published_at: sp,
        t_publish_ms: Number(pubMs),
        t_exposure_ms: Number(pulseMs),
        transport: 'adaptive'
      };
      await coll.add(doc);
    }
    return res.json({ ok: true, seeded: Number(count), source });
  } catch (e) {
    console.error('[admin][seed-latency] error', e);
    return res.status(500).json({ ok: false, error: (e as any)?.message || 'error' });
  }
});

// Helper function to calculate detailed Impact breakdown
function calculateImpactBreakdown(item: {
  headline?: string;
  description?: string;
  sources?: string[];
  tickers?: string[];
  published_at?: string;
}) {
  const headline = (item.headline || '').toLowerCase();
  const description = (item.description || '').toLowerCase();
  const text = `${headline} ${description}`;
  const sources = item.sources || [];
  const tickers = item.tickers || [];
  const published_at = item.published_at;

  let base_score = 20;
  let recency_boost = 0;
  let ticker_boost = 0;
  let keyword_boost = 0;
  let source_boost = 0;
  const drivers: Array<{feature: string, contribution: number}> = [];
  const flags = { has_opinion_keywords: false };

  // Recency boost
  if (published_at) {
    const published = new Date(published_at);
    const now = new Date();
    const hoursDiff = (now.getTime() - published.getTime()) / (1000 * 60 * 60);
    
    if (hoursDiff < 1) {
      recency_boost = 15;
      drivers.push({feature: 'recency_under_1h', contribution: 15});
    } else if (hoursDiff < 6) {
      recency_boost = 10;
      drivers.push({feature: 'recency_under_6h', contribution: 10});
    } else if (hoursDiff < 24) {
      recency_boost = 5;
      drivers.push({feature: 'recency_under_24h', contribution: 5});
    }
  }

  // Ticker signal
  if (tickers.length === 1) {
    ticker_boost = 10;
    drivers.push({feature: 'single_ticker', contribution: 10});
  } else if (tickers.length >= 2) {
    ticker_boost = 15;
    drivers.push({feature: 'multiple_tickers', contribution: 15});
  }

  // HIGH_IMPACT keywords
  const HIGH_IMPACT = [
    'acquisition', 'merger', 'lawsuit', 'guidance', 'earnings', 'downgrade', 
    'upgrade', 'layoffs', 'ceo resigns', 'investigation', 'ban', 'tariff', 
    'sanction', 'data breach', 'hack', 'halt', 'bankrupt', 'chapter 11'
  ];
  
  for (const keyword of HIGH_IMPACT) {
    if (text.includes(keyword)) {
      keyword_boost += 15;
      drivers.push({feature: `high_impact_keyword_${keyword}`, contribution: 15});
      break;
    }
  }

  // MEDIUM_IMPACT keywords
  const MEDIUM_IMPACT = [
    'partnership', 'license', 'contract', 'redirect', 'price cut', 
    'price increase', 'expansion', 'plant', 'facility', 'chip', 'ai model'
  ];
  
  for (const keyword of MEDIUM_IMPACT) {
    if (text.includes(keyword)) {
      keyword_boost += 8;
      drivers.push({feature: `medium_impact_keyword_${keyword}`, contribution: 8});
      break;
    }
  }

  // MACRO_KEYWORDS
  const MACRO_KEYWORDS = [
    'fed', 'interest rate', 'cpi', 'ppi', 'jobs report', 'opec', 
    'oil cut', 'war', 'geopolitics', 'tariff', 'sanctions', 
    'treasury', 'ecb'
  ];
  
  for (const keyword of MACRO_KEYWORDS) {
    if (text.includes(keyword)) {
      keyword_boost += 12;
      drivers.push({feature: `macro_keyword_${keyword}`, contribution: 12});
      break;
    }
  }

  // Source weight
  const SOURCE_W: { [key: string]: number } = { 
    'bloomberg': 6, 'reuters': 6, 'wsj': 5, 'ft': 5, 'cnbc': 3, 
    'marketwatch': 3, 'techcrunch': 2 
  };
  
  if (sources.length > 0) {
    const firstSource = sources[0].toLowerCase();
    for (const [source, weight] of Object.entries(SOURCE_W)) {
      if (firstSource.includes(source)) {
        source_boost = weight;
        drivers.push({feature: `source_${source}`, contribution: weight});
        break;
      }
    }
  }

  // Opinion keywords (for flags only)
  const OPINION_KEYWORDS = [
    'opinion', 'op-ed', 'column', 'rumor', 'reportedly', 'sources say'
  ];
  
  for (const keyword of OPINION_KEYWORDS) {
    if (headline.includes(keyword)) {
      flags.has_opinion_keywords = true;
      break;
    }
  }

  const total_score = Math.max(0, Math.min(100, base_score + recency_boost + ticker_boost + keyword_boost + source_boost));

  return {
    intermediates: {
      base_score,
      recency_boost,
      ticker_boost,
      keyword_boost,
      source_boost,
      total_score
    },
    drivers,
    flags
  };
}

// Demo watchlist (commented out as unused)
// const demoWatchlist: Watchlist = {
//   user_id: "demo",
//   tickers: ["AAPL", "GOOGL", "MSFT"],
//   keywords: ["AI", "earnings", "guidance"],
//   min_confidence: 70,
//   min_impact: "M",
//   quiet_hours: {
//     start: "22:00",
//     end: "08:00"
//   }
// };

// GET /feed
router.get('/feed', async (req, res) => {
  // Instrumentation: request id + start time (behind env flag)
  const latencyHeadersEnabled = process.env.API_LATENCY_HEADERS === '1';
  const startNs = process.hrtime.bigint();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (latencyHeadersEnabled) {
    res.set('X-Request-Id', requestId);
  }
  try {
    // Accept query params: filter, q, limit, after, debug
    const { filter, limit, debug } = req.query;
    
    // Validate query params (basic validation for now)
    if (filter && !['my', 'market-moving', 'macro', 'all'].includes(filter as string)) {
      if (latencyHeadersEnabled) {
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        res.set('X-Backend-Duration-Ms', elapsedMs.toFixed(1));
      }
      return res.status(400).json({ 
        error: { message: 'Invalid filter. Must be one of: my, market-moving, macro, all' } 
      });
    }
    
    if (limit && (isNaN(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) {
      if (latencyHeadersEnabled) {
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        res.set('X-Backend-Duration-Ms', elapsedMs.toFixed(1));
      }
      return res.status(400).json({ 
        error: { message: 'Invalid limit. Must be a number between 1 and 100' } 
      });
    }
    
    // Check for debug flags - handle multiple debug parameters
    const debugParams = Array.isArray(debug) ? debug : [debug].filter(Boolean);
    const debugImpact = debugParams.includes('impact');
    const debugTime = debugParams.includes('time');
    const debugVerification = debugParams.includes('verif');
    
    // Get news items from Firestore (newest first)
    const newsLimit = limit ? parseInt(limit as string) : 20;
    let items = await getNewsItems(newsLimit);
    
    // Filter for new version items only (v2) - include items without version field for backward compatibility
    items = items.filter(item => !item.version || item.version === 'v2');
    
    // Always compute new scoring systems (confidence_state, verification V1, impact V3)
    // Debug parameters only control whether to include debug information
    const titleMode = (process.env.TITLE_CASE_MODE ?? 'original').toLowerCase();
    const smartTitle = (title?: string): string => {
      if (!title) return '';
      if (titleMode === 'original') return title;
      const keepToken = (t: string) => /^[A-Z]{2,}$/.test(t) || /^\$/.test(t) || /[A-Z][a-z]+[A-Z]/.test(t) || /^(Fed|SEC|CFTC|OPEC|ECB|BoE|ETF|IPO|PCE|FOMC|FX|BTC|ETH)$/.test(t);
      const trimmed = title.trim();
      // Only adjust if the string appears fully lower-case (rough heuristic)
      const isAllLower = trimmed === trimmed.toLowerCase();
      if (!isAllLower) return title; // respect original styling
      // Capitalize first printable letter; do not downcase the rest
      const idx = trimmed.search(/[A-Za-z]/);
      if (idx === -1) return title;
      const head = trimmed.slice(0, idx);
      const first = trimmed[idx].toUpperCase();
      const rest = trimmed.slice(idx + 1).split(/(\s+)/).map(tok => (keepToken(tok) ? tok : tok)).join('');
      return head + first + rest;
    };

    items = items.map(item => {
      // Re-score with new systems
      const scoredItem = scoreNews({
        headline: item.headline,
        description: item.why,
        sources: item.sources,
        tickers: item.tickers,
        published_at: item.published_at,
        debug: debugImpact || debugVerification
      });
      
      // Confidence state mapping fallback
      const mapNumericToState = (n?: number) => {
        if (typeof n !== 'number' || isNaN(n)) return undefined;
        return n >= 90 ? 'confirmed' : n >= 75 ? 'verified' : n >= 50 ? 'corroborated' : n >= 25 ? 'reported' : 'unconfirmed';
      };

      // Verification to confidence mapping (fallback)
      const mapVerifToState = (v?: string) => {
        if (!v) return undefined;
        const s = String(v).toLowerCase();
        if (s === 'confirmed') return 'confirmed';
        if (s === 'verified') return 'verified';
        if (s === 'reported') return 'reported';
        if (s === 'unconfirmed') return 'unconfirmed';
        return undefined;
      };

      const mappedState = (item.confidence_state && ['unconfirmed','reported','corroborated','verified','confirmed'].includes(item.confidence_state))
        ? item.confidence_state
        : (scoredItem.confidence_state
          || mapVerifToState((item as any)?.verification?.state)
          || mapNumericToState((item as any).confidence));

      const result: any = {
        ...item
      };
      // Only set confidence_state if missing on the item
      if (!result.confidence_state) {
        result.confidence_state = mappedState || 'unconfirmed';
      }
      // Title mode handling (non-destructive; only modify if smart mode enabled)
      if (titleMode !== 'original') {
        result.headline = smartTitle(item.headline);
      }
      
      // Always include new system fields
      if (scoredItem.verification) {
        // Transform verification to match frontend expected structure
        result.verification = {
          state: scoredItem.verification
        };
        
        // Include additional verification details if available
        if (scoredItem.verification_result) {
          result.verification.evidence = {
            sources: item.sources,
            confirmations: scoredItem.verification_result.k,
            max_tier: scoredItem.verification_result.max_tier,
            reason: scoredItem.verification_result.reason
          };
        }
      }
      
      let impactCategory: any = undefined;
      let impactScore: number | undefined = undefined;
      let impactLevel: any = undefined;
      if (scoredItem.impact) {
        impactCategory = (scoredItem as any).impact;
        impactScore = (scoredItem as any).impact_score;
        impactLevel = (scoredItem as any).impact; // same as category by design
      } else {
        // Fallback: map legacy shapes
        const rawImpact: any = (item as any).impact;
        const rawScore: any = (item as any).impact_score;
        if (typeof rawImpact === 'string') {
          impactCategory = rawImpact;
          impactScore = typeof rawScore === 'number' ? rawScore : undefined;
        } else if (rawImpact && typeof rawImpact === 'object') {
          impactCategory = rawImpact.category;
          impactScore = rawImpact.score;
          impactLevel = rawImpact.level;
        } else if (typeof rawScore === 'number') {
          const cat = rawScore >= 80 ? 'C' : rawScore >= 60 ? 'H' : rawScore >= 35 ? 'M' : 'L';
          impactCategory = cat;
          impactScore = rawScore;
        }
      }
      if (impactCategory) {
        // Build resolved impact object per spec
        const resolved: any = { category: impactCategory, level: impactLevel ?? impactCategory, score: impactScore ?? 0 };
        const cat = resolved.category ?? resolved.level ?? 'L';
        result.impact = { category: cat, level: resolved.level ?? cat, score: resolved.score ?? 0 };
        result.impact_score = impactScore ?? result.impact_score ?? 0;
      }
      
      // Confidence categorical only flag: ensure numeric is never emitted
      if (process.env.CONFIDENCE_CATEGORICAL_ONLY === '1') {
        if ('confidence' in result) delete result.confidence;
      }

      // Include debug information if requested
      // confidence numeric debug removed
      
      if (debugImpact && scoredItem._impact_debug) {
        result.impact_debug = scoredItem._impact_debug;
      }
      
      if (debugVerification && scoredItem._verification_debug) {
        result._verification_debug = scoredItem._verification_debug;
      }
      
      return result;
    });
    
    // Apply timestamp debug if requested (dev only)
    if (debugTime && getNodeEnv() === 'development') {
      items = items.map(item => ({
        ...item,
        _time_debug: {
          id: item.id,
          arrival_at: item.arrival_at,
          ingested_at: item.ingested_at,
          published_at: item.published_at
        }
      }));
    }
    
    // Apply "My" filter if requested
    if (filter === 'my') {
      try {
        // Get watchlist
        const systemCollection = getDb().collection('system');
        const watchlistDoc = await systemCollection.doc('watchlist_public').get();
        
        if (watchlistDoc.exists) {
          const watchlist = watchlistDoc.data();
          const wl: WatchlistData = (watchlist ? (watchlist as Partial<WatchlistData>) : {}) as WatchlistData;
          
          const tickers: string[] = Array.isArray(wl.tickers) ? wl.tickers : [];
          const keywords: string[] = Array.isArray(wl.keywords) ? wl.keywords : [];
          
          if (tickers.length > 0 || keywords.length > 0) {
            // Filter items based on watchlist
            items = items.filter(item => {
              // Check if any ticker matches
              const tickerMatch = tickers.some((ticker: string) => 
                ticker && item.tickers.some(itemTicker => 
                  itemTicker.toUpperCase() === ticker.toUpperCase()
                )
              );
              
              // Check if any keyword matches in headline or why
              const keywordMatch = keywords.some((keyword: string) => {
                if (!keyword) return false;
                const searchText = `${item.headline} ${item.why}`.toLowerCase();
                return searchText.includes(keyword.toLowerCase());
              });
              
              return tickerMatch || keywordMatch;
            });
          }
        }
      } catch (watchlistError) {
        console.error('Error fetching watchlist for My filter:', watchlistError);
        // Continue with unfiltered results if watchlist fetch fails
      }
    }
    
    // Set timing headers and log before responding
    if (latencyHeadersEnabled) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      res.set('X-Backend-Duration-Ms', elapsedMs.toFixed(1));
      console.log('[api][feed][timing]', {
        requestId,
        durationMs: Math.round(elapsedMs),
        filter: filter || undefined,
        limit: newsLimit,
        items: items.length
      });
    } else {
      // Always emit a concise info log for observability
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      console.log('[api][feed]', { durationMs: Math.round(elapsedMs), items: items.length });
    }

    res.json({
      items,
      total: items.length
    });
    return;
  } catch (error) {
    console.error('Error in /feed endpoint:', error);
    if (latencyHeadersEnabled) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      res.set('X-Backend-Duration-Ms', elapsedMs.toFixed(1));
    }
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
    return;
  }
});

// GET /watchlist - Return public watchlist
router.get('/watchlist', async (_req, res) => {
  try {
    const systemCollection = getDb().collection('system');
    const docRef = systemCollection.doc('watchlist_public');
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
      res.json(docSnap.data());
    } else {
      // Return empty default watchlist
      const defaultWatchlist = {
        tickers: [],
        keywords: [],
        thresholds: {},
        updated_at: new Date().toISOString()
      };
      res.json(defaultWatchlist);
    }
  } catch (error) {
    console.error('Error in GET /watchlist endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

// POST /watchlist - Hardened public watchlist endpoint
router.post('/watchlist', watchlistLimiter, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<WatchlistData>;
    const { tickers, keywords, thresholds } = body;
    
    // Validate payload structure
    if (tickers !== undefined && !Array.isArray(tickers)) {
      return res.status(400).json({ 
        error: { message: 'tickers must be an array of strings' } 
      });
    }
    
    if (keywords !== undefined && !Array.isArray(keywords)) {
      return res.status(400).json({ 
        error: { message: 'keywords must be an array of strings' } 
      });
    }
    
    if (thresholds !== undefined && (typeof thresholds !== 'object' || thresholds === null)) {
      return res.status(400).json({ 
        error: { message: 'thresholds must be an object' } 
      });
    }
    
    // Validate and normalize tickers
    let normalizedTickers: string[] = [];
    const safeTickers: string[] = Array.isArray(tickers) ? tickers.map(String) : [];
    if (safeTickers.length > 0) {
      if (safeTickers.length > 30) {
        return res.status(400).json({ 
          error: { message: 'tickers limit exceeded (max 30)' } 
        });
      }
      
      // Validate each ticker: uppercase, A-Z, 0-9, .,- only; dedupe
      const tickerSet = new Set<string>();
      for (const ticker of safeTickers) {
        if (typeof ticker !== 'string') continue;
        
        const normalizedTicker = ticker.toUpperCase().trim();
        if (normalizedTicker.length === 0) continue;
        
        // Validate format: A-Z, 0-9, .,- only
        if (!/^[A-Z0-9.,-]+$/.test(normalizedTicker)) {
          return res.status(400).json({ 
            error: { message: `Invalid ticker format: ${ticker}. Only A-Z, 0-9, .,- allowed` } 
          });
        }
        
        tickerSet.add(normalizedTicker);
      }
      normalizedTickers = Array.from(tickerSet);
    }
    
    // Validate and normalize keywords
    let normalizedKeywords: string[] = [];
    const safeKeywords: string[] = Array.isArray(keywords) ? keywords.map(String) : [];
    if (safeKeywords.length > 0) {
      if (safeKeywords.length > 50) {
        return res.status(400).json({ 
          error: { message: 'keywords limit exceeded (max 50)' } 
        });
      }
      
      // Validate each keyword: 2-40 chars; dedupe
      const keywordSet = new Set<string>();
      for (const keyword of safeKeywords) {
        if (typeof keyword !== 'string') continue;
        
        const normalizedKeyword = keyword.trim();
        if (normalizedKeyword.length < 2 || normalizedKeyword.length > 40) {
          return res.status(400).json({ 
            error: { message: `Invalid keyword length: ${keyword}. Must be 2-40 characters` } 
          });
        }
        
        keywordSet.add(normalizedKeyword);
      }
      normalizedKeywords = Array.from(keywordSet);
    }
    
    // Validate thresholds if provided
    if (thresholds) {
      for (const [key, value] of Object.entries(thresholds)) {
        if (typeof value !== 'number' || value < 0 || value > 100) {
          return res.status(400).json({ 
            error: { message: `threshold ${key} must be a number between 0 and 100` } 
          });
        }
      }
    }
    
    // Create normalized watchlist
    const normalizedWatchlist = {
      tickers: normalizedTickers,
      keywords: normalizedKeywords,
      thresholds: thresholds || {},
      updated_at: new Date().toISOString()
    };
    
    // Store in system/watchlist_public doc (merge)
    const systemCollection = getDb().collection('system');
    const docRef = systemCollection.doc('watchlist_public');
    await docRef.set(normalizedWatchlist, { merge: true });
    
    console.log('[api][write]', { 
      collection: 'system', 
      id: 'watchlist_public', 
      tickers: normalizedTickers.length,
      keywords: normalizedKeywords.length,
      thresholds: Object.keys(thresholds || {}).length
    });
    
    res.status(200).json(normalizedWatchlist);
    return;
  } catch (error) {
    console.error('Error in POST /watchlist endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
    return;
  }
});

// GET /metrics-summary
router.get('/metrics-summary', async (_req, res) => {
  try {
    const db = getDb();
    const windowMin = parseInt(process.env.METRICS_LATENCY_WINDOW_MIN || '60', 10);
    const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
    const snap = await db.collection('latency_metrics')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(500)
      .get();
    const per: Record<string, { pub: number[]; pulse: number[]; transports?: string[]; last_age_min?: number | null; dropped_by_date?: number } > = {};
    if (snap && Array.isArray((snap as any).docs)) {
      (snap as any).docs.forEach((d: any) => {
        const data = d.data();
        const s = data.source as string;
        if (!s) return;
        const isSynthetic = data.transport === 'test' || (Array.isArray(data.tags) && data.tags.includes('test'));
        per[s] = per[s] || { pub: [], pulse: [], transports: [], last_age_min: null, dropped_by_date: 0 };
        if (!isSynthetic && typeof data.t_publish_ms === 'number') per[s].pub.push(data.t_publish_ms);
        if (typeof data.t_exposure_ms === 'number') per[s].pulse.push(data.t_exposure_ms);
        if (data.transport) per[s].transports!.push(data.transport);
      });
    } else if (snap && typeof (snap as any).forEach === 'function') {
      (snap as any).forEach((d: any) => {
        const data = d.data();
        const s = data.source as string;
        if (!s) return;
        const isSynthetic = data.transport === 'test' || (Array.isArray(data.tags) && data.tags.includes('test'));
        per[s] = per[s] || { pub: [], pulse: [], transports: [], last_age_min: null, dropped_by_date: 0 };
        if (!isSynthetic && typeof data.t_publish_ms === 'number') per[s].pub.push(data.t_publish_ms);
        if (typeof data.t_exposure_ms === 'number') per[s].pulse.push(data.t_exposure_ms);
        if (data.transport) per[s].transports!.push(data.transport);
      });
    }
    const p50 = (arr: number[]) => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : null;
    const p90 = (arr: number[]) => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.9)] : null;
    const bySource: any = {};
    const pubAgg: number[] = []; const pulseAgg: number[] = [];
    Object.entries(per).forEach(([k,v]) => {
      const sp50 = p50(v.pub); const sp90 = p90(v.pub);
      const xp50 = p50(v.pulse); const xp90 = p90(v.pulse);
      bySource[k] = { publisher_p50: sp50, publisher_p90: sp90, pulse_p50: xp50, pulse_p90: xp90, samples: v.pub.length };
      if (sp50 != null) pubAgg.push(sp50);
      if (xp50 != null) pulseAgg.push(xp50);
    });
    const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    const aggregate = { publisher: { p50: avg(pubAgg) }, pulse: { p50: avg(pulseAgg) } };
    res.json({ ok: true, by_source: bySource, aggregate });
  } catch (e) {
    console.error('[metrics-summary] error:', e);
    res.status(500).json({ ok: false });
  }
});

// Dev helper: toggle runtime flags without restart (staging/dev only)
router.post('/admin/flags', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'Forbidden in production' });
    }
    const body = req.body || {};
    const allowed = ['BREAKING_AUTODEMOTE','PULSE_LATENCY_ALERTS','SSE_ENABLED','FASTLANE_ENABLED','SSE_MAX_CLIENTS_PER_IP','SSE_RING_SIZE'];
    const changed: Record<string,string> = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        process.env[k] = String(body[k]);
        changed[k] = String(body[k]);
      }
    }
    return res.json({ ok: true, changed });
  } catch (e) {
    console.error('[admin][flags] error', e);
    return res.status(500).json({ ok: false });
  }
});

// Register metrics routes
router.use(metrics);

// Register admin routes
router.use('/admin', adminRoutes);

export default router;
