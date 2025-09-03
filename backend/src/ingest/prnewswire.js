// backend/src/ingest/prnewswire.ts
import { broadcastBreaking } from "../sse.js";
import { recordLatency } from "../metrics/latency.js";
import { DEFAULT_URLS } from "../config/rssFeeds";
const URL = process.env.PRN_RSS_URL ?? DEFAULT_URLS.PRN_RSS_URL;
const POLL_MS_BASE = 1200; // ~1.2 s clamp
const JITTER_MS = 200;
const FRESH_MS = 5 * 60 * 1000; // accept only items newer than 5 min
let lastGuids = new Set();
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
    const res = await fetch(URL, {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(900),
    });
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
export function startPRNewswireIngest() {
    if (timer)
        return;
    console.log("[ingest:prnewswire] start");
    if (!URL) { if (!warnedMissingUrl) { console.warn("[ingest:prnewswire] missing URL; skipping fetch"); warnedMissingUrl = true; } return; }
    const schedule = () => { timer = setTimeout(tick, jitter()); timer?.unref?.(); };
    const tick = async () => {
        try {
            // mark tick start
            // lightweight: single line, no payloads
            console.log("[ingest:prnewswire] tick");
            const r = await fetchFeed();
            if (r.status === 304) {
                console.log("[ingest:prnewswire] not modified");
                schedule();
                return;
            }
            if (r.status !== 200 || !r.text) {
                console.warn("[ingest:prnewswire] error status", r.status);
                schedule();
                return;
            }
            etag = r.etag || etag;
            lastModified = r.lastModified || lastModified;
            const now = Date.now();
            const items = extractItems(r.text);
            for (const it of items) {
                if (lastGuids.has(it.guid))
                    continue;
                lastGuids.add(it.guid);
                // freshness & watermark
                if (it.publishedAt < now - FRESH_MS)
                    continue;
                if (watermarkPublishedAt && it.publishedAt <= watermarkPublishedAt)
                    continue;
                // emit-first
                const visibleAt = Date.now();
                broadcastBreaking({
                    id: it.guid,
                    source: "prnewswire",
                    title: it.title,
                    url: it.link,
                    published_at: it.publishedAt,
                    visible_at: visibleAt,
                });
                // latency sample
                recordLatency("prnewswire", it.publishedAt, visibleAt);
                if (it.publishedAt > watermarkPublishedAt)
                    watermarkPublishedAt = it.publishedAt;
            }
            if (lastGuids.size > 2000) {
                lastGuids = new Set(Array.from(lastGuids).slice(-1000));
            }
        }
        catch (e) {
            console.warn("[ingest:prnewswire] error", (e && e.message) || e);
        }
        finally {
            schedule();
        }
    };
    schedule();
}
export function stopPRNewswireIngest() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
