// backend/src/ingest/index.ts
import { startBusinessWireIngest } from "./businesswire.js";
import { startPRNewswireIngest } from "./prnewswire.js";
// Registry for future sources (add new keys later, e.g. prnewswire, nasdaq_halts)
const REGISTRY = {
    businesswire: startBusinessWireIngest,
    prnewswire: startPRNewswireIngest,
};
function parseEnabled(env) {
    if (!env)
        return ["businesswire"]; // default: start BW
    return env.split(",").map(s => s.trim()).filter(Boolean);
}
/**
 * Start all enabled ingests. Controlled by optional env INGEST_SOURCES, e.g.:
 *   INGEST_SOURCES=businesswire,prnewswire
 * Not required to set now; defaults to "businesswire".
 */
export function startIngests() {
    const enabled = parseEnabled(process.env.INGEST_SOURCES);
    for (const key of enabled) {
        const starter = REGISTRY[key];
        if (starter)
            starter();
    }
}
