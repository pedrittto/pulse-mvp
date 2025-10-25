// frontend/scripts/sanitize.mjs
import { readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

if (process.env.PREBUILD_SANITIZER_SKIP === "1") {
  console.log("[Sanitizer] SKIP requested via PREBUILD_SANITIZER_SKIP=1");
  process.exit(0);
}

const CWD = process.cwd(); // expected: .../frontend
const SRC_DIRS = [join(CWD, "src"), join(CWD, "app")]; // ONLY source trees
const CLEAN_DIRS = [join(CWD, ".next"), join(CWD, "out")];

// best-effort: remove stale artifacts so they can't be scanned by mistake
for (const d of CLEAN_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

const offenders = [];
const importDoc = /from\s+['"]next\/document['"]/;
const hasHtmlJsx = /<\s*Html\b/;

function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const fp = join(dir, ent.name);
    if (ent.isDirectory()) { walk(fp); continue; }
    const ext = extname(fp).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) continue;

    let txt = "";
    try { txt = readFileSync(fp, "utf8"); } catch { continue; }

    // Rule 1: forbid next/document import anywhere in src/app
    if (importDoc.test(txt)) offenders.push(`next/document import: ${fp}`);

    // Rule 2: <Html> JSX only matters in TSX/JSX (not strings in .js)
    if ((ext === ".tsx" || ext === ".jsx") && hasHtmlJsx.test(txt))
      offenders.push(`<Html> JSX in App Router: ${fp}`);

    // Rule 3: forbid legacy pages/_document|_error under src/app (rare)
    const low = fp.replace(/\\/g, "/").toLowerCase();
    if (low.includes("/pages/_document.") || low.includes("/pages/_error."))
      offenders.push(`pages/_document or pages/_error path: ${fp}`);
  }
}

for (const base of SRC_DIRS) walk(base);

if (offenders.length) {
  console.error("\n[Sanitizer] Disallowed Next.js API usage detected. Blocked before build.");
  for (const o of offenders) console.error(" - " + o);
  console.error("\nResolve: remove next/document imports, <Html> usage in TSX/JSX, and any pages/_document|_error files under src/ or app/.\n");
  process.exit(2);
}

console.log("[Sanitizer] OK — src/app clean.");
process.exit(0);
