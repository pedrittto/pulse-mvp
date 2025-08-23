#!/usr/bin/env node
// ESM script to compute historical publisher→pulse latency report
import fs from 'fs';
import path from 'path';

function toMs(iso){ try{ const t=Date.parse(iso); return Number.isFinite(t)?t:null }catch{ return null } }
function pct(arr, p){ if(!arr.length) return null; const i=Math.floor((arr.length-1)*p); return arr[i] }
function fmtMs(x){ return x==null?null:Number(x) }
function safeJson(s){ try{ return JSON.parse(s) }catch{ return null } }

// Discover inputs
const cwd = process.cwd(); // expect backend/ as CWD
const repoRoot = path.resolve(cwd, '..');
const diagFile = path.join(cwd, 'diagnostics', 'latency_samples.jsonl');
const altDiag = path.join(cwd, 'diagnostics', 'PULSE_LATENCY_SAMPLES.json');
const pm2Out = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2', 'logs', 'pulse-out.log');

// Load latency_samples.jsonl or alt JSON
const idToVisible = new Map(); // id -> { visible_at, source }
let sourcesCount = new Map();
let windowMin = null, windowMax = null;
if (fs.existsSync(diagFile)){
  const lines = fs.readFileSync(diagFile,'utf8').split(/\r?\n/).filter(Boolean);
  for(const line of lines){
    const j = safeJson(line); if(!j) continue;
    const id = j.id || null; const vis = j.visible_at || null; const src = j.source || null;
    if(!id || !vis) continue;
    // keep the latest visible_at per id
    const prev = idToVisible.get(id);
    if(!prev || (toMs(vis) || 0) >= (toMs(prev.visible_at) || 0)){
      idToVisible.set(id, { visible_at: vis, source: src });
    }
    const vt = toMs(vis); if(vt!=null){ if(windowMin==null||vt<windowMin) windowMin=vt; if(windowMax==null||vt>windowMax) windowMax=vt; }
    if(src){ sourcesCount.set(src, (sourcesCount.get(src)||0)+1); }
  }
} else if (fs.existsSync(altDiag)){
  const arr = safeJson(fs.readFileSync(altDiag,'utf8')) || [];
  for(const j of Array.isArray(arr)?arr:[]){
    const id = j.id || null; const vis = j.visible_at || null; const src = j.source || null;
    if(!id || !vis) continue;
    const prev = idToVisible.get(id);
    if(!prev || (toMs(vis) || 0) >= (toMs(prev.visible_at) || 0)){
      idToVisible.set(id, { visible_at: vis, source: src });
    }
    const vt = toMs(vis); if(vt!=null){ if(windowMin==null||vt<windowMin) windowMin=vt; if(windowMax==null||vt>windowMax) windowMax=vt; }
    if(src){ sourcesCount.set(src, (sourcesCount.get(src)||0)+1); }
  }
}

// Parse PM2 out log for SSE ingested_at events
const idToIngested = new Map(); // id -> ingested_at
if (pm2Out && fs.existsSync(pm2Out)){
  const lines = fs.readFileSync(pm2Out,'utf8').split(/\r?\n/);
  let inSse = false;
  let curId = null; let curIngested = null;
  for(const ln of lines){
    if(ln.includes('[sse][new]')){ inSse = true; curId=null; curIngested=null; continue; }
    if(inSse){
      const idm = ln.match(/id:\s*'([a-f0-9]{40})'/i); if(idm){ curId = idm[1]; }
      const im = ln.match(/ingested_at:\s*'([^']+)'/i); if(im){ curIngested = im[1]; }
      if(ln.trim().startsWith('}')){ // block end
        if(curId && curIngested){ idToIngested.set(curId, curIngested); }
        inSse=false; curId=null; curIngested=null;
      }
    }
  }
}

// Build rows
const rows = []; // {source,id,fetched_at,visible_at,delta_ms,join_method, sse_ms}
for (const [id, rec] of idToVisible.entries()){
  const visIso = rec.visible_at; const visMs = toMs(visIso);
  const ingIso = idToIngested.get(id) || null; const ingMs = ingIso ? toMs(ingIso) : null;
  // We do not have fetched_at (publisher→ingest) in probes; keep null
  const fetchedIso = null;
  let deltaMs = null; let joinMethod = 'sse_only';
  // sse-only: compute pulse→UI if ingested exists
  const sseMs = (visMs!=null && ingMs!=null) ? Math.max(0, visMs - ingMs) : null;
  rows.push({ source: rec.source || null, id, fetched_at: fetchedIso, visible_at: visIso, delta_ms: deltaMs, join_method: joinMethod, sse_ms: sseMs });
}

// Stats
const exactRows = rows.filter(r=>r.join_method==='exact').length;
const approxRows = rows.filter(r=>r.join_method==='approx').length;
const sseOnlyRows = rows.filter(r=>r.join_method==='sse_only').length;
const deltaVals = rows.map(r=>r.delta_ms).filter(v=>typeof v==='number').sort((a,b)=>a-b);
const sseVals = rows.map(r=>r.sse_ms).filter(v=>typeof v==='number').sort((a,b)=>a-b);

const overall = {
  p50: fmtMs(pct(deltaVals,0.5)), p90: fmtMs(pct(deltaVals,0.9)), p99: fmtMs(pct(deltaVals,0.99)), n: deltaVals.length
};
const sseAgg = {
  p50: fmtMs(pct(sseVals,0.5)), p90: fmtMs(pct(sseVals,0.9)), n: sseVals.length
};

// By source (top 5 by volume)
const topSources = Array.from(sourcesCount.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,_c])=>s);
const bySource = {};
for(const s of topSources){
  const d = rows.filter(r=>r.source===s && typeof r.delta_ms==='number').map(r=>r.delta_ms).sort((a,b)=>a-b);
  bySource[s] = { p50: fmtMs(pct(d,0.5)), p90: fmtMs(pct(d,0.9)), n: d.length };
}

// Write CSV
const artDir = path.join(repoRoot, 'ARTIFACTS');
try{ fs.mkdirSync(artDir, { recursive: true }); }catch{}
const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
const csvPath = path.join(artDir, `historical_latency_${dateStr}.csv`);
const header = ['source','id','fetched_at','visible_at','delta_ms','join_method'].join(',');
const csvLines = [header, ...rows.map(r=>[
  r.source||'', r.id, r.fetched_at||'', r.visible_at||'', (r.delta_ms==null?'':r.delta_ms), r.join_method
].map(v=>String(v).replace(/"/g,'""')).map(v=>/[,\n"]/.test(v)?`"${v}"`:v).join(','))];
fs.writeFileSync(csvPath, csvLines.join('\n'));

// Write report MD
const mdPath = path.join(artDir, 'HISTORICAL_LATENCY_REPORT.md');
const windowStr = (windowMin&&windowMax) ? `${new Date(windowMin).toISOString()} .. ${new Date(windowMax).toISOString()}` : 'unknown';
const filesUsed = [fs.existsSync(diagFile)?path.relative(repoRoot,diagFile):null, fs.existsSync(pm2Out)?path.relative(repoRoot,pm2Out):null].filter(Boolean);
const md = [];
md.push(`# Historical Latency Report`);
md.push(``);
md.push(`- Window: ${windowStr}`);
md.push(`- Files: ${filesUsed.join(', ')||'none'}`);
md.push(``);
md.push(`## Counts`);
md.push(`- Total rows: ${rows.length}`);
md.push(`- Rows with publisher→pulse delta_ms: ${overall.n}`);
md.push(``);
md.push(`## Publisher→Pulse (ms)`);
md.push(`- p50: ${overall.p50 ?? 'n/a'}`);
md.push(`- p90: ${overall.p90 ?? 'n/a'}`);
md.push(`- p99: ${overall.p99 ?? 'n/a'}`);
md.push(``);
md.push(`## Pulse→UI (SSE delivery, ms)`);
md.push(`- p50: ${sseAgg.p50 ?? 'n/a'} (n=${sseAgg.n})`);
md.push(`- p90: ${sseAgg.p90 ?? 'n/a'} (n=${sseAgg.n})`);
md.push(``);
md.push(`## Top 5 sources by volume (publisher→pulse)`);
for(const s of topSources){ const v = bySource[s]; md.push(`- ${s}: p50=${v.p50 ?? 'n/a'} p90=${v.p90 ?? 'n/a'} (n=${v.n})`); }
md.push(``);
md.push(`## Caveats`);
md.push(`- No per-item ingest timestamps were present in probes; computed Pulse→UI only from PM2 SSE logs (join_method=sse_only).`);
md.push(`- Publisher→Pulse could not be reconstructed from available history without ingest records.`);
fs.writeFileSync(mdPath, md.join('\n'));

// Console summary
const summary = [
  'HISTORICAL LATENCY',
  `window=${windowStr} files=[${filesUsed.join(' | ')}] exact_rows=${exactRows} approx_rows=${approxRows} sse_only=${sseOnlyRows}`,
  `publisher→pulse: p50=${overall.p50 ?? 'n/a'}ms p90=${overall.p90 ?? 'n/a'}ms p99=${overall.p99 ?? 'n/a'}ms (${overall.n} rows)`,
  `by-source (top 5): ${topSources.map(s=>`${s} ${bySource[s].p50 ?? 'n/a'}/${bySource[s].p90 ?? 'n/a'}`).join(' / ')}`,
  `pulse→UI: p50=${sseAgg.p50 ?? 'n/a'}ms p90=${sseAgg.p90 ?? 'n/a'}ms (${sseAgg.n} rows)`,
  `CSV=${path.relative(repoRoot, csvPath)} MD=${path.relative(repoRoot, mdPath)}`
].join('\n');

console.log(summary);


