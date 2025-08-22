import { parseString } from 'xml2js';
import { promisify } from 'util';
import { publishStub, enrichItem } from './breakingIngest';
import { recordHttpDateSkew } from '../ops/driftMonitor';
import { getDb } from '../lib/firestore';
import { rssFeeds } from '../config/rssFeeds';
import { expansionFeeds } from '../config/expansionFeeds';
import * as fs from 'fs';
import * as path from 'path';
import { probes } from '../ops/probes';
import { isOriginDomain } from './originsRegistry';

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
  enabled?: boolean;
  fastlane?: boolean;
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

// Demotion state with hysteresis/cool-down
type DemoteInfo = {
  until: number;              // cool-down end (epoch ms). > now => actively demoted
  consecutive: number;        // consecutive demotions for penalty
  last_demoted_at: number;    // epoch ms
  last_promoted_at?: number;  // epoch ms
};

class BreakingScheduler {
  private config: BreakingConfig;
  private eventWindows: EventWindowsConfig;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private etags: Map<string, string> = new Map();
  private lastModified: Map<string, string> = new Map();
  private isRunning = false;
  private backoffStates: Map<string, BackoffState> = new Map();
  private overrideIntervals: Map<string, number> = new Map();
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
  private hostActive: Map<string, number> = new Map();
  private hostLimit = parseInt(process.env.LANE_PER_HOST_MAX || '4', 10);
  // Per-host token buckets per lane (origins, fastlane, default) — guarded by flags
  private hostTokens: Map<string, { origins: number; fastlane: number; def: number; lastRefill: number }> = new Map();
  private instanceId: string = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  private lockInterval: NodeJS.Timeout | null = null;
  private hasLock: boolean = false;
  private demotedSources: Map<string, number> = new Map();
  private demoted: Map<string, DemoteInfo> = new Map();
  private latencyAlertActive: boolean = false;
  private metricsMonitorInterval: NodeJS.Timeout | null = null;
  private demoteWindowMin = parseInt(process.env.DEMOTE_WINDOW_MIN || process.env.BREAKING_DEMOTE_WINDOW_MIN || '30', 10);
  private demoteThresholdMs = parseInt(process.env.DEMOTE_THRESHOLD_MS || process.env.BREAKING_DEMOTE_P50_MS || '60000', 10);
  private demoteTtlMs = parseInt(process.env.BREAKING_DEMOTE_TTL_MS || '3600000', 10); // legacy TTL (fallback)
  private promoteThresholdMs = parseInt(process.env.PROMOTE_THRESHOLD_MS || '45000', 10);
  private promoteMaxP90Ms = process.env.PROMOTE_MAX_P90_MS ? parseInt(process.env.PROMOTE_MAX_P90_MS, 10) : undefined;
  private promoteMinSamples = parseInt(process.env.PROMOTE_MIN_SAMPLES || '10', 10);
  private demoteMinCooldownMs = parseInt(process.env.DEMOTE_MIN_COOLDOWN_MS || '1800000', 10); // 30m default
  private demotePenaltyFactor = parseFloat(process.env.DEMOTE_PENALTY_FACTOR || '1.5');
  private demoteMaxCooldownMs = parseInt(process.env.DEMOTE_MAX_COOLDOWN_MS || '10800000', 10); // 3h
  // Burst state: when a source yields a new item, accelerate polling for a short window
  private burstUntil: Map<string, number> = new Map();
  // Stable per-source splay to avoid herd effects
  private splayMs: Map<string, number> = new Map();
  private burstWindowMs = parseInt(process.env.BURST_WINDOW_MS || '60000', 10);
  private burstMinIntervalMs = parseInt(process.env.BURST_MIN_INTERVAL_MS || '2000', 10);
  private splayMaxMs = parseInt(process.env.SPLAY_MAX_MS || '700', 10);
  // Heartbeat fields
  private lastTickAt: number | null = null;
  private nextPollAt: Map<string, number> = new Map();

  private async writeIngestStatus(kind: 'tick'|'run'): Promise<void> {
    if (process.env.INGEST_STATUS_WRITER !== '1') return;
    try {
      const db = getDb();
      const ref = db.collection('system').doc('ingest_status');
      const now = Date.now();
      const payload: any = { last_scheduler_tick: new Date(now).toISOString() };
      if (kind === 'run') payload.last_breaking_run = new Date(now).toISOString();
      await ref.set(payload, { merge: true });
    } catch (e: any) {
      console.error('[ingest_status] write failed:', e?.message || e);
    }
  }

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

    // Periodic cleanup of expired burst windows
    try {
      const t = setInterval(() => {
        const now = Date.now();
        for (const [k, until] of this.burstUntil) {
          if (until <= now) this.burstUntil.delete(k);
        }
      }, 30000);
      (t as any).unref?.();
    } catch {}
  }

  // Stable splay per source, computed from sha1(name)
  private getSplayFor(sourceName: string): number {
    if (!this.splayMs.has(sourceName)) {
      try {
        const crypto = require('crypto');
        const h: Buffer = crypto.createHash('sha1').update(String(sourceName)).digest();
        const n = h.readUInt16BE(0) % (this.splayMaxMs + 1);
        this.splayMs.set(sourceName, n);
      } catch {
        this.splayMs.set(sourceName, Math.floor(Math.random() * (this.splayMaxMs + 1)));
      }
    }
    return this.splayMs.get(sourceName)!;
  }

  // External signal from ingest: source produced >=1 new items
  public onSourceHit(sourceName: string, count: number): void {
    if (count > 0) {
      const until = Date.now() + this.burstWindowMs;
      this.burstUntil.set(sourceName, until);
      if (process.env.DEBUG_BURST === '1') {
        console.log('[burst][start]', { source: sourceName, until });
      }
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
        event_window: false,
        enabled: (f.enabled !== false),
        fastlane: (typeof f.fastlane === 'boolean' ? f.fastlane : undefined)
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

    // Controller override (never worse than computed best)
    const ov = this.overrideIntervals.get(source.name);
    if (typeof ov === 'number' && ov > 0) {
      interval = Math.min(interval, ov);
    }
    // Jitter to avoid herd
    const jitterMs = Math.floor(Math.random() * 500);
    // Fastlane v2 clamps (Origins and Fastlane lanes), fully flag-guarded
    const fastlane = process.env.FASTLANE_ENABLED === '1';
    const origins = process.env.ORIGINS_ENABLED === '1';
    const inBurst = (this.burstUntil.get(source.name) || 0) > now;

    const pickInRange = (raw: string | undefined, fallbackMin: number, fallbackMax: number) => {
      try {
        if (!raw) return Math.floor(Math.random() * (fallbackMax - fallbackMin + 1)) + fallbackMin;
        const [a,b] = String(raw).split('-').map(s=>parseInt(s.trim(),10));
        const lo = Number.isFinite(a) ? a : fallbackMin; const hi = Number.isFinite(b) ? b : (Number.isFinite(a)?a:fallbackMax);
        const minV = Math.min(lo, hi), maxV = Math.max(lo, hi);
        return Math.floor(Math.random() * (maxV - minV + 1)) + minV;
      } catch { return Math.floor(Math.random() * (fallbackMax - fallbackMin + 1)) + fallbackMin; }
    };

    // Hot windows (simple: use per-lane time ranges in local tz string; leave exact windowing for future improvement)
    const useHot = true; // placeholder: flag-driven windows are future work; clamp ranges already provide spread

    // Determine host classification
    const host = (() => { try { return new URL(source.url).host; } catch { return ''; } })();
    const isOrigin = origins && isOriginDomain(host);
    if (origins && isOrigin) {
      // Origins lane clamps
      const active = pickInRange(process.env.ORIGINS_CLAMP_ACTIVE_MS, 500, 1500);
      const idle = pickInRange(process.env.ORIGINS_CLAMP_IDLE_MS, 1500, 3000);
      let clamped = useHot ? active : idle;
      if (inBurst) clamped = Math.min(clamped, this.burstMinIntervalMs);
      interval = Math.min(interval, clamped);
    } else if (fastlane && this.isBreakingSource(source.name)) {
      // Fastlane Tier-1 clamps
      const active = pickInRange(process.env.FASTLANE_CLAMP_ACTIVE_MS, 1000, 2000);
      const idle = pickInRange(process.env.FASTLANE_CLAMP_IDLE_MS, 2000, 5000);
      let clamped = useHot ? active : idle;
      if (inBurst) clamped = Math.min(clamped, this.burstMinIntervalMs);
      interval = Math.min(interval, clamped);
    } else {
      // Regular/Longtail ranges (best-effort)
      const reg = pickInRange(process.env.REGULAR_CLAMP_MS, 20000, 30000);
      const lt = pickInRange(process.env.LONGTAIL_CLAMP_MS, 90000, 180000);
      // prefer existing interval, otherwise favor regular window
      interval = Math.min(interval, Math.max(reg, 1000));
      // longtail round-robin window honored elsewhere via schedule fairness
    }
    // Add stable per-source splay
    interval += this.getSplayFor(source.name);
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

  // --- Per-host lane helpers ---
  private canRunForHost(host: string): boolean {
    const cur = this.hostActive.get(host) || 0;
    return cur < this.hostLimit;
  }
  private incHost(host: string): void {
    this.hostActive.set(host, (this.hostActive.get(host) || 0) + 1);
  }
  private decHost(host: string): void {
    const v = (this.hostActive.get(host) || 1) - 1;
    this.hostActive.set(host, Math.max(0, v));
  }

  // Token bucket (per host per lane). Rates controlled via *_PER_HOST_RPS flags.
  private takeToken(host: string, lane: 'origins'|'fastlane'|'def'): boolean {
    const now = Date.now();
    let rec = this.hostTokens.get(host);
    if (!rec) { rec = { origins: 0, fastlane: 0, def: 0, lastRefill: now }; this.hostTokens.set(host, rec); }
    const dt = Math.max(0, now - rec.lastRefill);
    // refill based on RPS per lane
    const originsRps = Math.max(1, parseInt(process.env.ORIGINS_PER_HOST_RPS || '3', 10));
    const fastRps = Math.max(1, parseInt(process.env.FASTLANE_PER_HOST_RPS || '3', 10));
    const defRps = Math.max(1, parseInt(process.env.DEFAULT_PER_HOST_RPS || '2', 10));
    const addOrigins = Math.floor((dt / 1000) * originsRps);
    const addFast = Math.floor((dt / 1000) * fastRps);
    const addDef = Math.floor((dt / 1000) * defRps);
    // caps to small burst size=RPS
    rec.origins = Math.min(originsRps, rec.origins + addOrigins);
    rec.fastlane = Math.min(fastRps, rec.fastlane + addFast);
    rec.def = Math.min(defRps, rec.def + addDef);
    rec.lastRefill = now;
    if (lane === 'origins') { if (rec.origins > 0) { rec.origins--; return true; } return false; }
    if (lane === 'fastlane') { if (rec.fastlane > 0) { rec.fastlane--; return true; } return false; }
    if (rec.def > 0) { rec.def--; return true; }
    return false;
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
      // Per-host admission control to avoid one host starving others
      const host = (() => { try { return new URL(source.url).host; } catch { return 'unknown'; } })();
      if (!this.canRunForHost(host)) {
        // Requeue soon to avoid busy loop
        setTimeout(() => this.scheduleSource(source), 250);
        return [];
      }
      this.incHost(host);
      // Lane token bucket per host (guarded by flags; no-op when flags off)
      const originsEnabled = process.env.ORIGINS_ENABLED === '1';
      const fastlaneEnabled = process.env.FASTLANE_ENABLED === '1';
      const isTier1 = this.isBreakingSource(source.name);
      const lane: 'origins'|'fastlane'|'def' = (originsEnabled && isOriginDomain(host)) ? 'origins' : (fastlaneEnabled && isTier1 ? 'fastlane' : 'def');
      if (!this.takeToken(host, lane)) {
        // No tokens available → slight backoff and reschedule
        setTimeout(() => this.scheduleSource(source), 200);
        return [];
      }
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
          'If-None-Match': (process.env.HTTP_CONDITIONAL_GET === '1') ? (this.etags.get(source.name) || '') : '',
          'If-Modified-Since': (process.env.HTTP_CONDITIONAL_GET === '1') ? (this.lastModified.get(source.name) || '') : ''
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
        const dateHdr = getFn ? getFn('date') : (hdrs?.date ?? null);
        if (et) this.etags.set(source.name, et);
        if (lm) this.lastModified.set(source.name, lm);
        if (et || lm) await this.persistSourceState(source.name, { etag: et || undefined as any, lastModified: lm || undefined as any });
        try { const { recordHttpDateSkew } = require('../ops/driftMonitor'); const host = new URL(source.url).host; recordHttpDateSkew(host, dateHdr || null); } catch {}
      } catch { /* ignore header parse issues in tests/mocks */ }

      // Reset backoff on success
      this.resetBackoff(source.name);
      this.lastOkTimes.set(source.name, now);

      if (response.status === 304) {
        try { const host = new URL(source.url).host; probes.recordHttpStatus(host, 304); } catch {}
        log('info', `[304] ${source.name}: Not Modified`);
        return [];
      }

      if (!response.ok) {
        try { const host = new URL(source.url).host; probes.recordHttpStatus(host, Number(response.status) || 0); } catch {}
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
      // Per-host counter decrement
      try { const h = new URL(source.url).host; this.decHost(h); } catch { this.decHost('unknown'); }
      if (inBreakingLane) this.activeBreakingFetches = Math.max(0, this.activeBreakingFetches - 1);
      else this.activeDefaultFetches = Math.max(0, this.activeDefaultFetches - 1);
    }
  }

  // Process RSS items
  private async processRSSItems(items: any[], source: BreakingSource): Promise<void> {
    let newCount = 0;
    for (const item of items) {
      try {
        const title = item.title?.[0];
        const link = item.link?.[0];
        const pubDate = item.pubDate?.[0];
        // Freshness gate (MAX_AGE_FOR_BREAKING_MS), guarded by env
        const maxAgeMs = parseInt(process.env.MAX_AGE_FOR_BREAKING_MS || '0', 10);
        if (maxAgeMs > 0 && pubDate) {
          const ts = Date.parse(pubDate);
          if (Number.isFinite(ts) && (Date.now() - ts) > maxAgeMs) {
            continue; // skip stale
          }
        }
        // Minimal publish_at shim (env-gated) to improve timestamp coverage
        const useShim = String(process.env.PUBLISH_AT_SHIM || '0') === '1';
        const pubShim = useShim ? (
          (item.pubDate && item.pubDate[0]) ||
          (item.isoDate && item.isoDate[0]) ||
          (item.published && item.published[0]) ||
          (item.updated && item.updated[0]) ||
          null
        ) : pubDate;

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
          published_at: pubShim,
          transport: 'adaptive',
          first_seen_at: new Date(this.lastFetchTimes.get(source.name) || Date.now()).toISOString()
        });

        if (result.success) {
          newCount++;
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
    if (newCount > 0) {
      this.onSourceHit(source.name, newCount);
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
    this.nextPollAt.set(source.name, nextPollAt);
    this.persistSourceState(source.name, { nextPoll: nextPollAt }).catch(()=>{});
    const timer = setTimeout(async () => {
      this.lastTickAt = Date.now();
      this.writeIngestStatus('tick').catch(()=>{});
      try {
        const items = await this.fetchRSSFeed(source);
        if (items.length > 0) {
          await this.processRSSItems(items, source);
          this.writeIngestStatus('run').catch(()=>{});
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
    try { require('../ops/ready').setReady('scheduler', true); } catch {}
    for (const source of this.config.sources) {
      if (source.enabled === false) { continue; }
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
    this.nextPollAt.clear();
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
      enabled?: boolean;
      fastlane?: boolean;
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
        lastModified: lm,
        enabled: (source.enabled !== false),
        fastlane: (source.fastlane !== false)
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
    // Admin kill-switch
    if ((this as any)._admin_breaking_override === false) return false;
    const s = String(name).toLowerCase();
    try {
      const cfg = this.config.sources.find(src => String(src.name).toLowerCase() === s);
      if (cfg && cfg.fastlane === false) return false;
      if (cfg && cfg.enabled === false) return false;
    } catch {}
    // Auto-demotion: only when flag enabled, hide sources demoted in last 60 minutes
    if (process.env.BREAKING_AUTODEMOTE === '1') {
      // New hysteresis-based demotion takes precedence
      const info = this.demoted.get(name);
      if (info && typeof info.until === 'number' && info.until > Date.now()) return false;
      // Legacy TTL demotion fallback
      const ts = this.demotedSources.get(name);
      if (typeof ts === 'number' && (Date.now() - ts) <= this.demoteTtlMs) return false;
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
    const out = new Set<string>();
    // Legacy demotes with TTL
    for (const [k, v] of this.demotedSources.entries()) {
      if ((now - v) <= this.demoteTtlMs) out.add(k); else this.demotedSources.delete(k);
    }
    // New hysteresis-based demotes
    for (const [k, info] of this.demoted.entries()) {
      if (typeof info?.until === 'number' && info.until > now) out.add(k);
    }
    return Array.from(out);
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
      const db = getDb();
      const sources = this.config.sources.map(s => s.name);
      const now = Date.now();
      const windowTs = new Date(now - this.demoteWindowMin * 60 * 1000).toISOString();
      const window10Ts = new Date(now - 10 * 60 * 1000).toISOString();
      let pulseAlertOn = false;
      for (const name of sources) {
        try {
          const snap30 = await db.collection('latency_metrics')
            .where('source', '==', name)
            .where('timestamp', '>=', windowTs)
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
            const p90pub = (() => { const arr = publishTimes.slice().sort((a,b)=>a-b); return arr.length ? arr[Math.floor(arr.length*0.9)] : null; })();
            const count = publishTimes.length;
            const info = this.demoted.get(name);
            // Evaluate demotion
            if (p50pub != null && count >= 1 && p50pub > this.demoteThresholdMs) {
              const consecutive = (info?.consecutive || 0) + 1;
              const base = this.demoteMinCooldownMs;
              const factor = isFinite(this.demotePenaltyFactor) ? this.demotePenaltyFactor : 1.5;
              const penalty = Math.pow(factor, consecutive - 1);
              const cooldown = Math.min(this.demoteMaxCooldownMs, Math.floor(base * penalty));
              const until = now + cooldown;
              this.demoted.set(name, { until, consecutive, last_demoted_at: now, last_promoted_at: info?.last_promoted_at });
              if (process.env.DEBUG_DEMOTE === '1') {
                console.log('[demote][apply]', { source: name, p50: p50pub, p90: p90pub, samples: count, until, cooldown_ms: cooldown, consecutive });
              }
            } else if (info && info.until <= now) {
              // Consider promotion if currently demoted and cooldown elapsed
              const eligibleBySamples = count >= this.promoteMinSamples;
              const eligibleByP50 = (p50pub != null) && p50pub <= this.promoteThresholdMs;
              const eligibleByP90 = (this.promoteMaxP90Ms == null) || ((p90pub != null) && p90pub <= this.promoteMaxP90Ms);
              if (eligibleBySamples && eligibleByP50 && eligibleByP90) {
                // Promote (re-entry)
                this.demoted.delete(name);
                this.demotedSources.delete(name); // also clear legacy if present
                if (process.env.DEBUG_DEMOTE === '1') {
                  console.log('[demote][promote]', { source: name, p50: p50pub, p90: p90pub, samples: count });
                }
              } else {
                // Keep demoted, possibly extend last_demoted_at but not until
                // No-op, entry remains until future evaluation passes
              }
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
    this.nextPollAt.clear();
    log('info', 'Reset in-memory state');
  }

  // --- Heartbeat & admin ---
  public getHeartbeat(): { lastTickAt: string | null; nextPollInSec: number | null; activeSources: number | null } {
    const now = Date.now();
    let nextMs: number | null = null;
    for (const v of this.nextPollAt.values()) {
      const rem = Math.max(0, v - now);
      nextMs = nextMs == null ? rem : Math.min(nextMs, rem);
    }
    return {
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      nextPollInSec: nextMs != null ? Math.round(nextMs / 1000) : null,
      activeSources: this.config?.sources?.length ?? null
    };
  }

  public async runOnce(): Promise<{ fetched: number; scheduled: number }> {
    let fetched = 0;
    let scheduled = 0;
    this.lastTickAt = Date.now();
    for (const source of this.config.sources) {
      if (!this.isBreakingSource(source.name)) continue;
      scheduled++;
      try {
        const items = await this.fetchRSSFeed(source);
        if (items.length > 0) {
          await this.processRSSItems(items, source);
          fetched += items.length;
        }
      } catch {}
    }
    return { fetched, scheduled };
  }

  // --- Controller integration ---
  public setOverrideInterval(sourceName: string, ms: number): void {
    if (typeof ms === 'number' && ms > 0) this.overrideIntervals.set(sourceName, ms);
  }
  public applyOverrides(map: Record<string, number>): void {
    for (const [k, v] of Object.entries(map)) this.setOverrideInterval(k, v as number);
  }
  public getOverrides(): Record<string, number> { const out: Record<string, number> = {}; for (const [k, v] of this.overrideIntervals) out[k] = v; return out; }

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
