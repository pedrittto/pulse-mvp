#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const PLAN = path.join('housekeeping','QUARANTINE_DRYRUN.txt');

if (!fs.existsSync(PLAN)) {
  console.error('Missing plan file:', PLAN);
  process.exit(1);
}

const txt = fs.readFileSync(PLAN,'utf8');
const lines = txt.split(/\r?\n/).filter(l => /=>/.test(l));

let moved = 0;
for (const line of lines) {
  const m = /(.*)\s*=>\s*(.*)\s*\[/.exec(line) || line.match(/^(.*)\s*=>\s*(.*)$/);
  if (!m) continue;
  const src = m[1].trim();
  const dest = m[2].trim();
  if (!src || !dest) continue;
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(src)) { console.warn('Skip missing:', src); continue; }
  fs.renameSync(src, dest);
  console.log('Moved', src, '->', dest);
  moved++;
}
console.log('Total moved:', moved);
