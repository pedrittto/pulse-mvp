# Backend logging and ingest guards

Safe defaults and env flags to reduce log volume under failures without affecting healthy-path cadence.

## Defaults

- LOG_LEVEL=error
- LOG_SAMPLING=0
- LOG_MAX_PER_LOOP=5
- WARN_COOLDOWN_MS=60000
- BACKOFF_FAIL_MS=30000
- LAG_WARN_COOLDOWN_MS=60000
- BOOT_PROBE_LOGS=0
- JOBS_ENABLED=0 (explicitly enable) 
- INGEST_SOURCES="" (explicit list required to start ingest or set JOBS_ENABLED=1)

## Behavior

- Jobs start only when `JOBS_ENABLED=1` or `INGEST_SOURCES` is non-empty. Heavy sources are not auto-enabled.
- Adapters classify outcomes and back off on any failure (5xx/network/other 4xx) using `BACKOFF_FAIL_MS`.
- WARNs in ingest loops are rate-limited to ≤1/min/source via `WARN_COOLDOWN_MS` and replaced by counters in `/metrics-lite`.
- Event loop watchdog emits on edge and then respects `LAG_WARN_COOLDOWN_MS`.
- Boot-time request probe logs are disabled unless `BOOT_PROBE_LOGS=1`.

## Local failure smoke

Set env:

```
JOBS_ENABLED=1
INGEST_SOURCES=["prnewswire"]
BACKOFF_FAIL_MS=30000
WARN_COOLDOWN_MS=60000
LAG_WARN_COOLDOWN_MS=60000
```

Simulate failure by pointing PRN_RSS_URL to an invalid host or blocking with a firewall. Observe:

- Before (baseline): WARN ~ every 1–2s.
- After: first WARN immediate, then ≤1/min; next delay ≥30s; `/metrics-lite` shows outcome counters increasing.


