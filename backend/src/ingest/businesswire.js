// backend/src/ingest/businesswire.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds.js";
const URL = process.env.BW_RSS_URL ?? DEFAULT_URLS.BW_RSS_URL;
let BW_BACKOFF_UNTIL = 0; // epoch ms; skip ticks until this time after 403
let BW_LAST_SKIP_LOG = 0; // epoch ms, rate-limit skip logs
// Sub-2s lane
const POLL_MS_BASE = 1200; // ~1.2s base clamp
const JITTER_MS = 200; // ± jitter
const FRESH_MS = 5 * 60 * 1000; // accept items newer than 5 min
let lastGuids = new Set(); // short-window dedup
let etag;
let lastModified;
let timer = null;
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
    const text = await res.text();
    return {
        status: res.status,
        text,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
    };
}
export function startBusinessWireIngest() {
    if (timer)
        return;
    if (!URL) { console.warn("[ingest:businesswire] missing URL; skipping fetch"); return; }
    console.log("[ingest:businesswire] start");
    const schedule = () => { timer = setTimeout(tick, jitter()); timer?.unref?.(); };
    const tick = async () => {
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
            console.log("[ingest:businesswire] tick");
            const r = await fetchFeed();
            if (!r) { schedule(); return; }
            if (r.status === 304) {
                console.log("[ingest:businesswire] not modified");
                schedule();
                return;
            }
            if (r.status !== 200 || !r.text) {
                console.warn("[ingest:businesswire] error status", r.status);
                schedule();
                return;
            }
            etag = r.etag || etag;
            lastModified = r.lastModified || lastModified;
            // use the same now computed at the top of this tick
            const items = extractItems(r.text);
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
            }
            // bound dedup memory
            if (lastGuids.size > 2000) {
                lastGuids = new Set(Array.from(lastGuids).slice(-1000));
            }
        }
        catch (e) {
            console.warn("[ingest:businesswire] error", (e && e.message) || e);
        }
        finally {
            schedule();
        }
    };
    schedule();
}
export function stopBusinessWireIngest() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
