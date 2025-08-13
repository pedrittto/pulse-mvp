#!/usr/bin/env ts-node

/**
 * Backfill Key Facts Script
 * Recomputes summaries for recent documents to append key facts
 */

// Load environment variables
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

import { getDb } from '../src/lib/firestore';
import { composeSummary } from '../src/utils/factComposer';
import { extractKeyFact } from '../src/pipeline/keyFacts';

interface NewsItem {
  id: string;
  headline?: string;
  why?: string; // This is the summary field
  title?: string;
  description?: string;
  body?: string;
  published_at?: string;
  ingested_at?: string;
  sources?: string[];
  tickers?: string[];
}

interface BackfillStats {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Check if summary already contains a fact suffix
 */
function hasFactSuffix(summary: string): boolean {
  if (!summary) return false;
  
  // Check for trailing parenthesis pattern like (...)
  const factPattern = /\s*\([^)]+\)\s*$/;
  return factPattern.test(summary);
}

/**
 * Rebuild summary with key fact
 */
function rebuildSummaryWithFact(item: NewsItem): string | null {
  try {
    const currentSummary = item.why || '';
    
    // Extract key fact from title + body
    const combinedText = `${item.title || item.headline || ''} ${item.description || ''} ${item.body || ''}`;
    const keyFact = extractKeyFact(combinedText);
    
    if (!keyFact) {
      return currentSummary; // No key fact found, return current summary unchanged
    }
    
    // Check if fact is already in the current summary
    if (currentSummary.toLowerCase().includes(keyFact.value.toLowerCase())) {
      return currentSummary; // Fact already present, return current summary unchanged
    }
    
    // Append key fact suffix to current summary
    let factSuffix = '';
    switch (keyFact.type) {
      case 'percent':
        factSuffix = `(${keyFact.value})`;
        break;
      case 'money':
        factSuffix = `(${keyFact.currency} ${keyFact.value})`;
        break;
      case 'count':
        factSuffix = keyFact.unit ? `(${keyFact.value} ${keyFact.unit})` : `(${keyFact.value})`;
        break;
      case 'date':
        factSuffix = `(${keyFact.value})`;
        break;
      case 'place':
        factSuffix = `(${keyFact.value})`;
        break;
    }
    
    return factSuffix ? `${currentSummary} ${factSuffix}` : currentSummary;
  } catch (error) {
    console.error(`Error rebuilding summary for item ${item.id}:`, error);
    return null;
  }
}

/**
 * Process items in batches
 */
async function processBatch(
  items: NewsItem[], 
  stats: BackfillStats, 
  dryRun: boolean
): Promise<void> {
  const db = getDb();
  const batch = db.batch();
  let batchUpdates = 0;
  
  for (const item of items) {
    stats.processed++;
    
    try {
      // Skip if already has fact suffix
      if (hasFactSuffix(item.why || '')) {
        stats.skipped++;
        continue;
      }
      
      // Rebuild summary with key fact
      const newSummary = rebuildSummaryWithFact(item);
      
      if (!newSummary) {
        stats.errors++;
        continue;
      }
      
      // Only update if summary changed
      if (newSummary !== item.why) {
        if (dryRun) {
          console.log(`[DRY RUN] Would update ${item.id}:`);
          console.log(`  Old: "${item.why}"`);
          console.log(`  New: "${newSummary}"`);
          console.log('');
        } else {
          const docRef = db.collection('news').doc(item.id);
          batch.update(docRef, { why: newSummary });
          batchUpdates++;
        }
        stats.updated++;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      console.error(`Error processing item ${item.id}:`, error);
      stats.errors++;
    }
  }
  
  // Commit batch if not dry run and has updates
  if (!dryRun && batchUpdates > 0) {
    try {
      await batch.commit();
      console.log(`Committed batch with ${batchUpdates} updates`);
    } catch (error) {
      console.error('Error committing batch:', error);
      stats.errors += batchUpdates;
      stats.updated -= batchUpdates;
    }
  }
}

/**
 * Main backfill function
 */
async function backfillFacts(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  const limit = parseInt(process.env.LIMIT || '1000');
  const sinceDays = parseInt(process.env.SINCE_DAYS || '0');
  const batchSize = 300;
  
  console.log('=== Key Facts Backfill Script ===');
  console.log(`Dry run: ${dryRun}`);
  console.log(`Limit: ${limit}`);
  console.log(`Since days: ${sinceDays || 'all'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');
  
  const stats: BackfillStats = {
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0
  };
  
  try {
    const db = getDb();
    const collection = db.collection('news');
    
    // Build query
    let query = collection.orderBy('ingested_at', 'desc').limit(limit);
    
    // Add time filter if specified
    if (sinceDays > 0) {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - sinceDays);
      query = query.where('ingested_at', '>=', sinceDate.toISOString());
    }
    
    console.log('Fetching documents...');
    const snapshot = await query.get();
    
    if (snapshot.empty) {
      console.log('No documents found.');
      return;
    }
    
    console.log(`Found ${snapshot.size} documents to process.`);
    console.log('');
    
    // Process in batches
    const items: NewsItem[] = [];
    snapshot.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() } as NewsItem);
    });
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)} (${batch.length} items)...`);
      
      await processBatch(batch, stats, dryRun);
      
      // Progress report
      console.log(`Progress: ${stats.processed}/${items.length} processed`);
      console.log(`  Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
      console.log('');
    }
    
    // Final report
    console.log('=== Final Report ===');
    console.log(`Total processed: ${stats.processed}`);
    console.log(`Updated: ${stats.updated}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Errors: ${stats.errors}`);
    
    if (dryRun) {
      console.log('\nThis was a dry run. No changes were made.');
      console.log('Run without DRY_RUN=1 to apply changes.');
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  backfillFacts().catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}
