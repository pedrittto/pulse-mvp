// backend/src/ingest/nyse_notices.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";

const URL = process.env.NYSE_NOTICES_URL ?? DEFAULT_URLS.NYSE_NOTICES_URL; // HTML/RSS/JSON

// Match fast-lane clamps used by BW/PRN/Nasdaq
const POLL_MS_BASE = 1200;
const JITTER_MS = 200;
const FRESH_MS = 5 * 60 * 1000;

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let watermarkPublishedAt = 0;
let warnedMissingUrl = false;

function jitter(): number {
  return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");

async function fetchFeed(): Promise<{ status: number; text?: string; json?: any; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = { "user-agent": "pulse-ingest/1.0" };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(900),
  });
  if (res.status === 304) return { status: 304 };
  const ct = res.headers.get("content-type") || "";
  const common = {
    status: res.status,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
  try {
    if (/json/i.test(ct)) {
      const json = await res.json().catch(() => undefined);
      return { ...common, json } as any;
    }
  } catch {}
  const text = await res.text().catch(() => undefined);
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
      if (DEBUG_INGEST) console.log("[ingest:nyse_notices] tick");
      const r = await fetchFeed();
      if (r.status === 304) { if (DEBUG_INGEST) console.log("[ingest:nyse_notices] not modified"); schedule(); return; }
      if (r.status !== 200) { console.warn("[ingest:nyse_notices] error status", r.status); schedule(); return; }
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
        recordLatency("nyse_notices", publishedAt, visibleAt);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
    } catch (e) {
      console.warn("[ingest:nyse_notices] error", (e as any)?.message || e);
    } finally {
      schedule();
    }
  };
  schedule();
}

export function start(): void { return startNyseNoticesIngest(); }
export function stopNyseNoticesIngest() {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }



