# Pulse Backend

## Ingest Sources

Enable sources via env:

```
INGEST_SOURCES=businesswire,prnewswire,nasdaq_halts,nyse_notices,cme_notices,sec_press,fed_press

# Ingest URLs (override if needed; defaults baked in code)
PRN_RSS_URL=
BW_RSS_URL=
SEC_PRESS_URL=
NASDAQ_HALTS_URL=
NYSE_NOTICES_URL=
CME_NOTICES_URL=
FED_PRESS_URL=
```

By default, each adapter uses a safe built-in URL. Setting any of the env vars above overrides the default.
### `fed_press` (OFF by default)
First-party Federal Reserve Board “Press Releases” via official RSS.

Enable locally:
```powershell
cd backend
$env:INGEST_SOURCES='fed_press'
$env:FED_PRESS_URL='https://www.federalreserve.gov/feeds/press_all.xml'
npm run dev
```

Smoke test (fast):

Terminal A:
```powershell
cd backend
 
## Cost Safety Invariants

- Default `JOBS_ENABLED=false`. Ingest only runs when `JOBS_ENABLED=1` and `INGEST_SOURCES` is a non-empty list.
 - Legacy disable flag is not used anywhere.
- Absolute HTTP timeouts: RSS 0.9–1.5s; HTML ≤2s.
- Response body caps ≤ 0.8 MB; bodies are not logged.
- Global backoff on errors ≥30s with jitter; single in-flight per adapter.
- Default logging: `LOG_LEVEL=error`, `LOG_SAMPLING=0`. WARNs rate-limited ≥60s per key.
- `/health`, `/metrics-lite`, `/metrics-summary` do not trigger network fetches or schedulers.
- SSE publishes in-memory only; telemetry remains in-process (no external sinks).

$env:INGEST_SOURCES='businesswire,prnewswire,nasdaq_halts,nyse_notices,cme_notices,sec_press'
npm run dev
```

Expect within ~10–15s: each source prints start then tick … | not modified (or occasional 200), with no repeating “missing URL” messages.

Terminal B:
```powershell
$BASE='http://localhost:4000'
curl.exe -sS "$BASE/metrics-summary" > backend\ARTIFACTS\ms_local.json
node backend\scripts\sse_watch.mjs --path /sse/breaking --maxSeconds 60
type backend\ARTIFACTS\latency_samples.jsonl
```

Behavior matches other adapters: emit-first, 1–3 s clamps, ~900 ms HTTP timeout,
ETag/Last-Modified, LRU dedupe, identical metrics & SSE schema.

 


