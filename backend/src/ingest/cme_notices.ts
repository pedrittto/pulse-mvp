// backend/src/ingest/cme_notices.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";

const FEED_URL = process.env.CME_NOTICES_URL ?? DEFAULT_URLS.CME_NOTICES_URL;

// Match fast-lane clamps used by BW/PRN/Nasdaq
const POLL_MS_BASE = 1200;
const JITTER_MS = 200;
const FRESH_MS = 5 * 60 * 1000;

let lastIds = new Set<string>(); // dedupe by absolute notice URL (or canonical id)
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let watermarkPublishedAt = 0; // newest accepted publishedAt
let warnedMissingUrl = false;

function jitter(): number {
  return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}

type Notice = { title: string; url: string; publishedAt: number; summary?: string };

function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
function decodeHtml(s: string): string { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

async function httpGet(FEED_URL: string, conditional = false): Promise<{ status: number; text?: string; etag?: string; lastModified?: string; headers?: Headers }>{
  const headers: Record<string, string> = { "user-agent": "pulse-ingest/1.0" };
  if (conditional) {
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }
  const res = await fetch(FEED_URL, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(900),
  });
  if (res.status === 304) return { status: 304 };
  const text = await res.text().catch(() => undefined);
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
      console.log("[ingest:cme_notices] tick");
      const hub = await httpGet(FEED_URL, true);
      if (hub.status === 304) { console.log("[ingest:cme_notices] not modified"); schedule(); return; }
      if (hub.status !== 200 || !hub.text) { console.warn("[ingest:cme_notices] error status", hub.status); schedule(); return; }
      etag = hub.etag || etag;
      lastModified = hub.lastModified || lastModified;

      const links = pickFirstNoticeLinksFromHub(hub.text, FEED_URL, 10);
      const now = Date.now();
      for (const href of links) {
        const baseUrl = FEED_URL;
        const url = new URL(href, baseUrl).toString();
        const page = await httpGet(url);
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
      schedule();
    }
  };
  schedule();
}

export function stopCmeNoticesIngest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}





