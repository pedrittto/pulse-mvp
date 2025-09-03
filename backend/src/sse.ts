import type { Request, Response } from "express";

const clients = new Map<string, Response>();
let eventsSent = 0;
export function getSSEStats() {
  return {
    enabled: process.env.SSE_ENABLED === "1",
    connections: clients.size,
    eventsSent,
  };
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
    // Send immediate comment ping to emit first bytes and avoid edge idle timeouts
    res.write(":\n\n");

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    clients.set(id, res);

    // initial event
    eventsSent++; res.write(`event: hello\ndata: {"id":"${id}"}\n\n`);

    // keepalive heartbeat (SSE comment ping) every 15s
    const keepalive = setInterval(() => {
      if (!res.writableEnded) { eventsSent++; res.write(`:\n\n`); }
    }, 15000);
    (keepalive as any).unref?.();

    req.on("close", () => {
      clearInterval(keepalive);
      clients.delete(id);
    });
  });

  // debug
  app.get("/_debug/sse-stats", (_req: Request, res: Response) => {
    res.json({ enabled: true, connections: clients.size });
  });
}



// broadcast to all connected SSE clients
export function broadcastBreaking(data: any) {
  let delivered = 0;
  const payload = `event: breaking\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.values()) {
    if (!res.writableEnded) {
      res.write(payload);
      eventsSent++;
      delivered++;
    }
  }
  return delivered;
}

