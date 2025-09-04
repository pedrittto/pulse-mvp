// Lightweight ingest governor: state machine + per-host token bucket
// ESM/NodeNext friendly, no timers; uses monotonic time based on nowMs

export type GovState = 'FAST' | 'NORMAL' | 'SLOW' | 'BACKOFF';
export type Outcome = 'NEW' | 'HTTP_200' | 'HTTP_304' | 'TIMEOUT' | 'R429' | 'R403';

export interface GovConfig {
  normalMs?: number;
  fastMs?: number;
  slowMs?: number;
  fastWindowMs?: number;
  slowWindowMs?: number;
  timeoutStreakForSlow?: number;
  backoff429Ms?: number;
  backoff403Ms?: number;
  jitterPct?: number;
}

export interface HostBudgetCfg {
  capacity: number;     // tokens per minute
  refillPerSec: number; // tokens per second
}

export type Host = 'prnewswire.com' | 'sec.gov' | 'nyse.com' | 'nasdaqtrader.com' | 'cmegroup.com' | 'businesswire.com';

type SourceTrack = {
  fastUntilMs: number;
  slowUntilMs: number;
  backoffUntilMs: number;
  timeoutStreak: number;
  lastR429BackoffMs: number;
};

type HostBucket = {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefillMs: number;
};

function clampMin(v: number, min: number): number { return v < min ? min : v; }
function jitter(ms: number, pct: number): number {
  const delta = Math.floor(ms * pct);
  const j = (Math.random() * 2 - 1) * delta;
  return Math.max(0, ms + j);
}

function now(): number { return Date.now(); }

const DEFAULT_CFG: Required<GovConfig> = {
  normalMs: 1200,
  fastMs: 700,
  slowMs: 3000,
  fastWindowMs: 2 * 60_000,
  slowWindowMs: 5 * 60_000,
  timeoutStreakForSlow: 3,
  backoff429Ms: 120_000,
  backoff403Ms: 600_000,
  jitterPct: 0.15,
};

function readEnvFlag(name: string, defOn = true): boolean {
  const v = process?.env?.[name];
  if (v == null) return defOn;
  return !/^(0|false|off|no)$/i.test(String(v));
}

function buildHostBudgetsFromEnv(): Record<Host, HostBudgetCfg> {
  const get = (k: string, fallback: number) => {
    const v = Number(process?.env?.[k]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const prn = get('PRN_BUDGET_PER_MIN', 12);
  const sec = get('SEC_BUDGET_PER_MIN', 10);
  const ny  = get('NYSE_BUDGET_PER_MIN', 8);
  const na  = get('NASDAQ_BUDGET_PER_MIN', 8);
  const cme = get('CME_BUDGET_PER_MIN', 8);
  const bw  = get('BW_BUDGET_PER_MIN', 6);
  return {
    'prnewswire.com':   { capacity: prn, refillPerSec: prn / 60 },
    'sec.gov':          { capacity: sec, refillPerSec: sec / 60 },
    'nyse.com':         { capacity: ny,  refillPerSec: ny  / 60 },
    'nasdaqtrader.com': { capacity: na,  refillPerSec: na  / 60 },
    'cmegroup.com':     { capacity: cme, refillPerSec: cme / 60 },
    'businesswire.com': { capacity: bw,  refillPerSec: bw  / 60 },
  };
}

export function createGovernor(cfg?: Partial<GovConfig>) {
  const enabled = readEnvFlag('GOVERNOR_ENABLED', true);
  const domainBudgetsOn = readEnvFlag('DOMAIN_BUDGETS', true);
  const C = { ...DEFAULT_CFG, ...(cfg || {}) } as Required<GovConfig>;

  const sources = new Map<string, SourceTrack>();
  const hostCfg = buildHostBudgetsFromEnv();
  const hostBuckets = new Map<Host, HostBucket>(
    (Object.keys(hostCfg) as Host[]).map((h) => [h, {
      capacity: hostCfg[h].capacity,
      refillPerSec: hostCfg[h].refillPerSec,
      tokens: hostCfg[h].capacity,
      lastRefillMs: now(),
    }])
  );

  function ensureSource(name: string): SourceTrack {
    let t = sources.get(name);
    if (!t) {
      t = { fastUntilMs: 0, slowUntilMs: 0, backoffUntilMs: 0, timeoutStreak: 0, lastR429BackoffMs: 0 };
      sources.set(name, t);
    }
    return t;
  }

  function getState(source: string, tNow = now()): GovState {
    const s = ensureSource(source);
    if (s.backoffUntilMs > tNow) return 'BACKOFF';
    if (s.slowUntilMs > tNow) return 'SLOW';
    if (s.fastUntilMs > tNow) return 'FAST';
    return 'NORMAL';
  }

  function baseDelayForState(st: GovState): number {
    switch (st) {
      case 'FAST': return C.fastMs;
      case 'SLOW': return C.slowMs;
      case 'BACKOFF': return C.normalMs; // will be overridden by remaining backoff
      default: return C.normalMs;
    }
  }

  function getNextInMs(source: string, tNow = now()): number {
    const s = ensureSource(source);
    if (s.backoffUntilMs > tNow) return s.backoffUntilMs - tNow;
    const st = getState(source, tNow);
    return baseDelayForState(st);
  }

  function nextDelayAfter(source: string, outcome: Outcome, opts?: { recencyMs?: number; nowMs?: number }): number {
    if (!enabled) {
      return DEFAULT_CFG.normalMs;
    }
    const tNow = opts?.nowMs ?? now();
    const s = ensureSource(source);

    // Transitions
    if (outcome === 'R403') {
      s.backoffUntilMs = Math.max(s.backoffUntilMs, tNow + C.backoff403Ms);
    } else if (outcome === 'R429') {
      const base = C.backoff429Ms;
      const next = s.lastR429BackoffMs ? Math.min(s.lastR429BackoffMs * 2, 600_000) : base;
      s.lastR429BackoffMs = next;
      s.backoffUntilMs = Math.max(s.backoffUntilMs, tNow + next);
    } else if (outcome === 'TIMEOUT') {
      s.timeoutStreak += 1;
      if (s.timeoutStreak >= C.timeoutStreakForSlow) {
        s.slowUntilMs = Math.max(s.slowUntilMs, tNow + C.slowWindowMs);
      }
    } else {
      // success paths reset timeout streak
      if (outcome === 'HTTP_200' || outcome === 'HTTP_304' || outcome === 'NEW') s.timeoutStreak = 0;
    }

    // FAST window on NEW or 200 with recent content
    const recentEnough = typeof opts?.recencyMs === 'number' && opts!.recencyMs <= 120_000;
    if (outcome === 'NEW' || (outcome === 'HTTP_200' && recentEnough)) {
      s.fastUntilMs = Math.max(s.fastUntilMs, tNow + C.fastWindowMs);
    }

    const st = getState(source, tNow);
    if (st === 'BACKOFF') {
      const rem = s.backoffUntilMs - tNow;
      return clampMin(rem, 500);
    }
    const base = baseDelayForState(st);
    const d = jitter(base, C.jitterPct);
    return clampMin(Math.floor(d), 500);
  }

  function getHostBudgets(): Record<Host, { capacity:number; tokens:number; refillPerSec:number }> {
    const out: any = {};
    for (const [h, b] of hostBuckets) {
      out[h] = { capacity: b.capacity, tokens: Math.max(0, Math.min(b.capacity, Math.round(b.tokens * 100) / 100)), refillPerSec: b.refillPerSec };
    }
    return out;
  }

  function claimHostToken(host: Host, nowMs?: number): { ok: true } | { ok: false; waitMs: number } {
    if (!domainBudgetsOn) return { ok: true };
    const b = hostBuckets.get(host);
    if (!b) return { ok: true };
    const tNow = nowMs ?? now();
    const elapsedSec = Math.max(0, (tNow - b.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillPerSec);
      b.lastRefillMs = tNow;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const need = 1 - b.tokens;
    const waitSec = need / b.refillPerSec;
    return { ok: false, waitMs: Math.ceil(waitSec * 1000) };
  }

  return { getHostBudgets, claimHostToken, getState, nextDelayAfter, getNextInMs };
}

// Singleton governor with defaults
let __gov: ReturnType<typeof createGovernor> | null = null;
export function getGovernor() {
  if (!__gov) __gov = createGovernor({});
  return __gov;
}


