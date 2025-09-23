// backend/src/ingest/sec_press.ts
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { getGovernor, classifyOutcome } from "./governor.js";
import { warnOncePer } from "../log/rateLimit.js";
import { ingestOutcome } from "../metrics/simpleCounters.js";
import { readTextWithCap } from "./read_text_cap.js";

const FEED_URL = process.env.SEC_PRESS_URL ?? DEFAULT_URLS.SEC_PRESS_URL;

// HTML clamp base ~2300ms ±15%
const POLL_MS_BASE = 2300;
const JITTER_MS = Math.round(POLL_MS_BASE * 0.15);
const FRESH_MS = Number(process.env.FRESH_MS || 5 * 60 * 1000);
const BASE_TIMEOUT_MS = 2000;

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
const GOV = getGovernor();
const SOURCE = "sec_press";
const HOST: "sec.gov" = "sec.gov";
let inFlight = false;
let deferred = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
const MAX_BYTES_HTML = Number(process.env.MAX_BYTES_HTML || 800_000);
let watermarkPublishedAt = 0;
let warnedMissingUrl = false;
let noChangeStreak = 0;

function jitter(): number {
  return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

type Item = { title: string; url: string; publishedAt: number };

function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
function stripCdata(s: string): string { return s.replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1"); }
function decodeHtml(s: string): string { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function pick(tag: string, s: string): string { const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i")); return m ? m[1].trim() : ""; }

async function fetchOnce(): Promise<{ status: number; text?: string; etag?: string; lastModified?: string; ct?: string }>{
  const headers: Record<string,string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.7",
    "user-agent": "PulseNewsBot/1.0 (+contact: ops@pulsenewsai.com)",
    "cache-control": "no-cache",
  };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(FEED_URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(BASE_TIMEOUT_MS),
  });
  if (res.status === 304) return { status: 304 };
  let text: string | undefined;
  try { text = await readTextWithCap(res as any, MAX_BYTES_HTML); } catch (e) { if ((e as any)?.message === 'cap_exceeded') { respTooLarge++; } throw e; }
  return { status: res.status, text, etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined, ct: res.headers.get("content-type") ?? undefined };
}

function parseXML(xml: string): Item[] {
  const out: Item[] = [];
  if (!xml) return out;
  // RSS <item>
  const items = xml.includes("<item") ? xml.split(/<item\b/i).slice(1).map(x => x.split(/<\/item>/i)[0]) : [];
  for (const raw of items.slice(0, 20)) {
    const title = decodeHtml(stripCdata(pick("title", raw)));
    const link = stripCdata(pick("link", raw));
    const pubRaw = pick("pubDate", raw) || pick("published", raw) || pick("updated", raw);
    const publishedAt = pubRaw ? Date.parse(pubRaw) : 0;
    if (title && link) out.push({ title, url: link, publishedAt });
  }
  if (out.length) return out;
  // Atom <entry>
  const entries = xml.includes("<entry") ? xml.split(/<entry\b/i).slice(1).map(x => x.split(/<\/entry>/i)[0]) : [];
  for (const raw of entries.slice(0, 20)) {
    const title = decodeHtml(stripTags(pick("title", raw)));
    const linkHref = /<link\b[^>]*href=\"([^\"]+)\"/i.exec(raw)?.[1] ?? "";
    const pubRaw = pick("updated", raw) || pick("published", raw) || pick("created", raw);
    const publishedAt = pubRaw ? Date.parse(pubRaw) : 0;
    if (title && linkHref) out.push({ title, url: linkHref, publishedAt });
  }
  return out;
}

function parseHTML(html: string, base: string): Item[] {
  if (!html) return [];
  const out: Item[] = [];
  const re = /<a\b[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 20) {
    const href = m[1];
    const titleText = decodeHtml(stripTags(m[2]).trim());
    if (!titleText) continue;
    if (!/sec\.gov|press/i.test(href) && !/press/i.test(titleText)) {
      // heuristics: prefer press links/anchors
    }
    try {
      const url = new URL(href, base).toString();
      const head = html.slice(Math.max(0, m.index - 400), Math.min(html.length, m.index + 400));
      const dateMatch = head.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}/i) || head.match(/\b\d{4}-\d{2}-\d{2}\b/);
      const publishedAt = dateMatch ? Date.parse(dateMatch[0]) : 0;
      out.push({ title: titleText, url, publishedAt });
    } catch {}
  }
  return out;
}

export function startSecPressIngest(): void {
  if (timer) return;
  console.log("[ingest:sec_press] start");
  if (!FEED_URL) { const w = warnOncePer('ingest:sec_press:missing_url', 60_000); w("[ingest:sec_press] missing URL; skipping fetch"); return; }
  const schedule = () => { timer = setTimeout(tick, jitter()); (timer as any)?.unref?.(); };
  const tick = async () => {
    try {
      if (inFlight) { deferred = true; overlapsPrevented++; return; }
      inFlight = true;
      if (DEBUG_INGEST) console.log("[ingest:sec_press] tick");
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 429/403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const tok = GOV.claimHostToken(HOST);
      if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip budget wait, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const r = await fetchOnce();
      if (r.status === 304) { noChangeStreak++; const base = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); const d = noChangeStreak >= 3 ? 15000 : base; if (DEBUG_INGEST) console.log("[ingest:sec_press] 304, streak", noChangeStreak, 'base', base, "next in", d, "ms"); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 429) { const d = GOV.nextDelayAfter(SOURCE, 'R429'); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 429 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 403) { const d = GOV.nextDelayAfter(SOURCE, 'R403'); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status !== 200 || !r.text) {
        const outcome = classifyOutcome(r?.status);
        ingestOutcome(SOURCE, outcome);
        const w = warnOncePer(`ingest:${SOURCE}`, Number(process.env.WARN_COOLDOWN_MS ?? 60_000));
        w(`[ingest:${SOURCE}] ${outcome} status=${r?.status ?? 'NA'}`);
        const d = GOV.nextDelayAfter(SOURCE, outcome);
        timer = setTimeout(tick, d); (timer as any)?.unref?.(); return;
      }
      etag = r.etag || etag;
      lastModified = r.lastModified || lastModified;

      const ct = r.ct || "";
      let items: Item[] = [];
      if (/xml|rss|atom/i.test(ct) || /<rss|<feed|<entry|<item/i.test(r.text)) {
        items = parseXML(r.text);
      } else if (r.text) {
        items = parseHTML(r.text, FEED_URL!);
      }

      const now2 = Date.now();
      for (const it of items) {
        const publishedAt = it.publishedAt || now2;
        const canonicalId = `sec_press:${it.url}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < now2 - FRESH_MS) continue;
        if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;

        const visibleAt = Date.now();
        broadcastBreaking({
          id: canonicalId,
          source: "sec_press",
          title: it.title,
          url: it.url,
          published_at: publishedAt,
          visible_at: visibleAt,
        });
        setTimestampSource('sec_press', 'feed');
        recordPublisherLatency("sec_press", publishedAt, visibleAt);
        recordPipelineLatency("sec_press", visibleAt, visibleAt + 1);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
    } catch (e) {
      { const w = warnOncePer('ingest:sec_press:error', 60_000); w("[ingest:sec_press] error", (e as any)?.message || e); }
    } finally {
      ingestOutcome(SOURCE, 'HTTP_200');
      const base = GOV.nextDelayAfter(SOURCE, 'HTTP_200');
      const d = noChangeStreak >= 3 ? 15000 : base;
      timer = setTimeout(tick, d); (timer as any)?.unref?.();
      inFlight = false;
      if (deferred) { deferred = false; setImmediate(tick); return; }
    }
  };
  schedule();
}

export function start(): void { return startSecPressIngest(); }
export function stopSecPressIngest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }

export function getLimiterStats() {
  return { inFlight, deferred, overlapsPrevented, respTooLarge } as any;
}

// Deterministic single-shot health probe (no publish)
export async function probeOnce() {
  const fetch_started_at = Date.now();
  try {
    const r = await fetchOnce();
    const fetch_finished_at = Date.now();
    if (r.status !== 200 || !r.text) {
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
    let items: Item[] = [];
    const ct = r.ct || '';
    if (/xml|rss|atom/i.test(ct) || /<rss|<feed|<entry|<item/i.test(r.text)) {
      items = parseXML(r.text);
    } else {
      items = parseHTML(r.text, FEED_URL!);
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






