import axios from 'axios';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { publishStub, enrichItem } from './breakingIngest';
import * as fs from 'fs';
import * as path from 'path';

const parseXML = promisify(parseString);

interface BreakingSource {
  name: string;
  url: string;
  interval_ms: number;
  mode: string;
  event_window: boolean;
}

interface BreakingConfig {
  sources: BreakingSource[];
  default_interval_ms: number;
  watchlist_interval_ms: number;
  event_window_interval_ms: number;
}

interface EventWindow {
  name: string;
  description: string;
  start_time: string;
  end_time: string;
  days: string[];
  frequency: string;
  relevant_sources: string[];
}

interface EventWindowsConfig {
  events: EventWindow[];
}

interface RSSItem {
  title?: string[];
  description?: string[];
  link?: string[];
  pubDate?: string[];
  category?: string[];
}

interface RSSChannel {
  title?: string[];
  description?: string[];
  link?: string[];
  item?: RSSItem[];
}

interface RSSFeed {
  rss?: {
    channel?: RSSChannel[];
  };
}

class BreakingScheduler {
  private config: BreakingConfig;
  private eventWindows: EventWindowsConfig;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private etags: Map<string, string> = new Map();
  private lastModified: Map<string, string> = new Map();
  private isRunning = false;

  constructor() {
    this.config = this.loadBreakingConfig();
    this.eventWindows = this.loadEventWindowsConfig();
  }

  private loadBreakingConfig(): BreakingConfig {
    try {
      const configPath = path.join(__dirname, '../config/breaking-sources.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('[breaking][config] Failed to load breaking sources config:', error);
      return {
        sources: [],
        default_interval_ms: 120000,
        watchlist_interval_ms: 10000,
        event_window_interval_ms: 5000
      };
    }
  }

  private loadEventWindowsConfig(): EventWindowsConfig {
    try {
      const configPath = path.join(__dirname, '../config/event-windows.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('[breaking][config] Failed to load event windows config:', error);
      return { events: [] };
    }
  }

  // Check if we're currently in an event window
  private isInEventWindow(sourceName: string): boolean {
    const now = new Date();
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentTime = now.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    for (const event of this.eventWindows.events) {
      if (event.relevant_sources.includes(sourceName) &&
          event.days.includes(currentDay) &&
          currentTime >= event.start_time &&
          currentTime <= event.end_time) {
        return true;
      }
    }

    return false;
  }

  // Get the appropriate interval for a source
  private getSourceInterval(source: BreakingSource): number {
    if (source.event_window && this.isInEventWindow(source.name)) {
      return this.config.event_window_interval_ms;
    }
    return source.interval_ms;
  }

  // Fetch RSS feed with ETag/If-Modified-Since support
  private async fetchRSSFeed(source: BreakingSource): Promise<RSSItem[]> {
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Pulse-MVP-Breaking-Ingestor/1.0'
      };

      // Add ETag if we have it
      const etag = this.etags.get(source.name);
      if (etag) {
        headers['If-None-Match'] = etag;
      }

      // Add If-Modified-Since if we have it
      const lastMod = this.lastModified.get(source.name);
      if (lastMod) {
        headers['If-Modified-Since'] = lastMod;
      }

      console.log(`[breaking][fetch] ${source.name} - interval: ${this.getSourceInterval(source)}ms`);
      
      const response = await axios.get(source.url, {
        timeout: 8000,
        headers,
        validateStatus: (status) => status < 500 // Accept 304 Not Modified
      });

      // Handle 304 Not Modified
      if (response.status === 304) {
        console.log(`[breaking][cache] ${source.name} - no new content`);
        return [];
      }

      // Store ETag and Last-Modified for next request
      const newEtag = response.headers.etag;
      if (newEtag) {
        this.etags.set(source.name, newEtag);
      }

      const lastModified = response.headers['last-modified'];
      if (lastModified) {
        this.lastModified.set(source.name, lastModified);
      }

      const parsed = await parseXML(response.data) as RSSFeed;
      const channel = parsed.rss?.channel?.[0];
      
      if (!channel?.item) {
        return [];
      }

      return channel.item;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          console.log(`[breaking][rate-limit] ${source.name} - backing off`);
          // Back off for rate limiting
          await this.backoff(source.name);
        } else if (error.response && error.response.status >= 500) {
          console.log(`[breaking][server-error] ${source.name} - backing off`);
          // Back off for server errors
          await this.backoff(source.name);
        } else {
          console.error(`[breaking][error] ${source.name}:`, error.message);
        }
      } else {
        console.error(`[breaking][error] ${source.name}:`, error);
      }
      return [];
    }
  }

  // Backoff mechanism for rate limiting and server errors
  private async backoff(sourceName: string): Promise<void> {
    const currentTimer = this.timers.get(sourceName);
    if (currentTimer) {
      clearTimeout(currentTimer);
    }

    // Exponential backoff: double the interval
    const source = this.config.sources.find(s => s.name === sourceName);
    if (source) {
      const backoffInterval = this.getSourceInterval(source) * 2;
      console.log(`[breaking][backoff] ${sourceName} - backing off for ${backoffInterval}ms`);
      
      const timer = setTimeout(() => {
        this.scheduleSource(source);
      }, backoffInterval);
      
      this.timers.set(sourceName, timer);
    }
  }

  // Process RSS items for a source
  private async processRSSItems(items: RSSItem[], source: BreakingSource): Promise<void> {
    for (const item of items) {
      const title = item.title?.[0];
      const description = item.description?.[0];
      const link = item.link?.[0];
      const pubDate = item.pubDate?.[0];

      if (!title || !link) {
        continue;
      }

      // Filter out non-actionable content
      if (this.shouldRejectArticle(title, description || '')) {
        continue;
      }

      // Publish stub immediately
      const result = await publishStub({
        title,
        source: source.name,
        url: link,
        published_at: pubDate,
        description
      });

      if (result.success) {
        // Schedule enrichment asynchronously
        setTimeout(async () => {
          await enrichItem(result.id);
        }, 1000); // Small delay to ensure stub is written
      }
    }
  }

  // Filtering rules for actionable market news
  private shouldRejectArticle(title: string, description: string): boolean {
    const combinedText = `${title} ${description}`.toLowerCase();
    
    const rejectPatterns = [
      /\b(top|things to watch|best|worst|how to|opinion|guide|tips|review|ranking|list)\b/i,
      /\b(cramer|podcast|interview|show|announcement|takeaways)\b/i,
      /\b(lifestyle|culture|travel|education|college|university)\b/i,
      /\b(sports|movie|celebrity|award|entertainment|retirement|smart moves)\b/i,
      /\b(here are|these are|what to|when you|options when)\b/i
    ];
    
    for (const pattern of rejectPatterns) {
      if (pattern.test(combinedText)) {
        return true;
      }
    }
    
    const hasFinancialContent = /\b(\d+%|\$\d+|[A-Z]{2,4}\b|fed|ecb|boe|treasury|sec)\b/i.test(combinedText);
    const wordCount = title.split(/\s+/).length;
    if (wordCount > 15 && !hasFinancialContent) {
      return true;
    }
    
    const titleLower = title.toLowerCase();
    if (titleLower.startsWith('here are') || 
        titleLower.startsWith('these are') || 
        titleLower.startsWith('what to') ||
        titleLower.includes('smart moves') ||
        titleLower.includes('takeaways')) {
      return true;
    }
    
    return false;
  }

  // Schedule a single source
  private scheduleSource(source: BreakingSource): void {
    const interval = this.getSourceInterval(source);
    
    const timer = setTimeout(async () => {
      try {
        const items = await this.fetchRSSFeed(source);
        if (items.length > 0) {
          await this.processRSSItems(items, source);
        }
      } catch (error) {
        console.error(`[breaking][process] Error processing ${source.name}:`, error);
      }
      
      // Reschedule for next interval
      this.scheduleSource(source);
    }, interval);
    
    this.timers.set(source.name, timer);
  }

  // Start the breaking scheduler
  public start(): void {
    if (this.isRunning) {
      console.log('[breaking][scheduler] Already running');
      return;
    }

    console.log('[breaking][scheduler] Starting breaking news scheduler');
    this.isRunning = true;

    // Schedule all sources
    for (const source of this.config.sources) {
      this.scheduleSource(source);
    }

    // Reload config every hour to pick up changes
    setInterval(() => {
      this.reloadConfig();
    }, 60 * 60 * 1000);
  }

  // Stop the breaking scheduler
  public stop(): void {
    console.log('[breaking][scheduler] Stopping breaking news scheduler');
    this.isRunning = false;

    // Clear all timers
    for (const [sourceName, timer] of this.timers) {
      clearTimeout(timer);
      console.log(`[breaking][scheduler] Stopped ${sourceName}`);
    }
    this.timers.clear();
  }

  // Reload configuration
  private reloadConfig(): void {
    console.log('[breaking][scheduler] Reloading configuration');
    this.config = this.loadBreakingConfig();
    this.eventWindows = this.loadEventWindowsConfig();
  }

  // Get current status
  public getStatus(): {
    isRunning: boolean;
    sources: Array<{
      name: string;
      interval_ms: number;
      nextPoll: number;
      inEventWindow: boolean;
    }>;
  } {
    const sources = this.config.sources.map(source => ({
      name: source.name,
      interval_ms: this.getSourceInterval(source),
      nextPoll: 0, // Would need to track next poll time
      inEventWindow: this.isInEventWindow(source.name)
    }));

    return {
      isRunning: this.isRunning,
      sources
    };
  }
}

// Export singleton instance
export const breakingScheduler = new BreakingScheduler();
