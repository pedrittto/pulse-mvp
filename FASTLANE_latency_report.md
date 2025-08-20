FASTLANE Latency Report (2025-08-19T21:05:05.582Z)

Inputs
- Base URL: http://127.0.0.1:4000
- SSE events observed: 7

SSE Proxy Latency (now - ingested_at)
- count: 7
- p50: 2 ms
- p90: 7 ms
- min: 0 ms
- max: 7 ms
- PASS: true

Authoritative Pulse→Visible (from /metrics-summary, p50)
- p50: 389 ms
- PASS: true

Publisher→Ingest (per-source)
- sources: 3
- passing % (p50 ≤ 300000 ms): 0%
- failing sources: Bloomberg Breaking, MarketWatch Breaking, CNBC Breaking
- PASS: false

Mid-run health
- /health @ ~T+5m sse.clients: 1
- heartbeat gap > 45s observed: false
- reconnect used Last-Event-ID: 
- post-reconnect events observed: false

FINAL VERDICT: INCOMPLETE
Reasons: Publisher→Ingest SLO failed or unavailable