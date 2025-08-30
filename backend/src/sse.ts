import type { Request, Response } from "express";

const clients = new Map<string, Response>();

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

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    clients.set(id, res);

    // initial event
    res.write(`event: hello\ndata: {"id":"${id}"}\n\n`);

    // keepalive pings
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 15000);

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


