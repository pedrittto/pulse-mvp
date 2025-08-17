import cron from 'node-cron';
import { ingestRSSFeeds } from './ingest/rss';
import { getConfig } from './config/env';

// Store cron task reference for cleanup
let rssCronTask: cron.ScheduledTask | null = null;

// Schedule RSS ingestion
export const startRSSIngestion = (): void => {
  const schedule = getConfig().cronSchedule || '*/1 * * * *';
  
  console.log(`Starting RSS ingestion cron job with schedule: ${schedule}`);
  
  // Run initial ingestion on startup
  ingestRSSFeeds().then(stats => {
    console.log('Initial RSS ingestion completed:', stats);
  }).catch(error => {
    console.error('Initial RSS ingestion failed:', error);
  });
  
  // Schedule recurring ingestion
  rssCronTask = cron.schedule(schedule, () => {
    ingestRSSFeeds().then(stats => {
      console.log('Scheduled RSS ingestion completed:', stats);
    }).catch(error => {
      console.error('Scheduled RSS ingestion failed:', error);
    });
  });
};

// Cleanup function for cron jobs
export const stopRSSIngestion = (): void => {
  if (rssCronTask) {
    rssCronTask.stop();
    rssCronTask = null;
    console.log('Stopped RSS ingestion cron job');
  }
};
