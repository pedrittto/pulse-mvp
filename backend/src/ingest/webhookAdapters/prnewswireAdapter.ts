import type { WebhookAdapter } from './types';

export const prnewswireAdapter: WebhookAdapter = {
	name: 'prnewswire',
	detect: (_h, body) => !!body,
	extractId: (_h, body) => {
		try { const j = JSON.parse(body); return j.id || j.messageId || null; } catch { return null; }
	},
	parse: async (_h, body) => {
		let j: any = null;
		try { j = JSON.parse(body); } catch {}
		if (!j) { throw new Error('invalid json'); }
		const headline = String(j.headline || j.title || '').slice(0, 300);
		const url = j.url || j.link || '';
		const published_at = j.published_at || j.publishedAt || j.pubDate || '';
		const tickers: string[] = Array.isArray(j.tickers) ? j.tickers.map(String) : [];
		return {
			headline,
			source: 'PRNewswire',
			transport: 'webhook',
			published_at,
			url,
			tickers,
			confidence: 'high'
		};
	}
};


