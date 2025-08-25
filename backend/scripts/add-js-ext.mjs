#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'backend', 'src');
const exts = ['.js', '.json'];

function patch(content) {
  return content
    .replace(/\b(from\s+)["'](\.{1,2}\/[^"']+)["']/g, (m, from, sp) => {
      if (exts.some(e => sp.endsWith(e))) return m;
      return `${from}'${sp}.js'`;
    })
    .replace(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, (m, sp) => {
      if (exts.some(e => sp.endsWith(e))) return m;
      return `import('${sp}.js')`;
    });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) {
      const s = fs.readFileSync(p, 'utf8');
      const t = patch(s);
      if (t !== s) fs.writeFileSync(p, t);
    }
  }
}

walk(root);
console.log('Patched .js extensions where missing.');


