import { NewsItem } from './types';
import { getDb } from './lib/firestore';

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
        primary_entity: sanitizedItem.primary_entity || undefined,
        sources: Array.isArray(sanitizedItem.sources) ? sanitizedItem.sources : [],
        tickers: Array.isArray(sanitizedItem.tickers) ? sanitizedItem.tickers : [],
        impact: sanitizedItem.impact || 'L',
        confidence: typeof sanitizedItem.confidence === 'number' ? sanitizedItem.confidence : 50
      };

      // Add new document
      await docRef.set(safeItem);
      console.log('[ingest][write]', { 
        collection: 'news', 
        id: safeItem.id, 
        headline: safeItem.headline, 
        published_at: safeItem.published_at,
        primary_entity: safeItem.primary_entity,
        impact: safeItem.impact,
        confidence: safeItem.confidence
      });
      added++;
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
    snapshot.forEach(doc => {
      items.push(doc.data() as NewsItem);
    });
    
    return items;
  } catch (error) {
    console.error('Error fetching news items:', error);
    return [];
  }
};
