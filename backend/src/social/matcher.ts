import type { SocialPost } from './provider.js';

export type WatchEntry = { id: string; type: 'ticker'|'keyword'; terms: string[]; enabled: boolean };

function normalize(text: string): string {
	let t = String(text || '').toLowerCase();
	// remove urls and handles
	t = t.replace(/https?:\/\/\S+/g, ' ').replace(/@[a-z0-9_]+/g, ' ');
	return t.replace(/\s+/g, ' ').trim();
}

function extractTickers(text: string): string[] {
	const out = new Set<string>();
	const re = /\$(?:[A-Z]{1,5})(?![A-Za-z])/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.add(m[0].slice(1));
	}
	return Array.from(out);
}

export function scorePostAgainstWatchlist(post: SocialPost, watch: WatchEntry[]): { score: number; tickers: string[] } {
	const t = normalize(post.text);
	let score = 0;
	for (const w of watch) {
		if (!w.enabled) continue;
		for (const term of w.terms) {
			const q = term.toLowerCase();
			if (!q) continue;
			if (t.includes(q)) {
				score += (w.type === 'ticker') ? 0.5 : 0.25;
			}
		}
	}
	const tickers = extractTickers(post.text);
	if (tickers.length) score += Math.min(0.5, 0.1 * tickers.length);
	return { score: Math.max(0, Math.min(1, score)), tickers };
}


