// backend/src/ingest/sec_edgar.ts
// Minimal skeleton adapter for SEC EDGAR (Latest Filings) — no runtime impact.
// Not registered yet; Part 2 will wire it into the scheduler when ready.

import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { pickAgent } from "./http_agent.js";
import { canonicalIdFromItem } from "./lib/canonicalId.js";
import { warnOncePer } from "../log/rateLimit.js";

export const id = 'sec_edgar';
export const name = 'SEC EDGAR';

// Minimal internal timer loop (legacy-owned scheduling)
let t: NodeJS.Timeout | null = null;
const TICK_MS = Number(process.env.RSS_TICK_MS || 15000);

export function start(): void {
  if (t) return;
  console.log("[ingest:sec_edgar] start");
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
    source: id,
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

export async function tick(): Promise<{ http_status: number; new_items: number }> {
  const url = resolveUrl();
  if (!url) {
    warnOnceMissingUrl();
    return { http_status: 412, new_items: 0 };
  }
  const ua = resolveUserAgent();
  if (!ua) {
    warnOnceMissingUA();
    return { http_status: 412, new_items: 0 };
  }
  try {
    const r = await fetchAtom(url, ua);
    if (r.status === 304) return { http_status: 304, new_items: 0 };
    if (r.status !== 200 || !r.text) {
      if (DEBUG_INGEST) { try { console.log("[ingest:sec_edgar] error status", r.status); } catch {} }
      return { http_status: r.status || 0, new_items: 0 };
    }
    etag = r.etag || etag;
    lastModified = r.lastModified || lastModified;
    const now = Date.now();
    const entries = extractEntries(r.text);
    const passForm = buildFormFilter();
    let newCount = 0;
    for (const it of entries) {
      if (!passForm(it.formType)) continue;
      const publishedAt = it.publishedAt || now;
      if (publishedAt < now - FRESH_MS) continue;
      if (watermarkPublishedAt && publishedAt <= watermarkPublishedAt) continue;
      const canonId = canonicalIdFromItem({ guid: it.guid, url: it.link, title: it.title });
      const visibleAt = Date.now();
      broadcastBreaking({
        id: canonId,
        source: id,
        title: it.title,
        url: it.link,
        published_at_ms: publishedAt,
        visible_at_ms: visibleAt,
      });
      setTimestampSource(id, 'feed');
      recordPublisherLatency(id, publishedAt, visibleAt);
      recordPipelineLatency(id, visibleAt, visibleAt + 1);
      if (publishedAt > watermarkPublishedAt) watermarkPublishedAt = publishedAt;
      newCount++;
    }
    if (DEBUG_INGEST) console.log(`[ingest:${id}] 200 items=${entries.length} new=${newCount}`);
    return { http_status: 200, new_items: newCount };
  } catch (e) {
    if (DEBUG_INGEST) { try { console.log("[ingest:sec_edgar] error", (e as any)?.message || e); } catch {} }
    return { http_status: 599, new_items: 0 };
  }
}

const adapter = { id, name, start, stop, getTimerCount, probeOnce, tick };
export default adapter;

// --- Internals ---
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
const FRESH_MS = Number(process.env.FRESH_MS || 5 * 60 * 1000);
const MAX_BYTES_ATOM = Number(process.env.MAX_BYTES_RSS || 1_000_000);
let etag: string | undefined;
let lastModified: string | undefined;
let watermarkPublishedAt = 0;

function resolveUrl(): string {
  return String((DEFAULT_URLS as any)?.EDGAR_ATOM_URL || "").trim();
}

let warnedMissing = false;
function warnOnceMissingUrl() {
  if (warnedMissing) return;
  warnedMissing = true;
  try { const w = warnOncePer('ingest:sec_edgar:missing_url', 60_000); w("[ingest:sec_edgar] missing URL; set EDGAR_LATEST_ATOM_URL to enable"); } catch {}
}

function resolveUserAgent(): string {
  return String(process.env.SEC_USER_AGENT || "").trim();
}

let warnedMissingUA = false;
function warnOnceMissingUA() {
  if (warnedMissingUA) return;
  warnedMissingUA = true;
  try { const w = warnOncePer('ingest:sec_edgar:missing_ua', 60_000); w("[ingest:sec_edgar] missing SEC_USER_AGENT; required by SEC Fair Access"); } catch {}
}

async function fetchAtom(url: string, ua: string): Promise<{ status: number; text?: string; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = {
    "user-agent": ua,
    "accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    "cache-control": "no-cache",
  };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(1200),
    agent: pickAgent(url),
  } as any);
  if (res.status === 304) return { status: 304 } as any;
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && cl > MAX_BYTES_ATOM) throw new Error('RESP_TOO_LARGE');
  const text = await readTextWithCap(res as any, MAX_BYTES_ATOM);
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

type Entry = { guid: string; link: string; title: string; publishedAt: number; formType?: string };
function pick(tag: string, s: string): string {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function stripCdata(s: string): string { return s.replace(/^<!\\[CDATA\\[(.*)\\]>/s, "$1"); }

function extractEntries(xml: string): Entry[] {
  if (!xml) return [];
  const out: Entry[] = [];
  const blocks = xml.split(/<entry\b[^>]*>/i).slice(1).map(b => b.split(/<\/entry>/i)[0]);
  for (const raw of blocks) {
    const idTag = stripCdata(pick('id', raw));
    const title = stripCdata(pick('title', raw));
    const linkHref = /<link\b[^>]*href=\"([^\"]+)\"/i.exec(raw)?.[1] || stripCdata(pick('link', raw));
    const pubRaw = pick('updated', raw) || pick('published', raw);
    const publishedAt = pubRaw ? Date.parse(pubRaw) : Date.now();
    const catTerm = /<category\b[^>]*term=\"([^\"]+)\"/i.exec(raw)?.[1];
    const guid = idTag || linkHref || title;
    if (guid && linkHref && title) out.push({ guid, link: linkHref, title, publishedAt, formType: catTerm });
  }
  return out;
}

function buildFormFilter(): (t?: string) => boolean {
  const FORM_FILTER = String(process.env.EDGAR_FORM_TYPES || "")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  return (t?: string) => !FORM_FILTER.length || (t ? FORM_FILTER.includes(String(t).toUpperCase()) : false);
}

