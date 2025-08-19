import cron from 'node-cron';
import { ingestRSSFeeds } from './ingest/rss';
import { breakingScheduler } from './ingest/breakingScheduler';
import { getConfig } from './config/env';
import { runFastlaneWatchersOnce } from './ingest/rssWatchers';

// Store cron task reference for cleanup
let rssCronTask: cron.ScheduledTask | null = null;

// Schedule RSS ingestion
export const startRSSIngestion = (): void => {
  // Default to adaptive unless explicitly forced to batch
  const adaptive = process.env.RSS_BATCH_FORCE === '1' ? false : true;
  const schedule = (process.env.INGEST_EXPANSION === '1') ? '*/30 * * * * *' : (getConfig().cronSchedule || '*/1 * * * *');
  
  if (adaptive) {
    console.log('[rss] RSS_ADAPTIVE=1 enabled: delegating to breakingScheduler for adaptive polling');
  } else {
    console.log(`Starting RSS ingestion cron job with schedule: ${schedule}`);
  }
  
  // Run initial ingestion on startup (non-adaptive path)
  if (!adaptive) {
    ingestRSSFeeds().then(stats => {
      console.log('Initial RSS ingestion completed:', stats);
    }).catch(error => {
      console.error('Initial RSS ingestion failed:', error);
    });
  }
  
  // Schedule recurring ingestion or start adaptive scheduler
  if (!adaptive) {
    rssCronTask = cron.schedule(schedule, () => {
      ingestRSSFeeds().then(stats => {
        console.log('Scheduled RSS ingestion completed:', stats);
      }).catch(error => {
        console.error('Scheduled RSS ingestion failed:', error);
      });
    });
  } else {
    // Start adaptive breaking scheduler in RSS mode (reusing breakingScheduler)
    try {
      breakingScheduler.start();
      // Run canary watchers once per minute if FASTLANE is enabled
      if (process.env.FASTLANE_ENABLED === '1') {
        cron.schedule('*/1 * * * *', () => {
          runFastlaneWatchersOnce().catch(()=>{});
        });
      }
    } catch (e) {
      console.error('[rss] Failed to start adaptive scheduler:', e);
    }
  }
};

// Cleanup function for cron jobs
export const stopRSSIngestion = (): void => {
  if (rssCronTask) {
    rssCronTask.stop();
    rssCronTask = null;
    console.log('Stopped RSS ingestion cron job');
  }
};
