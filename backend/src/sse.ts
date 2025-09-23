import type { Request, Response } from "express";
type Client = { res: Response };
const clients = new Set<Client>();
let eventsSent = 0;
// in-memory recent items buffer for API v0
type BreakingItem = Record<string, any>;
const recentItems: BreakingItem[] = [];
const RECENT_MAX = 500;

function toISO(ms: number | undefined | null): string | null {
  const n = typeof ms === 'number' ? ms : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

export function shapeForWire(data: any): any {
  const out: any = { ...(data || {}) };
  // map ms → ISO strings; keep ms internally elsewhere
  out.publisher_ts = toISO(out.publisher_ts) || out.publisher_ts || null;
  out.first_seen_at = toISO(out.first_seen_at) || out.first_seen_at || null;
  out.fetched_at = toISO(out.fetched_at) || out.fetched_at || null;
  out.visible_at = toISO(out.visible_at) || out.visible_at || null;
  // ensure required fields present
  if (!('symbols' in out)) out.symbols = Array.isArray(out.symbols) ? out.symbols : [];
  if (!('severity' in out)) out.severity = out.severity ?? 'info';
  if (!('timestamp_source' in out)) out.timestamp_source = out.timestamp_source ?? undefined;
  if (!('publisher_latency_ms' in out)) out.publisher_latency_ms = out.publisher_latency_ms ?? undefined;
  if (!('pulse_latency_ms' in out)) out.pulse_latency_ms = out.pulse_latency_ms ?? undefined;
  return out;
}

function writeEvent(res: Response, name: string, data: string) {
  res.write(`event: ${name}\n`);
  res.write(`data: ${data}\n\n`);
}

export function getSSEStats() {
  return {
    enabled: process.env.SSE_ENABLED === "1",
    connections: clients.size,
    eventsSent,
  };
}

// Global heartbeat every 15s only when SSE is enabled
if (process.env.SSE_ENABLED === "1") {
  setInterval(() => {
    const ts = Date.now().toString();
    for (const c of clients) {
      if (!c.res.writableEnded) { writeEvent(c.res, 'ping', ts); eventsSent++; }
    }
  }, 15000).unref?.();
}

export function registerSSE(app: any) {
  // If disabled, expose a fast 503 on the SSE route
  if (process.env.SSE_ENABLED !== "1") {
    app.get("/sse/breaking", (_req: Request, res: Response) =>
      res.status(503).json({ ok: false, reason: "SSE_DISABLED" })
    );
    app.get("/_debug/sse-stats", (_req: Request, res: Response) =>
      res.json({ enabled: false, connections: 0 })
    );
    return;
  }

  // Enabled
  app.get("/sse/breaking", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    (res as any).flushHeaders?.();

    // initial hello event (sends first bytes)
    writeEvent(res, 'hello', JSON.stringify({ ok: true }));
    eventsSent++;

    const client: Client = { res };
    clients.add(client);
    console.log(`[sse] client +1 (clients=${clients.size})`);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clients.delete(client);
      try { res.end(); } catch {}
      console.log(`[sse] client -1 (clients=${clients.size})`);
    };

    // Tear down on BOTH sides to cover proxy/idle/aborts
    ['close','finish','error','aborted'].forEach(ev => (res as any).once(ev, cleanup));
    ['close','aborted'].forEach(ev => (req as any).once(ev, cleanup));
  });

  // debug
  app.get("/_debug/sse-stats", (_req: Request, res: Response) => {
    res.json({ enabled: true, connections: clients.size });
  });
}

// broadcast to all connected SSE clients
export function broadcastBreaking(data: any) {
  let delivered = 0;
  const payload = JSON.stringify(shapeForWire(data));
  // push into recent buffer for API access
  try {
    recentItems.push(data);
    if (recentItems.length > RECENT_MAX) recentItems.splice(0, recentItems.length - RECENT_MAX);
  } catch {}
  for (const c of clients) {
    if (!c.res.writableEnded) { writeEvent(c.res, 'breaking', payload); eventsSent++; delivered++; }
  }
  return delivered;
}

export function getRecentBreaking(limit: number, sources?: string[]) {
  const lim = Math.max(1, Math.min(Number(limit) || 10, 100));
  const filt = Array.isArray(sources) && sources.length ? sources : undefined;
  const out = [] as any[];
  for (let i = recentItems.length - 1; i >= 0; i--) {
    const it = recentItems[i];
    if (filt && !filt.includes(String(it?.source))) continue;
    out.push(shapeForWire(it));
    if (out.length >= lim) break;
  }
  return out;
}

