// Lightweight SSE helper for subscribing to new item events
// Usage: const sub = subscribeNewItems(baseUrl, (ev) => { ... }); sub.close();

export type SseSubscription = { close: () => void };

export function subscribeNewItems(baseUrl: string, onEvent: (event: any) => void): SseSubscription {
	let closed = false;
	let es: EventSource | null = null;
	let lastEventId: string | null = null;
	const beaconEnabled = String(process.env.NEXT_PUBLIC_RENDER_BEACON || 'true').toLowerCase() === 'true';

	const url = (() => {
		const base = (baseUrl || '').replace(/\/$/, '');
		return `${base}/sse/new-items`;
	})();

	function safeParse(data: string) {
		try { return JSON.parse(data); } catch { return null; }
	}

	function attach() {
		if (closed) return;
		try {
			const fullUrl = lastEventId ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}` : url;
			es = new EventSource(fullUrl);
		} catch {
			es = null;
			// Retry shortly if constructor failed
			if (!closed) setTimeout(attach, 1500);
			return;
		}

		// Default unnamed messages (not expected from backend, but supported defensively)
		es.onmessage = (evt: MessageEvent) => {
			if (closed) return;
			const payload = typeof evt.data === 'string' ? safeParse(evt.data) : evt.data;
			try { const lid = (evt as any).lastEventId || (payload && payload.id && String(payload.id)); if (lid) lastEventId = String(lid); } catch {}
			if (payload) {
				try {
					if (payload.emitted_at && String(process.env.NEXT_PUBLIC_SSE_DEBUG).toLowerCase() === 'true') {
						const delta = Date.now() - Date.parse(payload.emitted_at);
						// eslint-disable-next-line no-console
						console.debug('[SSE] client_receive_delta_ms=', delta, 'id=', payload.id);
					}
				} catch {}
				const tReceive = Date.now();
				onEvent(payload);
				// Non-blocking render beacon: after paint
				if (beaconEnabled && typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
					try {
						requestAnimationFrame(() => {
							requestAnimationFrame(() => {
								const tRender = Date.now();
								const data: any = payload || {};
								const emittedAt = (typeof data.emitted_at === 'string') ? data.emitted_at : null;
								const deltaReceive = emittedAt ? (tReceive - Date.parse(emittedAt)) : null;
								const body = {
									id: data?.id || null,
									source: data?.source || null,
									emitted_at: emittedAt,
									received_at: new Date(tReceive).toISOString(),
									rendered_at: new Date(tRender).toISOString(),
									delta_receive_ms: (typeof deltaReceive === 'number') ? deltaReceive : null,
									delta_render_ms: tRender - tReceive
								};
								const url = `${(baseUrl || '').replace(/\/$/, '')}/beacon/render`;
								try {
									const json = JSON.stringify(body);
									if (navigator?.sendBeacon) {
										const blob = new Blob([json], { type: 'application/json' });
										navigator.sendBeacon(url, blob);
									} else {
										fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true as any }).catch(() => {});
									}
								} catch {}
							});
						});
					} catch {}
				}
			}
		};

		// Named events from backend: init/new/ping
		es.addEventListener('new', (evt: MessageEvent) => {
			if (closed) return;
			const payload = typeof evt.data === 'string' ? safeParse(evt.data) : evt.data;
			try { const lid = (evt as any).lastEventId || (payload && payload.id && String(payload.id)); if (lid) lastEventId = String(lid); } catch {}
			if (payload) {
				try {
					if (payload.emitted_at && String(process.env.NEXT_PUBLIC_SSE_DEBUG).toLowerCase() === 'true') {
						const delta = Date.now() - Date.parse(payload.emitted_at);
						// eslint-disable-next-line no-console
						console.debug('[SSE] client_receive_delta_ms=', delta, 'id=', payload.id);
					}
				} catch {}
				const tReceive = Date.now();
				onEvent(payload);
				if (beaconEnabled && typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
					try {
						requestAnimationFrame(() => {
							requestAnimationFrame(() => {
								const tRender = Date.now();
								const data: any = payload || {};
								const emittedAt = (typeof data.emitted_at === 'string') ? data.emitted_at : null;
								const deltaReceive = emittedAt ? (tReceive - Date.parse(emittedAt)) : null;
								const body = {
									id: data?.id || null,
									source: data?.source || null,
									emitted_at: emittedAt,
									received_at: new Date(tReceive).toISOString(),
									rendered_at: new Date(tRender).toISOString(),
									delta_receive_ms: (typeof deltaReceive === 'number') ? deltaReceive : null,
									delta_render_ms: tRender - tReceive
								};
								const url = `${(baseUrl || '').replace(/\/$/, '')}/beacon/render`;
								try {
									const json = JSON.stringify(body);
									if (navigator?.sendBeacon) {
										const blob = new Blob([json], { type: 'application/json' });
										navigator.sendBeacon(url, blob);
									} else {
										fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true as any }).catch(() => {});
									}
								} catch {}
							});
						});
					} catch {}
				}
			}
		});

		es.addEventListener('init', () => { /* ignore */ });
		es.addEventListener('ping', () => { /* ignore keep-alive */ });

		es.addEventListener('error', () => {
			// EventSource will typically auto-retry using server-provided retry:
			// If the stream is closed, perform our own reconnect after 1.5s
			if (closed) return;
			if (es && (es.readyState === (EventSource as any).CLOSED || es.readyState === 2)) {
				try { es.close(); } catch {}
				es = null;
				setTimeout(attach, 1500);
			}
		});
	}

	attach();

	return {
		close: () => {
			closed = true;
			if (es) {
				try { es.close(); } catch {}
				es = null;
			}
		}
	};
}


