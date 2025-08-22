## Breaking Soak Test (Windows-safe)

This script samples Breaking KPIs periodically and asserts the SLO (p50 ≤ 60s, p90 ≤ 120s) over a ~30 minute window.

How to run:

1. Build and start the backend:

```
npm run build
node dist/index.js
```

2. In a separate terminal, run the soak test:

```
npm run soak:breaking
```

Optional environment:

```
SOAK_INTERVAL_SEC=60
SOAK_DURATION_MIN=30
```

Outputs are written to `backend/artifacts/`:

- `soak_breaking_<timestamp>.csv` (columns: ts,breaking_p50_ms,breaking_p90_ms,passes,eligible_cnt,demoted_cnt)
- `soak_breaking_<timestamp>.json` (all samples with metadata)

The script exits with non-zero code if any tick fails the SLO.

## Feed Pagination and Indexes

Endpoints `/feed` and `/breaking-feed` support cursor-based pagination using:

- Query params: `limit` (1–100), `cursor` (opaque string)
- Response includes an additive `page` block:

```
{
  "items": [...],
  "total": 5,
  "page": { "cursor": "<next-or-null>", "limit": 5, "has_more": true }
}
```

Pagination is based on `ingested_at DESC, __name__ DESC` with `startAfter`.

Indexes: see `backend/firestore.indexes.json` for the defined index on `news(ingested_at DESC, __name__ DESC)`.

Verification (Windows-safe):

```
npm run build
node dist/index.js
npm run verify:feed
```

## HTTP Validators Persistence & Warmup

The service can persist ETag/Last-Modified per source and warm up Tier-1 hosts on startup.

- Persistence: stored in Firestore collection `http_validators` (doc id = normalized source name)
- Warmup: optional conditional GETs to Tier-1 to prime DNS and TCP/TLS

Enable via env:

```
WARMUP_TIER1=1
WARMUP_CONCURRENCY=2
```

Validators are loaded on boot so conditional requests can avoid full downloads after restarts.

## SSE Durability & Replay

The SSE hub emits monotonic `id:` for each event and keeps a ring buffer (size `SSE_RING_SIZE`, default 500). On reconnect, if the client provides `Last-Event-ID` (header sent automatically by browsers) or `?lastEventId=...`, the server replays missed events in order before resuming live.

Diagnostics:

- `/sse/status` returns current stats (seq, ring, clients, counters)
- Client helpers (EventSource) should keep a stable URL so browsers auto-send Last-Event-ID

Environment:

```
SSE_RING_SIZE=500
SSE_HEARTBEAT_MS=20000
```

## Adaptive Burst Polling

When a source yields new items, the breaking scheduler temporarily accelerates polling for that source to approximately 2s for up to 60s. This is additive to the existing fastlane clamp (5–10s) and respects all lane/concurrency limits. A stable per-source splay (`SPLAY_MAX_MS`, default 700ms) is added to avoid synchronized polls across sources.

Environment:

```
BURST_WINDOW_MS=60000
BURST_MIN_INTERVAL_MS=2000
SPLAY_MAX_MS=700
```

Diagnostics:

- `/health` includes `burst` with active_sources and thresholds
- `/metrics-lite` includes `burst_stats`

## SLO Watchdog

An internal watchdog can periodically evaluate Breaking SLO using the same `/kpi-breaking` logic and optionally send webhook alerts when the SLO fails or recovers.

Environment:

```
WATCHDOG_ENABLED=1
WATCHDOG_INTERVAL_SEC=60
WATCHDOG_WINDOW_MIN=30
WATCHDOG_SLO_P50_MS=60000
WATCHDOG_SLO_P90_MS=120000
WATCHDOG_WEBHOOK_URL=    # optional, HTTPS endpoint
WATCHDOG_MIN_CONSECUTIVE_FAILS=2
WATCHDOG_MIN_CONSECUTIVE_RECOVERS=2
```

Behavior:

- Evaluates at the configured interval
- Tracks consecutive passes/fails and emits `slo_fail` or `slo_recovered` webhooks once thresholds are met
- Robust to webhook errors (logged only)
- Optional status: `GET /watchdog/status`

Webhook payload examples:

```json
{ "type":"slo_fail", "breaking_p50_ms": 70000, "breaking_p90_ms": 130000, "window_min": 30, "generated_at": "2025-01-01T00:00:00Z" }
```

```json
{ "type":"slo_recovered", "breaking_p50_ms": 50000, "breaking_p90_ms": 90000, "window_min": 30, "generated_at": "2025-01-01T00:30:00Z" }
```

## Runtime Health Metrics & Ops Watchdog

The backend samples runtime health every 5s and maintains a rolling 5-minute window:

- Event-loop delay (p50/p95) via monitorEventLoopDelay
- GC pause time (p50/p95) via PerformanceObserver('gc')
- CPU% (p50/p95) derived from process.cpuUsage over wall clock
- Memory: rss, heap used/total (last sample)

Surfacing:

- `/metrics-lite` includes an `ops` block (window_sec, el_lag_*, gc_pause_*, cpu_*, memory, samples)
- `/health` includes a compact `ops` subset (el_lag_p95_ms, gc_pause_p95_ms, cpu_p95_pct, rss_mb, heap_used_mb, last_sample_at)

Ops Watchdog (additive):

```
WATCHDOG_OPS_ENABLED=1
WATCHDOG_OPS_INTERVAL_SEC=60
WATCHDOG_EL_LAG_P95_MS=200
WATCHDOG_GC_P95_MS=150
WATCHDOG_CPU_P95_PCT=85
WATCHDOG_OPS_MIN_CONSECUTIVE=2
```

When thresholds are exceeded for N consecutive intervals, a webhook is posted:

```json
{ "type": "ops_warn", "el_lag_p95_ms": 250, "gc_pause_p95_ms": 160, "cpu_p95_pct": 92, "rss_mb": 420, "heap_used_mb": 300, "window_sec": 300, "generated_at": "..." }
```

Verification:

```
npm run print:ops
```

## Readiness/Liveness & Drain

- `/livez` returns `{ok:true}` when the process is up
- `/readyz` returns `{ready:true}` when Firestore, scheduler, and SSE are ready (and warmup done if enabled); otherwise 503 with reason
- Graceful drain: on SIGTERM/SIGINT or `POST /admin/drain` (guarded) the server pauses schedulers, announces `server-draining` to SSE clients, closes SSE after `DRAIN_SSE_CLOSE_MS`, and flushes the BulkWriter

## Effective Config Snapshot

- `GET /config/effective` returns a sanitized snapshot of key flags/tunables (no secrets)

## Guarded Admin Endpoints

Enable with:

```
ADMIN_API_ENABLED=1
ADMIN_API_TOKEN=optional
```

Endpoints:

- `POST /admin/toggle-breaking` body `{ "enabled": boolean }` — kill-switch for Breaking lane (SSE unaffected)
- `POST /admin/clear-demotions` — clear demotion maps
- `POST /admin/drain` — initiate graceful drain

## Tier-1 Firestore BulkWriter

## Prometheus Exporter

- Endpoint: `GET /metrics-prom` (text/plain; version=0.0.4)
- Read-only; additive to existing `/metrics-lite`
- Includes gauges (readiness, SSE, BulkWriter), counters (HTTP 200/304, webhook/social), and quantiles (latency, exposure, render, ops)
- Example scrape config:

```
- job_name: pulse
  static_configs:
  - targets: ['localhost:4000']
  metrics_path: /metrics-prom
```

## Latency Profiler

- Generate synthetic traffic and profile end-to-end latency:

```
npm run synth:webhook:prn
npm run profile:latency
```

CSV and JSON summaries are written to backend/artifacts/. The profiler exits non-zero if SLO (p50 ≤ 60s, p90 ≤ 120s) fails.

## Load Test

Run a short load and assert SLO online:

```
LT_RPS=1 LT_DURATION_SEC=300 npm run load:breaking
```

### Latency Regression Guard (CI example)

```
- run: npm --prefix backend run build
- run: node backend/dist/index.js &
- run: npm --prefix backend run synth:webhook:prn
- run: npm --prefix backend run profile:latency
```

When enabled, Tier-1 lane writes use the official Firestore BulkWriter for higher throughput with robust retries and graceful shutdown. Other lanes remain unchanged.

Environment:

```
BULKWRITER_ENABLED=1
BULKWRITER_MAX_OPS_PER_SEC=500
```

Behavior:

- Retries retriable errors (aborted, deadline-exceeded, unavailable, internal) with capped attempts and jittered delay
- Graceful flush on shutdown to avoid lost writes
- Additive metrics: `/metrics-lite` includes `bulkwriter { enabled, enqueued, errors }`
- `/health` includes `bulkwriter_enabled`
- Disable by setting `BULKWRITER_ENABLED=0`

## Auto-Demote Hysteresis

The breaking scheduler supports stable auto-demotion with hysteresis, cool-down, and confidence-based re-entry.

Environment (new knobs; legacy BREAKING_DEMOTE_* remain supported as fallbacks):

```
DEMOTE_WINDOW_MIN=30                # evaluation window (min)
DEMOTE_THRESHOLD_MS=60000           # p50 to demote (fallback BREAKING_DEMOTE_P50_MS)
PROMOTE_THRESHOLD_MS=45000          # p50 to re-promote (lower than demote)
PROMOTE_MAX_P90_MS=90000            # optional p90 cap for re-entry
PROMOTE_MIN_SAMPLES=10              # min samples to consider re-entry
DEMOTE_MIN_COOLDOWN_MS=1800000      # base cool-down (ms)
DEMOTE_PENALTY_FACTOR=1.5           # multiplies cooldown per consecutive demotion
DEMOTE_MAX_COOLDOWN_MS=10800000     # cap (ms)
```

Behavior:

- Demote when p50 > threshold; compute cool-down with penalty factor; track consecutive demotes
- During cool-down, source remains excluded
- After cool-down, promote only if samples ≥ PROMOTE_MIN_SAMPLES and p50 ≤ PROMOTE_THRESHOLD_MS (and p90 ≤ PROMOTE_MAX_P90_MS if set)
- Additive surfacing:
  - `/health` includes `demote_policy`
  - `/metrics-lite` includes `demote_stats` with active and per-source until
  - Set `DEBUG_DEMOTE=1` to log transitions

## CI Gate

Use the soak test as a CI gate. Add:

```
npm run ci:soak
```

The script exits non-zero on FAIL.

Example (GitHub Actions) snippet (illustrative):

```yaml
jobs:
  pulse-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm --prefix backend ci
      - run: npm --prefix backend run build
      - run: |
          PORT=4000 USE_FAKE_FIRESTORE=1 RSS_TRANSPORT_V2=1 BREAKING_MODE=1 SSE_ENABLED=1 FASTLANE_ENABLED=1 \
          node backend/dist/index.js &
          sleep 5
      - run: npm --prefix backend run ci:soak
```


