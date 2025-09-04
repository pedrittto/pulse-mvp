// backend/src/ingest/index.ts
// NodeNext/ESM requires explicit .js for runtime-resolved imports in dist/
import { startBusinessWireIngest as start, getTimerCount as getBwTimer } from "./businesswire.js";
import { startPRNewswireIngest  as startPr, getTimerCount as getPrTimer } from "./prnewswire.js";
import { startNasdaqHaltsIngest as startNa, getTimerCount as getNaTimer } from "./nasdaq_halts.js";
import { startNyseNoticesIngest as startNy, getTimerCount as getNyTimer } from "./nyse_notices.js";
import { startCmeNoticesIngest  as startCm, getTimerCount as getCmTimer } from "./cme_notices.js";
import { startSecPressIngest    as startSe, getTimerCount as getSeTimer } from "./sec_press.js";
import { startFedPressIngest    as startFe, getTimerCount as getFeTimer } from "./fed_press.js";

const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

const registry: Record<string, () => void> = {
  businesswire: start,
  prnewswire:   startPr,
  nasdaq_halts: startNa,
  nyse_notices: startNy,
  cme_notices:  startCm,
  sec_press:    startSe,
  fed_press:    startFe,
};

let __ingestStarted = false;
let __enabledNames: string[] = [];

function parseSources(env?: string): string[] {
  return (env ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function startIngests(): void {
  if (__ingestStarted) {
    console.warn('[sched] startIngests called again — ignored');
    return;
  }
  __ingestStarted = true;

  const wanted = parseSources(process.env.INGEST_SOURCES);
  const registryKeys = Object.keys(registry);
  console.log('[registry:keys]', registryKeys.join(','));

  if (!wanted.length) {
    console.error('[boot][FATAL] INGEST_SOURCES is empty or unparsable'); process.exit(1);
  }
  const unknown = wanted.filter(n => !Object.prototype.hasOwnProperty.call(registry, n));
  if (unknown.length) {
    console.error('[boot][FATAL] Unknown sources in INGEST_SOURCES:', unknown.join(',')); process.exit(1);
  }

  const enabled = wanted.filter(n => registry[n]);
  console.log('[sched] enabled sources:', enabled.join(', ') || '(none)');
  __enabledNames = enabled.slice();

  for (const name of enabled) {
    console.log(`[ingest:${name}] start`);
    try { registry[name]!(); } catch (e) {
      console.error(`[ingest:${name}] failed to start`, e); process.exit(1);
    }
  }
}

export function getIngestDebug(): { adapters: string[]; timers: number } {
  try {
    const timers =
      (getBwTimer?.() || 0) +
      (getPrTimer?.() || 0) +
      (getNaTimer?.() || 0) +
      (getNyTimer?.() || 0) +
      (getCmTimer?.() || 0) +
      (getSeTimer?.() || 0) +
      (getFeTimer?.() || 0);
    return { adapters: __enabledNames.slice(), timers };
  } catch {
    return { adapters: __enabledNames.slice(), timers: 0 };
  }
}





