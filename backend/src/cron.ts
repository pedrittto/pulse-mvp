import cron from 'node-cron';
import { ingestRSSFeeds } from './ingest/rss';

// Schedule RSS ingestion
export const startRSSIngestion = (): void => {
  const schedule = process.env.CRON_SCHEDULE || '*/3 * * * *';
  
  console.log(`Starting RSS ingestion cron job with schedule: ${schedule}`);
  
  // Run initial ingestion on startup
  ingestRSSFeeds().then(stats => {
    console.log('Initial RSS ingestion completed:', stats);
  }).catch(error => {
    console.error('Initial RSS ingestion failed:', error);
  });
  
  // Schedule recurring ingestion
  cron.schedule(schedule, () => {
    ingestRSSFeeds().then(stats => {
      console.log('Scheduled RSS ingestion completed:', stats);
    }).catch(error => {
      console.error('Scheduled RSS ingestion failed:', error);
    });
  });
};
