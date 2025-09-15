// backend/src/ingest/nyse_notices.ts
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { getGovernor } from "./governor.js";
import { readTextWithCap } from "./read_text_cap.js";

const URL = process.env.NYSE_NOTICES_URL ?? DEFAULT_URLS.NYSE_NOTICES_URL; // HTML/RSS/JSON

// HTML clamp base ~2300ms ±15%
const POLL_MS_BASE = 2300;
const JITTER_MS = Math.round(POLL_MS_BASE * 0.15);
// Fast-Path clamp per PDF: 1–3 s window
if (process.env.SPEC_V1 === '1') {
  (globalThis as any).__nyseClamp = true;
}
const FRESH_MS = Number(process.env.FRESH_MS || 5 * 60 * 1000);
const BASE_TIMEOUT_MS = 900;

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let deferred = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
const MAX_BYTES_HTML = Number(process.env.MAX_BYTES_HTML || 2_000_000);
const GOV = getGovernor();
const SOURCE = "nyse_notices";
const HOST: "nyse.com" = "nyse.com";
let watermarkPublishedAt = 0;
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
  if (cl && /html|text|xml|json/i.test(ct) && cl > MAX_BYTES_HTML) { respTooLarge++; }
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

type Notice = { title: string; url: string; publishedAt: number };

function parseJSON(maybe: any): Notice[] {
  const out: Notice[] = [];
  const arr = Array.isArray(maybe) ? maybe : (Array.isArray(maybe?.items) ? maybe.items : Array.isArray(maybe?.data) ? maybe.data : []);
  for (const it of arr) {
    const title = String(it.title ?? it.headline ?? "").trim();
    const url = String(it.url ?? it.link ?? it.href ?? "").trim();
    const t = it.publishedAt ?? it.updatedAt ?? it.date ?? it.pubDate ?? it.time ?? 0;
    const ms = typeof t === "number" ? t : Date.parse(String(t));
    if (!title || !url) continue;
    out.push({ title, url, publishedAt: ms || Date.now() });
  }
  return out;
}

function pick(tag: string, s: string): string {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
function stripCdata(s: string): string { return s.replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1"); }
function decodeHtml(s: string): string { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

function parseRSSorHTML(text: string): Notice[] {
  if (!text) return [];
  // Try RSS first (very lightweight)
  if (/<rss|<feed|<channel/i.test(text)) {
    const items = text.split(/<item>/i).slice(1).map(x => x.split(/<\/item>/i)[0]);
    const out: Notice[] = [];
    for (const raw of items) {
      const link = stripCdata(pick("link", raw));
      const title = stripCdata(pick("title", raw));
      const pubRaw = pick("pubDate", raw) || pick("updated", raw) || pick("published", raw);
      const publishedAt = pubRaw ? Date.parse(pubRaw) : Date.now();
      if (title && link) out.push({ title, url: link, publishedAt });
    }
    if (out.length) return out;
  }
  // Fallback tiny HTML parser: look for anchors in list/table structures
  const out: Notice[] = [];
  const rows = text.split(/<a\b[^>]*href=\"[^\"]+\"[^>]*>/i);
  for (let i = 1; i < rows.length; i++) {
    const seg = rows[i - 1].slice(-200) + rows[i].slice(0, 400);
    const hrefMatch = rows[i - 1].match(/<a\b[^>]*href=\"([^\"]+)\"/i) || rows[i].match(/<a\b[^>]*href=\"([^\"]+)\"/i);
    const textMatch = rows[i].match(/>([^<]{4,200})</);
    const tMatch = seg.match(/\b(\d{4}-\d{2}-\d{2}[^\s<]*|\w{3,9}\s+\d{1,2},\s+\d{4}[^<]*)/);
    const url = hrefMatch ? hrefMatch[1] : "";
    const title = textMatch ? decodeHtml(stripTags(textMatch[1]).trim()) : "";
    const ms = tMatch ? Date.parse(tMatch[1]) : 0;
    if (url && title) out.push({ title, url, publishedAt: ms || Date.now() });
  }
  return out.slice(0, 50);
}

export function startNyseNoticesIngest() {
  if (timer) return;
  console.log("[ingest:nyse_notices] start");
  if (!URL) { console.warn("[ingest:nyse_notices] missing URL; skipping fetch"); return; }
  const schedule = () => { timer = setTimeout(tick, jitter()); (timer as any)?.unref?.(); };
  const tick = async () => {
    try {
      if (inFlight) { deferred = true; overlapsPrevented++; return; }
      inFlight = true;
      if (DEBUG_INGEST) console.log("[ingest:nyse_notices] tick");
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:nyse_notices] skip 429/403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const tok = GOV.claimHostToken(HOST);
      if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:nyse_notices] skip budget wait, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const r = await fetchFeed();
      try { (await import('./index.js')).reportTick?.('nyse_notices', { status: (r as any)?.status }); } catch {}
      if (r.status === 304) { noChangeStreak++; const base = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); const d = noChangeStreak >= 3 ? 15000 : base; if (DEBUG_INGEST) console.log('[ingest:nyse_notices] 304, streak', noChangeStreak, 'base', base, 'next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 429) { const base = GOV.nextDelayAfter(SOURCE, 'R429'); const d = noChangeStreak >= 3 ? 15000 : base; if (DEBUG_INGEST) console.log('[ingest:nyse_notices] skip 429 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 403) { const base = GOV.nextDelayAfter(SOURCE, 'R403'); const d = noChangeStreak >= 3 ? 15000 : base; if (DEBUG_INGEST) console.log('[ingest:nyse_notices] skip 403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status !== 200) { console.warn("[ingest:nyse_notices] error status", r.status); const base = GOV.nextDelayAfter(SOURCE, 'HTTP_200'); const d = noChangeStreak >= 3 ? 15000 : base; timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      etag = r.etag || etag;
      lastModified = r.lastModified || lastModified;

      let items: Notice[] = [];
      if (r.json) items = parseJSON(r.json);
      else if (r.text && /^\s*[{\[]/.test(r.text)) {
        try { items = parseJSON(JSON.parse(r.text)); } catch {}
      } else if (r.text) {
        items = parseRSSorHTML(r.text);
      }

      const now = Date.now();
      for (const it of items) {
        const publishedAt = it.publishedAt || now;
        const canonicalId = `nyse_notices:${it.url || it.title}:${new Date(publishedAt).toISOString()}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < now - FRESH_MS) continue;
        if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;

        const visibleAt = Date.now();
        broadcastBreaking({
          id: canonicalId,
          source: "nyse_notices",
          title: it.title,
          url: it.url,
          published_at: publishedAt,
          visible_at: visibleAt,
        });
        setTimestampSource('nyse_notices', 'feed');
        recordPublisherLatency("nyse_notices", publishedAt, visibleAt);
        recordPipelineLatency("nyse_notices", visibleAt, visibleAt + 1);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
      const recency = items.length ? (now - items[0].publishedAt) : undefined;
      const base = GOV.nextDelayAfter(SOURCE, 'HTTP_200', { recencyMs: recency });
      const d = noChangeStreak >= 3 ? 15000 : base;
      if (DEBUG_INGEST) console.log('[ingest:nyse_notices] 200, streak', noChangeStreak, 'base', base, 'next in', d, 'ms');
      timer = setTimeout(tick, d); (timer as any)?.unref?.();
      return;
    } catch (e) {
      console.warn("[ingest:nyse_notices] error", (e as any)?.message || e);
    } finally {
      inFlight = false;
      if (deferred) { deferred = false; setImmediate(tick); return; }
    }
  };
  schedule();
}

export function start(): void { return startNyseNoticesIngest(); }
export function stopNyseNoticesIngest() {
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

// Deterministic single-run probe (no publish)
export async function probeOnce() {
  const fetch_started_at = Date.now();
  try {
    const r = await fetchFeed();
    const fetch_finished_at = Date.now();
    if (r.status !== 200 || (!r.text && !r.json)) {
      return {
        source: SOURCE,
        ok: false,
        http_status: r.status,
        items_found: 0,
        latest_item_timestamp: null,
        fetch_started_at,
        fetch_finished_at,
        parse_ms: 0,
        notes: 'http_error_or_empty',
      };
    }
    const p0 = Date.now();
    let items: Notice[] = [];
    if ((r as any).json) items = parseJSON((r as any).json);
    else if (r.text && /^\s*[{\[]/.test(r.text)) {
      try { items = parseJSON(JSON.parse(r.text)); } catch {}
    } else if (r.text) {
      items = parseRSSorHTML(r.text);
    }
    const parse_ms = Date.now() - p0;
    const latest = items.reduce((m, it) => Math.max(m, it.publishedAt || 0), 0) || null;
    return {
      source: SOURCE,
      ok: true,
      http_status: 200,
      items_found: items.length,
      latest_item_timestamp: latest,
      fetch_started_at,
      fetch_finished_at,
      parse_ms,
      notes: items.length ? 'reachable_parsable' : 'reachable_no_items',
    };
  } catch (e) {
    const fetch_finished_at = Date.now();
    return {
      source: SOURCE,
      ok: false,
      http_status: 0,
      items_found: 0,
      latest_item_timestamp: null,
      fetch_started_at,
      fetch_finished_at,
      parse_ms: 0,
      notes: 'exception:' + ((e as any)?.message || String(e)),
    };
  }
}



