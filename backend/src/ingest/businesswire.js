// backend/src/ingest/businesswire.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { getGovernor } from "./governor.js";
import { pickAgent } from "./http_agent.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
const URL = process.env.BW_RSS_URL ?? DEFAULT_URLS.BW_RSS_URL;
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
let BW_BACKOFF_UNTIL = 0; // epoch ms; skip ticks until this time after 403
let BW_LAST_SKIP_LOG = 0; // epoch ms, rate-limit skip logs
// Sub-2s lane
const POLL_MS_BASE = 1200; // ~1.2s base clamp
const JITTER_MS = 200; // ± jitter
const FRESH_MS = 5 * 60 * 1000; // accept items newer than 5 min
const MAX_BYTES_RSS = Number(process.env.MAX_BYTES_RSS || 1_000_000);
let lastGuids = new Set(); // short-window dedup
let etag;
let lastModified;
let timer = null;
const GOV = getGovernor();
const SOURCE = "businesswire";
const HOST = "businesswire.com";
let inFlight = false;
let deferred = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
let watermarkPublishedAt = 0; // newest accepted publishedAt
let warnedMissingUrl = false;
function jitter() {
    return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}
function pick(tag, s) {
    const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? m[1].trim() : "";
}
function stripCdata(s) {
    return s.replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1");
}
function extractItems(xml) {
    const chunks = xml.split(/<item>/i).slice(1).map(x => x.split(/<\/item>/i)[0]);
    return chunks
        .map(raw => {
        const guid = stripCdata(pick("guid", raw)) || stripCdata(pick("link", raw));
        const link = stripCdata(pick("link", raw));
        const title = stripCdata(pick("title", raw));
        const pubRaw = pick("pubDate", raw);
        const publishedAt = pubRaw ? Date.parse(pubRaw) : Date.now();
        return { guid, link, title, publishedAt };
    })
        .filter(it => it.guid && it.title && it.link);
}
async function fetchFeed() {
    const headers = {
        "User-Agent": "PulseBot/1.0 (+https://pulsenewsai.com)",
        "Accept": "application/rss+xml, text/html;q=0.8,*/*;q=0.5",
    };
    if (etag)
        headers["if-none-match"] = etag;
    if (lastModified)
        headers["if-modified-since"] = lastModified;

    // 5s timeout just for BusinessWire
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);

    const res = await fetch(URL, {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
        signal: ctrl.signal,
        // agent: pickAgent(URL)
    });

    clearTimeout(to);

    // Gentle backoff on WAF 403 to avoid hammering
    if (res.status === 403) {
        BW_BACKOFF_UNTIL = Date.now() + 10 * 60 * 1000; // 10 minutes
        console.warn('[ingest:businesswire] 403 from BusinessWire — backing off 10m');
        return;
    }

    if (res.status === 304)
        return { status: 304 };
    const cl = Number(res.headers.get("content-length") || 0);
    if (cl && cl > MAX_BYTES_RSS) { respTooLarge++; throw new Error('RESP_TOO_LARGE'); }
    const text = await readTextWithCap(res, MAX_BYTES_RSS);
    return {
        status: res.status,
        text,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
    };
}

async function readTextWithCap(res, cap) {
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) {
        const t = await res.text();
        if (t && t.length * 2 > cap) { respTooLarge++; throw new Error('RESP_TOO_LARGE'); }
        return t;
    }
    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const n = value?.byteLength ?? value?.length ?? 0;
        received += n;
        if (received > cap) { try { reader.cancel(); } catch {} respTooLarge++; throw new Error('RESP_TOO_LARGE'); }
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}
export function startBusinessWireIngest() {
    if (timer)
        return;
    if (!URL) { console.warn("[ingest:businesswire] missing URL; skipping fetch"); return; }
    console.log("[ingest:businesswire] start");
    const schedule = (ms) => { const base = typeof ms === 'number' ? ms : jitter(); const jit = Math.floor(base * 0.15 * (Math.random() - 0.5)); timer = setTimeout(tick, base + jit); timer?.unref?.(); };
    const tick = async () => {
        if (inFlight) { deferred = true; overlapsPrevented++; return; }
        inFlight = true;
        try {
            // Skip this tick if still backing off (and rate-limit skip logs)
            const now = Date.now();
            if (now < BW_BACKOFF_UNTIL) {
                if (now - BW_LAST_SKIP_LOG > 60_000) {
                    console.warn("[ingest:businesswire] skip (backoff)", Math.ceil((BW_BACKOFF_UNTIL - now) / 1000), "s left");
                    BW_LAST_SKIP_LOG = now;
                }
                schedule();
                return;
            }
            if (DEBUG_INGEST) console.log("[ingest:businesswire] tick");
            // Governor backoff/budget
            const backoffMs = GOV.getNextInMs(SOURCE);
            if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:businesswire] skip 429/403 backoff, next in', d, 'ms'); return schedule(d); }
            const tok = GOV.claimHostToken(HOST);
            if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:businesswire] skip budget wait, next in', d, 'ms'); return schedule(d); }
            const r = await fetchFeed();
            if (!r) { schedule(); return; }
            if (r.status === 304) {
                if (DEBUG_INGEST) console.log("[ingest:businesswire] not modified");
                const d = GOV.nextDelayAfter(SOURCE, 'HTTP_304');
                schedule(d);
                return;
            }
            if (r.status !== 200 || !r.text) {
                console.warn("[ingest:businesswire] error status", r.status);
                let outcome = 'HTTP_200';
                if (r.status === 429) outcome = 'R429';
                else if (r.status === 403) outcome = 'R403';
                const d = GOV.nextDelayAfter(SOURCE, outcome);
                schedule(d);
                return;
            }
            etag = r.etag || etag;
            lastModified = r.lastModified || lastModified;
            // use the same now computed at the top of this tick
            const items = extractItems(r.text);
            let anyNew = false;
            for (const it of items) {
                if (lastGuids.has(it.guid))
                    continue;
                lastGuids.add(it.guid);
                // freshness & watermark: skip stale, avoid initial flood
                if (it.publishedAt < now - FRESH_MS)
                    continue;
                if (watermarkPublishedAt && it.publishedAt <= watermarkPublishedAt)
                    continue;
                // emit-first
                const visibleAt = Date.now();
                const payload = {
                    id: it.guid,
                    source: "businesswire",
                    title: it.title,
                    url: it.link,
                    published_at: it.publishedAt,
                    visible_at: visibleAt,
                };
                broadcastBreaking(payload);
                // latency sample
                recordLatency("businesswire", it.publishedAt, visibleAt);
                if (it.publishedAt > watermarkPublishedAt)
                    watermarkPublishedAt = it.publishedAt;
                anyNew = true;
            }
            // bound dedup memory
            if (lastGuids.size > 2000) {
                lastGuids = new Set(Array.from(lastGuids).slice(-1000));
            }
            const recency = items.length ? (now - items[0].publishedAt) : undefined;
            const d = GOV.nextDelayAfter(SOURCE, anyNew ? 'NEW' : 'HTTP_200', { recencyMs: recency });
            schedule(d);
        }
        catch (e) {
            console.warn("[ingest:businesswire] error", (e && e.message) || e);
        }
        finally {
            inFlight = false;
            if (deferred) { deferred = false; setImmediate(tick); return; }
        }
    };
    schedule();
}
export function start() { return startBusinessWireIngest(); }
export function stopBusinessWireIngest() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
export function getTimerCount() { return timer ? 1 : 0; }
