// backend/src/ingest/index.ts
// ESM imports — explicit .js extensions
import * as BW  from './businesswire.js';
import * as PRN from './prnewswire.js';
import * as NA  from './nasdaq_halts.js';
import * as NY  from './nyse_notices.js';
import * as CME from './cme_notices.js';
import * as SEC from './sec_press.js';
import * as FED from './fed_press.js';
import * as GNW from './globenewswire.js';
import * as SED from './sec_edgar.js';
import { getGovernor } from './governor.js';
import { reportTick as reportTickGlobal, getSchedulerSnapshot, onTickStart, onHttp, onSuccess, onFailure } from './telemetry.js';
import { warnRateLimited } from "../log/logger.js";

const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

// Registry holds full modules so we can introspect timers/state
type AdapterMod = {
  start: () => void;
  getTimerCount?: () => number;
  getState?: () => string;
  nextInMs?: () => number;
  __started?: boolean;
  // Deterministic, single-run health probe (no publish)
  probeOnce?: () => Promise<{
    source: string;
    ok: boolean;
    http_status?: number;
    items_found?: number;
    latest_item_timestamp?: number|null;
    fetch_started_at?: number;
    fetch_finished_at?: number;
    parse_ms?: number;
    notes?: string;
  }>;
};

const registry: Record<string, AdapterMod> = {
  businesswire: BW as unknown as AdapterMod,
  prnewswire:   PRN as unknown as AdapterMod,
  nasdaq_halts: NA as unknown as AdapterMod,
  nyse_notices: NY as unknown as AdapterMod,
  cme_notices:  CME as unknown as AdapterMod,
  sec_press:    SEC as unknown as AdapterMod,
  fed_press:    FED as unknown as AdapterMod,
  globenewswire: GNW as unknown as AdapterMod,
  sec_edgar:    SED as unknown as AdapterMod,
};

// --- staged boot configuration (no new files) ---
const LIGHT = new Set(['prnewswire', 'sec_press', 'fed_press']); // RSS/light XML
const HEAVY = new Set(['nyse_notices', 'nasdaq_halts']); // start businesswire immediately (non-heavy)

// Kill-switch: set STAGED_BOOT_OFF=1 to disable staging and start all from ENV immediately.
const STAGED_BOOT_OFF = process.env.STAGED_BOOT_OFF === '1';

function parseSources(env?: string): string[] {
  const raw = env ?? "";
  if (!raw) return [];
  // Accept JSON array or CSV (legacy)
  try {
    const maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) return maybe.map(v => String(v)).map(s => s.trim()).filter(Boolean);
  } catch {}
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Aliases map to canonical registry keys
const ALIASES: Record<string, string> = {
  "sec-press": "sec_press",
  "sec_press": "sec_press",
  "nyse-notices": "nyse_notices",
  "cme-notices": "cme_notices",
  "nasdaq-halts": "nasdaq_halts",
};

function toCanonical(name: string): string {
  const k = String(name || "").trim();
  const lower = k.toLowerCase().replace(/\s+/g, "");
  return ALIASES[lower] || lower;
}

let __ingestStarted = false;
let __enabled: string[] = [];
const timers = new Map<string, NodeJS.Timeout>();
const nextDue = new Map<string, number>();
export function getNextDueAt(id: string) { return nextDue.get(id); }
export function isRegistered(id: string) { return timers.has(id); }
type Sched = { ticks_total: number; last_tick_at?: number; last_http_status?: number; consecutive_failures: number; last_error?: string };
const __sched: Record<string, Sched> = {};

export function reportTick(name: string, info: { status?: number; error?: any }) {
  const k = String(name);
  const s = (__sched[k] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.ticks_total += 1;
  s.last_tick_at = Date.now();
  if (typeof info?.status === 'number') {
    s.last_http_status = info.status;
    if (info.status >= 200 && info.status < 400) s.consecutive_failures = 0; else s.consecutive_failures += 1;
  }
  if (info?.error) {
    s.consecutive_failures += 1;
    try { s.last_error = String((info.error as any)?.message || info.error); } catch {}
  }
  // global mirror
  try { reportTickGlobal(name, info); } catch {}
}

function seedActive(active: string[]) {
  const snap = getSchedulerSnapshot();
  for (const id of active) {
    (snap as any)[id] ||= { ticks_total: 0, consecutive_failures: 0 };
  }
}

export function resolveActive(envStr?: string): string[] {
  const raw = envStr ?? '';
  if (!raw) return [];
  return parseSources(raw).map(toCanonical).filter((n) => Object.prototype.hasOwnProperty.call(registry, n));
}

function jitterMs(min: number, max: number): number {
  const a = Math.max(1, Number(min || 1));
  const b = Math.max(a, Number(max || a));
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function loadAdapter(name: string): Promise<any | null> {
  try {
    switch (name) {
      case 'businesswire':
        return await import('./businesswire.js');
      // future: add more adapters here with dynamic import
      default:
        if (DEBUG_INGEST) warnRateLimited('sched:unknown-source', 60_000)('[sched] unknown source', name);
        return null;
    }
  } catch (e: any) {
    try { console.error('[sched] adapter import failed', name, e?.message || String(e)); } catch {}
    return null;
  }
}

async function registerSource(name: string): Promise<boolean> {
  const mod = await loadAdapter(name);
  if (!mod || typeof (mod as any).tick !== 'function') {
    // fallback to legacy registry-based start
    const legacy = (registry as any)[name];
    if (legacy && typeof legacy.start === 'function') { try { legacy.start(); return true; } catch {} }
    try { console.error('[sched] adapter lacks tick()', name); } catch {}
    return false;
  }

  const minMs = Math.max(1000, Number(process.env.BW_CLAMP_MS_MIN ?? 15000));
  const maxMs = Math.max(minMs, Number(process.env.BW_CLAMP_MS_MAX ?? 30000));
  const rnd = () => jitterMs(minMs, maxMs);

  const run = async () => {
    onTickStart(name);
    let status = 0;
    try {
      const r = await (mod as any).tick();
      status = Number(r?.http_status || 0);
      onHttp(name, status); onSuccess(name);
    } catch (e) {
      onHttp(name, status || 599); onFailure(name, e);
    } finally {
      const d = rnd();
      const prev = timers.get(name);
      if (prev) { try { clearTimeout(prev); } catch {} }
      const t = setTimeout(run, d);
      (t as any)?.unref?.();
      timers.set(name, t);
      nextDue.set(name, Date.now() + d);
      if (DEBUG_INGEST) console.log(`[sched] next ${name} in ${d} ms`);
    }
  };

  const prev = timers.get(name);
  if (prev) { try { clearTimeout(prev); } catch {} }
  const t = setTimeout(run, 0);
  (t as any)?.unref?.();
  timers.set(name, t);
  nextDue.set(name, Date.now());
  try { console.log('[sched] armed', name, 'in 0 ms'); } catch {}
  return true;
}

export function startIngests(): void {
  if (__ingestStarted) { return; }

  const raw = process.env.INGEST_SOURCES ?? '';
  const wanted = parseSources(raw).map(toCanonical);
  const enabled = wanted.filter((n) => Object.prototype.hasOwnProperty.call(registry, n));

  try {
    console.log('[env] INGEST_SOURCES=', JSON.stringify(raw));
    console.log('[env] RESOLVED_SOURCES=', JSON.stringify(enabled), '(count=', enabled.length, ')');
  } catch {}

  if (!enabled.length) {
    // Hard guard: do not start any ingest when sources are empty
    try { console.log('[boot] no sources configured; ingest disabled'); } catch {}
    return;
  }

  __ingestStarted = true;
  __enabled = enabled.slice();
  // Seed ACTIVE into global singleton snapshot so surfaces show them pre-first-tick
  try { seedActive(__enabled); } catch {}

  // If staging is off, start all enabled immediately via explicit registration
  if (STAGED_BOOT_OFF) {
    for (const name of enabled) { void registerSource(name).then((ok) => { if (!ok) enableAdapter(name); }); }
    return;
  }

  // Staging ON: start only LIGHT immediately; defer HEAVY to fixed times
  const initial = enabled.filter((n) => LIGHT.has(n) || !HEAVY.has(n));
  const delayed = enabled.filter((n) => HEAVY.has(n));

  // Start initial with staggered jitter 0.5–5s
  for (const name of initial) {
    const jitter = 500 + Math.floor(Math.random() * 4500);
    setTimeout(() => { void registerSource(name).then((ok) => { if (!ok) enableAdapter(name); }); }, jitter).unref?.();
  }

  if (delayed.length > 0) {
    // Deterministic staging windows for the first three heavy adapters
    const schedule = [120_000, 180_000, 240_000];
    delayed.slice(0, schedule.length).forEach((name, i) => {
      setTimeout(() => { void registerSource(name).then((ok) => { if (!ok) enableAdapter(name); }); }, schedule[i]).unref?.();
    });
    // If more than 3 heavy adapters, add the rest every +60s
    delayed.slice(schedule.length).forEach((name, k) => {
      setTimeout(() => { void registerSource(name).then((ok) => { if (!ok) enableAdapter(name); }); }, 240_000 + (k + 1) * 60_000).unref?.();
    });
  }
}

export function enableAdapter(name: string): void {
  const mod = (registry as any)[name];
  if (!mod) return;
  if (mod.__started) return; // idempotent guard
  const jitter = 500 + Math.floor(Math.random() * 4500);
  setTimeout(() => {
    try {
      if (mod.__started) return;
      mod.__started = true;
      if (name === 'businesswire' && typeof (mod as any).tick === 'function') {
        const minMs = Math.max(1000, Number(process.env.BW_CLAMP_MS_MIN || 15000));
        const maxMs = Math.max(minMs, Number(process.env.BW_CLAMP_MS_MAX || 30000));
        const jitterFactor = 0.2;
        const rnd = () => minMs + Math.random() * (maxMs - minMs);
        let timer: NodeJS.Timeout | null = null;
        const scheduleNext = (ms: number) => {
          const j = Math.max(0, Math.floor(ms * (1 + (Math.random()*2 - 1) * jitterFactor)));
          if (timer) { try { clearTimeout(timer); } catch {} }
          timer = setTimeout(run, j);
          (timer as any)?.unref?.();
          timers.set(name, timer);
          nextDue.set(name, Date.now() + j);
          if (DEBUG_INGEST) console.log(`[sched] next ${name} in ${j} ms`);
        };
        const run = async () => {
          onTickStart(name);
          let status = 0;
          try {
            const r = await (mod as any).tick();
            status = Number(r?.http_status || 0);
            onHttp(name, status);
            onSuccess(name);
          } catch (e) {
            onHttp(name, status || 599);
            onFailure(name, e);
          } finally {
            scheduleNext(rnd());
          }
        };
        try { setImmediate(run); } catch { try { (globalThis.queueMicrotask || ((fn:any)=>Promise.resolve().then(fn)))(run); } catch {} }
        (mod as any).__stop = () => { if (timer) { try { clearTimeout(timer); } catch {} } timers.delete(name); nextDue.delete(name); timer = null; };
        return;
      }
      // Default: legacy adapters own their timers
      mod.start();
    } catch (e) {
      // keep silent or guard behind DEBUG_INGEST; no heavy logging
    }
  }, jitter).unref?.();
}

export function getIngestDebug() {
  const gov = getGovernor();
  const adapters = Object.entries(registry).map(([name, mod]) => ({
    name,
    timers: Number(mod.getTimerCount?.() ?? 0),
    state: gov.getState(name),
    nextInMs: gov.getNextInMs(name),
    scheduler: __sched[name] || { ticks_total: 0, consecutive_failures: 0 },
    ...(typeof (mod as any).getLimiterStats === 'function' ? (mod as any).getLimiterStats() : {}),
  }));
  const hostBudget = gov.getHostBudgets();
  const schedSnap = getSchedulerSnapshot();
  return { started: __ingestStarted, enabled: __enabled.slice(), adapters, hostBudget, sched: schedSnap };
}

export function listRegisteredSources(): string[] {
  return Object.keys(registry);
}

export async function runProbeOnce(source: string) {
  const name = String(source || '').trim();
  const mod = (registry as any)[name] as AdapterMod | undefined;
  if (!mod) {
    return {
      source: name,
      ok: false,
      http_status: 0,
      items_found: 0,
      latest_item_timestamp: null,
      fetch_started_at: Date.now(),
      fetch_finished_at: Date.now(),
      parse_ms: 0,
      notes: 'unknown_source'
    };
  }
  if (typeof mod.probeOnce === 'function') {
    try {
      const r = await mod.probeOnce!();
      try { reportTick(name, { status: Number((r as any)?.http_status || 0) }); } catch {}
      return r;
    } catch (e) {
      try { reportTick(name, { error: e }); } catch {}
      return {
        source: name,
        ok: false,
        http_status: 0,
        items_found: 0,
        latest_item_timestamp: null,
        fetch_started_at: Date.now(),
        fetch_finished_at: Date.now(),
        parse_ms: 0,
        notes: 'probe_failed: ' + ((e as any)?.message || String(e))
      };
    }
  }
  return {
    source: name,
    ok: false,
    http_status: 0,
    items_found: 0,
    latest_item_timestamp: null,
    fetch_started_at: Date.now(),
    fetch_finished_at: Date.now(),
    parse_ms: 0,
    notes: 'no_probe_implemented'
  };
}

let __startedOnce = false;
export function startIngestsOnce(): void {
  if (__startedOnce) return;
  __startedOnce = true;
  startIngests();
}





