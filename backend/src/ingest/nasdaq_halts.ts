// backend/src/ingest/nasdaq_halts.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { readTextWithCap } from "./read_text_cap.js";
import { getGovernor } from "./governor.js";

// Prefer ENV override with safe fallback
const URL = process.env.NASDAQ_HALTS_URL ?? DEFAULT_URLS.NASDAQ_HALTS_URL;

// HTML clamp base ~2300ms ±15%
const POLL_MS_BASE = 2300;
const JITTER_MS = Math.round(POLL_MS_BASE * 0.15);
const FRESH_MS = 5 * 60 * 1000; // accept only items newer than 5 min
const BASE_TIMEOUT_MS = 2000; // per-request timeout (HTML)
const GOV = getGovernor();
const SOURCE = "nasdaq_halts";
const HOST: "nasdaqtrader.com" = "nasdaqtrader.com";

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let inFlight: boolean = false;
let deferred: boolean = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
const MAX_BYTES_HTML = Number(process.env.MAX_BYTES_HTML || 2_000_000);
let watermarkPublishedAt = 0; // newest accepted publishedAt
let warnedMissingUrl = false;
let noChangeStreak = 0;

function jitter(): number {
  return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

async function fetchFeed(): Promise<{ status: number; text?: string; json?: any; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.7",
    "user-agent": "PulseNewsBot/1.0 (+contact: ops@pulsenewsai.com)",
    "cache-control": "no-cache",
  };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(2000),
  });
  if (res.status === 304) return { status: 304 };
  const ct = res.headers.get("content-type") || "";
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && /html|text|xml|csv|json/i.test(ct) && cl > MAX_BYTES_HTML) { respTooLarge++; }
  const common = {
    status: res.status,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
  try {
    if (/json/i.test(ct)) {
      let raw: string | undefined;
      try { raw = await readTextWithCap(res as any, MAX_BYTES_HTML); } catch (e) { if ((e as any)?.message === 'cap_exceeded') { respTooLarge++; } throw e; }
      const json = raw ? JSON.parse(raw) : undefined;
      return { ...common, json } as any;
    }
  } catch {}
  let text: string | undefined;
  try { text = await readTextWithCap(res as any, MAX_BYTES_HTML); } catch (e) { if ((e as any)?.message === 'cap_exceeded') { respTooLarge++; } throw e; }
  return { ...common, text } as any;
}

type HaltRecord = {
  symbol: string;
  reason?: string;
  halt_time: number; // ms epoch UTC
  url?: string;
};

function parseCSV(text: string): HaltRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idxSym = header.findIndex(h => /symbol|ticker/.test(h));
  const idxReason = header.findIndex(h => /reason|pause/i.test(h));
  const idxTime = header.findIndex(h => /(halt|time)/i.test(h));
  const records: HaltRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const symbol = (cols[idxSym] || "").trim().toUpperCase();
    const reason = (idxReason >= 0 ? cols[idxReason] : "").trim();
    const tRaw = (idxTime >= 0 ? cols[idxTime] : "").trim();
    if (!symbol || !tRaw) continue;
    const haltMs = Date.parse(tRaw) || Number(tRaw) || 0;
    if (!haltMs) continue;
    records.push({ symbol, reason, halt_time: haltMs });
  }
  return records;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = false; }
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ""; }
      else if (ch === '"') { inQ = true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseJSON(json: any): HaltRecord[] {
  if (!json) return [];
  const arr = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
  const out: HaltRecord[] = [];
  for (const row of arr) {
    const symbol = String(row.symbol ?? row.ticker ?? "").trim().toUpperCase();
    const reason = String(row.reason ?? row.pause_reason ?? "");
    const t = row.halt_time ?? row.time ?? row.timestamp ?? 0;
    const ms = typeof t === "number" ? t : Date.parse(String(t));
    if (!symbol || !ms) continue;
    out.push({ symbol, reason, halt_time: ms, url: row.url });
  }
  return out;
}

function parseHTML(text: string): HaltRecord[] {
  if (!text) return [];
  const rows = text.split(/<tr[\s\S]*?>/i).slice(1).map(r => r.split(/<\/tr>/i)[0]);
  const out: HaltRecord[] = [];
  for (const r of rows) {
    const cols = Array.from(r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m => stripTags(decodeHtml(m[1]).trim()));
    if (cols.length < 2) continue;
    const symbol = (cols[0] || "").toUpperCase();
    const tRaw = cols.find(c => /\d{4}-\d{2}-\d{2}|\d{1,2}\/[\d/]{4}/.test(c)) || cols[1] || "";
    const reason = cols.find(c => /LUDP|News|Volatility|Reg/i.test(c)) || "";
    const ms = Date.parse(tRaw);
    if (!symbol || !ms) continue;
    out.push({ symbol, reason, halt_time: ms });
  }
  return out;
}

function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
function decodeHtml(s: string): string { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

export function startNasdaqHaltsIngest() {
  if (timer) return;
  console.log("[ingest:nasdaq_halts] start");
  if (!URL) { console.warn("[ingest:nasdaq_halts] missing URL; skipping fetch"); return; }
  const schedule = () => { timer = setTimeout(tick, jitter()); (timer as any)?.unref?.(); };
  const tick = async () => {
    try {
      if (inFlight) { deferred = true; overlapsPrevented++; return; }
      inFlight = true;
      if (DEBUG_INGEST) console.log("[ingest:nasdaq_halts] tick");
      // Backoff/state/budget gates
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') {
        const delay = Math.max(500, backoffMs);
        if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] skip 429/403 backoff, next in', delay, 'ms');
        timer = setTimeout(tick, delay); (timer as any)?.unref?.();
        return;
      }
      const token = GOV.claimHostToken(HOST);
      if (!token.ok) {
        const wait = Math.max(500, token.waitMs);
        if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] skip budget wait, next in', wait, 'ms');
        timer = setTimeout(tick, wait); (timer as any)?.unref?.();
        return;
      }
      const t0 = Date.now();
      const r = await fetchFeed();
      const dt = Date.now() - t0;
      if (r.status === 304) {
        noChangeStreak++;
        const base = GOV.nextDelayAfter(SOURCE, 'HTTP_304');
        const delay = noChangeStreak >= 3 ? 15000 : base;
        if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] 304 in', dt, 'ms, streak', noChangeStreak, 'base', base, 'next in', delay, 'ms');
        timer = setTimeout(tick, delay); (timer as any)?.unref?.();
        return;
      }
      if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] http', r.status, 'in', dt, 'ms', r.etag || r.lastModified || '');
      if (r.status === 429) {
        const delay = GOV.nextDelayAfter(SOURCE, 'R429');
        if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] skip 429 backoff in', dt, 'ms, next in', delay, 'ms');
        timer = setTimeout(tick, delay); (timer as any)?.unref?.();
        return;
      }
      if (r.status === 403) {
        const delay = GOV.nextDelayAfter(SOURCE, 'R403');
        if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] skip 403 backoff in', dt, 'ms, next in', delay, 'ms');
        timer = setTimeout(tick, delay); (timer as any)?.unref?.();
        return;
      }
      if (r.status !== 200) { console.warn("[ingest:nasdaq_halts] error status", r.status); const delay = GOV.nextDelayAfter(SOURCE, 'HTTP_200'); timer = setTimeout(tick, delay); (timer as any)?.unref?.(); return; }
      etag = r.etag || etag;
      lastModified = r.lastModified || lastModified;

      let records: HaltRecord[] = [];
      if (r.json) records = parseJSON(r.json);
      else if (r.text && /^\s*[{\[]/.test(r.text)) {
        try { records = parseJSON(JSON.parse(r.text)); } catch {}
      } else if (r.text && /,/.test(r.text)) {
        records = parseCSV(r.text);
      } else if (r.text) {
        records = parseHTML(r.text);
      }

      const nowMs = Date.now();
      for (const rec of records) {
        const publishedAt = rec.halt_time;
        const canonicalId = `nasdaq_halts:${rec.symbol}:${new Date(publishedAt).toISOString()}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < nowMs - FRESH_MS) continue;
        if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;

        const visibleAt = Date.now();
        broadcastBreaking({
          id: canonicalId,
          source: "nasdaq_halts",
          title: `Nasdaq Trading Halt: ${rec.symbol}${rec.reason ? ` (${rec.reason})` : ""}`,
          url: rec.url || URL || "",
          published_at: publishedAt,
          visible_at: visibleAt,
        });
        recordLatency("nasdaq_halts", publishedAt, visibleAt);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }

      if (lastIds.size > 5000) {
        lastIds = new Set(Array.from(lastIds).slice(-2500));
      }
      if (records.length) { noChangeStreak = 0; } else { noChangeStreak++; }
      const recency = records.length ? (nowMs - records[0].halt_time) : undefined;
      const base = GOV.nextDelayAfter(SOURCE, 'HTTP_200', { recencyMs: recency });
      const delay = noChangeStreak >= 3 ? 15000 : base;
      if (DEBUG_INGEST) console.log('[ingest:nasdaq_halts] 200 in', dt, 'ms, streak', noChangeStreak, 'base', base, 'next in', delay, 'ms');
      timer = setTimeout(tick, delay); (timer as any)?.unref?.();
      return;
    } catch (e) {
      const isTo = ((e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError' || /timeout|aborted/i.test(String((e as any)?.message)));
      if (DEBUG_INGEST && isTo) { console.log('[ingest:nasdaq_halts] timeout 2000 ms'); }
      const base = GOV.nextDelayAfter(SOURCE, isTo ? 'TIMEOUT' : 'HTTP_200');
      const delay = noChangeStreak >= 3 ? 15000 : base;
      console.warn("[ingest:nasdaq_halts] error", (e as any)?.message || e);
      timer = setTimeout(tick, delay); (timer as any)?.unref?.();
      return;
    } finally {
      inFlight = false;
      if (deferred) { deferred = false; setImmediate(tick); return; }
      // scheduled above in each path
    }
  };
  schedule();
}

export function start(): void { return startNasdaqHaltsIngest(); }
export function stopNasdaqHaltsIngest() {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }

export function getLimiterStats() {
  return {
    inFlight,
    deferred,
    overlapsPrevented,
    respTooLarge,
  };
}



