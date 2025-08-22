#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join('housekeeping','SCRIPTS_AUDIT.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function grepAll(pattern) {
  const results = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      if (['dist','build','.next','coverage','playwright-report','_quarantine'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else {
        const txt = fs.readFileSync(full, 'utf8');
        if (pattern.test(txt)) {
          results.push(path.relative(process.cwd(), full).replace(/\\/g,'/'));
        }
      }
    }
  }
  walk(process.cwd());
  return Array.from(new Set(results));
}

const pkgs = [ 'package.json', path.join('backend','package.json'), path.join('frontend','package.json') ];
const scripts = {};
for (const p of pkgs) {
  if (!fs.existsSync(p)) continue;
  const j = readJson(p); if (!j?.scripts) continue;
  scripts[p] = j.scripts;
}

// Enumerate script files
const scriptDirs = ['scripts', path.join('backend','scripts')];
const files = [];
for (const dir of scriptDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && /(\.ps1|\.sh|\.mjs|\.js)$/.test(e.name)) {
      files.push(path.join(dir, e.name).replace(/\\/g,'/'));
    }
  }
}

// Cross-reference usage by grepping for their paths or names
const referencedBy = {};
for (const f of files) {
  const base = path.basename(f);
  const re = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  referencedBy[f] = grepAll(re);
}

fs.mkdirSync('housekeeping', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary: 'Scripts audit', npm_scripts: scripts, shell_ps1_mjs: files, referenced_by: referencedBy }, null, 2));
console.log('Wrote', OUT);
