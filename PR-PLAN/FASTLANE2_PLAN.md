## Fast Lane Polling 2.0 — Minimal-Diff Plan (All Flags OFF by Default)

### Goals
- p50 1–3 s in hot windows for Tier-1 without reducing coverage
- Per-lane isolation, per-host token buckets, HTTP/2 + keep-alive, conditional GET, retries with jitter

### Flags (to add in .env.sample)
- FASTLANE_ENABLED=false
- FASTLANE_CLAMP_ACTIVE_MS=1000-2000
- FASTLANE_CLAMP_IDLE_MS=2000-5000
- FASTLANE_MAX_CONCURRENCY=12
- FASTLANE_PER_HOST_RPS=3
- REGULAR_CLAMP_MS=20000-30000
- LONGTAIL_CLAMP_MS=90000-180000
- LONGTAIL_ROUND_ROBIN_WINDOW_MS=600000
- HTTP2_ENABLED=false
- HTTP_KEEPALIVE_ENABLED=false
- HTTP_TIMEOUT_MS=2000
- HTTP_RETRY=2
- HTTP_RETRY_JITTER_MS=250
- DNS_CACHE_TTL_MS=120000
- DEMOTE_THRESHOLD_P50_MS=60000
- DEMOTE_429_RATE=0.05
- PROMOTE_STABLE_HOURS=24
- FASTLANE_PROBE=false
- COVERAGE_PROBE=false
- SSE_ENABLED=true
- FASTLANE_HOT_WINDOWS="08:00-22:00 Europe/Warsaw"
- MAX_AGE_FOR_BREAKING_MS=1800000

### File-Level Change List

- Lanes
  - `backend/src/ingest/breakingScheduler.ts`: introduce explicit lane configs for FASTLANE/REGULAR/LONGTAIL, plus per-lane queues and clamps (guarded by FASTLANE_ENABLED)
  - Add token buckets per host (FASTLANE_PER_HOST_RPS) with separate buckets per lane
  - Add Origins lane (guarded by ORIGINS_ENABLED) with tighter clamps and per-host tokens
  - Freshness gate via `MAX_AGE_FOR_BREAKING_MS` (guarded)

- Transport
  - `backend/src/http/transport.ts`: optional HTTP2 agent and keep-alive knobs; DNS cache TTL configurable; short timeouts and retries with jitter
  - Conditional GET already supported; ensure enabled via flags

- Coverage
  - Round-robin scheduler for LONGTAIL to guarantee ≥1 hit per 5–10 min per source window

- Auto-promote/demote
  - FSM in `breakingScheduler.ts` guarded by flags; cool-down 24h; thresholds on publisher_p50 and 429 rate

- Observability
  - Extend `/metrics-lite` with new nodes for per-lane queue depth, token bucket pressure; include probes when enabled
  - Add coverage probe (rolling 10 min) when COVERAGE_PROBE=1

### Exact Rollback Toggle
- Set `FASTLANE_ENABLED=false`, `HTTP2_ENABLED=false`, `HTTP_KEEPALIVE_ENABLED=false`, `HTTP_CONDITIONAL_GET=0` to fully revert to current behavior

### Test Plan
- Unit: token bucket timing, clamp jitter ranges, promote/demote FSM, conditional GET logic
- Integration: per-lane isolation under synthetic 429 storms; verify no cross-lane starvation
- Observability: metrics nodes appear; probes disabled by default


