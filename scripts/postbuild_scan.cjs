#!/usr/bin/env node
// Scan compiled Next output for forbidden patterns
const fs = require('node:fs');
const path = require('node:path');

if (String(process.env.GUARDS_ENABLED || '1') === '0') {
  console.log('[postbuild_scan] Disabled via GUARDS_ENABLED=0');
  process.exit(0);
}

const CWD = process.cwd();
const isFrontendCwd = /(^|\\|\/)frontend$/.test(CWD.replace(/[/\\]+$/, ''));
const serverDir = isFrontendCwd
  ? path.join(CWD, '.next', 'server')
  : path.join(CWD, 'frontend', '.next', 'server');

if (!fs.existsSync(serverDir)) {
  console.log('[postbuild_scan] Skipped: directory not found:', serverDir);
  process.exit(0);
}

const IGNORED_DIR_REGEX = /(^|\\|\/)chunks(\\|\/cache)(\\|\/)/; // keep broad, but still scan chunks
const INCLUDED_EXT_REGEX = /\.(js|mjs|cjs|html|txt|json)$/i;

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

const patterns = [
  { re: /from\s+["']next\/document["']/, label: 'next/document import' },
  { re: /<\s*(Html|Head|Main|NextScript)\b/, label: 'Document primitive (<Html|Head|Main|NextScript>)' },
];

let found = [];
for (const file of walk(serverDir)) {
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch {}
  if (!content) continue;
  for (const p of patterns) {
    if (p.re.test(content)) {
      found.push(`${p.label}: ${file}`);
    }
  }
}

if (found.length > 0) {
  console.error('[postbuild_scan] Found forbidden patterns in compiled output:');
  for (const f of found) console.error(' - ' + f);
  process.exit(1);
}
console.log('[postbuild_scan] OK — no forbidden patterns in compiled output.');
