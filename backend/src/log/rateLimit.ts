type Key = string;

type Entry = { until: number; last: string };

const state = new Map<Key, Entry>();

export function warnOncePer(key: Key, ms: number, logFn: (...args: any[]) => void = console.warn) {
  return (msg: string, ...args: any[]) => {
    const now = Date.now();
    const s = state.get(key);
    if (!s || now > s.until || s.last !== msg) {
      state.set(key, { until: now + Math.max(0, Number(ms) || 0), last: msg });
      try { logFn(msg, ...args); } catch {}
    }
  };
}


