// backend/src/ingest/index.ts
import { startBusinessWireIngest } from "./businesswire.js";
import { startPRNewswireIngest } from "./prnewswire.js";
import { startNasdaqHaltsIngest } from "./nasdaq_halts.js";

const REGISTRY: Record<string, () => void> = {
  businesswire: startBusinessWireIngest,
  prnewswire: startPRNewswireIngest,
  nasdaq_halts: startNasdaqHaltsIngest,
};

function parseEnabled(env?: string | null): string[] {
  if (!env) return ["businesswire"]; // default: start BW
  return env.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Start all enabled ingests. Controlled by optional env INGEST_SOURCES, e.g.:
 *   INGEST_SOURCES=businesswire,prnewswire
 * Not required to set now; defaults to "businesswire".
 */
export function startIngests(): void {
  const enabled = parseEnabled(process.env.INGEST_SOURCES);
  for (const key of enabled) {
    const starter = REGISTRY[key];
    if (starter) starter();
  }
}


