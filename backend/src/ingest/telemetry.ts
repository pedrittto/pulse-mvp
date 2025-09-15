// Lightweight scheduler telemetry (no cycles)
export type Sched = { ticks_total: number; last_tick_at?: number; last_http_status?: number; consecutive_failures: number; last_error?: string };

declare global {
  // eslint-disable-next-line no-var
  var __PULSE_SCHED__: Record<string, Sched> | undefined;
}

// Force a single shared object across the process (guards duplicate module loads)
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const sched: Record<string, Sched> = (globalThis as any).__PULSE_SCHED__ ||= {} as Record<string, Sched>;

export function reportTick(source: string, info?: { status?: number; error?: any }) {
  const k = String(source || '').trim();
  const s = (sched[k] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.ticks_total += 1;
  s.last_tick_at = Date.now();
  if (typeof info?.status === 'number') {
    s.last_http_status = info.status;
    if (info.status >= 200 && info.status < 400) s.consecutive_failures = 0; else s.consecutive_failures += 1;
  }
  if (info?.error) {
    s.consecutive_failures += 1;
    try { s.last_error = String(info.error?.message || info.error); } catch {}
  }
}

// Scheduler-owned counters (single source of truth)
export function onTickStart(source: string) {
  const k = String(source || '').trim();
  const s = (sched[k] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.ticks_total += 1; s.last_tick_at = Date.now();
}
export function onHttp(source: string, status: number) {
  const s = (sched[source] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.last_http_status = status;
}
export function onSuccess(source: string) {
  const s = (sched[source] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.consecutive_failures = 0;
}
export function onFailure(source: string, err?: any) {
  const s = (sched[source] ||= { ticks_total: 0, consecutive_failures: 0 });
  s.consecutive_failures += 1;
  try { s.last_error = String(err?.message || err); } catch {}
}

export function getSchedulerSnapshot(): Record<string, Sched> {
  return sched;
}


