// backend/src/ingest/fed_press.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { getGovernor } from "./governor.js";
import { readTextWithCap } from "./read_text_cap.js";

const FEED_URL = process.env.FED_PRESS_URL ?? DEFAULT_URLS.FED_PRESS_URL;

// Same clamps/jitter as PRN/BW
const POLL_MS_BASE = 1200;
const JITTER_MS = 200;
const FRESH_MS = 5 * 60 * 1000;
const BASE_TIMEOUT_MS = 900;

let lastIds = new Set<string>();
let etag: string | undefined;
let lastModified: string | undefined;
let timer: NodeJS.Timeout | null = null;
let watermarkPublishedAt = 0;
const GOV = getGovernor();
const SOURCE = "fed_press";
const HOST: "sec.gov" = "sec.gov"; // many FED endpoints are served via gov domains; adjust if needed
let inFlight = false;
let deferred = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
const MAX_BYTES_HTML = Number(process.env.MAX_BYTES_HTML || 2_000_000);

// Local soft breaker + clamp escalator (module scope)
let pausedUntil = 0; // epoch ms
let consecutiveTimeouts = 0;
let timeoutWindow: number[] = []; // last 60s timestamps
let currentTimeoutMs = BASE_TIMEOUT_MS;

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
    signal: AbortSignal.timeout(currentTimeoutMs),
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

export function startFedPressIngest(): void {
  if (timer) return;
  const schedule = (ms?: number) => { timer = setTimeout(tick, typeof ms === 'number' ? ms : jitter()); (timer as any)?.unref?.(); };
  if (!FEED_URL) { console.warn("[ingest:fed_press] missing URL; skipping fetch"); return; }
  const tick = async () => {
    try {
      const now = Date.now();
      if (now < pausedUntil) { const d = Math.max(500, pausedUntil - now); schedule(d); return; }
      if (DEBUG_INGEST) console.log("[ingest:fed_press] tick");
      const backoffMs = GOV.getNextInMs(SOURCE);
      if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); schedule(d); return; }
      const tok = GOV.claimHostToken(HOST);
      if (!tok.ok) { schedule(Math.max(500, tok.waitMs)); return; }
      const r = await fetchOnce();
      if (r.status === 304) { const d = GOV.nextDelayAfter(SOURCE, 'HTTP_304'); schedule(d); return; }
      if (r.status === 429) { consecutiveTimeouts++; timeoutWindow.push(now); timeoutWindow = timeoutWindow.filter(t => now - t <= 60_000); currentTimeoutMs = timeoutWindow.length >= 3 ? Math.max(currentTimeoutMs, 1800) : currentTimeoutMs; if (consecutiveTimeouts >= 5) { pausedUntil = now + 10 * 60 * 1000; consecutiveTimeouts = 0; } const d = GOV.nextDelayAfter(SOURCE, 'R429'); schedule(d); return; }
      if (r.status === 403) { consecutiveTimeouts++; timeoutWindow.push(now); timeoutWindow = timeoutWindow.filter(t => now - t <= 60_000); currentTimeoutMs = timeoutWindow.length >= 3 ? Math.max(currentTimeoutMs, 1800) : currentTimeoutMs; if (consecutiveTimeouts >= 5) { pausedUntil = now + 10 * 60 * 1000; consecutiveTimeouts = 0; } const d = GOV.nextDelayAfter(SOURCE, 'R403'); schedule(d); return; }
      if (r.status !== 200 || !r.text) { const d = GOV.nextDelayAfter(SOURCE, 'HTTP_200'); schedule(d); return; }
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
        const canonicalId = `fed_press:${it.url}`;
        if (lastIds.has(canonicalId)) continue;
        lastIds.add(canonicalId);
        if (publishedAt < now - FRESH_MS) continue;
        if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;

        const visibleAt = Date.now();
        broadcastBreaking({
          id: canonicalId,
          source: "fed_press",
          title: it.title,
          url: it.url,
          published_at: publishedAt,
          visible_at: visibleAt,
        });
        recordLatency("fed_press", publishedAt, visibleAt);
        if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      }
      if (lastIds.size > 5000) lastIds = new Set(Array.from(lastIds).slice(-2500));
    } catch {
      // keep hot path quiet
    } finally {
      const d = GOV.nextDelayAfter(SOURCE, 'HTTP_200');
      // success-like: reset window and timeout
      consecutiveTimeouts = 0;
      timeoutWindow = [];
      currentTimeoutMs = BASE_TIMEOUT_MS;
      schedule(d);
    }
  };
  schedule();
}

export function start(): void { return startFedPressIngest(); }
export function stopFedPressIngest(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
export function getTimerCount(): number { return timer ? 1 : 0; }

export function getLimiterStats() {
  return {
    inFlight: false,
    deferred: deferred,
    overlapsPrevented,
    respTooLarge,
    pausedUntil,
    consecutiveTimeouts,
    timeoutWindowCount: timeoutWindow.length,
    currentTimeoutMs,
  };
}






