import { getValidator, setValidator } from '../lib/httpCache.js';
import { recordHttpDateSkew } from '../ops/driftMonitor.js';
import { rssFeeds } from '../config/rssFeeds.js';

type WarmupResult = { source: string; status: 200 | 304 | 'timeout' | 'error'; etag?: string; lastModified?: string; duration_ms: number; host: string; error?: string };
export type WarmupSummary = { ran: boolean; started_at: string; finished_at: string; results: WarmupResult[] } | { ran: false };

let lastSummary: WarmupSummary | null = null;
export function getWarmupSummary(): WarmupSummary { return lastSummary ?? { ran: false }; }

function getTier1List(): Array<{ name: string; url: string }> {
  const tier1Names = new Set<string>([
    'PRNewswire', 'GlobeNewswire', 'Business Wire', 'SEC Filings', 'NASDAQ Trader News', 'NYSE Notices',
    'Reuters Business', 'AP Business', 'CNBC', 'Financial Times', 'Bloomberg Markets'
  ]);
  return (rssFeeds as any[])
    .filter(f => tier1Names.has(f.name))
    .map(f => ({ name: f.name, url: f.url }));
}

export async function runWarmupIfEnabled(): Promise<WarmupSummary | null> {
  if (process.env.WARMUP_TIER1 !== '1') return null;
  const started_at = new Date().toISOString();
  const urls = getTier1List();
  const conc = Math.max(1, parseInt(process.env.WARMUP_CONCURRENCY || '2', 10));
  const results: WarmupResult[] = [];

  async function one(u: { name: string; url: string }) {
    const t0 = Date.now();
    const host = (() => { try { return new URL(u.url).host; } catch { return ''; } })();
    let status: WarmupResult['status'] = 'error';
    let etag: string | undefined; let lastModified: string | undefined; let errMsg: string | undefined;
    try {
      const v = await getValidator(u.name).catch(() => null);
      const ctrl = new AbortController();
      const timeoutMs = parseInt(process.env.TIER1_HTTP_TIMEOUT_MS || '3000', 10);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const headers: Record<string, string> = { 'User-Agent': 'pulse-warmup/1.0' };
      if (v?.etag) headers['If-None-Match'] = v.etag;
      if (v?.lastModified) headers['If-Modified-Since'] = v.lastModified;
      const res = await fetch(u.url, { headers, signal: ctrl.signal } as any);
      clearTimeout(timer);
      if (res.status === 304) {
        status = 304;
      } else if (res.status === 200) {
        status = 200;
        etag = res.headers.get('etag') || undefined;
        lastModified = res.headers.get('last-modified') || undefined;
        try { const dateHdr = res.headers.get('date'); if (dateHdr) recordHttpDateSkew(host, dateHdr); } catch {}
        if (etag || lastModified) {
          await setValidator(u.name, { etag, lastModified, updated_at: new Date().toISOString() });
        }
        try { (res as any).body?.cancel?.(); } catch { /* ignore */ }
      } else {
        status = 'error';
      }
    } catch (e: any) {
      status = (e?.name === 'AbortError') ? 'timeout' : 'error';
      errMsg = e?.message || String(e);
    } finally {
      results.push({ source: u.name, status, etag, lastModified, duration_ms: Date.now() - t0, host, ...(errMsg ? { error: errMsg } : {}) });
    }
  }

  const queue = urls.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < conc; i++) {
    workers.push((async function run() {
      while (queue.length) { await one(queue.shift()!); }
    })());
  }
  await Promise.all(workers);

  lastSummary = { ran: true, started_at, finished_at: new Date().toISOString(), results } as WarmupSummary;
  try { require('../ops/ready').setReady('warmupDone', true); } catch {}
  return lastSummary;
}


