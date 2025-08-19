// Phase 1 canary watchers: read-only listings with ETag/Last-Modified. No schema/API changes.
import { getDb } from '../lib/firestore';

type WatcherConfig = {
  name: string;
  url: string;
  parse: (text: string) => Array<{ id: string; title: string; link: string; published_at: string }>;
};

const etags = new Map<string, string>();
const lastModified = new Map<string, string>();

function logInfo(msg: string, obj?: any) {
  console.log(`[watcher] ${msg}`, obj || '');
}

async function fetchWithConditional(url: string, name: string, timeoutMs: number): Promise<{ status: number; text: string; headers: any }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'User-Agent': process.env.RSS_UA || 'PulseWatcher/1.0' };
    if (etags.has(name)) headers['If-None-Match'] = etags.get(name)!;
    if (lastModified.has(name)) headers['If-Modified-Since'] = lastModified.get(name)!;
    const res: any = await fetch(url, { headers, signal: controller.signal });
    const text = res.ok ? await res.text() : '';
    const hdrs: any = res.headers;
    try {
      const getFn = hdrs && typeof hdrs.get === 'function' ? hdrs.get.bind(hdrs) : null;
      const et = getFn ? getFn('etag') : (hdrs?.etag ?? null);
      const lm = getFn ? getFn('last-modified') : (hdrs?.['last-modified'] ?? hdrs?.lastModified ?? null);
      if (et) etags.set(name, et);
      if (lm) lastModified.set(name, lm);
    } catch {}
    return { status: res.status, text, headers: hdrs };
  } finally {
    clearTimeout(t);
  }
}

// Minimal canary watcher bootstrap (disabled by default)
export async function runFastlaneWatchersOnce(): Promise<void> {
  if (process.env.FASTLANE_ENABLED !== '1') return;
  // Canary configs (stubs; parsing kept trivial and safe)
  const watchers: WatcherConfig[] = [
    { name: 'NASDAQ Trader News', url: 'http://www.nasdaqtrader.com/rss.aspx?feed=Headlines', parse: (_)=>[] },
    { name: 'NYSE Notices', url: 'https://www.nyse.com/api/announcements/rss', parse: (_)=>[] },
    { name: 'SEC Filings', url: 'https://www.sec.gov/Archives/edgar/usgaap.rss.xml', parse: (_)=>[] },
    { name: 'PRNewswire', url: 'https://www.prnewswire.com/rss/all-news-releases-list.rss', parse: (_)=>[] },
    { name: 'GlobeNewswire', url: 'https://www.globenewswire.com/Rss/Index', parse: (_)=>[] },
    { name: 'Business Wire', url: 'https://www.businesswire.com/portal/site/home/news', parse: (_)=>[] },
  ];
  const timeoutMs = parseInt(process.env.TIER1_HTTP_TIMEOUT_MS || '3000', 10);
  for (const w of watchers) {
    try {
      const res = await fetchWithConditional(w.url, w.name, timeoutMs);
      if (res.status === 304) {
        logInfo('[304] ' + w.name);
        continue;
      }
      if (res.status >= 200 && res.status < 300 && res.text) {
        logInfo('GET ' + w.name, { status: res.status });
        // In canary, we do not parse/write; just confirm headers and short-circuit behavior
      } else {
        logInfo('GET_FAIL ' + w.name, { status: res.status });
      }
    } catch (e: any) {
      logInfo('ERROR ' + w.name, { error: e?.message || String(e) });
    }
  }
}


