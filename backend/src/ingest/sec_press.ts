// backend/src/ingest/sec_press.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { getGovernor } from "./governor.js";

const FEED_URL = process.env.SEC_PRESS_URL ?? DEFAULT_URLS.SEC_PRESS_URL;

// Same clamps/jitter as PRN/BW
const POLL_MS_BASE = 1200;
const JITTER_MS = 200;
const FRESH_MS = 5 * 60 * 1000;

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
const GOV = getGovernor();
const SOURCE = "sec_press";
const HOST: "sec.gov" = "sec.gov";
let watermarkPublishedAt = 0;
let warnedMissingUrl = false;

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
  const headers: Record<string,string> = { "user-agent": "pulse-ingest/1.0" };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(FEED_URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(900),
  });
  if (res.status === 304) return { status: 304 };
  const text = await res.text().catch(() => undefined);
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
  if (!FEED_URL) { console.warn("[ingest:sec_press] missing URL; skipping fetch"); return; }
  const schedule = () => { timer = setTimeout(tick, jitter()); (timer as any)?.unref?.(); };
  const tick = async () => {
    try {
      if (DEBUG_INGEST) console.log("[ingest:sec_press] tick");
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 429/403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const tok = GOV.claimHostToken(HOST);
      if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip budget wait, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      const r = await fetchOnce();
      if (r.status === 304) { const d = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); if (DEBUG_INGEST) console.log("[ingest:sec_press] 304, next in", d, "ms"); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 429) { const d = GOV.nextDelayAfter(SOURCE, 'R429'); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 429 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status === 403) { const d = GOV.nextDelayAfter(SOURCE, 'R403'); if (DEBUG_INGEST) console.log('[ingest:sec_press] skip 403 backoff, next in', d, 'ms'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      if (r.status !== 200 || !r.text) { console.warn("[ingest:sec_press] error status", r.status); const d = GOV.nextDelayAfter(SOURCE, 'HTTP_200'); timer = setTimeout(tick, d); (timer as any)?.unref?.(); return; }
      etag = r.etag || etag;
      lastModified = r.lastModified || lastModified;

      const ct = r.ct || "";
      let items: Item[] = [];
      if (/xml|rss|atom/i.test(ct) || /<rss|<feed|<entry|<item/i.test(r.text)) {
        items = parseXML(r.text);
      } else if (r.text) {
        items = parseHTML(r.text, FEED_URL!);
      }

      const now = Date.now();
      for (const it of items) {
        const publishedAt = it.publishedAt || now;
        const canonicalId = `sec_press:${it.url}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < now - FRESH_MS) continue;
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
        recordLatency("sec_press", publishedAt, visibleAt);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
    } catch (e) {
      console.warn("[ingest:sec_press] error", (e as any)?.message || e);
    } finally {
      const d = GOV.nextDelayAfter(SOURCE, 'HTTP_200');
      timer = setTimeout(tick, d); (timer as any)?.unref?.();
    }
  };
  schedule();
}

export function start(): void { return startSecPressIngest(); }
export function stopSecPressIngest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }






