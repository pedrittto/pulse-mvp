import express from 'express';
import { NewsItem, Watchlist } from './types';
import { getNewsItems } from './storage';
import { db } from './config/firebase';

// Helper function to get Firestore database instance
export const getDb = () => db;

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
    const debugCollection = db.collection('debug');
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
    res.json(items);
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
    
    const watchlistsCollection = db.collection('watchlists');
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
    const watchlistsCollection = db.collection('watchlists');
    const docRef = watchlistsCollection.doc(watchlist.user_id);
    await docRef.set(watchlist);
    
    res.status(200).json(watchlist);
  } catch (error) {
    console.error('Error in POST /watchlist endpoint:', error);
    res.status(500).json({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  }
});

export default router;
