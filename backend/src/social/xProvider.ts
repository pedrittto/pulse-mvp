import type { SocialProvider, SocialPost } from './provider';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class XProvider implements SocialProvider {
	private bearer: string | null;
	private sinceId: string | null = null;
	private rpmLimit: number;
	private lastWindowStart = Date.now();
	private callsThisWindow = 0;
	private warned = false;

	constructor() {
		this.bearer = process.env.X_BEARER_TOKEN || null;
		this.rpmLimit = Math.max(30, parseInt(process.env.SOCIAL_RATE_LIMIT_RPM || '300', 10));
	}

	private async throttle() {
		const now = Date.now();
		if (now - this.lastWindowStart >= 60000) { this.lastWindowStart = now; this.callsThisWindow = 0; }
		if (this.callsThisWindow >= this.rpmLimit) {
			const waitMs = 60000 - (now - this.lastWindowStart);
			if (waitMs > 0) await sleep(waitMs);
			this.lastWindowStart = Date.now(); this.callsThisWindow = 0;
		}
		this.callsThisWindow++;
	}

	async pollRecent(): Promise<SocialPost[]> {
		if (!this.bearer) { if (!this.warned) { console.warn('[social][x] missing X_BEARER_TOKEN; provider idle'); this.warned = true; } return []; }
		await this.throttle();
		// Build query from env seed if provided (scheduler may pass dynamic list via env)
		const q = (process.env.SOCIAL_WATCHLIST || '').split(',').map(s=>s.trim()).filter(Boolean).slice(0, 20).join(' OR ');
		const params = new URLSearchParams();
		if (q) params.set('query', q);
		params.set('tweet.fields','created_at,author_id');
		params.set('expansions','author_id');
		if (this.sinceId) params.set('since_id', this.sinceId);
		const url = `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`;
		let res: any;
		for (let attempt=0; attempt<3; attempt++) {
			try {
				res = await fetch(url, { headers: { Authorization: `Bearer ${this.bearer}` } });
				if (res.status === 429 || res.status >= 500) {
					const backoff = Math.min(60000, (1000 * Math.pow(2, attempt)) + Math.floor(Math.random()*250));
					await sleep(backoff); continue;
				}
				break;
			} catch (e) { await sleep(1000); }
		}
		if (!res || !res.ok) return [];
		const json: any = await res.json().catch(()=>({}));
		const data = Array.isArray(json?.data) ? json.data : [];
		const users: Record<string, any> = {};
		if (Array.isArray(json?.includes?.users)) { for (const u of json.includes.users) users[u.id] = u; }
		const posts: SocialPost[] = data.map((t: any) => ({ id: String(t.id), text: String(t.text||''), author: users[t.author_id]?.username || undefined, created_at: t.created_at, url: `https://twitter.com/${users[t.author_id]?.username || 'i'}/status/${t.id}` }));
		// Advance since_id to newest
		if (data.length) this.sinceId = String(data[0].id);
		// Drop too-old
		const maxAgeSec = Math.max(10, parseInt(process.env.SOCIAL_MAX_POST_AGE_SEC || '120', 10));
		const cutoff = Date.now() - maxAgeSec * 1000;
		return posts.filter(p => { const ts = Date.parse(p.created_at||''); return Number.isFinite(ts) && ts >= cutoff; });
	}
}


