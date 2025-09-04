import type { Request, Response } from "express";
type Client = { res: Response };
const clients = new Set<Client>();
let eventsSent = 0;

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

// Global heartbeat every 15s (no per-connection intervals)
setInterval(() => {
  const ts = Date.now().toString();
  for (const c of clients) {
    if (!c.res.writableEnded) { writeEvent(c.res, 'ping', ts); eventsSent++; }
  }
}, 15000).unref?.();

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
  const payload = JSON.stringify(data);
  for (const c of clients) {
    if (!c.res.writableEnded) { writeEvent(c.res, 'breaking', payload); eventsSent++; delivered++; }
  }
  return delivered;
}

