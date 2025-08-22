#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DATE = '2025-08-22';
const CSV = path.join('housekeeping','DELETION_CANDIDATES.csv');
const OUT = path.join('housekeeping','QUARANTINE_DRYRUN.txt');

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  cells.push(cur);
  return cells.map(s => s.trim());
}

function shouldExclude(p) {
  const norm = p.replace(/\\/g,'/');
  if (norm.startsWith('housekeeping/')) return true;
  if (norm.startsWith('backend/scripts/')) return true; // latency tools
  if (/(^|\/)\.env(\.|$)/i.test(norm)) return true; // env files
  if (/firebase\.ts$/i.test(norm)) return true; // firebase configs
  return false;
}

if (!fs.existsSync(CSV)) {
  console.error('Missing', CSV);
  process.exit(1);
}

const lines = fs.readFileSync(CSV,'utf8').split(/\r?\n/).filter(l=>l.trim() && !l.startsWith('#'));
const rows = [];
for (const line of lines) {
  const [p, area, reason, evidence, risk, owner, undo, status] = parseCsvLine(line);
  if (!p || p === 'path') continue;
  rows.push({ p, area, reason, evidence, risk, owner, undo, status });
}

const plan = [];
for (const r of rows) {
  const p = r.p.replace(/\\/g,'/');
  if (shouldExclude(p)) continue;
  let base;
  if (p.startsWith('backend/')) base = `_quarantine/${DATE}/backend/`;
  else if (p.startsWith('frontend/')) base = `_quarantine/${DATE}/frontend/`;
  else base = `_quarantine/${DATE}/misc/`;
  const dest = base + p.replace(/^(backend\/|frontend\/)/,'');
  plan.push({ src: p, dest, reason: r.reason, evidence: r.evidence, risk: r.risk });
}

const linesOut = [];
linesOut.push(`Dry-run Quarantine Plan for ${DATE}`);
linesOut.push(`Exclusions: backend/scripts/**, housekeeping/**, .env*, firebase.ts`);
linesOut.push('');
linesOut.push(`Total candidates (after exclusions): ${plan.length}`);
linesOut.push('');
for (const it of plan) {
  linesOut.push(`${it.src} => ${it.dest} [${it.risk}] :: ${it.reason}`);
}

fs.writeFileSync(OUT, linesOut.join('\n'));
console.log('Wrote', OUT, 'count=', plan.length);
