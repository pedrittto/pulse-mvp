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

function parseSources(env?: string): string[] {
  return (env ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

export function startIngests(): void {
  const wanted = parseSources(process.env.INGEST_SOURCES);
  const enabled = wanted.filter(name => Object.prototype.hasOwnProperty.call(registry, name));

  console.log('[sched] enabled sources:', enabled.join(', ') || '(none)');

  for (const name of enabled) {
    try {
      console.log(`[ingest:${name}] start`);
      registry[name]!();
    } catch (err) {
      console.error(`[ingest:${name}] failed to start`, err);
    }
  }
}





