import { parseString } from 'xml2js';
import { promisify } from 'util';
import { publishStub, enrichItem } from './breakingIngest';
import { rssFeeds } from '../config/rssFeeds';
import { expansionFeeds } from '../config/expansionFeeds';
import * as fs from 'fs';
import * as path from 'path';

const parseXML = promisify(parseString);

// Environment getter functions
const getBreakingLogLevel = () => process.env.BREAKING_LOG_LEVEL || 'info';

// Logging utilities
const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = logLevels[getBreakingLogLevel() as keyof typeof logLevels] ?? 1;

const log = (level: keyof typeof logLevels, message: string, ...args: any[]) => {
  if (logLevels[level] >= currentLogLevel) {
    console.log(`[breaking][${level}] ${message}`, ...args);
  }
};

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

// Backoff tracking per source
interface BackoffState {
  currentInterval: number;
  baseInterval: number;
  attempt: number;
  maxAttempts: number;
  lastError: string;
  lastErrorTime: number;
}

class BreakingScheduler {
  private config: BreakingConfig;
  private eventWindows: EventWindowsConfig;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private etags: Map<string, string> = new Map();
  private lastModified: Map<string, string> = new Map();
  private isRunning = false;
  private backoffStates: Map<string, BackoffState> = new Map();
  private lastFetchTimes: Map<string, number> = new Map();
  private lastOkTimes: Map<string, number> = new Map();
  private lastActiveTimes: Map<string, number> = new Map();
  private configReloadInterval: NodeJS.Timeout | null = null;
  private activeFetches = 0;
  private maxConcurrent = parseInt(process.env.RSS_PARALLEL || '6', 10);

  constructor() {
    this.config = this.loadBreakingConfig();
    this.eventWindows = this.loadEventWindowsConfig();
    if (process.env.SOURCE_SET === 'crypto_v1') {
      console.log('[breaking][crypto_v1] Fast X accounts enabled (dry-run only unless AUDIT_MODE=1)');
    }
  }

  private loadBreakingConfig(): BreakingConfig {
    try {
      const configPath = path.join(__dirname, '../config/breaking-sources.json');
      if (!fs.existsSync(configPath)) {
        log('warn', 'Breaking sources config file not found, building defaults from rssFeeds');
        return this.buildDefaultConfigFromRssFeeds();
      }
      const configData = fs.readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(configData) as BreakingConfig;
      if (!cfg.sources || cfg.sources.length === 0) {
        log('warn', 'Breaking sources config is empty, building defaults from rssFeeds');
        return this.buildDefaultConfigFromRssFeeds();
      }
      return cfg;
    } catch (error) {
      log('warn', 'Failed to load breaking sources config, building defaults from rssFeeds:', error);
      return this.buildDefaultConfigFromRssFeeds();
    }
  }

  // Build a default adaptive config from rssFeeds when RSS_ADAPTIVE=1 and no JSON config is present
  private buildDefaultConfigFromRssFeeds(): BreakingConfig {
    // Tiering by name
    const tier1 = new Set<string>([
      'Bloomberg Markets', 'Reuters Business', 'Financial Times', 'CNBC', 'AP Business'
    ]);
    // Optional per-source overrides from env: "Name=30000,Other=60000"
    const rawOverrides = process.env.RSS_MIN_INTERVAL_OVERRIDES || '';
    const envOverrides = new Map<string, number>();
    rawOverrides.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const [k, v] = pair.split('=').map(x => x.trim());
      const ms = parseInt(v || '', 10);
      if (k && Number.isFinite(ms)) envOverrides.set(k, ms);
    });

    const allFeeds: Array<{ name: string; url: string; min_interval_sec?: number }> =
      (process.env.INGEST_EXPANSION === '1') ? [...rssFeeds, ...expansionFeeds as any] : [...rssFeeds];

    const sources: BreakingSource[] = allFeeds.map((f: any) => {
      const tierDefaultMs = tier1.has(f.name) ? 60000 : 180000;
      const fromConfigSec = Number.isFinite(f?.min_interval_sec) ? Math.max(1000, Math.floor(f.min_interval_sec * 1000)) : undefined;
      let fromEnv = envOverrides.get(f.name);
      if (fromEnv === undefined) {
        for (const [key, val] of envOverrides.entries()) {
          if (String(f.name).toLowerCase().includes(key.toLowerCase())) { fromEnv = val; break; }
        }
      }
      const intervalMs = fromEnv ?? fromConfigSec ?? tierDefaultMs;
      return {
        name: f.name,
        url: f.url,
        interval_ms: intervalMs,
        mode: 'breaking',
        event_window: false
      };
    });
    return {
      sources,
      default_interval_ms: 180000,
      watchlist_interval_ms: 60000,
      event_window_interval_ms: 5000
    };
  }

  private loadEventWindowsConfig(): EventWindowsConfig {
    try {
      const configPath = path.join(__dirname, '../config/event-windows.json');
      if (!fs.existsSync(configPath)) {
        log('warn', 'Event windows config file not found, using default empty config');
        return { events: [] };
      }
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      log('warn', 'Failed to load event windows config, using default empty config:', error);
      return { events: [] };
    }
  }

  // Check if we're currently in an event window
  private isInEventWindow(sourceName: string): boolean {
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    
    for (const event of this.eventWindows.events) {
      if (event.relevant_sources.includes(sourceName) && event.days.includes(dayOfWeek)) {
        const startTime = new Date(event.start_time);
        const endTime = new Date(event.end_time);
        
        if (now >= startTime && now <= endTime) {
          return true;
        }
      }
    }
    
    return false;
  }

  // Get the appropriate interval for a source
  private getSourceInterval(source: BreakingSource): number {
    const now = Date.now();
    let interval = source.interval_ms || this.config.default_interval_ms;

    // Activity-based boost: if produced >=1 item in last 10 min, poll at 30s for next 5 min
    const lastActive = this.lastActiveTimes.get(source.name) || 0;
    if (lastActive && (now - lastActive) <= (10 * 60 * 1000)) {
      interval = Math.min(interval, 30000);
    }

    // Event window override
    if (this.isInEventWindow(source.name)) {
      interval = Math.min(interval, this.config.event_window_interval_ms);
    }

    // Watchlist mode baseline
    if (source.mode === 'watchlist') {
      interval = Math.min(interval, this.config.watchlist_interval_ms);
    }

    // Jitter to avoid herd
    const jitterMs = Math.floor(Math.random() * 500);
    return Math.max(1000, interval + jitterMs);
  }

  // Apply exponential backoff
  private applyBackoff(sourceName: string, error: string): number {
    const now = Date.now();
    const backoffState = this.backoffStates.get(sourceName) || {
      currentInterval: this.config.default_interval_ms,
      baseInterval: this.config.default_interval_ms,
      attempt: 0,
      maxAttempts: 6,
      lastError: '',
      lastErrorTime: 0
    };

    // Check if this is a new error or if we should continue backoff
    const isNewError = error !== backoffState.lastError || (now - backoffState.lastErrorTime) > 300000; // 5 minutes
    
    if (isNewError) {
      backoffState.attempt = 1;
      backoffState.lastError = error;
      backoffState.lastErrorTime = now;
    } else {
      backoffState.attempt++;
    }

    // Calculate backoff interval
    let backoffInterval = backoffState.baseInterval;
    if (backoffState.attempt > 1) {
      backoffInterval = Math.min(
        backoffState.baseInterval * Math.pow(2, backoffState.attempt - 1),
        300000 // Cap at 5 minutes
      );
    }

    backoffState.currentInterval = backoffInterval;
    this.backoffStates.set(sourceName, backoffState);

    if (backoffState.attempt <= backoffState.maxAttempts) {
      log('warn', `${sourceName}: ${error}, backoff=${Math.round(backoffInterval/1000)}s (attempt ${backoffState.attempt}/${backoffState.maxAttempts})`);
    } else {
      log('error', `${sourceName}: Max backoff attempts reached, using base interval`);
      backoffState.currentInterval = backoffState.baseInterval;
    }

    return backoffState.currentInterval;
  }

  // Reset backoff on successful fetch
  private resetBackoff(sourceName: string): void {
    const backoffState = this.backoffStates.get(sourceName);
    if (backoffState) {
      backoffState.attempt = 0;
      backoffState.currentInterval = backoffState.baseInterval;
      backoffState.lastError = '';
      this.backoffStates.set(sourceName, backoffState);
    }
  }

  // Fetch RSS feed with error handling and backoff
  private async fetchRSSFeed(source: BreakingSource): Promise<any[]> {
    // Simple concurrency guard
    if (this.activeFetches >= this.maxConcurrent) {
      setTimeout(() => this.scheduleSource(source), 500);
      return [];
    }
    this.activeFetches++;
    const now = Date.now();
    this.lastFetchTimes.set(source.name, now);

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'Pulse-Breaking/1.0',
          'If-None-Match': this.etags.get(source.name) || '',
          'If-Modified-Since': this.lastModified.get(source.name) || ''
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Update ETag and Last-Modified
      if (response.headers.get('etag')) {
        this.etags.set(source.name, response.headers.get('etag')!);
      }
      if (response.headers.get('last-modified')) {
        this.lastModified.set(source.name, response.headers.get('last-modified')!);
      }

      // Reset backoff on success
      this.resetBackoff(source.name);
      this.lastOkTimes.set(source.name, now);

      if (response.status === 304) {
        log('debug', `${source.name}: No new content`);
        return [];
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      const feed = await parseXML(responseText) as RSSFeed;
      const items = feed.rss?.channel?.[0]?.item || [];
      
      log('debug', `${source.name}: Fetched ${items.length} items`);
      return items;

    } catch (error: any) {
      let errorMessage = 'Unknown error';
      let shouldBackoff = false;

      if (error.name === 'AbortError') {
        errorMessage = 'Request timeout';
        shouldBackoff = true;
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'DNS ENOTFOUND';
        shouldBackoff = true;
      } else if (error.code === 'ECONNRESET') {
        errorMessage = 'Connection reset';
        shouldBackoff = true;
      } else if (error.message?.includes('HTTP 5')) {
        errorMessage = error.message;
        shouldBackoff = true;
      } else if (error.message?.includes('HTTP 429')) {
        errorMessage = 'Rate limited (429)';
        shouldBackoff = true;
      } else {
        errorMessage = error.message || 'Network error';
      }

      if (shouldBackoff) {
        const backoffInterval = this.applyBackoff(source.name, errorMessage);
        // Schedule next attempt with backoff
        setTimeout(() => {
          this.scheduleSource(source);
        }, backoffInterval);
        return [];
      } else {
        log('error', `${source.name}: ${errorMessage}`);
        return [];
      }
    }
    finally {
      this.activeFetches = Math.max(0, this.activeFetches - 1);
    }
  }

  // Process RSS items
  private async processRSSItems(items: any[], source: BreakingSource): Promise<void> {
    for (const item of items) {
      try {
        const title = item.title?.[0];
        const link = item.link?.[0];
        const pubDate = item.pubDate?.[0];

        if (!title || !link) {
          continue;
        }

        // Skip certain types of content
        if (this.shouldSkipContent(title)) {
          continue;
        }

        // Publish stub immediately
        const result = await publishStub({
          title,
          source: source.name,
          url: link,
          published_at: pubDate
        });

        if (result.success) {
          // Record activity for adaptive boost
          this.lastActiveTimes.set(source.name, Date.now());
          // Schedule enrichment
          setTimeout(async () => {
            await enrichItem(result.id);
          }, 2000);
        }

      } catch (error) {
        console.error(`[breaking][error] Error processing item from ${source.name}:`, error);
      }
    }
  }

  // Check if content should be skipped
  private shouldSkipContent(title: string): boolean {
    const titleLower = title.toLowerCase();
    
    // Skip listicles and similar content (relaxed: keep more items)
    if (titleLower.startsWith('here are') || 
        titleLower.startsWith('these are') || 
        titleLower.startsWith('what to') ||
        titleLower.includes('smart moves')) {
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
        console.error(`[breaking][error] Error processing ${source.name}:`, error);
      }
      
      // Reschedule for next interval
      this.scheduleSource(source);
    }, interval);
    
    this.timers.set(source.name, timer);
  }

  // Start the breaking scheduler
  public start(): void {
    if (this.isRunning) {
      log('info', 'Already running');
      return;
    }

    log('info', 'Starting breaking news scheduler');
    this.isRunning = true;

    // Schedule all sources
    for (const source of this.config.sources) {
      this.scheduleSource(source);
    }

    // Reload config every hour to pick up changes
    if (this.configReloadInterval) {
      clearInterval(this.configReloadInterval);
    }
    this.configReloadInterval = setInterval(() => {
      this.reloadConfig();
    }, 60 * 60 * 1000);
  }

  // Stop the breaking scheduler
  public stop(): void {
    log('info', 'Stopping breaking news scheduler');
    this.isRunning = false;

    // Clear all timers
    for (const [sourceName, timer] of this.timers) {
      clearTimeout(timer);
      log('info', `Stopped ${sourceName}`);
    }
    this.timers.clear();

    // Clear config reload interval
    if (this.configReloadInterval) {
      clearInterval(this.configReloadInterval);
      this.configReloadInterval = null;
      log('info', 'Cleared config reload interval');
    }
  }

  // Reload configuration
  private reloadConfig(): void {
    log('info', 'Reloading configuration');
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
      lastFetchAt: string | null;
      lastOkAt: string | null;
      backoffState: BackoffState | null;
    }>;
  } {
    const sources = this.config.sources.map(source => {
      const backoffState = this.backoffStates.get(source.name) || null;
      const lastFetchAt = this.lastFetchTimes.get(source.name);
      const lastOkAt = this.lastOkTimes.get(source.name);
      
      return {
        name: source.name,
        interval_ms: this.getSourceInterval(source),
        nextPoll: 0, // Would need to track next poll time
        inEventWindow: this.isInEventWindow(source.name),
        lastFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
        lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
        backoffState
      };
    });

    return {
      isRunning: this.isRunning,
      sources
    };
  }

  // Force immediate fetch for specific sources
  public async forceFetch(sources: string[]): Promise<{ scheduled: string[]; skipped: string[]; reason: string }> {
    const scheduled: string[] = [];
    const skipped: string[] = [];
    
    for (const sourceName of sources) {
      const source = this.config.sources.find(s => s.name === sourceName);
      if (source) {
        scheduled.push(sourceName);
        // Clear any existing timer for this source
        const existingTimer = this.timers.get(sourceName);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        // Force immediate fetch
        this.scheduleSource(source);
      } else {
        skipped.push(sourceName);
      }
    }
    
    return {
      scheduled,
      skipped,
      reason: skipped.length > 0 ? 'Unknown sources' : 'All sources scheduled'
    };
  }

  // Reset in-memory state
  public resetState(): void {
    this.etags.clear();
    this.lastModified.clear();
    this.backoffStates.clear();
    this.lastFetchTimes.clear();
    this.lastOkTimes.clear();
    log('info', 'Reset in-memory state');
  }
}

// Export singleton instance
export const breakingScheduler = new BreakingScheduler();
