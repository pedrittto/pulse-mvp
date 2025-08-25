import { NewsItem } from './types.js';
import { getDb } from './lib/firestore.js';
import { sanitizeText } from './utils/sanitize.js';
import { scoreNews } from './utils/scoring.js';
import { composeHeadline, composeSummary } from './utils/factComposer.js';
import { isTradingRelevant } from './utils/tradingFilter.js';
import { sseHub } from './realtime/sse.js';
import { getBulkWriter, incEnqueued } from './lib/bulkWriter.js';

// Sanitize payload to remove undefined/null values (except where Firestore Timestamp is expected)
const sanitizePayload = (payload: any): any => {
  if (payload === null || payload === undefined) {
    return undefined;
  }
  
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const sanitized: any = {};
    let hasValidFields = false;
    
    for (const [key, value] of Object.entries(payload)) {
      // Skip undefined and null values
      if (value === undefined || value === null) {
        continue;
      }
      
      // Recursively sanitize nested objects
      if (typeof value === 'object' && !Array.isArray(value)) {
        const sanitizedNested = sanitizePayload(value);
        if (sanitizedNested !== undefined) {
          sanitized[key] = sanitizedNested;
          hasValidFields = true;
        }
      } else {
        sanitized[key] = value;
        hasValidFields = true;
      }
    }
    
    return hasValidFields ? sanitized : undefined;
  }
  
  return payload;
};

// Add news items to Firestore (with deduplication)
export const addNewsItems = async (items: NewsItem[]): Promise<{ added: number; skipped: number }> => {
  let added = 0;
  let skipped = 0;
  
  const newsCollection = getDb().collection('news');

  let i = 0;
  const bw = getBulkWriter({
    enabled: String(process.env.BULKWRITER_ENABLED || '0') === '1',
    maxOpsPerSecond: parseInt(process.env.BULKWRITER_MAX_OPS_PER_SEC || '500', 10)
  });
  for (const item of items) {
    try {
      // Check if document already exists (deduplication by document ID)
      const docRef = newsCollection.doc(item.id);
      const docSnap = await docRef.get();
      
      if (docSnap.exists) {
        skipped++;
        continue;
      }

      // Sanitize the payload to remove undefined/null values
      const sanitizedItem = sanitizePayload(item);
      
      // Check if sanitized payload is empty/invalid
      if (!sanitizedItem || Object.keys(sanitizedItem).length === 0) {
        console.log('[ingest][skip]', { 
          reason: 'empty_payload_after_sanitization',
          id: item.id, 
          headline: item.headline,
          originalKeys: Object.keys(item),
          sanitizedKeys: sanitizedItem ? Object.keys(sanitizedItem) : []
        });
        skipped++;
        continue;
      }

      // Ensure required fields have safe defaults
      const safeItem = {
        ...sanitizedItem,
        primary_entity: sanitizedItem.primary_entity || '',
        sources: Array.isArray(sanitizedItem.sources) ? sanitizedItem.sources : [],
        tickers: Array.isArray(sanitizedItem.tickers) ? sanitizedItem.tickers : [],
        impact: sanitizedItem.impact || 'L',
        impact_score: typeof sanitizedItem.impact_score === 'number' ? sanitizedItem.impact_score : 20,
        confidence_state: sanitizedItem.confidence_state,
        category: sanitizedItem.category || '',
        ingested_at: sanitizedItem.ingested_at ?? new Date().toISOString(),
        // Set arrival_at only on first insert - never overwrite existing
        arrival_at: sanitizedItem.arrival_at ?? new Date().toISOString(),
        // Add version field for feed filtering
        version: 'v2'
      };

      // Earliest gate for trading-only (second safety net)
      if (process.env.TRADING_ONLY_FILTER === '1') {
        try {
          const sourceUrlOrDomain = safeItem.sources?.[0] || '';
          const gate = isTradingRelevant(safeItem.headline || '', safeItem.why || '', sourceUrlOrDomain);
          if (!gate.relevant) {
            const db = getDb();
            const doc = db.collection('feeds_shadow').doc('trading_filter').collection('dropped').doc(safeItem.id);
            await doc.set({ id: safeItem.id, title: safeItem.headline, source: sourceUrlOrDomain, dropped_at: new Date().toISOString(), reason: gate.reason }, { merge: true });
            skipped++;
            continue;
          }
        } catch (e) {
          console.error('[filter][trading_only][storage] shadow write failed:', e);
        }
      }

      // Add new document (BulkWriter for Tier-1 lane when enabled)
      const isTier1 = Array.isArray(safeItem.sources) && safeItem.sources.length > 0 && typeof safeItem.sources[0] === 'string' && (
        ['Bloomberg Markets','Reuters Business','AP Business','CNBC','Financial Times','PRNewswire','GlobeNewswire','SEC Filings','NASDAQ Trader News','NYSE Notices','Business Wire']
          .includes(safeItem.sources[0])
      );
      if (bw && isTier1) {
        try { (bw as any).set(docRef, safeItem, { merge: false }); incEnqueued(); }
        catch { await docRef.set(safeItem); }
      } else {
        await docRef.set(safeItem);
      }
      console.log('[ingest][write]', { 
        collection: 'news', 
        id: safeItem.id, 
        headline: safeItem.headline, 
        published_at: safeItem.published_at,
        primary_entity: safeItem.primary_entity,
        impact: safeItem.impact
      });
      // Emit SSE event if enabled, with emitted_at
      try {
        const nowIso = new Date().toISOString();
        sseHub.broadcastNewItem({ id: safeItem.id, ingested_at: safeItem.ingested_at, emitted_at: nowIso, source: (safeItem as any)?.source || undefined });
        // Log SSE emit milestone into latency_metrics
        try {
          const pubMs = safeItem.published_at ? Date.parse(safeItem.published_at) : NaN;
          const ingMs = safeItem.ingested_at ? Date.parse(safeItem.ingested_at) : NaN;
          const tPublishMs = (Number.isFinite(pubMs) && Number.isFinite(ingMs)) ? Math.max(0, ingMs - pubMs) : null;
          const db = getDb();
          await db.collection('latency_metrics').add({
            source: ((safeItem as any)?.source || (safeItem as any)?.sources?.[0]) ?? null,
            source_published_at: safeItem.published_at ?? null,
            ingested_at: safeItem.ingested_at ?? null,
            arrival_at: nowIso, // treat SSE emit as arrival to delivery layer
            t_publish_ms: tPublishMs,
            timestamp: nowIso,
            transport: 'sse_emit'
          });
        } catch { /* non-fatal */ }
      } catch { /* ignore */ }
      added++;
      if (bw && (++i % 500 === 0)) { await new Promise(r => setImmediate(r)); }
    } catch (error) {
      console.error(`Error adding news item ${item.id}:`, error);
      skipped++;
    }
  }

  return { added, skipped };
};

// Generate hash for deduplication
export const generateArticleHash = (headline: string, primaryEntity?: string): string => {
  const content = `${headline.toLowerCase().trim()}${primaryEntity ? `|${primaryEntity.toLowerCase().trim()}` : ''}`;
  return require('crypto').createHash('sha1').update(content).digest('hex');
};

// Get news items from Firestore with optional limit
export const getNewsItems = async (limit: number = 20): Promise<NewsItem[]> => {
  try {
    const newsCollection = getDb().collection('news');
    const snapshot = await newsCollection
      .orderBy('ingested_at', 'desc')
      .limit(limit)
      .get();
    
    const items: NewsItem[] = [];
    snapshot.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const item = doc.data() as NewsItem;
      
      // Apply sanitization and fact composition as fallback for existing dirty data
      const cleanedItem = {
        ...item,
        headline: sanitizeText(item.headline),
        why: sanitizeText(item.why),
        primary_entity: item.primary_entity || ''
      };

      // Backfill scoring if missing
      if (!cleanedItem.impact_score || !cleanedItem.confidence_state || !cleanedItem.impact || cleanedItem.impact.category === 'L') {
        const score = scoreNews({
          headline: cleanedItem.headline,
          description: cleanedItem.why,
          sources: cleanedItem.sources,
          tickers: cleanedItem.tickers,
          published_at: cleanedItem.published_at
        });
        
        cleanedItem.impact = {
          score: score.impact_score,
          category: score.impact,
          drivers: []
        };
        cleanedItem.impact_score = score.impact_score;
        cleanedItem.confidence_state = score.confidence_state;
        if (score.tags?.includes('Macro') && !cleanedItem.category) {
          cleanedItem.category = 'macro';
        }
      }
      
      // Apply fact composition as fallback for headline/description
      if (!cleanedItem.headline || cleanedItem.headline.length < 3) {
        cleanedItem.headline = composeHeadline({
          title: item.headline || '',
          description: item.why || '',
          source: item.sources?.[0] || '',
          tickers: item.tickers || []
        });
      }
      
      if (!cleanedItem.why || cleanedItem.why.length < 5) {
        cleanedItem.why = composeSummary({
          title: item.headline || '',
          description: item.why || '',
          source: item.sources?.[0] || '',
          tickers: item.tickers || []
        });
      }
      
      // Preserve arrival_at exactly as stored - never modify it
      const itemWithArrival = {
        ...cleanedItem,
        // Use existing arrival_at if present, otherwise use ingested_at as fallback
        arrival_at: item.arrival_at ?? item.ingested_at
      };
      
      items.push(itemWithArrival);
    });
    
    return items;
  } catch (error) {
    console.error('Error fetching news items:', error);
    return [];
  }
};
