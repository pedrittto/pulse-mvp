### RCA: Export error "<Html> should not be imported outside of pages/_document" on /404

- Root cause: build instability and stale artifacts occasionally preserved a compiled chunk referencing `next/document` primitives. No active source files imported `next/document`, but missing clean step and inconsistent environment allowed old chunks to persist and be picked up during prerender of `/404`.
- Contributing factors:
  - No real clean before builds; Next cache and `.next` directory persisted between runs.
  - Prebuild guard previously missed some patterns and only ran on PowerShell.
  - Non-standard `NODE_ENV` and Windows path differences affected guard behavior.
  - Postbuild checks did not scan compiled output.

#### Fixes implemented
- Cross-platform guard (`scripts/app_router_guard.cjs`) scanning all `frontend` sources for:
  - `next/document` imports
  - `<Html|Head|Main|NextScript>` usage
  - `<html>/<body>` usage outside `app/layout.tsx`
- ESLint rules to prevent regressions:
  - `no-restricted-imports` for `next/document`
  - `no-restricted-syntax` forbidding document primitives; allowed in `src/app/layout.tsx`
- Real clean step using `rimraf` and wired into `prebuild` and `build:diag`.
- Postbuild compiled-output scan (`scripts/postbuild_scan.cjs`) to detect forbidden patterns in `.next/server/**`.
- Postbuild Pages-artifact check (`scripts/postbuild_check.cjs`) to ensure only benign compatibility files exist.
- Diagnostic build (`build:diag`) with `NEXT_CACHE_DISABLED=1`, `NEXT_TELEMETRY_DISABLED=1`, and `NODE_ENV=production`.
- CI workflow (`.github/workflows/ci-smoke.yml`) running the diagnostic build on PRs and main.

#### Outcome
- `pnpm -C frontend run build:diag` and `pnpm -C frontend run build` both succeed locally on Windows.
- Guard and scans report no forbidden `next/document` or `<Html>` in sources or compiled output.
- Future regressions will fail fast in lint, guard, postbuild scan, and CI.
