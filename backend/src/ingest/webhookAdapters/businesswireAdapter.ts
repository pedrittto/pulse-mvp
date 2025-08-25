import type { WebhookAdapter } from './types.js';

export const businesswireAdapter: WebhookAdapter = {
	name: 'businesswire',
	detect: (_h, body) => !!body,
	extractId: (_h, body) => { try { const j = JSON.parse(body); return j.id || j.messageId || null; } catch { return null; } },
	parse: async (_h, body) => {
		let j: any = null;
		try { j = JSON.parse(body); } catch {}
		if (!j) throw new Error('invalid json');
		return {
			headline: String(j.headline || j.title || '').slice(0, 300),
			source: 'Business Wire',
			transport: 'webhook',
			published_at: j.published_at || j.publishedAt || '',
			url: j.url || '',
			tickers: Array.isArray(j.tickers) ? j.tickers.map(String) : [],
			confidence: 'high'
		};
	}
};


