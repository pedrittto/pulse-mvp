// backend/src/ingest/index.ts
// NodeNext/ESM requires explicit .js for runtime-resolved imports in dist/
import { startBusinessWireIngest as start } from "./businesswire.js";
import { startPRNewswireIngest  as startPr } from "./prnewswire.js";
import { startNasdaqHaltsIngest as startNa } from "./nasdaq_halts.js";
import { startNyseNoticesIngest as startNy } from "./nyse_notices.js";
import { startCmeNoticesIngest  as startCm } from "./cme_notices.js";
import { startSecPressIngest    as startSe } from "./sec_press.js";
import { startFedPressIngest    as startFe } from "./fed_press.js";

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

  for (const name of enabled) {
    console.log(`[ingest:${name}] start`);
    try { registry[name]!(); } catch (e) {
      console.error(`[ingest:${name}] failed to start`, e); process.exit(1);
    }
  }
}





