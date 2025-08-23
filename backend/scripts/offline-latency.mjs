#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toMs(val){
  if(val==null) return null;
  if(typeof val==='number') return Number.isFinite(val)?val:null;
  const s=String(val).trim();
  if(/^\d{10,}$/.test(s)) return Number(s.length>13 ? Math.floor(Number(s)/1e3) : Number(s));
  const t = Date.parse(s); return Number.isFinite(t)?t:null;
}
function pct(arr,p){ if(!arr.length) return null; const i=Math.floor((arr.length-1)*p); return arr[i]; }
function safeJson(s){ try{ return JSON.parse(s) }catch{ return null } }

const repoRoot = path.resolve(process.cwd(), '..');
const backendDir = path.join(repoRoot, 'backend');
const diagFile = [path.join(backendDir,'diagnostics','latency_samples.jsonl'), path.join(repoRoot,'diagnostics','latency_samples.jsonl')].find(f=>fs.existsSync(f));
const pm2Dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2','logs');
const pm2Files = fs.existsSync(pm2Dir)
  ? fs.readdirSync(pm2Dir)
      .filter(f=>/^pulse-(out|error)(?:-\d+)?\.log$/i.test(f))
      .map(f=>path.join(pm2Dir,f))
  : [];

// Read visible_at per id (earliest)
const idToVisible = new Map();
const idToSource = new Map();
let winMin = null, winMax = null;
const pulseInternalRows = []; // for accept→SSE from JSONL delta_ms
if (diagFile && fs.existsSync(diagFile)){
  for (const line of fs.readFileSync(diagFile,'utf8').split(/\r?\n/)){
    if(!line) continue; const j = safeJson(line); if(!j) continue;
    const id = j.id; const vis = j.visible_at; const src = j.source;
    const t = toMs(vis); if(!id || t==null) continue;
    if(!idToVisible.has(id) || t < idToVisible.get(id)) idToVisible.set(id, t);
    if(src && !idToSource.has(id)) idToSource.set(id, src);
    if(winMin==null||t<winMin) winMin=t; if(winMax==null||t>winMax) winMax=t;
    const d = (j.delta_ms!=null && Number.isFinite(Number(j.delta_ms))) ? Number(j.delta_ms) : null;
    if (d!=null && d>=0) {
      pulseInternalRows.push({ id, source: src||null, accept_ts: t - d, visible_at: t, delta_ms: d, source_file: path.relative(repoRoot, diagFile)});
    }
  }
}

// Read fetched_at per id from PM2 logs (earliest only)
const idToIngest = new Map();
const filesParsed = [];
const sseRe = /\[sse\]\[new\][^\n]*?id\s*[:=]\s*['"]?([a-f0-9]{40})['"]?[^\n]*?ingested_at\s*[:=]\s*['"]?([^'"\s}]+)['"]?/i;
const acceptRe = /accepted\s+NEW[^\n]*?id\s*[:=]\s*([a-f0-9]{40})\b[^\n]*?\b(?:at|ts|ingested_at)\s*[:=]\s*([0-9T:\.\-Z\+]+)/i;
const fetchDoneRe = /FETCH_DONE[^\n]*?id\s*[:=]\s*['"]?([a-f0-9]{40})['"]?[^\n]*?fetched_at\s*[:=]\s*['"]?([^'"\s}]+)['"]?/i;
for (const fpath of pm2Files){
  try{
    const data = fs.readFileSync(fpath,'utf8');
    filesParsed.push({ file: fpath, size: data.length });
    for(const line of data.split(/\r?\n/)){
      if(!line) continue;
      let m = line.match(fetchDoneRe);
      if(m){ const id=m[1]; const ts=toMs(m[2]); if(id && ts!=null && (!idToIngest.has(id) || ts < idToIngest.get(id))) idToIngest.set(id, ts); continue; }
      m = line.match(sseRe);
      if(m){ const id=m[1]; const ts=toMs(m[2]); if(id && ts!=null && (!idToIngest.has(id) || ts < idToIngest.get(id))) idToIngest.set(id, ts); continue; }
      m = line.match(acceptRe);
      if(m){ const id=m[1]; const ts=toMs(m[2]); if(id && ts!=null && (!idToIngest.has(id) || ts < idToIngest.get(id))) idToIngest.set(id, ts); }
    }
  } catch {}
}

// Join for publisher→Pulse
const rows = [];
for (const [id, vis] of idToVisible.entries()){
  const ing = idToIngest.get(id);
  if(ing==null) continue;
  const d = vis - ing; if(!(d>=0 && d <= 24*60*60*1000)) continue;
  rows.push({ id, source: idToSource.get(id)||null, fetched_at: ing, visible_at: vis, delta_ms: d });
}
rows.sort((a,b)=>a.visible_at-b.visible_at);

// Stats
const deltas = rows.map(r=>r.delta_ms).sort((a,b)=>a-b);
const overall = { p50: pct(deltas,0.5), p90: pct(deltas,0.9), p99: pct(deltas,0.99) };

// By top 5 sources
const bySrcCount = {};
for(const r of rows){ bySrcCount[r.source||'unknown'] = (bySrcCount[r.source||'unknown']||0)+1; }
const top5 = Object.entries(bySrcCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s])=>s);
const bySrc = {};
for(const s of top5){ const ds = rows.filter(r=> (r.source||'unknown')===s).map(r=>r.delta_ms).sort((a,b)=>a-b); bySrc[s] = { p50: pct(ds,0.5), p90: pct(ds,0.9), p99: pct(ds,0.99), n: ds.length }; }

// Write artifacts
const artDir = path.join(repoRoot,'ARTIFACTS'); fs.mkdirSync(artDir,{recursive:true});
const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
const csv1Path = path.join(artDir, `publisher_to_pulse_latency_JOIN_${dateStr}.csv`);
const csv1 = ['id,source,publisher_ts,pulse_ts,delta_ms,join_note', ...rows.map(r=>[r.id, r.source||'', new Date(r.fetched_at).toISOString(), new Date(r.visible_at).toISOString(), r.delta_ms, 'pm2_fetch_done+sse_visible'].join(','))].join('\n');
fs.writeFileSync(csv1Path,csv1);

const csv2Path = path.join(artDir, `pulse_internal_accept_to_sse_${dateStr}.csv`);
const csv2 = ['id,source,accept_ts,visible_at,delta_ms,source_file', ...pulseInternalRows.map(r=>[r.id, r.source||'', new Date(r.accept_ts).toISOString(), new Date(r.visible_at).toISOString(), r.delta_ms, r.source_file].join(','))].join('\n');
fs.writeFileSync(csv2Path,csv2);

const mdPath = path.join(artDir,`LATENCY_REPORT_${dateStr}.md`);
const filesList = [diagFile?path.relative(repoRoot,diagFile):null, ...filesParsed.map(f=>path.relative(repoRoot,f.file))].filter(Boolean);
const fileDetails = [];
if (diagFile) { const st=fs.statSync(diagFile); fileDetails.push({ path: path.relative(repoRoot,diagFile), size: st.size, mtime: st.mtime.toISOString() }); }
for (const f of pm2Files) { try { const st=fs.statSync(f); fileDetails.push({ path: path.relative(repoRoot,f), size: st.size, mtime: st.mtime.toISOString() }); } catch {} }
const md = [];
md.push(`# Latency Report (historical, offline)`);
md.push('');
md.push(`Window: ${winMin?new Date(winMin).toISOString():'n/a'} .. ${winMax?new Date(winMax).toISOString():'n/a'}`);
md.push('Files:');
for(const fd of fileDetails){ md.push(`- ${fd.path} (size=${fd.size} mtime=${fd.mtime})`); }
md.push('');
md.push('## Publisher→Pulse');
md.push(`- total_visible: ${idToVisible.size}`);
md.push(`- total_ingested: ${idToIngest.size}`);
md.push(`- joined: ${rows.length}`);
md.push('');
md.push('### Percentiles (ms)');
md.push(`- p50: ${overall.p50??'n/a'}`);
md.push(`- p90: ${overall.p90??'n/a'}`);
md.push(`- p99: ${overall.p99??'n/a'}`);
md.push('');
md.push('### Top sources');
for(const s of top5){ const v=bySrc[s]; md.push(`- ${s}: p50=${v.p50??'n/a'} p90=${v.p90??'n/a'} p99=${v.p99??'n/a'} (n=${v.n})`); }
md.push('');
// Pulse internal section
const piDeltas = pulseInternalRows.map(r=>r.delta_ms).sort((a,b)=>a-b);
const pi = { p50: pct(piDeltas,0.5), p90: pct(piDeltas,0.9), p99: pct(piDeltas,0.99), n: piDeltas.length };
md.push('## Pulse internal (accept→SSE)');
md.push(`- count: ${pi.n}`);
md.push(`- p50: ${pi.p50??'n/a'}`);
md.push(`- p90: ${pi.p90??'n/a'}`);
md.push(`- p99: ${pi.p99??'n/a'}`);
fs.writeFileSync(mdPath, md.join('\n'));

// Console summary (required format)
console.log('LATENCY SUMMARY (historical, offline)');
console.log(`window=${winMin?new Date(winMin).toISOString():'n/a'} .. ${winMax?new Date(winMax).toISOString():'n/a'}`);
console.log(`publisher→Pulse: joined=${rows.length} p50=${overall.p50??'n/a'} p90=${overall.p90??'n/a'} p99=${overall.p99??'n/a'}`);
console.log('by-source (top 5):');
for(const s of top5){ const v=bySrc[s]; console.log(`  ${s}: p50=${v.p50??'n/a'} p90=${v.p90??'n/a'} p99=${v.p99??'n/a'} (n=${v.n})`); }
console.log(`pulse internal (accept→SSE): count=${pi.n} p50=${pi.p50??'n/a'} p90=${pi.p90??'n/a'} p99=${pi.p99??'n/a'}`);
console.log(`CSV1=${path.relative(repoRoot,csv1Path)}`);
console.log(`CSV2=${path.relative(repoRoot,csv2Path)}`);
console.log(`MD  =${path.relative(repoRoot,mdPath)}`);


