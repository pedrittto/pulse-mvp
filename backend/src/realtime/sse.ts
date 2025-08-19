import { Request, Response } from 'express';

type Client = { id: string; res: Response; ip: string };

class SSEHub {
	private clients: Map<string, Client> = new Map();
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private recentEvents: Array<{ id: string; ingested_at: string }> = [];
	private recentCapacity = parseInt(process.env.SSE_RING_SIZE || '200', 10);
	private dropped = 0;
	private lastBroadcastMs = 0;

	public addClient(req: Request, res: Response): void {
		if (process.env.SSE_ENABLED !== '1') {
			res.status(404).end();
			return;
		}
		// Simple per-IP limit
		const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
		const maxPerIp = parseInt(process.env.SSE_MAX_CLIENTS_PER_IP || '1', 10);
		const perIp = Array.from(this.clients.values()).filter(c => c.ip === ip).length;
		if (perIp >= maxPerIp) {
			res.status(429).json({ ok: false, error: 'Too many SSE connections from this IP' });
			return;
		}

		// Required headers
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache, no-transform');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');
		res.flushHeaders?.();

		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.clients.set(id, { id, res, ip });
		// Initial retry directive and init event
		res.write(`retry: 5000\n\n`);
		res.write(`event: init\n`);
		res.write(`data: {"ok":true}\n\n`);

		// Catch up based on Last-Event-ID
		const lastId = (req.headers['last-event-id'] as string) || '';
		if (lastId) {
			let found = this.recentEvents.length === 0;
			for (let i = 0; i < this.recentEvents.length; i++) {
				if (this.recentEvents[i].id === lastId) { found = true; continue; }
				if (found) {
					const ev = this.recentEvents[i];
					try {
						res.write(`id: ${ev.id}\n`);
						res.write(`event: new\n`);
						res.write(`data: ${JSON.stringify(ev)}\n\n`);
					} catch { /* ignore */ }
				}
			}
		}

		req.on('close', () => { this.clients.delete(id); });
		if (!this.heartbeatInterval) {
			this.heartbeatInterval = setInterval(() => {
				for (const c of this.clients.values()) {
					try { c.res.write(`event: ping\n` + `data:\n\n`); } catch { /* ignore */ }
				}
			}, 20000);
		}
	}

	public broadcastNewItem(payload: { id: string; ingested_at?: string }): void {
		if (process.env.SSE_ENABLED !== '1') return;
		const ev = { id: payload.id, ingested_at: payload.ingested_at || new Date().toISOString() };
		const json = JSON.stringify(ev);
		const start = Date.now();
		for (const c of this.clients.values()) {
			try {
				c.res.write(`id: ${ev.id}\n`);
				c.res.write(`event: new\n`);
				c.res.write(`data: ${json}\n\n`);
			} catch { this.dropped++; }
		}
		this.lastBroadcastMs = Date.now() - start;
		this.recentEvents.push(ev);
		if (this.recentEvents.length > this.recentCapacity) this.recentEvents.shift();
		// Minimal observability (info-level)
		// Throttle [sse][new] log (log at most 1 per 2s)
		try {
			if (Date.now() - this.lastBroadcastMs > 2000) console.log('[sse][new]', ev);
		} catch {}
	}

	public getStats() {
		return { clients: this.clients.size, broadcast_ms: this.lastBroadcastMs, dropped: this.dropped };
	}

	public shutdown(): void {
		if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
		for (const c of this.clients.values()) { try { c.res.end(); } catch { /* ignore */ } }
		this.clients.clear();
	}
}

export const sseHub = new SSEHub();


