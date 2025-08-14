import express from 'express';
import rateLimit from 'express-rate-limit';
// import { Watchlist } from './types';
import { getNewsItems } from './storage';
import { getDb } from './lib/firestore';
import { ingestRSSFeeds } from './ingest/rss';
import { metrics } from './routes/metrics';
import { scoreNews } from './utils/scoring';

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
  if (process.env.NODE_ENV === 'production') {
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
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const usesADC = !process.env.FIREBASE_PRIVATE_KEY; // If no private key, likely using ADC

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
  if (process.env.NODE_ENV === 'production') {
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
    snapshot.forEach(doc => {
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
  if (process.env.NODE_ENV === 'production') {
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
    snapshot.docs.forEach(doc => {
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

// Admin endpoint for purging feed data
router.post('/admin/purge-feed', async (_req, res) => {
  // Security checks
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(403).json({
      ok: false,
      error: 'ADMIN_TOKEN not configured',
      code: 'ADMIN_TOKEN_MISSING'
    });
  }

  const providedToken = _req.headers['x-admin-token'];
  if (providedToken !== adminToken) {
    return res.status(403).json({
      ok: false,
      error: 'Invalid admin token',
      code: 'INVALID_TOKEN'
    });
  }

  const confirm = _req.query.confirm;
  if (confirm !== 'PURGE') {
    return res.status(400).json({
      ok: false,
      error: 'Must include confirm=PURGE query parameter',
      code: 'CONFIRMATION_REQUIRED'
    });
  }

  // Determine if real deletion is allowed
  const allowRealDeletion = process.env.ADMIN_ALLOW_PURGE === 'true';
  const requestedDryRun = _req.query.dry === '1';
  const dryRun = !allowRealDeletion || requestedDryRun;
  const dryRunForced = !allowRealDeletion && !requestedDryRun;
  

  
  const startTime = Date.now();

  try {
    const collections = ['news', 'trending_topics', 'trends', 'NewsCards'];
    const deleted: { [key: string]: number } = {};

    if (dryRun) {
      // Dry run - just count documents
      for (const collectionName of collections) {
        try {
          const snapshot = await getDb().collection(collectionName).get();
          deleted[collectionName] = snapshot.size;
        } catch (error) {
          // Collection doesn't exist, count as 0
          deleted[collectionName] = 0;
        }
      }
    } else {
      // Real purge
      for (const collectionName of collections) {
        try {
          deleted[collectionName] = await purgeCollection(collectionName);
        } catch (error) {
          // Collection doesn't exist, count as 0
          deleted[collectionName] = 0;
        }
      }
    }

    const tookMs = Date.now() - startTime;
    
    console.log('[purge]', { dryRun, deleted, tookMs });
    
    res.json({
      ok: true,
      dryRun,
      dryRunForced,
      deleted,
      took_ms: tookMs
    });
    return;
  } catch (error) {
    console.error('[purge] Error:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return;
  }
});

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
  try {
    // Accept query params: filter, q, limit, after, debug
    const { filter, limit, debug } = req.query;
    
    // Validate query params (basic validation for now)
    if (filter && !['my', 'market-moving', 'macro', 'all'].includes(filter as string)) {
      return res.status(400).json({ 
        error: { message: 'Invalid filter. Must be one of: my, market-moving, macro, all' } 
      });
    }
    
    if (limit && (isNaN(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) {
      return res.status(400).json({ 
        error: { message: 'Invalid limit. Must be a number between 1 and 100' } 
      });
    }
    
    // Check for debug flag
    const debugConfidence = debug === 'conf';
    
    // Get news items from Firestore (newest first)
    const newsLimit = limit ? parseInt(limit as string) : 20;
    let items = await getNewsItems(newsLimit);
    
    // Apply confidence debug if requested
    if (debugConfidence) {
      items = items.map(item => {
        // Re-score with debug information
        const scoredItem = scoreNews({
          headline: item.headline,
          description: item.why,
          sources: item.sources,
          tickers: item.tickers,
          published_at: item.published_at,
          debug: true
        });
        
        return {
          ...item,
          confidence: scoredItem.confidence,
          confidenceDebug: scoredItem._confidence_debug
        };
      });
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
    
    res.json({
      items,
      total: items.length
    });
    return;
  } catch (error) {
    console.error('Error in /feed endpoint:', error);
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

// Register metrics routes
router.use(metrics);

export default router;
