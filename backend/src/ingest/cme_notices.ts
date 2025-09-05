// backend/src/ingest/cme_notices.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { getGovernor } from "./governor.js";
import { readTextWithCap } from "./read_text_cap.js";

const FEED_URL = process.env.CME_NOTICES_URL ?? DEFAULT_URLS.CME_NOTICES_URL;

// HTML clamp base ~2300ms ±15% (CME HTML)
const POLL_MS_BASE = 2300;
const JITTER_MS = Math.round(POLL_MS_BASE * 0.15);
const FRESH_MS = 5 * 60 * 1000;
const BASE_TIMEOUT_MS = 2000; // per-request base timeout for CME
const GOV = getGovernor();
const SOURCE = "cme_notices";
const HOST: "cmegroup.com" = "cmegroup.com";

let lastIds = new Set<string>(); // dedupe by absolute notice URL (or canonical id)
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let deferred = false;
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

type Notice = { title: string; url: string; publishedAt: number; summary?: string };

function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
function decodeHtml(s: string): string { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

async function httpGet(FEED_URL: string, conditional = false): Promise<{ status: number; text?: string; etag?: string; lastModified?: string; headers?: Headers }>{
  const headers: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.7",
    "user-agent": "PulseNewsBot/1.0 (+contact: ops@pulsenewsai.com)",
    "cache-control": "no-cache",
  };
  if (conditional) {
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }
  const t0 = Date.now();
  const token = GOV.claimHostToken(HOST);
  if (!token.ok) {
    return { status: 0 } as any; // caller will handle scheduling based on governor
  }
  const res = await fetch(FEED_URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(2000),
  });
  if (res.status === 304) return { status: 304 };
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && cl > MAX_BYTES_HTML) { respTooLarge++; throw new Error('RESP_TOO_LARGE'); }
  let text: string | undefined;
  try { text = await readTextWithCap(res as any, MAX_BYTES_HTML); } catch (e) { if ((e as any)?.message === 'cap_exceeded') { respTooLarge++; } throw e; }
  const dt = Date.now() - t0;
  return {
    status: res.status,
    text,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    headers: res.headers,
  };
}

function pickFirstNoticeLinksFromHub(html: string, baseUrl: string, max = 10): string[] {
  if (!html) return [];
  const out: string[] = [];
  const anchorRegex = /<a\b[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRegex.exec(html)) && out.length < max) {
    const href = m[1];
    if (!/\/notices\//i.test(href)) continue;
    if (!/\.html?(?:$|[?#])/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl).toString();
      if (!out.includes(url)) out.push(url);
    } catch {}
  }
  if (out.length) return out;
  // fallback: scan for direct path patterns under /notices/electronic-trading/
  const dirRegex = /\b(\/notices\/electronic-trading\/\d{4}\/\d{2}\/[^\"'\s<>]+\.html)/gi;
  const seen = new Set<string>();
  while ((m = dirRegex.exec(html)) && out.length < max) {
    try {
      const url = new URL(m[1], baseUrl).toString();
      if (!seen.has(url)) { out.push(url); seen.add(url); }
    } catch {}
  }
  return out;
}

function parseNoticePage(html: string, headers?: Headers): { title: string; publishedAt: number; summary?: string } | null {
  if (!html) return null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = h1?.[1] ?? titleTag?.[1] ?? "";
  const title = decodeHtml(stripTags(rawTitle).trim());
  if (!title) return null;
  // Find a date-like token near the top
  const head = html.slice(0, 4000);
  const dateMatch = head.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?/i)
                  || head.match(/\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  let publishedAt = dateMatch ? Date.parse(dateMatch[0]) : 0;
  if (!publishedAt) {
    const lm = headers?.get("last-modified");
    if (lm) publishedAt = Date.parse(lm) || 0;
  }
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const summary = p ? decodeHtml(stripTags(p[1]).trim()).slice(0, 400) : undefined;
  return { title, publishedAt, summary };
}

export function startCmeNoticesIngest(): void {
  if (timer) return;
  console.log("[ingest:cme_notices] start");
  if (!FEED_URL) { console.warn("[ingest:cme_notices] missing URL; skipping fetch"); return; }
  const schedule = () => { timer = setTimeout(tick, jitter()); (timer as any)?.unref?.(); };
  const tick = async () => {
    try {
      if (inFlight) { deferred = true; overlapsPrevented++; return; }
      inFlight = true;
      if (DEBUG_INGEST) console.log("[ingest:cme_notices] tick");
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') {
        const delay = Math.max(500, backoffMs);
        if (DEBUG_INGEST) console.log('[ingest:cme_notices] skip 429/403 backoff, next in', delay, 'ms');
        timer = setTimeout(tick, delay); (timer as any)?.unref?.();
        return;
      }
      const t0 = Date.now();
      const hub = await httpGet(FEED_URL, true);
      const dt = Date.now() - t0;
      if ((hub as any).status === 0) { const base = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); const d = noChangeStreak >= 3 ? 15000 : base; timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (hub.status === 304) { noChangeStreak++; const base = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); const delay = noChangeStreak >= 3 ? 15000 : base; if (DEBUG_INGEST) console.log('[ingest:cme_notices] 304 in', dt, 'ms, streak', noChangeStreak, 'base', base, 'next in', delay, 'ms'); timer = setTimeout(tick, delay); (timer as any)?.unref?.(); return; }
      if (DEBUG_INGEST) console.log('[ingest:cme_notices] http', hub.status, 'in', dt, 'ms', hub.etag || hub.lastModified || '');
      if (hub.status === 429) { const delay = GOV.nextDelayAfter(SOURCE, 'R429'); if (DEBUG_INGEST) console.log('[ingest:cme_notices] skip 429 backoff in', dt, 'ms, next in', delay, 'ms'); timer = setTimeout(tick, delay); (timer as any)?.unref?.(); return; }
      if (hub.status === 403) { const delay = GOV.nextDelayAfter(SOURCE, 'R403'); if (DEBUG_INGEST) console.log('[ingest:cme_notices] skip 403 backoff in', dt, 'ms, next in', delay, 'ms'); timer = setTimeout(tick, delay); (timer as any)?.unref?.(); return; }
      if (hub.status !== 200 || !hub.text) { console.warn("[ingest:cme_notices] error status", hub.status); const delay = GOV.nextDelayAfter(SOURCE, 'HTTP_200'); timer = setTimeout(tick, delay); (timer as any)?.unref?.(); return; }
      etag = hub.etag || etag;
      lastModified = hub.lastModified || lastModified;

      const links = pickFirstNoticeLinksFromHub(hub.text, FEED_URL, 10);
      const now = Date.now();
      for (const href of links) {
        const baseUrl = FEED_URL;
        const url = new URL(href, baseUrl).toString();
        const p0 = Date.now();
        const page = await httpGet(url);
        const pd = Date.now() - p0;
        if (DEBUG_INGEST) console.log('[ingest:cme_notices] page http', page.status, 'in', pd, 'ms');
        if (page.status !== 200 || !page.text) continue;
        const meta = parseNoticePage(page.text, page.headers);
        if (!meta) continue;
        const publishedAt = meta.publishedAt || now;
        // canonical id based on absolute URL and iso time for stability
        const canonicalId = `cme_notices:${url}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < now - FRESH_MS) continue;
        if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;

        const visibleAt = Date.now();
        broadcastBreaking({
          id: canonicalId,
          source: "cme_notices",
          title: meta.title,
          url,
          published_at: publishedAt,
          visible_at: visibleAt,
        });
        recordLatency("cme_notices", publishedAt, visibleAt);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
    } catch (e) {
      console.warn("[ingest:cme_notices] error", (e as any)?.message || e);
    } finally {
      const baseDelay = GOV.nextDelayAfter(SOURCE, 'HTTP_200');
      const delay = noChangeStreak >= 3 ? 15000 : baseDelay;
      if (DEBUG_INGEST) console.log('[ingest:cme_notices] next in', delay, 'ms', 'streak', noChangeStreak, 'base', baseDelay);
      timer = setTimeout(tick, delay); (timer as any)?.unref?.();
      inFlight = false;
      if (deferred) { deferred = false; setImmediate(tick); return; }
    }
  };
  schedule();
}

export function start(): void { return startCmeNoticesIngest(); }
export function stopCmeNoticesIngest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }

export function getLimiterStats() {
  return { inFlight, deferred, overlapsPrevented, respTooLarge } as any;
}






