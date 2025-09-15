import type { Express } from 'express';
import { reportTick as schedTick } from './ingest/index.js';
import { recordPublisherLatency, recordPipelineLatency, setTimestampSource } from './metrics/latency.js';

type Src = 'nasdaq_halts' | 'nyse_notices';

function parseEnvNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function inMarketHours(): boolean {
  if (process.env.FASTLANE_IGNORE_MARKET === '1') return true;
  const tz = process.env.FASTLANE_MARKET_TZ || 'America/New_York';
  const open = process.env.FASTLANE_MARKET_OPEN || '09:30';
  const close = process.env.FASTLANE_MARKET_CLOSE || '16:00';
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    const parts = fmt.format(now);
    return parts >= open && parts <= close;
  } catch { return true; }
}

// Track publisher-provided validators per source
const lastEtagBySource: Record<Src, string> = { nasdaq_halts: '', nyse_notices: '' };
const lastModBySource: Record<Src, string>  = { nasdaq_halts: '', nyse_notices: '' };

async function headThenMaybeGet(src: Src, url: string): Promise<{ headStatus: number; didGet: boolean; getStatus?: number; fetchedAtMs?: number; publisherSeenAtMs?: number; visibleAtMs?: number; changed: boolean }> {
  const to = AbortSignal.timeout(2000);
  // HEAD with no cache to check validators
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', cache: 'no-store', signal: to });
  const et = String(head.headers.get('etag') || '');
  const lm = String(head.headers.get('last-modified') || '');
  const prevEt = lastEtagBySource[src];
  const prevLm = lastModBySource[src];
  const validatorsPresent = !!(et || lm);
  const validatorsChanged = (et && et !== prevEt) || (lm && lm !== prevLm);

  if (!(head.status >= 200 && head.status < 400)) {
    return { headStatus: head.status, didGet: false, changed: false };
  }

  // If validators missing, or changed, do an immediate conditional GET
  if (!validatorsPresent || validatorsChanged) {
    const fetchedAt = Date.now();
    const headers: Record<string, string> = { 'cache-control': 'no-store' } as any;
    if (prevEt) headers['if-none-match'] = prevEt;
    if (prevLm) headers['if-modified-since'] = prevLm;
    const g = await fetch(url, { method: 'GET', headers, redirect: 'follow', cache: 'no-store', signal: to });
    const getStatus = g.status;
    if (getStatus === 200) {
      // Update validators from GET
      const newEt = String(g.headers.get('etag') || et || '');
      const newLm = String(g.headers.get('last-modified') || lm || '');
      if (newEt) lastEtagBySource[src] = newEt;
      if (newLm) lastModBySource[src] = newLm;
      const httpDate = g.headers.get('date');
      const publisherSeenAtMs = httpDate ? (Date.parse(httpDate) || fetchedAt) : fetchedAt;
      const visibleAtMs = Date.now();
      return { headStatus: head.status, didGet: true, getStatus, fetchedAtMs: fetchedAt, publisherSeenAtMs, visibleAtMs, changed: true };
    }
    // 304 or other → treat as no new items
    if (getStatus === 304) {
      if (et) lastEtagBySource[src] = et;
      if (lm) lastModBySource[src] = lm;
      return { headStatus: head.status, didGet: true, getStatus, changed: false };
    }
    return { headStatus: head.status, didGet: true, getStatus, changed: false };
  }

  // Validators present but unchanged → no GET
  return { headStatus: head.status, didGet: false, changed: false };
}

function jitteredDelay(minMs: number, maxMs: number, jitter: number): number {
  const base = minMs + Math.random() * Math.max(0, maxMs - minMs);
  const delta = base * jitter * (Math.random() * 2 - 1);
  return Math.max(200, Math.floor(base + delta));
}

export function startFastlaneIfEnabled(app: Express) {
  if (process.env.FASTLANE !== '1') return;
  const sources = String(process.env.FASTLANE_SOURCES || 'nasdaq_halts,nyse_notices').split(',').map(s=>s.trim()).filter(Boolean) as Src[];
  const min = parseEnvNum('FASTLANE_CLAMP_MS_MIN', 1000);
  const max = parseEnvNum('FASTLANE_CLAMP_MS_MAX', 3000);
  const jitter = Number(process.env.FASTLANE_JITTER || 0.2);
  const recentWindowMs = parseEnvNum('FASTLANE_RECENT_WINDOW_S', 120) * 1000;

  console.log('[fastlane] start', { sources, min, max, jitter, recentWindowMs });

  const URLS: Record<Src,string> = {
    nasdaq_halts: process.env.NASDAQ_HALTS_URL || 'https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts',
    nyse_notices: process.env.NYSE_NOTICES_URL || 'https://www.nyse.com/trader-update/history'
  };

  for (const s of sources) {
    let timer: NodeJS.Timeout | null = null;
    const tick = async () => {
      try {
        if (!inMarketHours()) { timer = setTimeout(tick, 30_000); timer.unref?.(); return; }
        const url = URLS[s];
        const r = await headThenMaybeGet(s, url);
        console.log(`[tick:${s}] HEAD`, r.headStatus);
        try { schedTick(s, { status: r.headStatus }); } catch {}
        if (r.didGet) {
          const status = r.getStatus ?? 0;
          if (status === 200 && r.changed) {
            const publisherSeenAt = r.publisherSeenAtMs ?? Date.now();
            const fetchedAt = r.fetchedAtMs ?? Date.now();
            const visibleAt = r.visibleAtMs ?? Date.now();
            setTimestampSource(s, 'http-date');
            // publisher→Pulse
            recordPublisherLatency(s, publisherSeenAt, visibleAt);
            // pipeline (firstSeen → visible)
            const pipelineEnd = Math.max(visibleAt, fetchedAt + 1);
            recordPipelineLatency(s, fetchedAt, pipelineEnd);
            console.log(`[ingest:${s}] GET 200 new_items=1`);
          }
        }
      } catch (e) {
        try { schedTick(s, { error: e }); } catch {}
      } finally {
        const d = jitteredDelay(min, max, jitter);
        timer = setTimeout(tick, d); timer.unref?.();
      }
    };
    timer = setTimeout(tick, 100); timer.unref?.();
  }

  // Guarded fixture replayer for canary-only evidence
  app.post('/_debug/fastlane/replay', async (req, res) => {
    const key = req.get('x-debug-key');
    const expected = process.env.DEBUG_PUSH_KEY;
    if (!expected || key !== expected) return res.status(401).json({ ok: false });
    const src = String(req.query?.source || 'nasdaq_halts') as Src;
    const now = Date.now();
    const pubs = Array.from({length: 6}, () => now - (500 + Math.floor(Math.random() * 1500)));
    setTimestampSource(src, 'fixture');
    for (const t of pubs) { recordPublisherLatency(src, t, now); recordPipelineLatency(src, now, now + 2); }
    res.json({ ok: true, source: src, recorded: pubs.length });
  });
}


