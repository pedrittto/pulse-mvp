// Centralized config parsing and safe defaults

export const asBool = (v?: string) => /^(1|true)$/i.test((v ?? '').trim());
export const asInt = (v?: string, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function splitNonEmpty(v?: string): string[] {
  const t = (v ?? '').trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map((x) => String(x)).map((s) => s.trim()).filter(Boolean);
  } catch {}
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

// Alias mapping to canonical ingest keys
const ALIASES: Record<string, string> = {
  'sec-press': 'sec_press',
  'sec_press': 'sec_press',
  'nyse-notices': 'nyse_notices',
  'cme-notices': 'cme_notices',
  'nasdaq-halts': 'nasdaq_halts',
};

function toCanonical(name: string): string {
  const k = String(name || '').trim();
  const lower = k.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
  return ALIASES[lower] || lower;
}

export type AppConfig = {
  JOBS_ENABLED: boolean;
  INGEST_SOURCES: string[];
  LOG_LEVEL: string;
  LOG_SAMPLING: number;
};

export function loadConfig(env = process.env): AppConfig {
  const JOBS_ENABLED = asBool(env.JOBS_ENABLED);
  const rawSources = splitNonEmpty(env.INGEST_SOURCES).map(toCanonical);
  const INGEST_SOURCES = rawSources;
  const LOG_LEVEL = (env.LOG_LEVEL ?? 'error').toLowerCase();
  const LOG_SAMPLING = asInt(env.LOG_SAMPLING, 0);
  return { JOBS_ENABLED, INGEST_SOURCES, LOG_LEVEL, LOG_SAMPLING };
}


