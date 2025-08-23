#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join('housekeeping','ENV_AUDIT.json');

const envRegex = /process\.env\.([A-Z0-9_]+)/g;
const definedEnvFiles = [
  path.join('backend','ENVIRONMENT.example'),
  path.join('frontend','env.example'),
  '.env', '.env.local'
];

function walk(dir, acc=[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    if (entry.name === 'node_modules') continue;
    if (['dist','build','.next','coverage','playwright-report'].includes(entry.name)) continue;
    if (dir.includes('_quarantine')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
}

function scanEnvUsages() {
  const files = walk(ROOT, [])
    .filter(f => /\.(ts|tsx|js|mjs|cjs)$/.test(f.replace(/\\/g,'/')));
  const used = new Map();
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    let m; let line=1; const lines = txt.split(/\r?\n/);
    for (const l of lines) {
      while ((m = envRegex.exec(l))) {
        const key = m[1];
        const arr = used.get(key) || [];
        arr.push({ file: path.relative(ROOT, f).replace(/\\/g,'/'), line });
        used.set(key, arr);
      }
      line++;
    }
  }
  return used;
}

function parseDefined() {
  const defined = new Set();
  for (const p of definedEnvFiles) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split(/\r?\n/);
    for (const ln of lines) {
      const m = /^\s*([A-Z0-9_]+)\s*=/.exec(ln);
      if (m) defined.add(m[1]);
    }
  }
  return defined;
}

const used = scanEnvUsages();
const defined = parseDefined();
const usedKeys = new Set(used.keys());
const usedButUndefined = [...usedKeys].filter(k => !defined.has(k));
const definedButUnused = [...defined].filter(k => !usedKeys.has(k));

const out = {
  summary: `Used=${usedKeys.size} Defined=${defined.size} UsedButUndefined=${usedButUndefined.length} DefinedButUnused=${definedButUnused.length}`,
  used: Object.fromEntries([...used.entries()]),
  defined: [...defined],
  used_but_undefined: usedButUndefined,
  defined_but_unused: definedButUnused
};

fs.mkdirSync('housekeeping', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('Wrote', OUT);
