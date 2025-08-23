# Pulse KPI Dashboard

Import `pulse_kpi_dashboard.json` into Grafana (Dashboards → Import). Set your Prometheus datasource and the dashboard variables will populate automatically.

Key panels and PromQL:

- Breaking SLO: `slo_breaking_ms{stat="p50"}`, `slo_breaking_ms{stat="p90"}`, and corrected variants.
- Publisher Latency per source: `publisher_latency_ms{quantile="0.5"}` (and `0.9`), group by source.
- Exposure & Client Render: `render_receive_ms{quantile="0.5|0.9"}`, `render_paint_ms{quantile="0.5|0.9"}`.
- SSE Clients: `sse_clients_connected`.
- Ingest Transport Mix: `http_conditional_200_total`, `http_conditional_304_total`, `webhook_emitted_total`, `social_emitted_total`.
- Ops: `eventloop_lag_ms{stat="p95"}`, `gc_pause_ms{stat="p95"}`, `cpu_pct{stat="p95"}`.
- Demotions & Eligibility: `demoted_sources_active`, `breaking_sources_eligible`.
- Clock Drift: `drift_global_p95_ms`.


