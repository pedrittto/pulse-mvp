// backend/src/ingest/prnewswire.ts
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { pickAgent } from "./http_agent.js";
import { getGovernor } from "./governor.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { canonicalIdFromItem } from "./lib/canonicalId.js";
const URL = process.env.PRN_RSS_URL ?? DEFAULT_URLS.PRN_RSS_URL;
const POLL_MS_BASE = 1200; // ~1.2 s clamp
const JITTER_MS = 200;
const FRESH_MS = Number(process.env.FRESH_MS || 5 * 60 * 1000); // accept only items newer than 5 min
let lastGuids = new Set();
let etag;
let lastModified;
let timer = null;
const GOV = getGovernor();
const SOURCE = "prnewswire";
const HOST = "prnewswire.com";
let inFlight = false;
let deferred = false;
let overlapsPrevented = 0;
let respTooLarge = 0;
const MAX_BYTES_RSS = Number(process.env.MAX_BYTES_RSS || 1_000_000);
let watermarkPublishedAt = 0; // newest accepted publishedAt
let warnedMissingUrl = false;
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
const SMOKE_ACCEPT_OLD = /^(1|true)$/i.test(process.env.SMOKE_ACCEPT_OLD ?? "");
function jitter() {
    return Math.max(500, POLL_MS_BASE + Math.floor((Math.random() * 2 - 1) * JITTER_MS));
}
function pick(tag, s) {
    const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? m[1].trim() : "";
}
function stripCdata(s) { return s.replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1"); }
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
    const headers = { "user-agent": "pulse-ingest/1.0" };
    if (etag)
        headers["if-none-match"] = etag;
    if (lastModified)
        headers["if-modified-since"] = lastModified;
    if (DEBUG_INGEST) console.log("[ingest:prnewswire] fetching", URL, { etag, ims: lastModified });
    const res = await fetch(URL, {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(900),
    });
    if (DEBUG_INGEST) console.log("[ingest:prnewswire] http", res.status, { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") });
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
export function startPRNewswireIngest() {
    if (timer)
        return;
    console.log("[ingest:prnewswire] start");
    if (!URL) { if (!warnedMissingUrl) { console.warn("[ingest:prnewswire] missing URL; skipping fetch"); warnedMissingUrl = true; } return; }
    const schedule = (ms) => {
        const base = typeof ms === 'number' ? ms : jitter();
        const nextMs = base + Math.floor(base * 0.15 * (Math.random() - 0.5));
        if (DEBUG_INGEST) console.log("[ingest:prnewswire] tick → next in", nextMs, "ms");
        timer = setTimeout(tick, nextMs);
        timer?.unref?.();
    };
    const tick = async () => {
        if (inFlight) { deferred = true; overlapsPrevented++; return; }
        inFlight = true;
        try {
            // mark tick start
            // lightweight: single line, no payloads
            if (DEBUG_INGEST) console.log("[ingest:prnewswire] tick");
            const backoffMs = GOV.getNextInMs(SOURCE);
            if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:prnewswire] skip 429/403 backoff, next in', d, 'ms'); return schedule(d); }
            const tok = GOV.claimHostToken(HOST);
            if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:prnewswire] skip budget wait, next in', d, 'ms'); return schedule(d); }
            const r = await fetchFeed();
            try { (await import('./index.js')).reportTick?.('prnewswire', { status: r?.status }); } catch {}
            if (r.status === 304) {
                if (DEBUG_INGEST) console.log("[ingest:prnewswire] not modified");
                const d = GOV.nextDelayAfter(SOURCE, 'HTTP_304');
                schedule(d);
                return;
            }
            if (r.status !== 200 || !r.text) {
                console.warn("[ingest:prnewswire] error status", r.status);
                let outcome = 'HTTP_200';
                if (r.status === 429) outcome = 'R429';
                else if (r.status === 403) outcome = 'R403';
                const d = GOV.nextDelayAfter(SOURCE, outcome);
                schedule(d);
                return;
            }
            etag = r.etag || etag;
            lastModified = r.lastModified || lastModified;
            const now = Date.now();
            const items = extractItems(r.text);
            let anyNew = false;
            for (const it of items) {
                if (lastGuids.has(it.guid))
                    continue;
                lastGuids.add(it.guid);
                // freshness & watermark
                if (!SMOKE_ACCEPT_OLD && it.publishedAt < now - FRESH_MS)
                    continue;
                if (watermarkPublishedAt && it.publishedAt <= watermarkPublishedAt)
                    continue;
                // emit-first
                const visibleAt = Date.now();
                if (DEBUG_INGEST) console.log("[ingest:prnewswire] NEW", { published_at_ms: it.publishedAt, id: it.guid });
                broadcastBreaking({
                    id: canonicalIdFromItem({ guid: it.guid, url: it.link, title: it.title }),
                    source: "prnewswire",
                    title: it.title,
                    url: it.link,
                    published_at_ms: it.publishedAt,
                    visible_at_ms: visibleAt,
                });
                // latency samples (spec_v1 clocks)
                setTimestampSource('prnewswire', 'feed');
                recordPublisherLatency("prnewswire", it.publishedAt, visibleAt);
                recordPipelineLatency("prnewswire", visibleAt, visibleAt + 1); // low-ms pipeline proxy
                if (it.publishedAt > watermarkPublishedAt)
                    watermarkPublishedAt = it.publishedAt;
                anyNew = true;
            }
            if (lastGuids.size > 2000) {
                lastGuids = new Set(Array.from(lastGuids).slice(-1000));
            }
            const recency = items.length ? (now - items[0].publishedAt) : undefined;
            const d = GOV.nextDelayAfter(SOURCE, anyNew ? 'NEW' : 'HTTP_200', { recencyMs: recency });
            schedule(d);
        }
        catch (e) {
            console.warn("[ingest:prnewswire] error", (e && e.message) || e);
        }
        finally {
            inFlight = false;
            if (deferred) { deferred = false; setImmediate(tick); return; }
        }
    };
    schedule();
}
export function start() { return startPRNewswireIngest(); }
export function stopPRNewswireIngest() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
export function getTimerCount() { return timer ? 1 : 0; }

// Deterministic single-run probe for health (no publish)
export async function probeOnce() {
    const fetch_started_at = Date.now();
    try {
        const r = await fetchFeed();
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
        const items = extractItems(r.text);
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
    }
    catch (e) {
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
            notes: 'exception:' + ((e && e.message) || String(e)),
        };
    }
}