#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join('housekeeping','ROUTES_AUDIT.json');

function walk(dir, filter) {
  const acc = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    if (['dist','build','.next','coverage','playwright-report','_quarantine'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) acc.push(...walk(full, filter));
    else if (!filter || filter.test(full)) acc.push(full);
  }
  return acc;
}

function findBackendRoutes() {
  const files = walk(path.join('backend','src'), /\.(ts|js)$/);
  const routes = [];
  const routeRegex = /router\.(get|post|put|delete|patch)\(['"]([^'"]+)/g;
  const appRegex = /app\.(get|post|put|delete|patch)\(['"]([^'"]+)/g;
  for (const f of files) {
    const txt = fs.readFileSync(f,'utf8');
    let m; while ((m = routeRegex.exec(txt))) routes.push({ method: m[1].toUpperCase(), path: m[2], file: path.relative(process.cwd(), f).replace(/\\/g,'/') });
    while ((m = appRegex.exec(txt))) routes.push({ method: m[1].toUpperCase(), path: m[2], file: path.relative(process.cwd(), f).replace(/\\/g,'/') });
  }
  // Deduplicate
  const key = r => `${r.method} ${r.path}`;
  const dedup = Object.values(routes.reduce((o,r)=>{o[key(r)] = o[key(r)]||r; return o;},{}));
  return dedup;
}

function findFrontendCalls() {
  const files = walk(path.join('frontend','src'), /\.(ts|tsx|js)$/);
  const calls = [];
  const fetchRegex = /fetch\(\s*[`'"]([^`'"]+)/g;
  for (const f of files) {
    const txt = fs.readFileSync(f,'utf8');
    let m; while ((m = fetchRegex.exec(txt))) {
      calls.push({ url: m[1], file: path.relative(process.cwd(), f).replace(/\\/g,'/') });
    }
  }
  return calls;
}

const backendRoutes = findBackendRoutes();
const frontendCalls = findFrontendCalls();

// Linkage heuristic: if frontend call contains '/api/feed', map to Next proxy which calls backend '/feed'
const linkage = [];
for (const c of frontendCalls) {
  if (c.url.includes('/api/feed')) linkage.push({ from: c.file, via: '/api/feed', to: '/feed' });
  if (c.url.includes('/sse/new-items')) linkage.push({ from: c.file, to: '/sse/new-items' });
  if (c.url.includes('/beacon/render')) linkage.push({ from: c.file, to: '/beacon/render' });
}

fs.mkdirSync('housekeeping', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary: 'Routes audit', backend_routes: backendRoutes, frontend_calls: frontendCalls, linkage }, null, 2));
console.log('Wrote', OUT);
