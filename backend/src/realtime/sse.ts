import { Request, Response } from 'express';
import { probes } from '../ops/probes';

type Client = { id: string; res: Response; ip: string };

class SSEHub {
	private clients: Map<string, Client> = new Map();
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private recentEvents: Array<{ seq: number; data: any; ts: number }> = [];
	private recentCapacity = parseInt(process.env.SSE_RING_SIZE || '500', 10);
	private dropped = 0;
	private lastBroadcastMs = 0;
	private seq = 0;
	private eventsTotal = 0;
	private replayedEventsTotal = 0;
	private replayedSessions = 0;
	private accepting = true;

	public addClient(req: Request, res: Response): void {
		if (!this.accepting) { try { res.status(503).end(); } catch {} return; }
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

		// Catch up based on Last-Event-ID (header or query)
		try {
			const qLast = (req.query as any)?.lastEventId as string || '';
			const hLast = (req.headers['last-event-id'] as string) || '';
			const lastStr = qLast || hLast;
			const last = lastStr ? parseInt(lastStr, 10) : NaN;
			if (Number.isFinite(last)) {
				let replayed = 0;
				for (const ev of this.recentEvents) {
					if (ev.seq > last) {
						try {
							res.write(`id: ${ev.seq}\n`);
							res.write(`event: new\n`);
							res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
							replayed++;
						} catch { /* ignore */ }
					}
				}
				if (replayed > 0) { this.replayedEventsTotal += replayed; this.replayedSessions++; }
			}
		} catch { /* ignore */ }

		req.on('close', () => { this.clients.delete(id); });
		const hbMs = Math.max(5000, parseInt(process.env.SSE_HEARTBEAT_MS || '20000', 10));
		if (!this.heartbeatInterval) {
			this.heartbeatInterval = setInterval(() => {
				for (const c of this.clients.values()) {
					try { c.res.write(`event: ping\n` + `data:\n\n`); } catch { /* ignore */ }
				}
			}, hbMs);
		}
	}

	public announceAndCloseAll(ms: number = 2000): void {
		for (const c of this.clients.values()) {
			try { c.res.write(`event: server-draining\n` + `data: {}\n\n`); } catch {}
		}
		setTimeout(() => this.shutdown(), Math.max(0, ms));
	}

	public stopAccepting(): void { this.accepting = false; }

	public broadcastNewItem(payload: { id: string; ingested_at?: string; emitted_at?: string; source?: string }): void {
		if (process.env.SSE_ENABLED !== '1') return;
		const data: any = {
			id: payload.id,
			ingested_at: payload.ingested_at || new Date().toISOString(),
			...(payload.emitted_at ? { emitted_at: payload.emitted_at } : {}),
			...(payload.source ? { source: payload.source } : {})
		};
		const seq = ++this.seq;
		const json = JSON.stringify(data);
		const start = Date.now();
		for (const c of this.clients.values()) {
			try {
				c.res.write(`id: ${seq}\n`);
				c.res.write(`event: new\n`);
				c.res.write(`data: ${json}\n\n`);
			} catch { this.dropped++; }
		}
		this.lastBroadcastMs = Date.now() - start;
		this.recentEvents.push({ seq, data, ts: Date.now() });
		try { if (process.env.FASTLANE_PROBE === '1') probes.recordEmitted(data.id, data.source || null, data.emitted_at || data.ingested_at); } catch {}
		if (this.recentEvents.length > this.recentCapacity) this.recentEvents.shift();
		this.eventsTotal++;
		// Minimal observability (info-level)
		// Throttle [sse][new] log (log at most 1 per 2s)
		try {
			if (Date.now() - this.lastBroadcastMs > 2000) console.log('[sse][new]', { seq, ...data });
		} catch {}
	}

	public getStats() {
		return {
			clients: this.clients.size,
			broadcast_ms: this.lastBroadcastMs,
			dropped: this.dropped,
			seq: this.seq,
			events_total: this.eventsTotal,
			replayed_events_total: this.replayedEventsTotal,
			replayed_sessions: this.replayedSessions,
			ring_size: this.recentEvents.length,
			ring_capacity: this.recentCapacity
		};
	}

	public shutdown(): void {
		if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
		for (const c of this.clients.values()) { try { c.res.end(); } catch { /* ignore */ } }
		this.clients.clear();
	}
}

export const sseHub = new SSEHub();


