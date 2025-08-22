#!/usr/bin/env node
/*
  confirmFastlaneFreshLatency.mjs
  - Hardcoded Fast Lane sources only (PRNewswire, Business Wire, Nasdaq Trader)
  - Poll each RSS every pollMs (default 1000ms) with conditional headers
  - Prefer SSE at /sse; fallback to polling /feed
  - Stop after samplesTotal fresh matches or timeoutSec
  - Write artifacts under backend/artifacts/fastlane_latency/
*/

import fs from 'fs';
import path from 'node:path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = fileURLToPath(new URL('.', import.meta.url));

// CLI args
function parseArgs(argv){
  const out = { timeoutSec: 300, samplesTotal: 5, pollMs: 1000 };
  for (let i=2;i<argv.length;i++){
    const a = argv[i]; const b = argv[i+1];
    if (a === '--timeoutSec'){ out.timeoutSec = parseInt(b,10)||out.timeoutSec; i++; }
    else if (a === '--samplesTotal'){ out.samplesTotal = parseInt(b,10)||out.samplesTotal; i++; }
    else if (a === '--pollMs'){ out.pollMs = parseInt(b,10)||out.pollMs; i++; }
  }
  return out;
}

const ART_DIR = path.resolve(__dirname, '../artifacts/fastlane_latency');
function ensureDir(p){ try{ fs.mkdirSync(p,{recursive:true}); }catch{} }
ensureDir(ART_DIR);
const RAW_PATH = path.join(ART_DIR, 'raw.ndjson');
const PER_SRC_PATH = path.join(ART_DIR, 'summary_per_source.json');
const OVERALL_PATH = path.join(ART_DIR, 'summary_overall.json');
try{ fs.writeFileSync(RAW_PATH,'','utf8'); }catch{}

function log(...a){ console.log('[fastlane]',...a); }
function warn(...a){ console.warn('[fastlane][warn]',...a); }

async function fetchWithTimeout(url, opts={}, timeoutMs=5000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally { clearTimeout(t); }
}

async function detectBase(){
  const ports = [process.env.PORT, '4000','4010'].filter(Boolean);
  for (const p of ports){
    const base = `http://127.0.0.1:${p}`;
    try{
      const r = await fetchWithTimeout(`${base}/health`, { headers:{'accept':'application/json'} }, 2000);
      if (r?.ok) return base;
    }catch{}
  }
  return '';
}

// Sources (Fast Lane only)
const SOURCES = [
  { label: 'PRNewswire', url: 'https://www.prnewswire.com/rss/prnewswire/all-news.rss' },
  { label: 'BusinessWire', url: 'https://www.businesswire.com/portal/site/home/rss/irw' },
  { label: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/17-Industry%20News' },
  { label: 'NasdaqTrader', url: 'https://www.nasdaqtrader.com/rss.aspx?feed=TradeHalts' },
  { label: 'NYSE', url: 'https://www.nyse.com/api/announcements/current' }
];

function normUrl(u){ try{ const x=new URL(u); let p=x.pathname||'/'; if(p.length>1&&p.endsWith('/')) p=p.slice(0,-1); return `${x.host}${p}`.toLowerCase(); }catch{ return String(u||'').toLowerCase(); } }
function normTitle(t){ return String(t||'').toLowerCase().replace(/\s+/g,' ').trim(); }

function parseFirstNewItem(xmlText, seen){
  if (!xmlText || typeof xmlText !== 'string') return null;
  const parts = xmlText.split(/<item[\s>]/i).slice(1).map(x=>'<item '+x);
  function pick(seg,re){ const m = seg.match(re); return m ? m[1] : ''; }
  for (const seg of parts){
    const guid = pick(seg, /<guid[^>]*>([\s\S]*?)<\/guid>/i).replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link = (pick(seg, /<link[^>]*>([\s\S]*?)<\/link>/i) || pick(seg, /<link[^>]*href=['"]([^'"]+)['"]/i)).replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const title = pick(seg, /<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const pub = pick(seg, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i).replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const key = normUrl(guid||link) || normTitle(title);
    if (!key) continue;
    if (!seen.has(key)) return { key, guid, link, title, pubDate: pub };
  }
  return null;
}

class SSEClient {
  constructor(url, onNew, onError){ this.url=url; this.onNew=onNew; this.onError=onError; this.req=null; }
  connect(){
    try{
      const u = new URL(this.url); const lib = u.protocol==='https:'?https:http;
      this.req = lib.request(u, res=>{
        if (res.statusCode!==200){ this.onError?.(new Error('SSE status '+res.statusCode)); return; }
        let buf=''; res.setEncoding('utf8');
        res.on('data', chunk=>{
          buf+=chunk; let idx;
          while((idx=buf.indexOf('\n\n'))!==-1){
            const block = buf.slice(0,idx); buf = buf.slice(idx+2);
            const lines = block.split(/\r?\n/); let event='message'; let data='';
            for (const line of lines){ if (line.startsWith('event:')) event=line.slice(6).trim(); else if (line.startsWith('data:')) data += (data?'\n':'') + line.slice(5).trim(); }
            if (event==='new' || event==='message'){ try{ const j=JSON.parse(data); this.onNew?.(j);}catch{} }
          }
        });
        res.on('end', ()=> this.onError?.(new Error('SSE ended')) );
      });
      this.req.on('error', err=> this.onError?.(err) );
      this.req.end();
    }catch(e){ this.onError?.(e); }
  }
  close(){ try{ this.req?.destroy?.(); }catch{} }
}

function percentile(arr,p){ if(!arr.length) return null; const a=arr.slice().sort((x,y)=>x-y); const i=Math.floor(a.length*p); return a[Math.min(Math.max(i,0),a.length-1)]; }

(async ()=>{
  const args = parseArgs(process.argv);
  const pollMs = Math.max(250, args.pollMs||1000);
  const timeoutMs = Math.max(1, args.timeoutSec||300)*1000;
  const samplesTarget = Math.max(0, args.samplesTotal||5);

  const base = await detectBase();
  if (!base){ console.log('NO BACKEND LISTENING — start backend and rerun'); process.exit(2); }
  console.log(`[fastlane] BASE selected: ${base}`);
  // Prefer /sse/new-items; some environments may expose /sse
  const sseCandidates = [`${base}/sse/new-items`, `${base}/sse`];
  const sseUrl = sseCandidates[0];
  const feedUrl = `${base}/feed`;

  const per = new Map(); // label -> state
  SOURCES.forEach(s=> per.set(s.label, { etag:'', lm:'', seen:new Set(), deltas:[], uiDeltas:[], samples:0 }));
  const pending = []; // {label, key, url, title, tSeen}

  async function fetchFeed(){ try{ const r=await fetchWithTimeout(feedUrl,{headers:{'accept':'application/json'}},4000); if(!r?.ok) return null; const j=await r.json(); const arr=Array.isArray(j?.items)?j.items:(Array.isArray(j)?j:[]); return arr.map(it=>({ url:it.source_url||it.url||'', title:it.headline||it.title||'', ingested_at:it.ingested_at||null })); }catch{ return null; } }
  function tryMatch(feedItems, nowMs){ if(!Array.isArray(feedItems)||!feedItems.length) return; const urlMap=new Map(); const titleMap=new Map(); for(const it of feedItems){ const u=normUrl(it.url||''); const t=normTitle(it.title||''); if(u) urlMap.set(u,it); if(t) titleMap.set(t,it);} for(let i=pending.length-1;i>=0;i--){ const pd=pending[i]; const u=normUrl(pd.url||''); const t=normTitle(pd.title||''); const cand = (u&&urlMap.get(u)) || (t&&titleMap.get(t)); if(cand){ const st=per.get(pd.label); const d=Math.max(0, nowMs - pd.tSeen); st.deltas.push(d); let uiDelta = null; if(cand.ingested_at){ const ing=Date.parse(cand.ingested_at); if(Number.isFinite(ing)) { uiDelta = Math.max(0, nowMs - ing); st.uiDeltas.push(uiDelta); } } st.samples++; const obj={ source: pd.label, guid: pd.key, T_src_first_seen: new Date(pd.tSeen).toISOString(), T_pulse_visible: new Date(nowMs).toISOString(), delta_src_to_pulse_ms: d, ...(uiDelta!=null?{ delta_ingest_to_visible_ms: uiDelta }: {}) }; try{ fs.appendFileSync(RAW_PATH, JSON.stringify(obj)+'\n','utf8'); }catch{} pending.splice(i,1); } } }

let method='SSE';
let sse=null; let feedTimer=null;
function startSSE(){ sse=new SSEClient(sseUrl, ()=>{ fetchFeed().then(items=> tryMatch(items||[], Date.now())).catch(()=>{}); }, ()=>{ method='FEED_POLL'; if(!feedTimer) feedTimer=setInterval(()=>{ fetchFeed().then(items=> tryMatch(items||[], Date.now())).catch(()=>{}); }, pollMs); }); sse.connect(); }
startSSE();

// Pollers
const stop={v:false};
const pollers = SOURCES.map(src => (async function loop(){ const st=per.get(src.label); while(!stop.v){ try{ const hdrs={'User-Agent':'FastlaneConfirm/1.0','Accept':'application/rss+xml, application/xml;q=0.9, */*;q=0.8'}; if(st.etag) hdrs['If-None-Match']=st.etag; if(st.lm) hdrs['If-Modified-Since']=st.lm; const r=await fetchWithTimeout(src.url,{headers:hdrs},5000); if(r && r.status===200){ const et=r.headers.get('etag'); const lm=r.headers.get('last-modified'); if(et) st.etag=et; if(lm) st.lm=lm; const text=await r.text(); const first=parseFirstNewItem(text, st.seen); if(first && (first.guid || first.link || first.title)){ const key= first.key || normUrl(first.link) || normTitle(first.title); if(key && !st.seen.has(key)){ st.seen.add(key); pending.push({ label: src.label, key, url: first.link||first.guid||'', title:first.title||'', tSeen: Date.now() }); } } } }catch{} await new Promise(r=>setTimeout(r,pollMs)); } })());

const t0=Date.now();
while(true){ await new Promise(r=>setTimeout(r,Math.min(1000,pollMs))); const now=Date.now(); let total=0; per.forEach(st=> total+=st.deltas.length); if(total>=samplesTarget) break; if(now - t0 >= timeoutMs) break; }

stop.v=true; try{ sse?.close(); }catch{} if(feedTimer) { clearInterval(feedTimer); feedTimer=null; }
await Promise.race([Promise.allSettled(pollers), new Promise(r=>setTimeout(r,500))]);

// Summaries
const perSummary={}; let all=[]; let allUi=[];
per.forEach((st,label)=>{ const p50=percentile(st.deltas,0.5); const p90=percentile(st.deltas,0.9); perSummary[label] = { samples: st.deltas.length, p50_ms: p50, p90_ms: p90, deltas_ms: st.deltas, method }; all=all.concat(st.deltas); allUi=allUi.concat(st.uiDeltas); });
const o50=percentile(all,0.5); const o90=percentile(all,0.9); const ui50=percentile(allUi,0.5); const ui90=percentile(allUi,0.9);
try{ fs.writeFileSync(PER_SRC_PATH, JSON.stringify(perSummary,null,2),'utf8'); }catch{}
try{ fs.writeFileSync(OVERALL_PATH, JSON.stringify({ samples: all.length, p50_ms: o50, p90_ms: o90, pulse_ui_p50_ms: ui50, pulse_ui_p90_ms: ui90, method }, null, 2), 'utf8'); }catch{}

if (all.length === 0){ console.log('NO NEW ITEMS — Cannot measure Fast Lane latency in this window.'); process.exit(0); }

console.log('FINAL ANSWER');
console.log('Fast Lane publisher→Pulse latency:');
console.log(`- PRNewswire: n=${perSummary['PRNewswire'].samples}, p50=${perSummary['PRNewswire'].p50_ms ?? 'null'}, p90=${perSummary['PRNewswire'].p90_ms ?? 'null'}`);
console.log(`- BusinessWire: n=${perSummary['BusinessWire'].samples}, p50=${perSummary['BusinessWire'].p50_ms ?? 'null'}, p90=${perSummary['BusinessWire'].p90_ms ?? 'null'}`);
console.log(`- GlobeNewswire: n=${perSummary['GlobeNewswire'].samples}, p50=${perSummary['GlobeNewswire'].p50_ms ?? 'null'}, p90=${perSummary['GlobeNewswire'].p90_ms ?? 'null'}`);
console.log(`- NasdaqTrader: n=${perSummary['NasdaqTrader'].samples}, p50=${perSummary['NasdaqTrader'].p50_ms ?? 'null'}, p90=${perSummary['NasdaqTrader'].p90_ms ?? 'null'}`);
console.log(`- NYSE: n=${perSummary['NYSE'].samples}, p50=${perSummary['NYSE'].p50_ms ?? 'null'}, p90=${perSummary['NYSE'].p90_ms ?? 'null'}`);
console.log(`Overall Fast Lane: n=${all.length}, p50=${o50 ?? 'null'}, p90=${o90 ?? 'null'}`);
if (ui50 != null) console.log(`Pulse→UI latency (ingest→visible on SSE/feed): p50=${ui50}, p90=${ui90 ?? 'null'} (if available)`);
console.log(`Base: ${base}, Method: ${method}, pollMs=1000`);
console.log('Evidence: backend/artifacts/fastlane_latency/summary_per_source.json, summary_overall.json, raw.ndjson');
process.exit(0);
})().catch(e=>{ console.error(e?.stack||e?.message||String(e)); process.exit(1); });


