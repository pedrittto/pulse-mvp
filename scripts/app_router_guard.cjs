#!/usr/bin/env node
// Cross-platform App Router guard: forbid next/document, Document primitives,
// and <html>/<body> outside app/layout.tsx
const fs = require('node:fs');
const path = require('node:path');

if (String(process.env.GUARDS_ENABLED || '1') === '0') {
  console.log('[App Router Guard] Disabled via GUARDS_ENABLED=0');
  process.exit(0);
}

const CWD = process.cwd();
const isFrontendCwd = /(^|\\|\/)frontend$/.test(CWD.replace(/[/\\]+$/, ''));
const ROOT = isFrontendCwd ? path.dirname(CWD) : CWD;
const FRONTEND_DIR = isFrontendCwd ? CWD : path.join(ROOT, 'frontend');
const LAYOUT_PATH = path.join(FRONTEND_DIR, 'src', 'app', 'layout.tsx');
const IGNORED_DIR_REGEX = /(^|\\|\/)node_modules(\\|\/)|(^|\\|\/)\.next(\\|\/)|(^|\\|\/)\.firebase(\\|\/)/;
const INCLUDED_EXT_REGEX = /\.(tsx|ts|jsx|js|mdx)$/i;

/** @param {string} file */
function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** @param {string} dir */
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (IGNORED_DIR_REGEX.test(full)) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (INCLUDED_EXT_REGEX.test(entry.name)) {
      yield full;
    }
  }
}

const offenders = [];
function addOffender(message) { offenders.push(message); }

// Patterns
const nextDocumentImport = /from\s+["']next\/document["']|require\(["']next\/document["']\)/;
const documentPrimitives = /<\s*(Html|Head|Main|NextScript)\b/;
const htmlBodyTag = /<\s*(html|body)\b/;

if (!fs.existsSync(FRONTEND_DIR)) {
  console.log('[App Router Guard] Skipping: frontend directory not found at', FRONTEND_DIR);
  process.exit(0);
}

for (const file of walk(FRONTEND_DIR)) {
  const src = readFileSafe(file);
  if (!src) continue;

  if (nextDocumentImport.test(src)) {
    addOffender(`next/document import: ${file}`);
  }
  if (documentPrimitives.test(src)) {
    addOffender(`Document primitive (<Html|Head|Main|NextScript>): ${file}`);
  }
  if (htmlBodyTag.test(src) && path.resolve(file) !== path.resolve(LAYOUT_PATH)) {
    addOffender(`<html>/<body> outside app/layout.tsx: ${file}`);
  }
}

if (offenders.length > 0) {
  console.error('[App Router Guard] FAILED. Offenders detected:');
  for (const o of offenders) console.error(` - ${o}`);
  process.exit(1);
}
console.log('[App Router Guard] PASSED. No legacy artifacts detected.');
