#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DC = path.join('housekeeping','DELETION_CANDIDATES.csv');
const GRAPH = path.join('housekeeping','USAGE_GRAPH.json');
const SCRIPTS = path.join('housekeeping','SCRIPTS_AUDIT.json');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

const graph = readJson(GRAPH) || { entrypoints: [], graph: {}, unreferenced: [] };
const scripts = readJson(SCRIPTS) || { npm_scripts: {}, shell_ps1_mjs: [], referenced_by: {} };

const rows = [];

// Heuristic 1: static unreferenced files
for (const file of graph.unreferenced || []) {
  if (!file.startsWith('backend/') && !file.startsWith('frontend/')) continue;
  // Keep known entry-like config and route files
  if (/\/app\//.test(file) && /(page\.tsx|layout\.tsx|route\.ts)$/.test(file)) continue;
  rows.push({
    path: file,
    area: file.startsWith('backend/') ? 'backend' : 'frontend',
    reason: 'Unreferenced in static graph',
    evidence: 'See housekeeping/USAGE_GRAPH.json#unreferenced',
    risk: 'medium',
    owner: '',
    undo_path: file,
    status: 'proposed'
  });
}

// Heuristic 2: scripts that are not referenced anywhere
const files = scripts.shell_ps1_mjs || [];
const refBy = scripts.referenced_by || {};
for (const f of files) {
  const refs = (refBy[f] || []).filter(p => !p.startsWith('housekeeping/'));
  if (refs.length === 0) {
    rows.push({
      path: f,
      area: 'scripts',
      reason: 'Script not referenced in repo',
      evidence: 'ReferencedBy=0 in SCRIPTS_AUDIT.json',
      risk: 'low',
      owner: '',
      undo_path: f,
      status: 'proposed'
    });
  }
}

// Write CSV fresh
const header = 'path,area,reason,evidence,risk,owner,undo_path,status\n';
const newLines = rows.map(r => [r.path,r.area,r.reason,r.evidence,r.risk,r.owner,r.undo_path,r.status].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
fs.mkdirSync('housekeeping', { recursive: true });
fs.writeFileSync(DC, header + newLines.join('\n') + (newLines.length?'\n':''));
console.log('Wrote', DC, 'count=', rows.length);
