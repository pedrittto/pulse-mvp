#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_MD = path.join('housekeeping','USAGE_GRAPH.md');
const OUT_JSON = path.join('housekeeping','USAGE_GRAPH.json');

const importRegex = /\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function walkFiles(dir) {
  const acc = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    if (['dist','build','.next','coverage','playwright-report','_quarantine'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) acc.push(...walkFiles(full));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

function resolveImport(srcFile, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = path.resolve(path.dirname(srcFile), spec);
    const candidates = ['', '.ts','.tsx','.js','.mjs','.cjs','/index.ts','/index.tsx','/index.js'];
    for (const ext of candidates) {
      const p = base + ext;
      if (fs.existsSync(p)) return path.relative(ROOT, p).replace(/\\/g,'/');
    }
  }
  // simple Next alias @/* for frontend
  if (spec.startsWith('@/')) {
    const p = path.join('frontend','src', spec.slice(2));
    const candidates = ['.ts','.tsx','.js'];
    for (const ext of candidates) {
      const fp = path.join(ROOT, p + ext);
      if (fs.existsSync(fp)) return path.relative(ROOT, fp).replace(/\\/g,'/');
    }
  }
  return spec; // external or unresolved
}

const files = walkFiles(ROOT).filter(f => f.includes('backend'+path.sep) || f.includes('frontend'+path.sep));
const graph = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g,'/');
  const txt = fs.readFileSync(f, 'utf8');
  const deps = new Set();
  let m;
  while ((m = importRegex.exec(txt))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    deps.add(resolveImport(f, spec));
  }
  graph[rel] = Array.from(deps);
}

// Entry points
const entrypoints = [];
if (fs.existsSync(path.join('backend','src','index.ts'))) entrypoints.push('backend/src/index.ts');
function collectNextEntrypoints(dir='frontend/src/app') {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectNextEntrypoints(full);
    else if (['page.tsx','layout.tsx','route.ts','middleware.ts','middleware.js','next.config.js'].includes(e.name)) {
      entrypoints.push(path.relative(ROOT, full).replace(/\\/g,'/'));
    }
  }
}
collectNextEntrypoints();

// Find unreferenced files (not reachable from entrypoints) via simple graph walk
const visited = new Set();
function dfs(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const deps = graph[file] || [];
  for (const d of deps) {
    // only follow repo-internal relative paths
    if (d.startsWith('backend/') || d.startsWith('frontend/')) dfs(d);
  }
}
for (const ep of entrypoints) dfs(ep);
const unreferenced = Object.keys(graph).filter(f => !visited.has(f) && (f.startsWith('backend/') || f.startsWith('frontend/')));

fs.mkdirSync('housekeeping', { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({ entrypoints, graph, unreferenced }, null, 2));

let md = fs.readFileSync(OUT_MD, 'utf8');
md += `\n\nStatic Graph Summary\n\n`;
md += `- Entrypoints: ${entrypoints.length}\n`;
md += `- Files analyzed: ${Object.keys(graph).length}\n`;
md += `- Unreferenced (static): ${unreferenced.length}\n`;
md += `\nUnreferenced files (sample):\n`;
md += unreferenced.slice(0, 200).map(f => `- ${f}`).join('\n');
md += `\n`;
fs.writeFileSync(OUT_MD, md);
console.log('Wrote', OUT_MD, 'and', OUT_JSON);
