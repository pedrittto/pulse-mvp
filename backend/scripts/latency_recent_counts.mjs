#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function safeJson(s){ try{ return JSON.parse(s) }catch{ return null } }
function toMs(v){ if(v==null) return null; if(typeof v==='number') return Number.isFinite(v)?v:null; const t=Date.parse(String(v)); return Number.isFinite(t)?t:null; }

const repoRoot = process.cwd();
const diagBase = [path.join(repoRoot,'backend','diagnostics'), path.join(repoRoot,'diagnostics')].find(d=>fs.existsSync(d)) || path.join(repoRoot,'backend','diagnostics');
const files = [path.join(diagBase,'latency_samples.jsonl'), path.join(diagBase,'latency_samples.jsonl.1'), path.join(diagBase,'latency_samples.jsonl.2')].filter(f=>fs.existsSync(f));
const pm2Dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2','logs');
const pm2Files = fs.existsSync(pm2Dir) ? fs.readdirSync(pm2Dir).filter(f=>/^pulse-(out|error)(?:-\d+)?\.log$/i.test(f)).map(f=>path.join(pm2Dir,f)) : [];

const now = Date.now();
const cutoff = now - 2*60*60*1000;

let joined = 0;
let sse = 0;
for (const f of files){
  try {
    const data = fs.readFileSync(f,'utf8');
    for (const line of data.split(/\r?\n/)){
      if(!line) continue; const j = safeJson(line); if(!j) continue;
      const vis = toMs(j.visible_at_ms ?? j.visible_at ?? null);
      if (vis!=null && vis >= cutoff) {
        sse++;
        const fat = toMs(j.fetched_at_ms ?? j.first_seen_ms ?? j.fetched_at ?? null);
        if (fat!=null) joined++;
      }
    }
  } catch {}
}

let fetchDone = 0;
const fetchDoneRe = /FETCH_DONE[^\n]*?fetched_at\s*[:=]\s*['\"]?([^'"\s}]+)['\"]?/i;
for (const f of pm2Files){
  try {
    const data = fs.readFileSync(f,'utf8');
    for (const line of data.split(/\r?\n/)){
      const m = line.match(fetchDoneRe); if(!m) continue; const ts = toMs(m[1]); if(ts!=null && ts >= cutoff) fetchDone++;
    }
  } catch {}
}

console.log(`joined_last_2h=${joined} fetch_done_last_2h=${fetchDone} sse_last_2h=${sse}`);


