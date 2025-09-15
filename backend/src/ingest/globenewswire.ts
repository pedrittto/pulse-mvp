// backend/src/ingest/globenewswire.ts
// GlobeNewswire adapter — mirrors prnewswire structure; not enabled by default.
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { pickAgent } from "./http_agent.js";
import { canonicalIdFromItem } from "./lib/canonicalId.js";

const SOURCE_GNW = 'globenewswire';

export const id = SOURCE_GNW;
export const name = 'GlobeNewswire';

// Minimal internal timer loop (legacy-owned scheduling)
let t: NodeJS.Timeout | null = null;
const TICK_MS = Number(process.env.RSS_TICK_MS || 15000);

export function start(): void {
  if (t) return;
  console.log("[ingest:globenewswire] start");
  const loop = async () => {
    try { await tick(); } finally { t = setTimeout(loop, TICK_MS); (t as any)?.unref?.(); }
  };
  const delay = Math.floor(Math.random() * TICK_MS);
  t = setTimeout(loop, delay);
  (t as any)?.unref?.();
}

export function stop(): void {
  if (t) { try { clearTimeout(t); } catch {} t = null; }
}

export function getTimerCount(): number {
  return t ? 1 : 0;
}

// Stub probe: returns a static shape compatible with other adapters
export async function probeOnce(): Promise<{
  source: string;
  ok: boolean;
  http_status: number;
  items_found: number;
  latest_item_timestamp: number | null;
  fetch_started_at: number;
  fetch_finished_at: number;
  parse_ms: number;
  notes?: string;
}> {
  const fetch_started_at = Date.now();
  const fetch_finished_at = fetch_started_at;
  return {
    source: SOURCE_GNW,
    ok: true,
    http_status: 0,
    items_found: 0,
    latest_item_timestamp: null,
    fetch_started_at,
    fetch_finished_at,
    parse_ms: 0,
    notes: 'stub',
  };
}

// Stub tick: placeholder for scheduler wrapper
export async function tick(): Promise<{ http_status: number; new_items: number }> {
  const url = resolveUrl();
  if (!url) {
    warnOnceMissingUrl();
    return { http_status: 412, new_items: 0 };
  }
  try {
    const r = await fetchFeed(url);
    if (r.status === 304) return { http_status: 304, new_items: 0 };
    if (r.status !== 200 || !r.text) {
      if (DEBUG_INGEST) console.warn("[ingest:globenewswire] error status", r.status);
      return { http_status: r.status || 0, new_items: 0 };
    }
    etag = r.etag || etag;
    lastModified = r.lastModified || lastModified;
    const now = Date.now();
    const items = extractItems(r.text);
    let newCount = 0;
    for (const it of items) {
      if (lastGuids.has(it.guid)) continue;
      lastGuids.add(it.guid);
      // freshness & watermark
      if (it.publishedAt < now - FRESH_MS) continue;
      if (watermarkPublishedAt && it.publishedAt <= watermarkPublishedAt) continue;
      const visibleAt = Date.now();
      const canonId = canonicalIdFromItem({ guid: it.guid, url: it.link, title: it.title });
      broadcastBreaking({
        id: canonId,
        source: SOURCE_GNW,
        title: it.title,
        url: it.link,
        published_at_ms: it.publishedAt,
        visible_at_ms: visibleAt,
      });
      setTimestampSource(SOURCE_GNW, 'feed');
      recordPublisherLatency(SOURCE_GNW, it.publishedAt, visibleAt);
      recordPipelineLatency(SOURCE_GNW, visibleAt, visibleAt + 1);
      if (it.publishedAt > watermarkPublishedAt) watermarkPublishedAt = it.publishedAt;
      newCount++;
    }
    if (DEBUG_INGEST) console.log(`[ingest:${SOURCE_GNW}] 200 items=${items.length} new=${newCount}`);
    // bound dedupe memory
    if (lastGuids.size > 2000) {
      lastGuids = new Set(Array.from(lastGuids).slice(-1000));
    }
    return { http_status: 200, new_items: newCount };
  } catch (e) {
    if (DEBUG_INGEST) console.warn("[ingest:globenewswire] error", (e as any)?.message || e);
    return { http_status: 599, new_items: 0 };
  }
}

const adapter = { id, name, start, stop, getTimerCount, probeOnce, tick };
export default adapter;

function resolveUrl(): string {
  return String((DEFAULT_URLS as any)?.GNW_RSS_URL || '').trim();
}

let warnedMissing = false;
function warnOnceMissingUrl() {
  if (warnedMissing) return;
  warnedMissing = true;
  try { console.warn('[ingest:globenewswire] missing URL; set GLOBENEWSWIRE_RSS_URL to enable'); } catch {}
}

// --- Internal helpers mirroring prnewswire.js ---
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
const FRESH_MS = Number(process.env.FRESH_MS || 5 * 60 * 1000);
const MAX_BYTES_RSS = Number(process.env.MAX_BYTES_RSS || 1_000_000);
let etag: string | undefined;
let lastModified: string | undefined;
let lastGuids = new Set<string>();
let watermarkPublishedAt = 0;

function pick(tag: string, s: string): string {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function stripCdata(s: string): string { return s.replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1"); }

function extractItems(xml: string): { guid: string; link: string; title: string; publishedAt: number }[] {
  if (!xml) return [];
  const chunks = xml.split(/<item>/i).slice(1).map(x => x.split(/<\/item>/i)[0]);
  return chunks
    .map(raw => {
      const guid = stripCdata(pick("guid", raw)) || stripCdata(pick("link", raw));
      const link = stripCdata(pick("link", raw));
      const title = stripCdata(pick("title", raw));
      const pubRaw = pick("pubDate", raw) || pick("updated", raw) || pick("published", raw);
      const publishedAt = pubRaw ? Date.parse(pubRaw) : Date.now();
      return { guid, link, title, publishedAt };
    })
    .filter(it => it.guid && it.title && it.link);
}

async function fetchFeed(url: string): Promise<{ status: number; text?: string; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = { "user-agent": "pulse-ingest/1.0" };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(900),
    agent: pickAgent(url),
  } as any);
  if (res.status === 304) return { status: 304 } as any;
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && cl > MAX_BYTES_RSS) throw new Error('RESP_TOO_LARGE');
  const text = await readTextWithCap(res as any, MAX_BYTES_RSS);
  return {
    status: res.status,
    text,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

async function readTextWithCap(res: any, cap: number): Promise<string> {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const t = await res.text();
    if (t && t.length * 2 > cap) throw new Error('RESP_TOO_LARGE');
    return t;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const n = (value?.byteLength ?? value?.length ?? 0) as number;
    received += n;
    if (received > cap) { try { reader.cancel(); } catch {} throw new Error('RESP_TOO_LARGE'); }
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}


