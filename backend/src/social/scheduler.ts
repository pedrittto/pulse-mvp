import { XProvider } from './xProvider';
import type { SocialProvider, SocialPost } from './provider';
import { scorePostAgainstWatchlist, WatchEntry } from './matcher';
import { getDb } from '../lib/firestore';
import { publishStub } from '../ingest/breakingIngest';

type Counters = { last_poll_at?: string; posts_seen: number; posts_matched: number; emitted: number; dedup_hits: number };
const counters: Counters = { posts_seen: 0, posts_matched: 0, emitted: 0, dedup_hits: 0 };

const dedup = new Map<string, number>();

function isEnabled(): boolean { return String(process.env.SOCIAL_ENABLED || '0') === '1'; }

function getProvider(): SocialProvider | null {
	if (!isEnabled()) return null;
	const provider = (process.env.SOCIAL_PROVIDER || 'X').toUpperCase();
	if (provider === 'X') return new XProvider();
	return null;
}

async function loadWatchlist(): Promise<WatchEntry[]> {
	const envList = (process.env.SOCIAL_WATCHLIST || '').split(',').map(s=>s.trim()).filter(Boolean);
	const envEntries: WatchEntry[] = envList.map(id => ({ id, type: /^[A-Z0-9.-]{1,6}$/.test(id) ? 'ticker' : 'keyword', terms: [id], enabled: true }));
	try {
		const db = getDb();
		const snap = await db.collection('watchlist').get();
		const out: WatchEntry[] = [];
		if (snap && Array.isArray((snap as any).docs)) {
			(snap as any).docs.forEach((d: any) => { const v = d.data(); if (!v || v.enabled === false) return; out.push({ id: d.id, type: v.type || 'keyword', terms: Array.isArray(v.terms) ? v.terms : [String(d.id)], enabled: true }); });
		} else if (snap && typeof (snap as any).forEach === 'function') {
			(snap as any).forEach((d: any) => { const v = d.data(); if (!v || v.enabled === false) return; out.push({ id: d.id, type: v.type || 'keyword', terms: Array.isArray(v.terms) ? v.terms : [String(d.id)], enabled: true }); });
		}
		return out.length ? out : envEntries;
	} catch { return envEntries; }
}

async function emitStubFromPost(post: SocialPost, tickers: string[], score: number) {
	const conf = score >= 0.85 ? 'medium' : 'low';
	await publishStub({
		title: (post.text || '').slice(0, 140),
		source: 'X',
		url: post.url || '',
		published_at: post.created_at,
		transport: 'social',
		first_seen_at: new Date().toISOString(),
	});
	try {
		const db = getDb();
		// Log latency metric for social
		await db.collection('latency_metrics').add({
			source: 'X',
			source_published_at: post.created_at,
			ingested_at: new Date().toISOString(),
			t_publish_ms: Math.max(0, Date.now() - Date.parse(post.created_at || '')),
			timestamp: new Date().toISOString(),
			transport: 'social',
			confidence: conf,
			match_score: score,
			tickers
		});
	} catch {}
}

export function getSocialCounters(): Counters { return { ...counters }; }

let loopTimer: NodeJS.Timeout | null = null;

export async function startSocialLane(): Promise<void> {
	if (!isEnabled()) return;
	const provider = getProvider();
	if (!provider) { return; }
	const pollMs = Math.max(1000, parseInt(process.env.SOCIAL_POLL_MS || '5000', 10));
	const minScore = Math.max(0, Math.min(1, parseFloat(process.env.SOCIAL_MATCH_MIN_SCORE || '0.6')));
	const dedupTtl = Math.max(60000, parseInt(process.env.SOCIAL_DEDUP_TTL_MS || '600000', 10));

	async function tick() {
		try {
			const watch = await loadWatchlist();
			if (!provider) { return; }
			const posts = await provider.pollRecent();
			counters.last_poll_at = new Date().toISOString();
			counters.posts_seen += posts.length;
			for (const p of posts) {
				if (dedup.has(p.id) && (Date.now() - (dedup.get(p.id) || 0)) <= dedupTtl) { counters.dedup_hits++; continue; }
				const { score, tickers } = scorePostAgainstWatchlist(p, watch);
				if (score >= minScore) {
					counters.posts_matched++;
					await emitStubFromPost(p, tickers, score);
					counters.emitted++;
				}
				dedup.set(p.id, Date.now());
			}
			// Cleanup dedup
			for (const [k, v] of Array.from(dedup.entries())) { if (Date.now() - v > dedupTtl) dedup.delete(k); }
		} catch (e) { console.warn('[social][tick] error', (e as any)?.message || String(e)); }
		finally { loopTimer = setTimeout(tick, pollMs); }
	}
	if (loopTimer) clearTimeout(loopTimer);
	loopTimer = setTimeout(tick, 1000);
}


