#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function parseArgs(){
  const args = process.argv.slice(2);
  const out = { window: '72h' };
  for (let i=0;i<args.length;i++){
    const a=args[i]; if(a==='--window' && args[i+1]){ out.window=args[++i]; }
  }
  return out;
}
function toMs(val){ if(val==null) return null; if(typeof val==='number') return Number.isFinite(val)?val:null; const s=String(val).trim(); if(/^\d{10,}$/.test(s)) return s.length>13?Math.floor(Number(s)/1e3):Number(s); const t=Date.parse(s); return Number.isFinite(t)?t:null; }
function pct(sorted, p){ if(!sorted.length) return null; const i=Math.floor((sorted.length-1)*p); return sorted[i]; }
function safeJson(s){ try{ return JSON.parse(s) }catch{ return null } }
function sizeOf(f){ try{ const st=fs.statSync(f); return { size: st.size, mtime: st.mtime.toISOString() }; }catch{ return null } }
function parseWindowSpec(w){ const m=String(w||'72h').match(/^(\d+)([smhd])$/i); if(!m) return 72*60*60*1000; const n=Number(m[1]); const u=m[2].toLowerCase(); return n * (u==='s'?1000:u==='m'?60000:u==='h'?3600000:86400000); }

const args = parseArgs();
const repoRoot = process.cwd();
const diagDirCandidates = [path.join(repoRoot,'backend','diagnostics'), path.join(repoRoot,'diagnostics')];
const diagBase = diagDirCandidates.find(d=>fs.existsSync(d)) || diagDirCandidates[0];
const diagFiles = [path.join(diagBase,'latency_samples.jsonl'), path.join(diagBase,'latency_samples.jsonl.1'), path.join(diagBase,'latency_samples.jsonl.2')].filter(f=>fs.existsSync(f));
const pm2Dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2','logs');
const pm2Files = fs.existsSync(pm2Dir) ? fs.readdirSync(pm2Dir).filter(f=>/^pulse-(out|error)(?:-\d+)?\.log$/i.test(f)).map(f=>path.join(pm2Dir,f)) : [];

const windowMs = parseWindowSpec(args.window);
const nowMs = Date.now();
const cutoffMs = nowMs - windowMs;

const earliestFetched = new Map(); // id -> ms
const earliestVisible = new Map(); // id -> ms
const sourceById = new Map();
const internalRows = []; // accept->SSE rows
let winMin = null, winMax = null;

function considerFetched(id, src, t){ if(!id||t==null) return; if(!earliestFetched.has(id) || t < earliestFetched.get(id)) earliestFetched.set(id, t); if(src && !sourceById.has(id)) sourceById.set(id, src); winMin = (winMin==null||t<winMin)?t:winMin; winMax=(winMax==null||t>winMax)?t:winMax; }
function considerVisible(id, src, t){ if(!id||t==null) return; if(!earliestVisible.has(id) || t < earliestVisible.get(id)) earliestVisible.set(id, t); if(src && !sourceById.has(id)) sourceById.set(id, src); winMin = (winMin==null||t<winMin)?t:winMin; winMax=(winMax==null||t>winMax)?t:winMax; }

// Read JSONL files (tolerant, tail entire file; rely on process writer to rotate at ~50MB)
for (const f of diagFiles){
  try {
    const data = fs.readFileSync(f,'utf8');
    for (const line of data.split(/\r?\n/)){
      if(!line) continue; const j=safeJson(line); if(!j) continue;
      const id = j.id; const src = j.source || null;
      const fat = toMs(j.fetched_at_ms ?? j.first_seen_ms ?? j.fetched_at ?? null);
      const vat = toMs(j.visible_at_ms ?? j.visible_at ?? null);
      const dmono = (j.delta_mono_ms!=null && Number.isFinite(Number(j.delta_mono_ms))) ? Number(j.delta_mono_ms) : null;
      const dwall = (j.delta_ms!=null && Number.isFinite(Number(j.delta_ms))) ? Number(j.delta_ms) : null;
      if (fat!=null && fat>=cutoffMs) considerFetched(id, src, fat);
      if (vat!=null && vat>=cutoffMs) considerVisible(id, src, vat);
      if (vat!=null && (dmono!=null || dwall!=null)){
        const acceptTs = (dmono!=null) ? (vat - dmono) : (dwall!=null ? (vat - dwall) : null);
        if (acceptTs!=null) internalRows.push({ id, source: src, accept_ts: acceptTs, visible_at_ms: vat, delta_ms: (dmono!=null?dmono:dwall) });
      }
    }
  } catch {}
}

// PM2 logs fallback to infer fetched_at when JSONL insufficient
const fetchDoneRe = /FETCH_DONE[^\n]*?id\s*[:=]\s*['\"]?([a-f0-9]{40})['\"]?[^\n]*?fetched_at\s*[:=]\s*['\"]?([^'"\s}]+)['\"]?/i;
for (const f of pm2Files){
  try {
    const data = fs.readFileSync(f,'utf8');
    for (const line of data.split(/\r?\n/)){
      const m = line.match(fetchDoneRe); if (!m) continue;
      const id = m[1]; const ts = toMs(m[2]); if(ts==null) continue; if (ts >= cutoffMs) considerFetched(id, null, ts);
    }
  } catch {}
}

function computeJoins(){
  const rows = [];
  for (const [id, vms] of earliestVisible.entries()){
    const fms = earliestFetched.get(id);
    if (fms==null) continue;
    const d = vms - fms; if (!(d>=0 && d <= 24*60*60*1000)) continue;
    const src = sourceById.get(id) || null;
    rows.push({ id, source: src, fetched_at_ms: fms, visible_at_ms: vms, delta_ms: d });
  }
  rows.sort((a,b)=>a.visible_at_ms-b.visible_at_ms);
  return rows;
}

let joined = computeJoins();
if (joined.length < 100){
  // auto-expand to 7d
  const cutoff7d = nowMs - 7*24*60*60*1000;
  earliestFetched.clear(); earliestVisible.clear(); sourceById.clear(); internalRows.length = 0; winMin = null; winMax = null;
  for (const f of diagFiles){
    try { const data = fs.readFileSync(f,'utf8'); for(const line of data.split(/\r?\n/)){ if(!line) continue; const j=safeJson(line); if(!j) continue; const id=j.id; const src=j.source||null; const fat=toMs(j.fetched_at_ms ?? j.first_seen_ms ?? j.fetched_at ?? null); const vat=toMs(j.visible_at_ms ?? j.visible_at ?? null); const dmono=(j.delta_mono_ms!=null&&Number.isFinite(Number(j.delta_mono_ms)))?Number(j.delta_mono_ms):null; const dwall=(j.delta_ms!=null&&Number.isFinite(Number(j.delta_ms)))?Number(j.delta_ms):null; if(fat!=null && fat>=cutoff7d) considerFetched(id,src,fat); if(vat!=null && vat>=cutoff7d) considerVisible(id,src,vat); if (vat!=null && (dmono!=null || dwall!=null)){ const acceptTs = (dmono!=null) ? (vat - dmono) : (dwall!=null ? (vat - dwall) : null); if (acceptTs!=null) internalRows.push({ id, source: src, accept_ts: acceptTs, visible_at_ms: vat, delta_ms: (dmono!=null?dmono:dwall) }); } } } catch {}
  }
  for (const f of pm2Files){ try { const data=fs.readFileSync(f,'utf8'); for(const line of data.split(/\r?\n/)){ const m=line.match(fetchDoneRe); if(!m) continue; const id=m[1]; const ts=toMs(m[2]); if(ts==null) continue; if(ts>=cutoff7d) considerFetched(id,null,ts); } } catch {}
  }
  joined = computeJoins();
}

// Stats
const deltas = joined.map(r=>r.delta_ms).sort((a,b)=>a-b);
const overall = { p50: pct(deltas,0.5), p90: pct(deltas,0.9), p99: pct(deltas,0.99) };

// By-source top 5
const byCount = new Map();
for(const r of joined){ const k=r.source||'unknown'; byCount.set(k, (byCount.get(k)||0)+1); }
const top5 = Array.from(byCount.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k])=>k);
const bySrc = {};
for(const s of top5){ const ds = joined.filter(r=> (r.source||'unknown')===s).map(r=>r.delta_ms).sort((a,b)=>a-b); bySrc[s] = { p50: pct(ds,0.5), p90: pct(ds,0.9), p99: pct(ds,0.99), n: ds.length }; }

// Internal stats
const internalSorted = internalRows.slice().sort((a,b)=>a.visible_at_ms-b.visible_at_ms);
const internalDeltas = internalSorted.map(r=>r.delta_ms).filter(v=>v!=null).sort((a,b)=>a-b);
const internalAgg = { n: internalDeltas.length, p50: pct(internalDeltas,0.5), p90: pct(internalDeltas,0.9), p99: pct(internalDeltas,0.99) };

// Artifacts
const artDir = path.join(repoRoot,'ARTIFACTS'); fs.mkdirSync(artDir,{recursive:true});
const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
const csv1Path = path.join(artDir, `publisher_to_pulse_latency_${ymd}.csv`);
const csv2Path = path.join(artDir, `pulse_internal_accept_to_sse_${ymd}.csv`);
const mdPath = path.join(artDir, `LATENCY_REPORT_${ymd}.md`);

const csv1 = ['id,source,fetched_at_ms,visible_at_ms,delta_ms', ...joined.map(r=>[r.id, r.source||'', r.fetched_at_ms, r.visible_at_ms, r.delta_ms].join(','))].join('\n');
fs.writeFileSync(csv1Path, csv1);
const csv2 = ['id,source,accept_ts,visible_at_ms,delta_ms', ...internalSorted.map(r=>[r.id, r.source||'', r.accept_ts, r.visible_at_ms, r.delta_ms].join(','))].join('\n');
fs.writeFileSync(csv2Path, csv2);

const filesDetails = [];
for (const f of [...diagFiles, ...pm2Files]){ const s = sizeOf(f); if(s) filesDetails.push({ path: path.relative(repoRoot,f), ...s }); }
const md = [];
md.push(`# Offline Latency Report`);
md.push('');
md.push(`Window: ${winMin?new Date(winMin).toISOString():'n/a'} .. ${winMax?new Date(winMax).toISOString():'n/a'}`);
md.push('Files:');
for (const fd of filesDetails){ md.push(`- ${fd.path} (size=${fd.size} mtime=${fd.mtime})`); }
md.push('');
md.push('## Publisher→Pulse (fetched→visible)');
md.push(`- joined: ${joined.length}`);
md.push(`- p50: ${overall.p50??'n/a'} ms`);
md.push(`- p90: ${overall.p90??'n/a'} ms`);
md.push(`- p99: ${overall.p99??'n/a'} ms`);
md.push('');
md.push('### By source (top 5)');
for (const s of top5){ const v=bySrc[s]; md.push(`- ${s}: p50=${v.p50??'n/a'} p90=${v.p90??'n/a'} p99=${v.p99??'n/a'} (n=${v.n})`); }
md.push('');
md.push('## Pulse internal (accept→SSE)');
md.push(`- count: ${internalAgg.n}`);
md.push(`- p50: ${internalAgg.p50??'n/a'} ms`);
md.push(`- p90: ${internalAgg.p90??'n/a'} ms`);
md.push(`- p99: ${internalAgg.p99??'n/a'} ms`);
fs.writeFileSync(mdPath, md.join('\n'));

// Console summary (verbatim format)
console.log('LATENCY SUMMARY (historical, offline)');
console.log(`window=${winMin?new Date(winMin).toISOString():'n/a'} .. ${winMax?new Date(winMax).toISOString():'n/a'}`);
console.log(`publisher→Pulse (fetched→visible): joined=${joined.length} p50=${overall.p50??'n/a'} p90=${overall.p90??'n/a'} p99=${overall.p99??'n/a'}`);
console.log('by-source (top 5):');
for (const s of top5){ const v=bySrc[s]; console.log(`  ${s}: p50=${v.p50??'n/a'} p90=${v.p90??'n/a'} p99=${v.p99??'n/a'} (n=${v.n})`); }
console.log(`pulse internal (accept→SSE): count=${internalAgg.n} p50=${internalAgg.p50??'n/a'} p90=${internalAgg.p90??'n/a'} p99=${internalAgg.p99??'n/a'}`);
console.log(`CSV1=${path.relative(repoRoot,csv1Path)}`);
console.log(`CSV2=${path.relative(repoRoot,csv2Path)}`);
console.log(`MD  =${path.relative(repoRoot,mdPath)}`);


