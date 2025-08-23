#!/usr/bin/env node
/*
  confirmMultiSourceLatency.mjs

  Non-destructive observer that:
  - Auto-discovers RSS sources from repo (fastlane vs regular)
  - Watches publishers via periodic conditional GET polling
  - Prefers SSE to trigger immediate backend feed checks; falls back to polling /feed
  - Matches publisher items to Pulse visibility and records deltas
  - Writes raw and summary artifacts under backend/artifacts/confirm_multisource/

  Constraints respected:
  - No env/behavior changes to backend
  - No purges or destructive actions
*/

import fs from 'fs';
import path from 'node:path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'node:url';

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname  = fileURLToPath(new URL('.', import.meta.url));

// --- CLI args ---
function parseArgs(argv) {
  const out = {
    rss: '',
    timeoutSec: 1800,
    samplesTotal: 12,
    samplesPerSourceMin: 2,
    pollMs: 1000,
    sse: '',
    feed: ''
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const nxt = argv[i + 1];
    const take = (key) => { if (nxt != null && !String(nxt).startsWith('--')) { out[key] = nxt; i++; } else { out[key] = ''; } };
    if (a === '--rss') take('rss');
    else if (a === '--timeoutSec') { out.timeoutSec = parseInt(nxt, 10) || out.timeoutSec; i++; }
    else if (a === '--samplesTotal') { out.samplesTotal = parseInt(nxt, 10) || out.samplesTotal; i++; }
    else if (a === '--samplesPerSourceMin') { out.samplesPerSourceMin = parseInt(nxt, 10) || out.samplesPerSourceMin; i++; }
    else if (a === '--pollMs') { out.pollMs = parseInt(nxt, 10) || out.pollMs; i++; }
    else if (a === '--sse') take('sse');
    else if (a === '--feed') take('feed');
  }
  return out;
}

// --- Filesystem helpers ---
const ART_DIR = path.resolve(__dirname, '../artifacts/confirm_multisource');
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
ensureDir(ART_DIR);

// --- Tiny logger ---
function logInfo(...args) { console.log('[cmsl]', ...args); }
function logWarn(...args) { console.warn('[cmsl][warn]', ...args); }
function logErr(...args) { console.error('[cmsl][err]', ...args); }

// --- Fetch with timeout using global fetch (Node 18+) ---
async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally { clearTimeout(t); }
}

// --- Auto-discover sources from backend/src/config/rssFeeds.ts ---
function readRssFeedsConfig() {
  const cfgPath = path.resolve(__dirname, '../src/config/rssFeeds.ts');
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
    return text;
  } catch (e) {
    logWarn('failed to read rssFeeds.ts:', e?.message || e);
    return '';
  }
}

function parseSourcesFromText(text) {
  const fastlane = [];
  const regular = [];
  // Rough parse blocks like { name: '...', url: '...', fastlane: true/false }
  const objectRegex = /\{[^\}]*name:\s*['"]([^'"\n]+)['"][^\}]*url:\s*['"]([^'"\n]+)['"][^\}]*\}/gms;
  let m;
  while ((m = objectRegex.exec(text))) {
    const block = m[0];
    const name = m[1];
    const url = m[2];
    // enabled?: default true; fastlane?: default true unless explicitly false in codebase, but we key off explicit fastlane: true/false presence
    const fastlaneFlag = /fastlane\s*:\s*true/.test(block) ? true : (/fastlane\s*:\s*false/.test(block) ? false : undefined);
    const enabledFlag = /enabled\s*:\s*false/.test(block) ? false : true;
    if (!enabledFlag) continue;
    const entry = { label: name, url };
    if (fastlaneFlag === false) { regular.push(entry); }
    else if (fastlaneFlag === true) { fastlane.push(entry); }
    else { regular.push(entry); }
  }
  return { fastlane, regular };
}

async function pickReachable(sources, limit) {
  const out = [];
  for (const s of sources) {
    if (out.length >= limit) break;
    try {
      const res = await fetchWithTimeout(s.url, { headers: { 'User-Agent': 'PulseConfirm/1.0', 'Accept': 'application/xml, text/xml;q=0.9, */*;q=0.8' } }, 4000);
      if (res && (res.status === 200)) out.push(s);
    } catch {}
  }
  return out;
}

async function autoDiscover(limitFast = 3, limitReg = 3) {
  const text = readRssFeedsConfig();
  const { fastlane, regular } = parseSourcesFromText(text);
  const fastSel = await pickReachable(fastlane, limitFast);
  const regSel = await pickReachable(regular, limitReg);
  const fallbackFast = [
    { label: 'PRNewswire', url: 'https://www.prnewswire.com/rss/prnewswire/all-news.rss' },
    { label: 'Business Wire', url: 'https://www.businesswire.com/portal/site/home/rss/irw' },
    { label: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/17-Industry%20News' }
  ];
  const fallbackReg = [
    { label: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { label: 'Reuters Top', url: 'https://www.reuters.com/rssFeed/topNews' },
    { label: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' }
  ];
  return {
    fastlane: fastSel.length ? fastSel : fallbackFast,
    regular: regSel.length ? regSel : fallbackReg
  };
}

// --- URL and title normalization ---
function normUrl(u) {
  try {
    const x = new URL(u);
    let keepQuery = '';
    if (x.searchParams.has('p')) keepQuery = `?p=${x.searchParams.get('p')}`;
    let p = x.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return `${x.host}${p}${keepQuery}`.toLowerCase();
  } catch { return String(u || '').trim().toLowerCase(); }
}
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// --- Simple RSS/Atom parser (first unseen item) ---
function parseFirstNewItem(xmlText, seenKeys) {
  if (!xmlText || typeof xmlText !== 'string') return null;
  // Try RSS <item>
  const items = xmlText.split(/<item[\s>]/i).slice(1).map(seg => '<item ' + seg);
  const entries = xmlText.split(/<entry[\s>]/i).slice(1).map(seg => '<entry ' + seg);
  function extractFromItem(seg) {
    const pick = (re) => { const m = seg.match(re); return m ? m[1] : ''; };
    const guid = pick(/<guid[^>]*>([\s\S]*?)<\/guid>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (pick(/<link[^>]*>([\s\S]*?)<\/link>/i) || pick(/<link[^>]*href=['"]([^'"]+)['"]/i)).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const pub = pick(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const key = normUrl(guid || link) || normTitle(title);
    return { key, guid, link, title, pubDate: pub };
  }
  function extractFromEntry(seg) {
    const pick = (re) => { const m = seg.match(re); return m ? m[1] : ''; };
    const id = pick(/<id[^>]*>([\s\S]*?)<\/id>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (pick(/<link[^>]*rel=["']alternate["'][^>]*href=['"]([^'"]+)['"]/i) || pick(/<link[^>]*href=['"]([^'"]+)['"]/i)).trim();
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const pub = (pick(/<published[^>]*>([\s\S]*?)<\/published>/i) || pick(/<updated[^>]*>([\s\S]*?)<\/updated>/i)).trim();
    const key = normUrl(id || link) || normTitle(title);
    return { key, guid: id, link, title, pubDate: pub };
  }
  const candidates = [];
  for (const seg of items) candidates.push(extractFromItem(seg));
  for (const seg of entries) candidates.push(extractFromEntry(seg));
  for (const c of candidates) {
    if (!c) continue;
    const k = c.key || normTitle(c.title) || normUrl(c.link);
    if (!k) continue;
    if (!seenKeys.has(k)) return c;
  }
  return null;
}

// --- SSE client (minimal) ---
class SSEClient {
  constructor(url, onNew, onError) {
    this.url = url;
    this.onNew = onNew;
    this.onError = onError;
    this.req = null;
    this.retryTimer = null;
    this.connected = false;
  }
  connect() {
    try {
      const u = new URL(this.url);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = { method: 'GET', headers: { 'Accept': 'text/event-stream' } };
      this.req = lib.request(u, res => {
        if (res.statusCode !== 200) { this.onError?.(new Error('SSE status ' + res.statusCode)); return; }
        this.connected = true;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            const lines = block.split(/\r?\n/);
            let event = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
            }
            if (event === 'new' || event === 'message') {
              try { const j = JSON.parse(data); this.onNew?.(j); } catch {}
            }
          }
        });
        res.on('end', () => { this.connected = false; this.onError?.(new Error('SSE ended')); });
      });
      this.req.on('error', err => { this.connected = false; this.onError?.(err); });
      this.req.end();
    } catch (e) { this.onError?.(e); }
  }
  close() {
    try { this.req?.destroy?.(); } catch {}
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.connected = false;
  }
}

// --- Percentiles ---
function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.floor(a.length * p);
  return a[Math.min(Math.max(idx, 0), a.length - 1)];
}

// --- Main ---
(async () => {
  const args = parseArgs(process.argv);
  const pollMs = Math.max(250, Number(args.pollMs) || 1000);
  const pollBias = Math.floor(pollMs / 2);
  const timeoutMs = Math.max(1, Number(args.timeoutSec) || 1800) * 1000;
  const samplesTotalTarget = Math.max(0, Number(args.samplesTotal) || 12);
  const perSourceMin = Math.max(0, Number(args.samplesPerSourceMin) || 2);

  // Detect backend base URL via /health
  async function isHealthy(base) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/$/, '')}/health`, { headers: { 'accept': 'application/json' } }, 2500);
      if (!res.ok) return false;
      const j = await res.json().catch(()=>({}));
      return !!(j && (j.ok === true || typeof j.ts === 'string'));
    } catch { return false; }
  }
  let base = '';
  const tryPorts = [];
  if (process.env.PORT) tryPorts.push(String(process.env.PORT));
  if (!tryPorts.includes('4000')) tryPorts.push('4000');
  if (!tryPorts.includes('4010')) tryPorts.push('4010');
  for (const p of tryPorts) {
    const cand = `http://127.0.0.1:${p}`;
    if (await isHealthy(cand)) { base = cand; break; }
  }
  if (!base) {
    console.log('NO BACKEND LISTENING — start backend and rerun the script');
    process.exit(2);
  }
  // Build SSE/FEED defaults if not provided via CLI
  const sseCandidates = [ `${base}/sse/new-items`, `${base}/sse` ];
  const sseUrl = args.sse && args.sse.trim() ? args.sse : sseCandidates[0];
  const feedUrl = args.feed && args.feed.trim() ? args.feed : `${base}/feed`;

  // Discover or parse --rss list
  let selected = { fastlane: [], regular: [] };
  if (args.rss && String(args.rss).trim()) {
    const list = String(args.rss).split(',').map(s => s.trim()).filter(Boolean).map((u, i) => ({ label: `custom_${i+1}`, url: u }));
    selected.fastlane = list.slice(0, Math.min(3, list.length));
    selected.regular = list.slice(Math.min(3, list.length));
  } else {
    selected = await autoDiscover(3, 3);
  }
  const sources = [...selected.fastlane.map(s => ({ ...s, lane: 'fastlane' })), ...selected.regular.map(s => ({ ...s, lane: 'regular' }))];
  const chosenPrint = { fastlane: selected.fastlane, regular: selected.regular };
  logInfo('chosen sources', JSON.stringify(chosenPrint, null, 2));

  // Artifact files
  const rawPath = path.join(ART_DIR, 'raw.ndjson');
  const perSourcePath = path.join(ART_DIR, 'summary_per_source.json');
  const overallPath = path.join(ART_DIR, 'summary_overall.json');
  try { fs.writeFileSync(rawPath, '', 'utf8'); } catch {}

  // Per-source state
  const per = new Map(); // label -> { seen:Set, etag:string, lm:string, deltas:number[], ingestDeltas:number[], samples:number }
  sources.forEach(s => per.set(s.label, { seen: new Set(), etag: '', lm: '', deltas: [], ingestDeltas: [], samples: 0 }));

  // Unmatched detections queue: { label, url, title, key, tSeen }
  const pending = [];

  // Match function: fetch /feed and attempt to map detections
  async function fetchFeed() {
    try {
      const res = await fetchWithTimeout(args.feed, { headers: { 'accept': 'application/json' } }, 4000);
      if (!res.ok) return null;
      const j = await res.json();
      const items = Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
      return items.map(it => ({
        url: it.source_url || it.url || '',
        title: it.headline || it.title || '',
        ingested_at: it.ingested_at || null
      }));
    } catch { return null; }
  }

  function tryMatchDetections(feedItems, nowMs) {
    if (!Array.isArray(feedItems) || feedItems.length === 0) return;
    const urlMap = new Map();
    const titleMap = new Map();
    for (const it of feedItems) {
      const u = normUrl(it.url || '');
      const t = normTitle(it.title || '');
      if (u) urlMap.set(u, it);
      if (t) titleMap.set(t, it);
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const pd = pending[i];
      const uKey = normUrl(pd.url || '');
      const tKey = normTitle(pd.title || '');
      const cand = (uKey && urlMap.get(uKey)) || (tKey && titleMap.get(tKey));
      if (cand) {
        const tVisible = nowMs;
        const delta = Math.max(0, tVisible - pd.tSeen);
        const st = per.get(pd.label);
        if (st) {
          st.deltas.push(delta);
          if (cand.ingested_at) {
            const ingMs = Date.parse(cand.ingested_at);
            if (Number.isFinite(ingMs)) st.ingestDeltas.push(Math.max(0, tVisible - ingMs));
          }
          st.samples++;
        }
        // Write raw
        const obj = { source_label: pd.label, url: pd.url || '', T_src_first_seen_iso: new Date(pd.tSeen).toISOString(), T_pulse_visible_iso: new Date(tVisible).toISOString(), delta_ms: delta };
        try { fs.appendFileSync(rawPath, JSON.stringify(obj) + '\n', 'utf8'); } catch {}
        // Remove from pending
        pending.splice(i, 1);
      }
    }
  }

  // Publisher pollers
  const stopFlags = { stop: false };
  const pollers = sources.map(src => (async function poller() {
    const st = per.get(src.label);
    while (!stopFlags.stop) {
      try {
        const headers = { 'User-Agent': 'PulseConfirm/1.0', 'Accept': 'application/xml, text/xml;q=0.9, */*;q=0.8' };
        if (st.etag) headers['If-None-Match'] = st.etag;
        if (st.lm) headers['If-Modified-Since'] = st.lm;
        const res = await fetchWithTimeout(src.url, { headers }, 5000);
        if (res && res.status === 200) {
          const et = res.headers.get('etag');
          const lm = res.headers.get('last-modified');
          if (et) st.etag = et; if (lm) st.lm = lm;
          const text = await res.text();
          const first = parseFirstNewItem(text, st.seen);
          if (first && (first.guid || first.link || first.title)) {
            const key = first.key || normUrl(first.link) || normTitle(first.title);
            if (key && !st.seen.has(key)) {
              st.seen.add(key);
              pending.push({ label: src.label, url: first.link || first.guid || '', title: first.title || '', key, tSeen: Date.now() });
            }
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, pollMs));
    }
  })());

  // Visibility watcher: SSE preferred to trigger feed fetches; fallback to periodic feed polling
  let method = 'SSE';
  let sse = null;
  let feedPollTimer = null;
  const doFeedCheck = async () => { const items = await fetchFeed(); tryMatchDetections(items || [], Date.now()); };
  function startFeedPoll() {
    if (feedPollTimer) return;
    method = 'FEED_POLL';
    feedPollTimer = setInterval(() => { doFeedCheck().catch(()=>{}); }, pollMs);
  }
  function stopFeedPoll() { if (feedPollTimer) { clearInterval(feedPollTimer); feedPollTimer = null; } }
  function startSSE() {
    sse = new SSEClient(sseUrl, () => { doFeedCheck().catch(()=>{}); }, (err) => {
      logWarn('SSE error:', err?.message || String(err));
      // Fallback to feed polling if SSE fails
      startFeedPoll();
    });
    sse.connect();
  }
  startSSE();

  // Stop conditions loop
  const t0 = Date.now();
  let lastProgressAt = Date.now();
  async function getCounts() {
    let total = 0; const perMin = new Map();
    for (const s of sources) {
      const st = per.get(s.label); const c = st?.deltas?.length || 0;
      total += c; perMin.set(s.label, c);
    }
    return { total, perMin };
  }

  while (true) {
    await new Promise(r => setTimeout(r, Math.min(1000, pollMs)));
    const now = Date.now();
    const { total, perMin } = await getCounts();
    const perSatisfied = sources.every(s => (perMin.get(s.label) || 0) >= perSourceMin);
    if (total >= samplesTotalTarget && perSatisfied) break;
    if ((now - t0) >= timeoutMs) break;
    // Progress heartbeat
    if (now - lastProgressAt > 15000) {
      lastProgressAt = now;
      logInfo('progress', { total, elapsed_sec: Math.round((now - t0)/1000) });
    }
  }

  // Stop
  stopFlags.stop = true;
  try { if (sse) sse.close(); } catch {}
  stopFeedPoll();
  // Wait briefly for pollers to exit
  await Promise.race([Promise.allSettled(pollers), new Promise(r => setTimeout(r, 1000))]);

  // Summaries
  const perSummary = {};
  let allD = []; let allIngestD = [];
  for (const s of sources) {
    const st = per.get(s.label);
    const deltas = st?.deltas || [];
    const ingestD = st?.ingestDeltas || [];
    const p50r = percentile(deltas, 0.5);
    const p90r = percentile(deltas, 0.9);
    const p50c = (p50r == null) ? null : Math.max(0, p50r - pollBias);
    const p90c = (p90r == null) ? null : Math.max(0, p90r - pollBias);
    perSummary[s.label] = {
      lane: s.lane,
      samples: deltas.length,
      deltas_ms: deltas,
      p50_raw_ms: p50r,
      p90_raw_ms: p90r,
      p50_corrected_ms: p50c,
      p90_corrected_ms: p90c,
      method,
      pollMs,
      pollMs_bias_ms: pollBias
    };
    allD = allD.concat(deltas);
    allIngestD = allIngestD.concat(ingestD);
  }
  const o50r = percentile(allD, 0.5);
  const o90r = percentile(allD, 0.9);
  const o50c = (o50r == null) ? null : Math.max(0, o50r - pollBias);
  const o90c = (o90r == null) ? null : Math.max(0, o90r - pollBias);
  const oIngest50 = percentile(allIngestD, 0.5);

  const overall = {
    samples: allD.length,
    p50_raw_ms: o50r,
    p90_raw_ms: o90r,
    p50_corrected_ms: o50c,
    p90_corrected_ms: o90c,
    method,
    pollMs,
    pollMs_bias_ms: pollBias,
    optional_ingest_to_visible_p50_ms: oIngest50
  };

  // Write summaries
  try { fs.writeFileSync(perSourcePath, JSON.stringify(perSummary, null, 2), 'utf8'); } catch {}
  try { fs.writeFileSync(overallPath, JSON.stringify(overall, null, 2), 'utf8'); } catch {}

  if (overall.samples === 0) {
    console.log('NO NEW ITEMS DURING WINDOW — unable to compute latency.');
    process.exit(0);
  }

  // Console FINAL ANSWER
  console.log('FINAL ANSWER');
  console.log(`Method: ${method}, base=${base}, pollMs=${pollMs}, bias=${pollBias} ms`);
  console.log('Per-source:');
  for (const s of sources) {
    const ss = perSummary[s.label];
    console.log(`- ${s.label}: n=${ss.samples}, p50_raw=${ss.p50_raw_ms ?? 'null'}, p50_corrected=${ss.p50_corrected_ms ?? 'null'}, p90_raw=${ss.p90_raw_ms ?? 'null'}, p90_corrected=${ss.p90_corrected_ms ?? 'null'}`);
  }
  console.log(`Overall: n=${overall.samples}, p50_raw=${overall.p50_raw_ms ?? 'null'}, p50_corrected=${overall.p50_corrected_ms ?? 'null'}, p90_raw=${overall.p90_raw_ms ?? 'null'}, p90_corrected=${overall.p90_corrected_ms ?? 'null'}`);
  if (overall.optional_ingest_to_visible_p50_ms != null) {
    console.log(`Optional Pulse→UI (ingest→visible): p50=${overall.optional_ingest_to_visible_p50_ms} (if available)`);
  }
  console.log('Evidence: backend/artifacts/confirm_multisource/summary_per_source.json, summary_overall.json, raw.ndjson');
  process.exit(0);
})().catch(e => { logErr(e?.stack || e?.message || String(e)); process.exit(1); });


