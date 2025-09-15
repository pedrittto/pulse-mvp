Hypotheses verification and changes

- Primary (GNW/EDGAR timers missing): TRUE
  - `backend/src/ingest/globenewswire.ts` had `start()`/`stop()` no-ops and `getTimerCount()` returned 0; although `tick()` existed, no module timer was attached, so it never ran.
  - `backend/src/ingest/sec_edgar.ts` had the same pattern (no-op start/stop; `getTimerCount()` returned 0) with a `tick()` never scheduled.

- Secondary (metrics missing in PRN/NASDAQ): PARTLY TRUE
  - Both PRN and NASDAQ already called `setTimestampSource`, `recordPublisherLatency`, and `recordPipelineLatency` when broadcasting.
  - However, PRN and NASDAQ broadcast payload fields were `published_at`/`visible_at` (non-*_ms). I aligned them to `published_at_ms`/`visible_at_ms` to be consistent with GNW/EDGAR and metrics consumers.

Scheduler behavior

- `backend/src/ingest/index.ts` registers adapters with a dynamic scheduler only for BusinessWire. Legacy adapters are started via `enableAdapter(name)` which calls their `start()`. Therefore, legacy adapters must own their timer loop. With GNW/EDGAR `start()` as no-ops, they never scheduled.

Changed files (highlights)

- `backend/src/ingest/globenewswire.ts`: Added jittered timer loop; `start()` now schedules `tick()`; `stop()` clears timer; `getTimerCount()` reflects state.
- `backend/src/ingest/sec_edgar.ts`: Same timer loop addition as GNW.
- `backend/src/ingest/prnewswire.js`: Standardized broadcast fields to `published_at_ms`/`visible_at_ms`.
- `backend/src/ingest/nasdaq_halts.ts`: Standardized broadcast fields to `published_at_ms`/`visible_at_ms`.

Exact broadcast + metrics placement

- GNW (`globenewswire.ts`): inside `tick()` per-item loop, right after `broadcastBreaking(...)` the code calls `setTimestampSource(id,'feed')`, `recordPublisherLatency(id, publishedAt, visibleAt)`, `recordPipelineLatency(id, visibleAt, visibleAt+1)`.
- SEC EDGAR (`sec_edgar.ts`): same pattern as GNW within `tick()` per-entry loop.
- PRN (`prnewswire.js`) and NASDAQ (`nasdaq_halts.ts`): already recording metrics after broadcasting; payload fields now `*_ms`.

Minimal diffs (concise)

- globenewswire.ts
```diff
+ let t: NodeJS.Timeout | null = null;
+ const TICK_MS = Number(process.env.RSS_TICK_MS || 15000);
+ export function start(): void {
+   if (t) return; console.log("[ingest:globenewswire] start");
+   const loop = async () => { try { await tick(); } finally { t = setTimeout(loop, TICK_MS); (t as any)?.unref?.(); } };
+   t = setTimeout(loop, Math.floor(Math.random() * TICK_MS)); (t as any)?.unref?.();
+ }
+ export function stop(): void { if (t) { try { clearTimeout(t); } catch {} t = null; } }
+ export function getTimerCount(): number { return t ? 1 : 0; }
```

- sec_edgar.ts
```diff
+ let t: NodeJS.Timeout | null = null;
+ const TICK_MS = Number(process.env.RSS_TICK_MS || 15000);
+ export function start(): void {
+   if (t) return; console.log("[ingest:sec_edgar] start");
+   const loop = async () => { try { await tick(); } finally { t = setTimeout(loop, TICK_MS); (t as any)?.unref?.(); } };
+   t = setTimeout(loop, Math.floor(Math.random() * TICK_MS)); (t as any)?.unref?.();
+ }
+ export function stop(): void { if (t) { try { clearTimeout(t); } catch {} t = null; } }
+ export function getTimerCount(): number { return t ? 1 : 0; }
```

- prnewswire.js
```diff
-   published_at: it.publishedAt,
-   visible_at: visibleAt,
+   published_at_ms: it.publishedAt,
+   visible_at_ms: visibleAt,
```

- nasdaq_halts.ts
```diff
-   published_at: publishedAt,
-   visible_at: visibleAt,
+   published_at_ms: publishedAt,
+   visible_at_ms: visibleAt,
```

Expected logs post-deploy

- One-time boot lines: `[ingest:globenewswire] start` and `[ingest:sec_edgar] start`.
- Under `DEBUG_INGEST=1`, periodic `200 items=… new=…` lines for GNW/EDGAR when feeds produce items.

Notes

- No scheduler/SSE/global code changes. No new dependencies. Logging is minimal; only one `start` line per process plus debug-gated lines when `DEBUG_INGEST=1`.
