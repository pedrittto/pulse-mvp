// backend/src/ingest/index.ts
// ESM imports — explicit .js extensions
import * as BW  from './businesswire.js';
import * as PRN from './prnewswire.js';
import * as NA  from './nasdaq_halts.js';
import * as NY  from './nyse_notices.js';
import * as CME from './cme_notices.js';
import * as SEC from './sec_press.js';
import * as FED from './fed_press.js';

const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

// Registry holds full modules so we can introspect timers/state
type AdapterMod = {
  start: () => void;
  getTimerCount?: () => number;
  getState?: () => string;
  nextInMs?: () => number;
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

function parseSources(env?: string): string[] {
  return (env ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

let __ingestStarted = false;
let __enabled: string[] = [];

export function startIngests(): void {
  if (__ingestStarted) {
    console.warn('[sched] startIngests called again — ignored');
    return;
  }

  const wanted = parseSources(process.env.INGEST_SOURCES);
  const keys = Object.keys(registry);
  console.log('[registry:keys]', keys.join(','));

  if (!wanted.length) {
    console.error('[boot][FATAL] INGEST_SOURCES is empty or unparsable'); process.exit(1);
  }
  const unknown = wanted.filter(n => Object.hasOwn(registry, n) === false);
  if (unknown.length) {
    console.error('[boot][FATAL] Unknown sources in INGEST_SOURCES:', unknown.join(',')); process.exit(1);
  }

  const enabled = wanted.filter(n => Object.hasOwn(registry, n));
  console.log('[sched] enabled sources:', enabled.join(', ') || '(none)');

  __ingestStarted = true;
  __enabled = enabled.slice();

  for (const name of enabled) {
    console.log(`[ingest:${name}] start`);
    try {
      registry[name].start();
    } catch (err) {
      console.error(`[ingest:${name}] failed to start`, err);
      process.exit(1);
    }
  }
}

export function getIngestDebug() {
  const adapters = Object.entries(registry).map(([name, mod]) => ({
    name,
    timers: Number(mod.getTimerCount?.() ?? 0),
    state: mod.getState?.(),
    nextInMs: typeof mod.nextInMs === 'function' ? mod.nextInMs() : undefined,
  }));
  return { started: __ingestStarted, enabled: __enabled.slice(), adapters };
}





