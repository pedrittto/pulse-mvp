import { NewsItem } from './types';
import { getDb } from './lib/firestore';

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

      // Add new document
      await docRef.set(item);
      console.log('[ingest][write]', { 
        collection: 'news', 
        id: item.id, 
        headline: item.headline, 
        published_at: item.published_at 
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
