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
  private recentItemTimes: Map<string, number[]> = new Map();
  private configReloadInterval: NodeJS.Timeout | null = null;
  private activeFetches = 0;
  private activeBreakingFetches = 0;
  private activeDefaultFetches = 0;
  private maxConcurrent = parseInt(process.env.RSS_PARALLEL || '6', 10);
  private laneMaxBreaking = parseInt(process.env.LANE_TIER1_MAX || '10', 10);
  private laneMaxDefault = parseInt(process.env.LANE_DEFAULT_MAX || '6', 10);
  private instanceId: string = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  private lockInterval: NodeJS.Timeout | null = null;
  private hasLock: boolean = false;
  private demotedSources: Map<string, number> = new Map();
  private latencyAlertActive: boolean = false;
  private metricsMonitorInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.config = this.loadBreakingConfig();
    this.eventWindows = this.loadEventWindowsConfig();
    if (process.env.SOURCE_SET === 'crypto_v1') {
      console.log('[breaking][crypto_v1] Fast X accounts enabled (dry-run only unless AUDIT_MODE=1)');
    }

    // Attempt to restore persisted scheduler state
    this.restorePersistedState().catch(err => console.warn('[breaking][state] restore failed:', err?.message || err));

    // Log effective lane settings once
    console.log('[breaking][lanes]', {
      laneMaxBreaking: this.laneMaxBreaking,
      laneMaxDefault: this.laneMaxDefault,
      maxConcurrent: this.maxConcurrent,
      fastlane: process.env.FASTLANE_ENABLED === '1'
    });
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
      'Bloomberg Markets', 'Reuters Business', 'Financial Times', 'CNBC', 'AP Business',
      'PRNewswire', 'GlobeNewswire', 'SEC Filings', 'BLS Releases', 'BEA News', 'NASDAQ Trader News', 'NYSE Notices'
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
      // Interval overrides via env: RSS_MIN_INTERVAL_OVERRIDES="Name=15000,Other=30000"
      const tierDefaultMs = tier1.has(f.name) ? 30000 : 180000;
      const fromConfigSec = Number.isFinite(f?.min_interval_sec) ? Math.max(1000, Math.floor(f.min_interval_sec * 1000)) : undefined;
      let fromEnv = envOverrides.get(f.name);
      if (fromEnv === undefined) {
        for (const [key, val] of envOverrides.entries()) {
          if (String(f.name).toLowerCase().includes(key.toLowerCase())) { fromEnv = val; break; }
        }
      }
      let intervalMs = fromEnv ?? fromConfigSec ?? tierDefaultMs;
      // Canary clamp: for designated wire sources, clamp 15–30s
      const canary = ['prnewswire','globenewswire','business wire','nasdaq trader','nyse notices'];
      if (canary.some(k => String(f.name).toLowerCase().includes(k))) {
        intervalMs = Math.min(30000, Math.max(15000, intervalMs));
      }
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

    // Spike boost: if 2+ items in last 2 minutes, poll at 5–10s for next 5 minutes
    const times = this.recentItemTimes.get(source.name) || [];
    const twoMinAgo = now - (2 * 60 * 1000);
    const recent = times.filter(t => t >= twoMinAgo);
    if (recent.length >= 2) {
      interval = Math.min(interval, 10000);
    }

    // Jitter to avoid herd
    const jitterMs = Math.floor(Math.random() * 500);
    // Fastlane clamp for designated breaking sources
    const fastlane = process.env.FASTLANE_ENABLED === '1';
    if (fastlane && this.isBreakingSource(source.name)) {
      const clamped = Math.max(5000, Math.min(30000, interval));
      return Math.max(1000, clamped + jitterMs);
    }
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

    // Calculate backoff interval (treat 403 like 429/5xx)
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
    // Concurrency lanes: breaking vs default
    const inBreakingLane = this.isBreakingSource(source.name);
    if (inBreakingLane) {
      if (this.activeBreakingFetches >= this.laneMaxBreaking) {
        setTimeout(() => this.scheduleSource(source), 500);
        return [];
      }
      this.activeBreakingFetches++;
    } else {
      if (this.activeDefaultFetches >= this.laneMaxDefault) {
        setTimeout(() => this.scheduleSource(source), 500);
        return [];
      }
      this.activeDefaultFetches++;
    }
    const now = Date.now();
    this.lastFetchTimes.set(source.name, now);

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const tier1 = ['Bloomberg Markets','Reuters Business','AP Business','CNBC','Financial Times','PRNewswire','GlobeNewswire','SEC Filings','NASDAQ Trader News','NYSE Notices','Business Wire'];
      const isTier1 = tier1.includes(source.name) || inBreakingLane;
      const timeoutMs = isTier1 ? parseInt(process.env.TIER1_HTTP_TIMEOUT_MS || '3000', 10) : 8000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const ua = process.env[`UA_${source.name.replace(/\W+/g,'_').toUpperCase()}`] || process.env.RSS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
      const fetchStart = Date.now();
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': ua,
          'If-None-Match': this.etags.get(source.name) || '',
          'If-Modified-Since': this.lastModified.get(source.name) || ''
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Update ETag and Last-Modified
      const hdrs: any = (response as any).headers;
      try {
        const getFn = hdrs && typeof hdrs.get === 'function' ? hdrs.get.bind(hdrs) : null;
        const et = getFn ? getFn('etag') : (hdrs?.etag ?? null);
        const lm = getFn ? getFn('last-modified') : (hdrs?.['last-modified'] ?? hdrs?.lastModified ?? null);
        if (et) this.etags.set(source.name, et);
        if (lm) this.lastModified.set(source.name, lm);
        if (et || lm) await this.persistSourceState(source.name, { etag: et || undefined as any, lastModified: lm || undefined as any });
      } catch { /* ignore header parse issues in tests/mocks */ }

      // Reset backoff on success
      this.resetBackoff(source.name);
      this.lastOkTimes.set(source.name, now);

      if (response.status === 304) {
        log('info', `[304] ${source.name}: Not Modified`);
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
      } else if (error.message?.includes('HTTP 429') || error.message?.includes('HTTP 403')) {
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
      if (inBreakingLane) this.activeBreakingFetches = Math.max(0, this.activeBreakingFetches - 1);
      else this.activeDefaultFetches = Math.max(0, this.activeDefaultFetches - 1);
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
          published_at: pubDate,
          transport: 'adaptive',
          first_seen_at: new Date(this.lastFetchTimes.get(source.name) || Date.now()).toISOString()
        });

        if (result.success) {
          // Record activity for adaptive boost
          this.lastActiveTimes.set(source.name, Date.now());
          const arr = this.recentItemTimes.get(source.name) || [];
          arr.push(Date.now());
          // Keep last 100 timestamps per source
          this.recentItemTimes.set(source.name, arr.slice(-100));
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
    
    const nextPollAt = Date.now() + interval;
    this.persistSourceState(source.name, { nextPoll: nextPollAt }).catch(()=>{});
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
    const lockEnabled = (process.env.SCHEDULER_LEADER_LOCK || (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1';
    if (lockEnabled) {
      this.tryAcquireLock().then(acquired => {
        if (!acquired) {
          log('warn', 'Scheduler lock not acquired; not starting');
          return;
        }
        this._startInner();
      }).catch(err => log('error', `Scheduler lock error: ${err?.message || err}`));
    } else {
      this._startInner();
    }
  }

  private _startInner(): void {
    log('info', 'Starting breaking news scheduler');
    // Dry-run summary for Fastlane
    if (process.env.FASTLANE_ENABLED === '1' && process.env.FASTLANE_DRY_RUN === '1') {
      // Report running=true for health checks during dry-run while avoiding actual scheduling
      this.isRunning = true;
      for (const source of this.config.sources) {
        const interval = this.getSourceInterval(source);
        const lane = this.isBreakingSource(source.name) ? 'breaking' : 'default';
        const timeoutMs = (lane === 'breaking') ? parseInt(process.env.TIER1_HTTP_TIMEOUT_MS || '3000', 10) : (parseInt(process.env.SOURCE_REQUEST_TIMEOUT_MS || '8000', 10));
        console.log('[fastlane][dry-run]', { source: source.name, next_interval_ms: interval, timeout_ms: timeoutMs, uses_etag: !!this.etags.get(source.name) || !!this.lastModified.get(source.name), lane });
      }
      log('info', 'Fastlane dry-run summary printed; not scheduling fetches.');
      return;
    }
    this.isRunning = true;
    for (const source of this.config.sources) {
      this.scheduleSource(source);
    }
    if (this.configReloadInterval) { clearInterval(this.configReloadInterval); }
    this.configReloadInterval = setInterval(() => { this.reloadConfig(); }, 60 * 60 * 1000);
    const lockEnabled = (process.env.SCHEDULER_LEADER_LOCK || (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1';
    if (lockEnabled) {
      this.lockInterval = setInterval(() => this.renewLock().catch(()=>{}), 10000);
    }
    // Start periodic policy monitor (every minute)
    if (this.metricsMonitorInterval) clearInterval(this.metricsMonitorInterval);
    this.metricsMonitorInterval = setInterval(() => { this.monitorLatencyAndApplyPolicies().catch(()=>{}); }, 60000);
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
    if (this.lockInterval) { clearInterval(this.lockInterval); this.lockInterval = null; }
    if (this.metricsMonitorInterval) { clearInterval(this.metricsMonitorInterval); this.metricsMonitorInterval = null; }
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
      etag?: string | null;
      lastModified?: string | null;
    }>;
  } {
    const sources = this.config.sources.map(source => {
      const backoffState = this.backoffStates.get(source.name) || null;
      const lastFetchAt = this.lastFetchTimes.get(source.name);
      const lastOkAt = this.lastOkTimes.get(source.name);
      const etag = this.etags.get(source.name) || null;
      const lm = this.lastModified.get(source.name) || null;
      
      return {
        name: source.name,
        interval_ms: this.getSourceInterval(source),
        nextPoll: 0, // Would need to track next poll time
        inEventWindow: this.isInEventWindow(source.name),
        lastFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
        lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
        backoffState,
        etag,
        lastModified: lm
      };
    });

    return {
      isRunning: this.isRunning,
      sources
    };
  }

  // Telemetry helpers for /health
  public getMinMaxNextPollMs(): { min: number | null; max: number | null } {
    if (!this.isRunning || this.config.sources.length === 0) return { min: null, max: null };
    const intervals = this.config.sources.map(s => this.getSourceInterval(s));
    return { min: Math.min(...intervals), max: Math.max(...intervals) };
  }

  private isBreakingSource(name: string): boolean {
    const s = String(name).toLowerCase();
    // Auto-demotion: only when flag enabled, hide sources demoted in last 60 minutes
    if (process.env.BREAKING_AUTODEMOTE === '1') {
      const ts = this.demotedSources.get(name);
      if (typeof ts === 'number' && (Date.now() - ts) <= 60 * 60 * 1000) return false;
    }
    const candidates = [
      'prnewswire','globenewswire','business wire','sec filings','nasdaq trader news','nyse notices','cnbc','financial times','bloomberg','reuters','ap business'
    ];
    return candidates.some(k => s.includes(k));
  }

  // Mark a source as demoted (breaking=false) for the next 60 minutes
  public demoteSource(name: string): void {
    this.demotedSources.set(name, Date.now());
    console.log('[breaking][demote]', { source: name });
  }

  public getDemotedSources(): string[] {
    const now = Date.now();
    // Cleanup old entries and return active demotions
    const active: string[] = [];
    for (const [k, v] of this.demotedSources.entries()) {
      if ((now - v) <= 60 * 60 * 1000) active.push(k); else this.demotedSources.delete(k);
    }
    return active;
  }

  public setLatencyAlertActive(active: boolean): void {
    this.latencyAlertActive = active;
    if (active) console.log('[pulse][latency][alert]');
  }

  public isLatencyAlertActive(): boolean { return this.latencyAlertActive; }

  // Periodic metrics check for auto-demotion and pulse latency alerts
  private async monitorLatencyAndApplyPolicies(): Promise<void> {
    try {
      const doDemote = process.env.BREAKING_AUTODEMOTE === '1';
      const doPulseAlert = process.env.PULSE_LATENCY_ALERTS === '1';
      if (!doDemote && !doPulseAlert) return;
      const db = require('../lib/firestore').getDb();
      const sources = this.config.sources.map(s => s.name);
      const now = Date.now();
      const window30Ts = new Date(now - 30 * 60 * 1000).toISOString();
      const window10Ts = new Date(now - 10 * 60 * 1000).toISOString();
      let pulseAlertOn = false;
      for (const name of sources) {
        try {
          const snap30 = await db.collection('latency_metrics')
            .where('source', '==', name)
            .where('timestamp', '>=', window30Ts)
            .get();
          const publishTimes: number[] = [];
          let exposureTimes10: number[] = [];
          // also build a 10-min subset for pulse
          const snap10 = await db.collection('latency_metrics')
            .where('source', '==', name)
            .where('timestamp', '>=', window10Ts)
            .get();
          const collect = (snap: any, arr: number[], kind: 'pub'|'pulse') => {
            if (snap && Array.isArray(snap.docs)) {
              for (const d of snap.docs) {
                const data = d.data();
                if (kind === 'pub') {
                  const t = data.t_publish_ms; if (typeof t === 'number' && t >= 0) arr.push(t);
                } else {
                  const te = data.t_exposure_ms; if (typeof te === 'number' && te >= 0) arr.push(te);
                }
              }
            } else if (snap && typeof snap.forEach === 'function') {
              snap.forEach((d: any) => {
                const data = d.data();
                if (kind === 'pub') { const t = data.t_publish_ms; if (typeof t === 'number' && t >= 0) arr.push(t); }
                else { const te = data.t_exposure_ms; if (typeof te === 'number' && te >= 0) arr.push(te); }
              });
            }
          };
          collect(snap30, publishTimes, 'pub');
          collect(snap10, exposureTimes10, 'pulse');
          const p50 = (arr: number[]) => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : null;
          if (doDemote) {
            const p50pub = p50(publishTimes);
            if (p50pub != null && p50pub > 5 * 60 * 1000 && publishTimes.length >= 10) {
              this.demoteSource(name);
            }
          }
          if (doPulseAlert) {
            const p50pulse = p50(exposureTimes10);
            if (p50pulse != null && p50pulse > 120 * 1000) pulseAlertOn = true;
          }
        } catch {}
      }
      this.setLatencyAlertActive(!!pulseAlertOn);
    } catch (e) { /* best-effort */ }
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
    this.recentItemTimes.clear();
    log('info', 'Reset in-memory state');
  }

  // --- Persistence ---
  private async persistSourceState(sourceName: string, patch: Partial<{ etag: string; lastModified: string; backoff: BackoffState; nextPoll: number }>): Promise<void> {
    try {
      const db = require('../lib/firestore').getDb();
      const ref = db.collection('ingest_state').doc(sourceName);
      await ref.set({
        ...(patch.etag ? { etag: patch.etag } : {}),
        ...(patch.lastModified ? { lastModified: patch.lastModified } : {}),
        ...(patch.backoff ? { backoff_state: patch.backoff } : {}),
        ...(typeof patch.nextPoll === 'number' ? { next_poll_in_ms: Math.max(0, patch.nextPoll - Date.now()) } : {}),
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (_e) { /* ignore in tests */ }
  }

  private async restorePersistedState(): Promise<void> {
    try {
      const db = require('../lib/firestore').getDb();
      const col = await db.collection('ingest_state').get();
      if (col && Array.isArray(col.docs)) {
        for (const doc of col.docs) {
          const data = doc.data();
          const name = doc.id;
          if (data.etag) this.etags.set(name, data.etag);
          if (data.lastModified) this.lastModified.set(name, data.lastModified);
          if (data.backoff_state) this.backoffStates.set(name, data.backoff_state);
        }
      } else if (col && typeof col.forEach === 'function') {
        col.forEach((d: any) => {
          const data = d.data();
          const name = d.id;
          if (data.etag) this.etags.set(name, data.etag);
          if (data.lastModified) this.lastModified.set(name, data.lastModified);
          if (data.backoff_state) this.backoffStates.set(name, data.backoff_state);
        });
      }
      console.log('[breaking][state] restored', { etags: this.etags.size, lastModified: this.lastModified.size, backoffs: this.backoffStates.size });
    } catch (e) {
      console.warn('[breaking][state] restore failed', e);
    }
  }

  // Leader lock
  private async tryAcquireLock(): Promise<boolean> {
    try {
      const db = require('../lib/firestore').getDb();
      const ref = db.collection('admin').doc('scheduler_lock');
      const now = Date.now();
      const leaseMs = 30000;
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : null;
      if (!snap.exists || !data || !data.leaseExpiresAt || Date.parse(data.leaseExpiresAt) <= now) {
        await ref.set({ ownerId: this.instanceId, leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date().toISOString(), version: 'v1' }, { merge: true });
        this.hasLock = true;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  private async renewLock(): Promise<void> {
    if (!this.hasLock) return;
    try {
      const db = require('../lib/firestore').getDb();
      const ref = db.collection('admin').doc('scheduler_lock');
      const now = Date.now();
      const leaseMs = 30000;
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : null;
      if (!data || data.ownerId !== this.instanceId) {
        this.hasLock = false;
        this.stop();
        log('warn', 'Lost scheduler lock; stopped');
        return;
      }
      await ref.set({ ownerId: this.instanceId, leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date().toISOString(), version: 'v1' }, { merge: true });
    } catch (e) {
      // best-effort
    }
  }
}

// Export singleton instance
export const breakingScheduler = new BreakingScheduler();
