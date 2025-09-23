// backend/src/ingest/businesswire.ts
import { createHash } from 'node:crypto';
import { broadcastBreaking } from "../sse.js";
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from "../metrics/latency.js";
import { getGovernor } from "./governor.js";
import { pickAgent } from "./http_agent.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
import { warnOncePer } from "../log/rateLimit.js";
const URL = process.env.BUSINESSWIRE_RSS_URL ?? process.env.BW_RSS_URL ?? DEFAULT_URLS.BW_RSS_URL;
const DEBUG_INGEST = /^(1|true)$/i.test(process.env.DEBUG_INGEST ?? "");
let BW_BACKOFF_UNTIL = 0; // epoch ms; skip ticks until this time after 403
let BW_LAST_SKIP_LOG = 0; // epoch ms, rate-limit skip logs
// Sub-2s lane
const POLL_MS_BASE = 8000; // 8s clamp on canary (non-fastlane)
const JITTER_MS = 200; // ± jitter
const RECENT_WINDOW_S = Number(process.env.RECENT_WINDOW_S || 120);
const FRESH_MS = RECENT_WINDOW_S * 1000;
const MAX_BYTES_RSS = Number(process.env.MAX_BYTES_RSS || 800_000);
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
// LRU fingerprint dedupe (sha1 of title|link|publishedAt)
function sha1(s) { return createHash('sha1').update(s).digest('hex'); }
const seen = new Map(); // key -> ts last seen
function remember(fp) { seen.set(fp, Date.now()); if (seen.size > 2000) { const keys = Array.from(seen.keys()); for (let i=0;i<500;i++) seen.delete(keys[i]); } }
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

    // ≤1.5s timeouts for RSS
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1200);

    const res = await fetch(URL, {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
        signal: ctrl.signal,
        agent: pickAgent(URL)
    });

    clearTimeout(to);

    // Gentle backoff on WAF 403 to avoid hammering
    if (res.status === 403) {
        BW_BACKOFF_UNTIL = Date.now() + 10 * 60 * 1000; // 10 minutes
        const w = warnOncePer('ingest:businesswire:403', 60_000);
        w('[ingest:businesswire] 403 from BusinessWire — backing off 10m');
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
    if (!URL) { if (!warnedMissingUrl) { const w = warnOncePer('ingest:businesswire:missing_url', 60_000); w("[ingest:businesswire] missing URL; skipping fetch"); warnedMissingUrl = true; } return; }
    console.log("[ingest:businesswire] start");
    try {
        const minClamp = Number(process.env.BW_CLAMP_MS_MIN || 15000);
        const maxClamp = Number(process.env.BW_CLAMP_MS_MAX || 30000);
        if (DEBUG_INGEST) console.log(`[sched] register source=${SOURCE} clamp=[${minClamp},${maxClamp}]`);
    } catch {}
    const tick = async () => {
        if (inFlight) { deferred = true; overlapsPrevented++; return; }
        inFlight = true;
        try {
            // Skip this tick if still backing off (and rate-limit skip logs)
            const now = Date.now();
            if (now < BW_BACKOFF_UNTIL) {
                if (now - BW_LAST_SKIP_LOG > 60_000) {
                    const w = warnOncePer('ingest:businesswire:skip_backoff', 60_000);
                    w("[ingest:businesswire] skip (backoff)", Math.ceil((BW_BACKOFF_UNTIL - now) / 1000), "s left");
                    BW_LAST_SKIP_LOG = now;
                }
                // external scheduler will re-arm
                return;
            }
            if (DEBUG_INGEST) console.log(`[sched] tick start source=${SOURCE}`);
            try { (await import('./index.js')).reportTick?.(SOURCE); } catch {}
            try { (await import('./index.js')).reportTick?.('businesswire'); } catch {}
            // Governor backoff/budget
            const backoffMs = GOV.getNextInMs(SOURCE);
            if (GOV.getState(SOURCE) === 'BACKOFF') { const d = Math.max(500, backoffMs); if (DEBUG_INGEST) console.log('[ingest:businesswire] skip 429/403 backoff, next in', d, 'ms'); return schedule(d); }
            const tok = GOV.claimHostToken(HOST);
            if (!tok.ok) { const d = Math.max(500, tok.waitMs); if (DEBUG_INGEST) console.log('[ingest:businesswire] skip budget wait, next in', d, 'ms'); return; }
            const r = await fetchFeed();
            try { (await import('./index.js')).reportTick?.(SOURCE, { status: r?.status }); } catch {}
            if (!r) { return; }
            if (r.status === 304) {
                if (DEBUG_INGEST) console.log("[ingest:businesswire] not modified");
                // re-arm by external scheduler
                return;
            }
            if (r.status !== 200 || !r.text) {
                { const w = warnOncePer('ingest:businesswire:error_status', 60_000); w("[ingest:businesswire] error status", r.status); }
                let outcome = 'HTTP_200';
                if (r.status === 429) outcome = 'R429';
                else if (r.status === 403) outcome = 'R403';
                // re-arm by external scheduler
                return;
            }
            etag = r.etag || etag;
            lastModified = r.lastModified || lastModified;
            const fetchedAt = Date.now();
            const items = extractItems(r.text);
            let anyNew = false;
            let newCount = 0;
            let firstLogged = false;
            for (const it of items) {
                const publisher_ts = it.publishedAt || fetchedAt;
                if (publisher_ts < fetchedAt - FRESH_MS) continue;
                if (watermarkPublishedAt && publisher_ts <= watermarkPublishedAt) continue;
                const fp = sha1(`${it.title}|${it.link}|${publisher_ts}`);
                if (seen.has(fp)) continue;
                remember(fp);
                const first_seen_at = fetchedAt;
                const visible_at = fetchedAt + 2;
                const publisher_latency_ms = Math.max(0, visible_at - publisher_ts);
                const pulse_latency_ms = Math.max(0, visible_at - first_seen_at);
                const payload = {
                    id: it.guid,
                    source: "businesswire",
                    title: it.title,
                    url: it.link,
                    publisher_ts,
                    first_seen_at,
                    fetched_at: fetchedAt,
                    visible_at,
                    publisher_latency_ms,
                    pulse_latency_ms,
                    symbols: [],
                    severity: 'info',
                    timestamp_source: 'feed'
                };
                if (DEBUG_INGEST && !firstLogged) { firstLogged = true; try { console.log('[sse:businesswire:first]', JSON.stringify(payload)); } catch {} }
                broadcastBreaking(payload);
                setTimestampSource('businesswire', 'feed');
                recordPublisherLatency("businesswire", publisher_ts, visible_at);
                recordPipelineLatency("businesswire", first_seen_at, visible_at);
                if (publisher_ts > watermarkPublishedAt) watermarkPublishedAt = publisher_ts;
                anyNew = true;
                newCount++;
            }
            // bound dedup memory
            if (lastGuids.size > 2000) {
                lastGuids = new Set(Array.from(lastGuids).slice(-1000));
            }
            const recency = items.length ? (now - items[0].publishedAt) : undefined;
            // external scheduler re-arms
            if (DEBUG_INGEST) console.log(`[sched] tick done source=${SOURCE} status=${r.status} new_items=${newCount}`);
        }
        catch (e) {
            { const w = warnOncePer('ingest:businesswire:error', 60_000); w("[ingest:businesswire] error", (e && e.message) || e); }
            try { (await import('./index.js')).reportTick?.(SOURCE, { error: e }); } catch {}
        }
        finally {
            inFlight = false;
            if (deferred) { deferred = false; setImmediate(tick); return; }
        }
    };
    schedule();
    try { setImmediate(tick); } catch { try { (globalThis.queueMicrotask || ((fn)=>Promise.resolve().then(fn)))(tick); } catch {} }
}
export function start() { return startBusinessWireIngest(); }
export function stopBusinessWireIngest() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
export function getTimerCount() { return timer ? 1 : 0; }

// Deterministic single-run probe (no publish); used in Source Health
export async function probeOnce() {
    const fetch_started_at = Date.now();
    try {
        const r = await fetchFeed();
        const fetch_finished_at = Date.now();
        if (!r) {
            return { source: 'businesswire', ok: true, http_status: 204, items_found: 0, latest_item_timestamp: null, fetch_started_at, fetch_finished_at, parse_ms: 0, notes: 'no_response_or_backoff' };
        }
        if (r.status === 304) {
            return { source: 'businesswire', ok: true, http_status: 304, items_found: 0, latest_item_timestamp: null, fetch_started_at, fetch_finished_at, parse_ms: 0 };
        }
        if (r.status !== 200 || !r.text) {
            return { source: 'businesswire', ok: false, http_status: r.status || 0, items_found: 0, latest_item_timestamp: null, fetch_started_at, fetch_finished_at, parse_ms: 0 };
        }
        const t0 = Date.now();
        const items = extractItems(r.text);
        const parse_ms = Date.now() - t0;
        const latest_item_timestamp = items.length ? Math.max(...items.map(it => Number(it.publishedAt || 0))) : null;
        if (DEBUG_INGEST) {
            const iso = latest_item_timestamp ? new Date(latest_item_timestamp).toISOString() : null;
            console.log(`[probe:businesswire] ok=${true} status=${r.status} items=${items.length} latest_ts=${iso}`);
        }
        return { source: 'businesswire', ok: true, http_status: r.status, items_found: items.length, latest_item_timestamp, fetch_started_at, fetch_finished_at, parse_ms };
    }
    catch (e) {
        const fetch_finished_at = Date.now();
        return { source: 'businesswire', ok: false, http_status: 0, items_found: 0, latest_item_timestamp: null, fetch_started_at, fetch_finished_at, parse_ms: 0, notes: 'probe_failed: ' + ((e && e.message) || e) };
    }
}

// Pure single-run tick for external scheduler wrapper (emits SSE; returns status & new count)
export async function tickOnce() {
    const now = Date.now();
    if (now < BW_BACKOFF_UNTIL) {
        return { http_status: 204, new_items: 0 };
    }
    const backoffMs = GOV.getNextInMs(SOURCE);
    if (GOV.getState(SOURCE) === 'BACKOFF') {
        return { http_status: 429, new_items: 0 };
    }
    const tok = GOV.claimHostToken(HOST);
    if (!tok.ok) {
        return { http_status: 429, new_items: 0 };
    }
    const r = await fetchFeed();
    if (!r) return { http_status: 204, new_items: 0 };
    if (r.status === 304) return { http_status: 304, new_items: 0 };
    if (r.status !== 200 || !r.text) return { http_status: r.status || 0, new_items: 0 };
    etag = r.etag || etag;
    lastModified = r.lastModified || lastModified;
    const fetchedAt = Date.now();
    const items = extractItems(r.text);
    let newCount = 0;
    for (const it of items) {
        const publisher_ts = it.publishedAt || fetchedAt;
        if (publisher_ts < fetchedAt - FRESH_MS) continue;
        if (watermarkPublishedAt && publisher_ts <= watermarkPublishedAt) continue;
        const fp = sha1(`${it.title}|${it.link}|${publisher_ts}`);
        if (seen.has(fp)) continue;
        remember(fp);
        const first_seen_at = fetchedAt;
        const visible_at = fetchedAt + 2;
        const publisher_latency_ms = Math.max(0, visible_at - publisher_ts);
        const pulse_latency_ms = Math.max(0, visible_at - first_seen_at);
        broadcastBreaking({
            id: it.guid,
            source: "businesswire",
            title: it.title,
            url: it.link,
            publisher_ts,
            first_seen_at,
            fetched_at: fetchedAt,
            visible_at,
            publisher_latency_ms,
            pulse_latency_ms,
            symbols: [],
            severity: 'info',
            timestamp_source: 'feed'
        });
        setTimestampSource('businesswire', 'feed');
        recordPublisherLatency("businesswire", publisher_ts, visible_at);
        recordPipelineLatency("businesswire", first_seen_at, visible_at);
        if (publisher_ts > watermarkPublishedAt) watermarkPublishedAt = publisher_ts;
        newCount++;
    }
    if (lastGuids.size > 2000) {
        lastGuids = new Set(Array.from(lastGuids).slice(-1000));
    }
    return { http_status: 200, new_items: newCount };
}

// Public tick with hard 2s timeout guard
export async function tick() {
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ http_status: 598, new_items: 0 }), 2000));
    try {
        const r = await Promise.race([tickOnce(), timeout]);
        return (r && typeof r === 'object') ? r : { http_status: 599, new_items: 0 };
    } catch {
        return { http_status: 599, new_items: 0 };
    }
}

// Deterministic replay (fixture) for canary: generate N items now
export async function replayFixture(n = 5) {
    const count = Math.max(1, Math.min(Number(n) || 5, 25));
    const now = Date.now();
    const items = [];
    for (let i = 0; i < count; i++) {
        const publisher_ts = now - (300 + Math.floor(Math.random() * 900));
        const first_seen_at = now;
        const visible_at = first_seen_at + 2;
        const publisher_latency_ms = Math.max(0, visible_at - publisher_ts);
        const pulse_latency_ms = Math.max(0, visible_at - first_seen_at);
        const id = `bw-fixture-${now}-${i}`;
        broadcastBreaking({
            id,
            source: 'businesswire',
            title: `BW Fixture ${i+1}`,
            url: `https://example.invalid/bw/${now}/${i}`,
            publisher_ts,
            first_seen_at,
            fetched_at: first_seen_at,
            visible_at,
            publisher_latency_ms,
            pulse_latency_ms,
            timestamp_source: 'fixture'
        });
        setTimestampSource('businesswire', 'fixture');
        recordPublisherLatency('businesswire', publisher_ts, visible_at);
        recordPipelineLatency('businesswire', first_seen_at, visible_at);
        items.push({ id, publisher_ts, visible_at });
    }
    return { ok: true, source: 'businesswire', generated: items.length };
}