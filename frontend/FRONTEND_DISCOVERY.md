## Toolchain & Versions

- Node: v22.17.1
- pnpm: 9.15.9
- Next.js: 15.5.2

Command outputs:

```bash
node -v
v22.17.1

pnpm -v
9.15.9

pnpm -C frontend list next --depth 0
Legend: production dependency, optional only, dev only

frontend@0.1.0 C:\Users\piotr\Desktop\pulse-mvp\frontend (PRIVATE)

dependencies:
next 15.5.2
```

- Tailwind: none
- PostCSS: none

```bash
[ -f frontend/tailwind.config.ts ] && cat frontend/tailwind.config.ts || echo "no tailwind"
no tailwind

[ -f frontend/postcss.config.js ] && cat frontend/postcss.config.js || echo "no postcss"
no postcss
```

- ESLint/TypeScript in use:
  - eslint: ^9
  - eslint-config-next: 15.5.2
  - typescript: ^5

ESLint config (rules include react-hooks):

```1:31:frontend/eslint.config.mjs
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];

export default eslintConfig;
```

---

## Build/Deploy Scripts

package.json scripts:

```1:30:frontend/package.json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "lint": "next lint"
  },
  "dependencies": {
    "firebase": "^12.3.0",
    "next": "15.5.2",
    "react": "19.1.0",
    "react-dom": "19.1.0"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "cross-env": "^10.0.0",
    "eslint": "^9",
    "eslint-config-next": "15.5.2",
    "typescript": "^5"
  },
  "engines": {
    "node": ">=18.17.0"
  }
}
```

- Clean step: not present (does not clear `.next`/`out` before build).
- Export: not explicitly scripted, but `next.config.ts` sets `output: "export"`, which triggers static export during `next build`.
- Deploy gating: not defined here; Firebase deploy is configured via `frontend/firebase.json`. No evidence of an automated step that blocks deploy on failed build within package scripts.

Firebase hosting config:

```1:7:frontend/firebase.json
{
  "hosting": {
    "public": "out",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "cleanUrls": true
  }
}
```

---

## Project Structure (App Router sanity)

Tree of `frontend/src/app` (files up to 2 levels deep):

```bash
app/error.tsx
app/favicon.ico
app/global-error.tsx
app/globals.css
app/layout.tsx
app/not-found.tsx
app/page.module.css
app/page.tsx
app/components\MetricsBar.tsx
app/components\NewsCard.tsx
```

Notes:
- Directories present: `frontend/src/app/404`, `frontend/src/app/500` (appear as directories in tree; no files listed in the two-level file dump). These are non-standard for App Router. App Router expects `not-found.tsx` and `error.tsx`/`global-error.tsx`, not route folders `404/` or `500/`.

Legacy artifacts search:

- `pages/` directories: none found (excluding node_modules/.next/.firebase).
- `_document.*` files: none found.
- Global grep for `next/document` and Document primitives: no matches in source.

```bash
find frontend -type d -name pages  # none
find frontend -type f (_document.*) # none
grep ... 'next/document' | '<Html|<Head|NextScript|Main' # no matches
```

---

## Case-Sensitivity Risks

Imports under `src/app` that reference `./components`:

```bash
frontend/src/app/page.tsx:3:import NewsCard from "./components/NewsCard";
frontend/src/app/page.tsx:4:import MetricsBar from "./components/MetricsBar";
```

Component filenames:

```bash
MetricsBar.tsx
NewsCard.tsx
```

Assessment: import paths match file casing; no offenders detected.

---

## React Hooks Hygiene

Hook usages (quick scan):

```bash
frontend/src/app/page.tsx
114:  useEffect(() => {
128:  useEffect(() => {
134:  useEffect(() => {
219:  const normalizedTerms = useMemo(
224:  const filtered = useMemo(() => {

frontend/src/app/components/MetricsBar.tsx
40:  useEffect(() => {
87:  const sseSummary = useMemo(() => {
```

Previously observed compile error (hooks rule):

```bash
./src/app/page.tsx
236:27  Error: React Hook "useMemo" is called conditionally. React Hooks must be called in the exact same order in every component render. Did you accidentally call a React Hook after an early return?  react-hooks/rules-of-hooks
241:20  Error: React Hook "useMemo" is called conditionally. React Hooks must be called in the exact same order in every component render. Did you accidentally call a React Hook after an early return?  react-hooks/rules-of-hooks
```

Additional build warnings (not fatal):

```bash
./src/app/components/MetricsBar.tsx
70:16  Warning: 'e' is defined but never used.  @typescript-eslint/no-unused-vars

./src/app/page.tsx
69:9  Warning: 'esRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
70:9  Warning: 'reconnectTimerRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
71:9  Warning: 'backoffMsRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
75:9  Warning: 'SSE_URL' is assigned a value but never used.  @typescript-eslint/no-unused-vars
78:33  Warning: Unexpected any. Specify a different type.  @typescript-eslint/no-explicit-any
```

---

## Runtime Integration

Next config (export enabled):

```1:6:frontend/next.config.ts
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};
export default nextConfig;
```

TypeScript config (includes/excludes):

```1:46:frontend/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": [
      "dom",
      "dom.iterable",
      "esnext"
    ],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": [
        "./src/*"
      ]
    },
    "esModuleInterop": true
  },
  "include": [
    "next-env.d.ts",
    "src/**/*.{ts,tsx}",
    ".next/types/**/*.ts"
  ],
  "exclude": [
    "node_modules",
    ".next",
    "out",
    "**/*.bak",
    "src.bak",
    "dist",
    "scripts"
  ]
}
```

Repo artifacts:
- `.firebase/hosting.b3V0.cache` is tracked and modified per earlier git status (frontend/.firebase/...); hosting cache files should generally be ignored.

ENV file presence:
- `frontend/.env.production.local`: NOT FOUND (read attempt failed). Required keys per target state:
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_SSE_PATH`
  - `NEXT_PUBLIC_METRICS_PATH`
  - `NEXT_PUBLIC_FIREBASE_*`

Value verification: Blocked (requires env file).

---

## UI Surface (MVP features present?)

- Firestore hydration (last N): not detected. No firebase/firestore imports or usage found under `src/app/**`.

- SSE subscription (live with auto-reconnect): present in `frontend/src/app/page.tsx`.
  - EventSource creation and handlers:

```146:154:frontend/src/app/page.tsx
    const sseUrl = `${API_BASE}${SSE_PATH}`;

    const open = () => {
      // Only one live EventSource per tab
      if (es || (typeof window !== "undefined" && window.__PULSE_SSE__)) return;
      setConn("reconnecting");
      const next = new EventSource(sseUrl);
      es = next;
      if (typeof window !== "undefined") window.__PULSE_SSE__ = next;
```

  - Auto-reconnect with backoff/jitter, network online listener, and window-level singleton guard are implemented within a `useEffect`.

- Search: present in `frontend/src/app/page.tsx` via `query` state and filtered list.

```241:253:frontend/src/app/page.tsx
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
    const withHit = base.map((it) => ({ it, hit: normalizedTerms.some((t) => t && it.title.toLowerCase().includes(t)) }));
    withHit.sort((a, b) => {
      if (priorityFirst) {
        const pd = Number(b.hit) - Number(a.hit);
        if (pd !== 0) return pd;
      }
      return (b.it.visible_at_ms ?? 0) - (a.it.visible_at_ms ?? 0);
    });
    return withHit;
  }, [items, query, normalizedTerms, priorityFirst]);
```

- Priority float (60 min): partial. There's priority-first sorting and term matching, but no explicit 60-minute floating window logic detected. Items are primarily sorted by `priorityFirst` and `visible_at_ms`.

- Metrics badge: present as `MetricsBar` component polling `base + path` (default `/metrics-summary`).

```55:70:frontend/src/app/components/MetricsBar.tsx
    const load = async () => {
      if (aborted) return;
      try {
        setError(null);
        const res = await fetch(endpoint, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 429) {
          setError("Rate limited: backing off…");
          const delay = RL_BACKOFF_MS + Math.floor(Math.random() * RL_JITTER_MS);
          schedule(delay);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as MetricsSummary;
        if (!aborted) setData(json);
        schedule(DEFAULT_POLL_MS);
      } catch (e) {
        if (aborted) return;
        const delay = ERROR_BACKOFF_MS + Math.floor(Math.random() * 5_000);
        schedule(delay);
      }
    };
```

Props/state boundaries: `MetricsBar` receives `{ base, path }` props; `page.tsx` owns SSE, filtering, and UI state. Hot path is straightforward; network operations are in effects.

---

## Build Repro Status

Build command attempted (PowerShell environment):

```bash
pnpm -C frontend -s build
```

Initial failure (Hooks rule):

```text
Failed to compile.

./src/app/components/MetricsBar.tsx
70:16  Warning: 'e' is defined but never used.  @typescript-eslint/no-unused-vars

./src/app/page.tsx
69:9  Warning: 'esRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
70:9  Warning: 'reconnectTimerRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
71:9  Warning: 'backoffMsRef' is assigned a value but never used.  @typescript-eslint/no-unused-vars
75:9  Warning: 'SSE_URL' is assigned a value but never used.  @typescript-eslint/no-unused-vars
78:33  Warning: Unexpected any. Specify a different type.  @typescript-eslint/no-explicit-any
236:27  Error: React Hook "useMemo" is called conditionally. React Hooks must be called in the exact same order in every component render. Did you accidentally call a React Hook after an early return?  react-hooks/rules-of-hooks
241:20  Error: React Hook "useMemo" is called conditionally. React Hooks must be called in the exact same order in every component render. Did you accidentally call a React Hook after an early return?  react-hooks/rules-of-hooks
```

Subsequent failures (static export step):

```text
Generating static pages (0/5) ...
Error: <Html> should not be imported outside of pages/_document.
Read more: https://nextjs.org/docs/messages/no-document-import-in-page
    at x (C:\Users\piotr\Desktop\pulse-mvp\frontend\.next\server\chunks\47.js:6:1351)
Error occurred prerendering page "/404". Read more: https://nextjs.org/docs/messages/prerender-error
Error: <Html> should not be imported outside of pages/_document.
Read more: https://nextjs.org/docs/messages/no-document-import-in-page
    at x (C:\Users\piotr\Desktop\pulse-mvp\frontend\.next\server\chunks\47.js:6:1351)
Export encountered an error on /_error: /404, exiting the build.
```

Another run observed:

```text
Error occurred prerendering page "/500". Read more: https://nextjs.org/docs/messages/prerender-error
TypeError: Cannot read properties of null (reading 'useContext')
    at B (C:\Users\piotr\Desktop\pulse-mvp\frontend\.next\server\chunks\637.js:6:57582) {
  digest: '3866684996'
}
Export encountered an error on /500/page: /500, exiting the build.
```

Trace attempt for `next/document` within build output:
- Error references `.next/server/chunks/47.js` but project source grep shows no `next/document` imports or `Html/Head/Main/NextScript` usage. Root cause likely indirect (see Risks).

If build passes: Blocked (requires successful build) to list generated routes and size table.

---

## Risk Summary & Prioritized Fix Plan

1. Static export failing with "<Html> should not be imported ..." while prerendering `/404` (and intermittently `/500`).
   - Suspected cause: Non-App-Router 404/500 artifacts present as directories (`frontend/src/app/404`, `frontend/src/app/500`) and/or an upstream usage of Document primitives. Source grep shows no `next/document` usage; error stems from exported build code.
   - Minimal fix: Remove/empty `app/404` and `app/500` directories entirely; ensure only `app/not-found.tsx`, `app/error.tsx` (and `app/global-error.tsx` with lowercase `<html><body>`) exist. Rebuild. If persists, search entire repo (including non-TS assets) for `Html|Head|Main|NextScript` and verify no third-party usage in client components.

2. Hooks order violation in `frontend/src/app/page.tsx` (conditional `useMemo` after early return) previously caused build fail.
   - Minimal fix: Ensure all hooks are declared before any conditional return; move `useMemo` invocations above the early return and short-circuit inside the hook callback.

3. `.firebase/**` hosting cache tracked in repo (e.g., `frontend/.firebase/hosting.b3V0.cache`).
   - Minimal fix: Add `.firebase/` to `.gitignore` and remove cached files from version control.

4. Build script does not clean artifacts or explicitly export.
   - Minimal fix: Update `frontend/package.json` scripts:
     - `build`: `rimraf .next out && next build` (export is auto via `output: 'export'`). Ensure CI/deploy aborts on non-zero.

5. Missing `frontend/.env.production.local` with required `NEXT_PUBLIC_*` keys.
   - Minimal fix: Create the env file with:
     - `NEXT_PUBLIC_API_BASE_URL=https://<cloud-run pulse-web>`
     - `NEXT_PUBLIC_SSE_PATH=/sse/breaking`
     - `NEXT_PUBLIC_METRICS_PATH=/metrics-summary`
     - `NEXT_PUBLIC_FIREBASE_*` (web config)
   - Then validate CORS for `https://pulse-adc8d.web.app` on backend.

Design system recommendation:
- Tailwind/shadcn: Not present. Current minimal CSS is acceptable for MVP. Consider adopting Tailwind + shadcn/ui later for velocity, but not required to unblock build/deploy.

---

## Blocked (requires build)

- Generated routes and size table from a successful `next build` (with `output: 'export'`).
- Mapping `.next/server/chunks/*.js` to original sources via sourcemaps to pinpoint origin of the `<Html>` error (current evidence points to no direct usage in project source).

---

## Appendix: App Router baseline files

Key App Router files verified present (lowercase `<html><body>` where required):

```6:12:frontend/src/app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```1:13:frontend/src/app/error.tsx
"use client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void; }) {
  return (
    <main style={{ padding: 24 }}>
      <h1>Something went wrong</h1>
      <pre style={{ whiteSpace: "pre-wrap" }}>{String(error?.message ?? "Unknown error")}</pre>
      <button onClick={reset} style={{ marginTop: 12 }}>Try again</button>
    </main>
  );
}
```

```1:15:frontend/src/app/global-error.tsx
"use client";
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void; }) {
  return (
    <html>
      <body style={{ padding: 24 }}>
        <h1>App Error</h1>
        <pre style={{ whiteSpace: "pre-wrap" }}>{String(error?.message ?? "Unknown error")}</pre>
        <button onClick={reset} style={{ marginTop: 12 }}>Reload</button>
      </body>
    </html>
  );
}
```

```1:7:frontend/src/app/not-found.tsx
export default function NotFound() {
  return (
    <main style={{padding:24}}>
      <h1>404 — Not Found</h1>
    </main>
  );
}
```


