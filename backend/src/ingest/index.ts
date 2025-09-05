// backend/src/ingest/index.ts
// ESM imports — explicit .js extensions
import * as BW  from './businesswire.js';
import * as PRN from './prnewswire.js';
import * as NA  from './nasdaq_halts.js';
import * as NY  from './nyse_notices.js';
import * as CME from './cme_notices.js';
import * as SEC from './sec_press.js';
import * as FED from './fed_press.js';
import { getGovernor } from './governor.js';

const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

// Registry holds full modules so we can introspect timers/state
type AdapterMod = {
  start: () => void;
  getTimerCount?: () => number;
  getState?: () => string;
  nextInMs?: () => number;
  __started?: boolean;
};

const registry: Record<string, AdapterMod> = {
  businesswire: BW as unknown as AdapterMod,
  prnewswire:   PRN as unknown as AdapterMod,
  nasdaq_halts: NA as unknown as AdapterMod,
  nyse_notices: NY as unknown as AdapterMod,
  cme_notices:  CME as unknown as AdapterMod,
  sec_press:    SEC as unknown as AdapterMod,
  fed_press:    FED as unknown as AdapterMod,
};

// --- staged boot configuration (no new files) ---
const LIGHT = new Set(['prnewswire', 'sec_press', 'fed_press']); // RSS/light XML
const HEAVY = new Set(['nyse_notices', 'cme_notices', 'nasdaq_halts', 'businesswire']); // HTML/WAF-heavy; BW as heavy defensively

// Kill-switch: set STAGED_BOOT_OFF=1 to disable staging and start all from ENV immediately.
const STAGED_BOOT_OFF = process.env.STAGED_BOOT_OFF === '1';

function parseSources(env?: string): string[] {
  return (env ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

let __ingestStarted = false;
let __enabled: string[] = [];

export function startIngests(): void {
  if (__ingestStarted) { return; }

  const enabled = (process.env.INGEST_SOURCES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter((n) => Object.prototype.hasOwnProperty.call(registry, n));

  if (!enabled.length) {
    console.warn('[boot] INGEST_SOURCES is empty or unparsable — starting without ingest adapters');
    return; // keep server alive; no adapters started
  }

  __ingestStarted = true;
  __enabled = enabled.slice();

  // If staging is off, start all enabled (legacy behavior with stagger)
  if (STAGED_BOOT_OFF) {
    for (const name of enabled) enableAdapter(name);
    return;
  }

  // Staging ON: start only LIGHT immediately; defer HEAVY to fixed times
  const initial = enabled.filter((n) => LIGHT.has(n) || !HEAVY.has(n));
  const delayed = enabled.filter((n) => HEAVY.has(n));

  // Start initial with staggered jitter 0.5–5s
  for (const name of initial) enableAdapter(name);

  if (delayed.length > 0) {
    // Deterministic staging windows for the first three heavy adapters
    const schedule = [120_000, 180_000, 240_000];
    delayed.slice(0, schedule.length).forEach((name, i) => {
      setTimeout(() => enableAdapter(name), schedule[i]).unref?.();
    });
    // If more than 3 heavy adapters, add the rest every +60s
    delayed.slice(schedule.length).forEach((name, k) => {
      setTimeout(() => enableAdapter(name), 240_000 + (k + 1) * 60_000).unref?.();
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
      mod.start(); // must keep single in-flight + timers:1 inside
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
    ...(typeof (mod as any).getLimiterStats === 'function' ? (mod as any).getLimiterStats() : {}),
  }));
  const hostBudget = gov.getHostBudgets();
  return { started: __ingestStarted, enabled: __enabled.slice(), adapters, hostBudget };
}





