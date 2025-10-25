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

const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

type AdapterEntry = { name: string; tick: () => Promise<any>; nextEligibleAt: number; baseIntervalMs: number };

// Build registry from statically imported adapters. Prefer tick(); adapters must not own timers.
const registry: AdapterEntry[] = [];

function pushIfTick(name: string, mod: any, base: number) {
  const fn = (typeof mod?.tick === 'function' ? mod.tick : (typeof mod?.probeOnce === 'function' ? mod.probeOnce : null));
  if (!fn) return;
  registry.push({ name, tick: fn, nextEligibleAt: Date.now(), baseIntervalMs: base });
}

pushIfTick('businesswire', BW, 1100);
pushIfTick('prnewswire',   PRN as any, 1100);
pushIfTick('nasdaq_halts', NA as any, 1800);
pushIfTick('nyse_notices', NY as any, 1800);
pushIfTick('cme_notices',  CME as any, 1800);
pushIfTick('sec_press',    SEC as any, 1200);
pushIfTick('fed_press',    FED as any, 1200);
pushIfTick('globenewswire', GNW as any, 1200);
pushIfTick('sec_edgar',    SED as any, 1200);

let locked = false;
let rrIdx = 0;
let globalTimer: NodeJS.Timeout | null = null;

function now() { return Date.now(); }
function jitter(ms: number) { return ms + Math.floor(Math.random() * 120); }

function plan(ms: number) {
  if (globalTimer) { try { clearTimeout(globalTimer); } catch {} }
  const d = Math.max(5, ms);
  globalTimer = setTimeout(runNext, d);
  (globalTimer as any)?.unref?.();
}

export async function runNext() {
  if (locked) { try { console.warn('[sched] skip_tick_locked'); } catch {} return plan(20); }
  locked = true;
  try {
    const t = now();
    const due = registry.filter(a => (a.nextEligibleAt ?? 0) <= t);
    const a = (due[0] ?? registry[rrIdx]);
    if (!a) { locked = false; return plan(100); }
    const wait = (a.nextEligibleAt ?? t) - t;
    if (wait > 1) { locked = false; return plan(wait); }
    try { console.info('run_next:%s', a.name); } catch {}
    await a.tick();
    a.nextEligibleAt = now() + jitter(a.baseIntervalMs ?? 1100);
    rrIdx = (registry.indexOf(a) + 1) % registry.length;
  } catch {
    // keep quiet on errors here; adapters log lightly themselves
  } finally {
    locked = false;
    try { await Promise.resolve(); } catch {}
    plan(20);
  }
}

function start() {
  const t = now();
  for (const a of registry) {
    a.nextEligibleAt = t;
    a.baseIntervalMs = a.baseIntervalMs ?? 1100;
  }
  plan(20);
}

export function startIngestScheduler() { start(); }

export function listRegisteredSources(): string[] {
  return registry.map(a => a.name);
}

// Lightweight status mirror for existing callers; no-op by default
export function reportTick(_name: string, _info: { status?: number; error?: any }) {
  // intentionally minimal
}
