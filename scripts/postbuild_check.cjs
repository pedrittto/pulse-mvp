#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

if (String(process.env.GUARDS_ENABLED || '1') === '0') {
  console.log('[postbuild_check] Disabled via GUARDS_ENABLED=0');
  process.exit(0);
}

const CWD = process.cwd();
const isFrontendCwd = /(^|\\|\/)frontend$/.test(CWD.replace(/[/\\]+$/, ''));
const serverDir = isFrontendCwd
  ? path.join(CWD, '.next', 'server')
  : path.join(CWD, 'frontend', '.next', 'server');

const pagesDir = path.join(serverDir, 'pages');

if (fs.existsSync(pagesDir)) {
  const entries = fs.readdirSync(pagesDir).filter((n) => n.endsWith('.js'));
  const allowed = new Set(['_error.js', '_app.js', '_document.js']);
  const unexpected = entries.filter((n) => !allowed.has(n));

  if (unexpected.length > 0) {
    console.error('❌ Detected unexpected Pages artifacts in compiled output:', unexpected.join(', '));
    process.exit(1);
  }

  // Only warn if the allowed fallbacks exist; rely on postbuild_scan to catch real violations
  if (entries.length > 0) {
    console.warn('⚠️ Pages compatibility artifacts present:', entries.join(', '), '\n    Relying on postbuild_scan to enforce no next/document primitives.');
  }
}

console.log('✅ No unexpected Pages artifacts detected.');
