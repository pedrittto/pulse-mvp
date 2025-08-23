Usage/Dependency Graph (Pass #1 - Static)

Overview
- This document will be auto-populated by `housekeeping/scripts/audit-graph.mjs` with:
  - File-level import graph for `backend/**` and `frontend/**`
  - Entry points (Next.js app pages/layouts/routes, backend server entry)
  - Unreferenced files/exports (static only)

Entrypoints Considered
- Backend: `backend/src/index.ts`
- Frontend: Next.js App Router files in `frontend/src/app/**`:
  - `page.tsx`, `layout.tsx`, `route.ts`, and middleware/config

Notes
- Dynamic imports and runtime `require()` paths may evade static detection; discrepancies will be reported in `DELETION_CANDIDATES.csv` with risk=medium.
- Runtime loading verification is scoped to mock mode only. If unavailable, only static results are provided.

[placeholder for graph output]




Static Graph Summary

- Entrypoints: 11
- Files analyzed: 144
- Unreferenced (static): 64

Unreferenced files (sample):
- backend/jest.config.js
- backend/scripts/backfillFacts.ts
- backend/scripts/confirmFastlaneFreshLatency.mjs
- backend/scripts/confirmMultiSourceLatency.mjs
- backend/scripts/generate-latency-report.js
- backend/scripts/load-breaking.js
- backend/scripts/poke-scheduler.js
- backend/scripts/print-config.js
- backend/scripts/print-drift.js
- backend/scripts/print-endpoints.js
- backend/scripts/print-ops.js
- backend/scripts/print-prom.js
- backend/scripts/print-render-metrics.js
- backend/scripts/print-social.js
- backend/scripts/probe-sources.js
- backend/scripts/profile-latency.js
- backend/scripts/smoke-breaking.js
- backend/scripts/soak-breaking.js
- backend/scripts/test-webhook.js
- backend/scripts/verify-feed-indexes.js
- backend/scripts/verify-sse-replay.js
- backend/scripts/verify-warmup.js
- backend/src/config/firebase.ts
- backend/src/http/transport.ts
- backend/src/ingest/twitterStub.ts
- backend/src/ingest/xmlWorker.ts
- backend/src/utils/confidenceV2.ts
- backend/src/utils/confirmations.ts
- backend/src/utils/contentFit.ts
- backend/src/utils/marketProxy.ts
- backend/src/_ingest/breakingScheduler.ts
- backend/test/admin-auth.test.ts
- backend/test/api-debug.test.ts
- backend/test/breakingIngest.test.ts
- backend/test/breakingScheduler.test.ts
- backend/test/confidenceV2.test.ts
- backend/test/confidenceV22.test.ts
- backend/test/factComposer.test.ts
- backend/test/feed.test.ts
- backend/test/helpers/env.ts
- backend/test/helpers/mocks.ts
- backend/test/helpers/setup.ts
- backend/test/impact.test.ts
- backend/test/impactV2.test.ts
- backend/test/impactV3.test.ts
- backend/test/metrics-lite.test.ts
- backend/test/rss-concurrency.test.ts
- backend/test/rss-date-url.test.ts
- backend/test/server-listen.test.ts
- backend/test/storage.test.ts
- backend/test/verification.test.ts
- frontend/jest.config.js
- frontend/next-env.d.ts
- frontend/next.config.js
- frontend/playwright.config.ts
- frontend/postcss.config.js
- frontend/src/components/VerificationBadge.tsx
- frontend/src/components/WatchlistModal.tsx
- frontend/src/lib/fetcher.spec.ts
- frontend/src/lib/time.test.ts
- frontend/src/lib/utils.ts
- frontend/src/types/index.ts
- frontend/src/__e2e__/open-source.spec.ts
- frontend/tailwind.config.js
