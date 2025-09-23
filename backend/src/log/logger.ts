const LEVEL = (process.env.LOG_LEVEL ?? 'error').toLowerCase();
const SAMPLE = Math.max(0, Math.min(1, Number(process.env.LOG_SAMPLING ?? '0') || 0));
const PER_LOOP = Math.max(0, Number(process.env.LOG_MAX_PER_LOOP ?? '5') || 5);
const __warnRate = 60_000;

export const log = {
  error: (...a: any[]) => { try { console.error(...a); } catch {} },
  warn:  (() => { const w = warnRateLimited('logger:warn', __warnRate); return (...a: any[]) => { try { w(...a); } catch {} }; })(),
  info:  (...a: any[]) => {
    if (LEVEL === 'info' || LEVEL === 'debug') {
      if (SAMPLE === 1 || Math.random() < SAMPLE) { try { console.log(...a); } catch {} }
    }
  },
  debug: (..._a: any[]) => { /* disabled by default */ },
};

export function withLoopBudget<T extends (...a: any[]) => void>(fn: T): T {
  let n = 0;
  return ((...a: any[]) => { if (n++ < PER_LOOP) fn(...a); }) as T;
}

// Warn rate limiter factory (≥60s default)
export function warnRateLimited(key: string, cooldownMs = 60_000) {
  let last = 0;
  return (...a: any[]) => {
    const now = Date.now();
    if (now - last >= Math.max(0, cooldownMs)) { last = now; try { /* warnRateLimited */ console.warn(...a); } catch {} }
  };
}


