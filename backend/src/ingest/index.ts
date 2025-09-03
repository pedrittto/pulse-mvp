// backend/src/ingest/index.ts
import { startBusinessWireIngest } from "./businesswire.js";
import { startPRNewswireIngest } from "./prnewswire.js";
import { startNasdaqHaltsIngest } from "./nasdaq_halts.js";
import { startNyseNoticesIngest } from "./nyse_notices.js";
import { startCmeNoticesIngest } from "./cme_notices.js";
import { startSecPressIngest } from "./sec_press.js";
// During ts/tsx dev, omit .js extension to please TS module resolution
import { startFedPressIngest } from "./fed_press.js";

const REGISTRY: Record<string, () => void> = {
  businesswire: startBusinessWireIngest,
  prnewswire: startPRNewswireIngest,
  nasdaq_halts: startNasdaqHaltsIngest,
  nyse_notices: startNyseNoticesIngest,
  cme_notices: startCmeNoticesIngest,
  sec_press: startSecPressIngest,
  fed_press: startFedPressIngest,
};

function parseEnabled(env?: string | null): string[] {
  if (!env) return ["businesswire"]; // default: start BW
  return env.split(",").map(s => s.trim()).filter(Boolean);
}

export function startIngests(): void {
  const enabled = parseEnabled(process.env.INGEST_SOURCES);
  for (const key of enabled) {
    const starter = REGISTRY[key];
    if (starter) starter();
  }
}





