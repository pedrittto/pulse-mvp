import express from 'express';
import { NewsItem, Watchlist } from './types';
import { getNewsItems } from './storage';
import { getDb } from './lib/firestore';
import { ingestRSSFeeds } from './ingest/rss';

// Helper function to get Firestore database instance
export const getDbInstance = () => getDb();

const router = express.Router();

// Debug endpoint for Firestore access verification
router.get('/debug/firestore', async (req, res) => {
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
  } catch (error) {
    console.error('Firestore debug endpoint error:', error);
    console.error('Full stack trace:', error instanceof Error ? error.stack : 'No stack trace available');
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
  }
});

// Debug endpoint for Firebase credentials verification
router.get('/debug/creds', async (req, res) => {
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
  } catch (error) {
    console.error('Creds debug endpoint error:', error);
    console.error('Full stack trace:', error instanceof Error ? error.stack : 'No stack trace available');
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
  }
});

// Debug endpoint for listing Firestore collections
router.get('/debug/firestore-list', async (req, res) => {
  // Environment guard - only allow in non-production
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({
      ok: false,
      error: 'Debug endpoint not available in production',
      code: 'DEBUG_DISABLED'
    });
  }

  try {
    const { col = 'news', limit = 5 } = req.query;
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
  } catch (error) {
    console.error('Firestore list debug endpoint error:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
  }
});

// Admin endpoint for manual ingestion
router.post('/admin/ingest-now', async (req, res) => {
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
  } catch (error) {
    console.error('[admin] Manual ingestion failed:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
  }
});

// Demo watchlist
const demoWatchlist: Watchlist = {
  user_id: "demo",
  tickers: ["AAPL", "GOOGL", "MSFT"],
  keywords: ["AI", "earnings", "guidance"],
  min_confidence: 70,
  min_impact: "M",
  quiet_hours: {
    start: "22:00",
    end: "08:00"
  }
};

// GET /feed
router.get('/feed', async (req, res) => {
  try {
    // Accept query params: filter, q, limit, after
    const { filter, q, limit, after } = req.query;
    
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
    
    // Get news items from Firestore (newest first)
    const newsLimit = limit ? parseInt(limit as string) : 20;
    const items = await getNewsItems(newsLimit);
    res.json({
      items,
      total: items.length
    });
  } catch (error) {
    console.error('Error in /feed endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

// GET /watchlist/:userId
router.get('/watchlist/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Return demo watchlist for demo user
    if (userId === 'demo') {
      return res.json(demoWatchlist);
    }
    
    const watchlistsCollection = getDb().collection('watchlists');
    const docRef = watchlistsCollection.doc(userId);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
      res.json(docSnap.data() as Watchlist);
    } else {
      // Return minimal default watchlist
      const defaultWatchlist: Watchlist = {
        user_id: userId,
        tickers: [],
        keywords: [],
        min_confidence: 50,
        min_impact: "L"
      };
      res.json(defaultWatchlist);
    }
  } catch (error) {
    console.error('Error in /watchlist/:userId endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

// POST /watchlist
router.post('/watchlist', async (req, res) => {
  try {
    const watchlist: Watchlist = req.body;
    
    // Basic validation
    if (!watchlist.user_id || typeof watchlist.user_id !== 'string') {
      return res.status(400).json({ 
        error: { message: 'user_id is required and must be a string' } 
      });
    }
    
    if (!Array.isArray(watchlist.tickers)) {
      return res.status(400).json({ 
        error: { message: 'tickers must be an array' } 
      });
    }
    
    if (!Array.isArray(watchlist.keywords)) {
      return res.status(400).json({ 
        error: { message: 'keywords must be an array' } 
      });
    }
    
    if (typeof watchlist.min_confidence !== 'number' || 
        watchlist.min_confidence < 0 || 
        watchlist.min_confidence > 100) {
      return res.status(400).json({ 
        error: { message: 'min_confidence must be a number between 0 and 100' } 
      });
    }
    
    if (!['L', 'M', 'H'].includes(watchlist.min_impact)) {
      return res.status(400).json({ 
        error: { message: 'min_impact must be one of: L, M, H' } 
      });
    }
    
    // Store in Firestore
    const watchlistsCollection = getDb().collection('watchlists');
    const docRef = watchlistsCollection.doc(watchlist.user_id);
    await docRef.set(watchlist);
    console.log('[api][write]', { 
      collection: 'watchlists', 
      id: watchlist.user_id, 
      tickers: watchlist.tickers.length,
      keywords: watchlist.keywords.length
    });
    
    res.status(200).json(watchlist);
  } catch (error) {
    console.error('Error in POST /watchlist endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

export default router;
