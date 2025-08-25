import crypto from 'node:crypto';
import { getDb } from '../lib/firestore.js';
import { getAdapter } from './webhookRegistry.js';
import { publishStub } from '../ingest/breakingIngest.js';

type Job = { provider: string; headers: Record<string,string>; body: string };
type ProviderCounters = { received: number; verified: number; enqueued: number; parsed_ok: number; emitted: number; idempotent_hits: number; errors: number; cb_active: boolean };

const q: Job[] = [];
const running: Set<Promise<void>> = new Set();
const conc = Math.max(1, parseInt(process.env.WEBHOOK_QUEUE_CONCURRENCY || '8', 10));
const counters: Record<string, ProviderCounters> = {};
const circuit: Map<string, number> = new Map();

function bump(provider: string, field: keyof ProviderCounters) {
	const p = (counters[provider] ||= { received:0, verified:0, enqueued:0, parsed_ok:0, emitted:0, idempotent_hits:0, errors:0, cb_active:false });
	(p as any)[field] = ((p as any)[field] || 0) + 1;
}

function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

export function getWebhookCounters() { return JSON.parse(JSON.stringify(counters)); }

export function enqueueWebhook(provider: string, headers: Record<string,string>, body: string) {
	(counters[provider] ||= { received:0, verified:0, enqueued:0, parsed_ok:0, emitted:0, idempotent_hits:0, errors:0, cb_active:false });
	q.push({ provider, headers, body }); bump(provider, 'enqueued');
	void drain();
}

async function processOne(job: Job): Promise<void> {
	const { provider, headers, body } = job;
	// Circuit break
	const until = circuit.get(provider) || 0; if (until && until > Date.now()) { counters[provider].cb_active = true; return; } else { counters[provider].cb_active = false; }
	const adapter = getAdapter(provider);
	if (!adapter) return;
	try {
		const db = getDb();
		// Idempotency
		const pid = adapter.extractId(headers, body) || sha1(provider + '|' + body);
		const key = sha1(provider + '|' + pid);
		const ttlMs = Math.max(60000, parseInt(process.env.WEBHOOK_IDEMPOTENCY_TTL_MS || '86400000', 10));
		const ref = db.collection('webhook_idempotency').doc(key);
		const snap = await ref.get();
		if (snap.exists) { bump(provider, 'idempotent_hits'); return; }
		await ref.set({ provider, pid, created_at: new Date().toISOString(), ttl_ms: ttlMs });
		// Parse
		const start = Date.now();
		const to = setTimeout(() => { throw new Error('parse timeout'); }, 2000);
		const stub = await adapter.parse(headers, body);
		clearTimeout(to);
		bump(provider, 'parsed_ok');
		// Emit stub
		await publishStub({
			title: stub.headline || '',
			source: stub.source || 'Direct Wire',
			url: stub.url || '',
			published_at: stub.published_at,
			transport: 'webhook'
		});
		bump(provider, 'emitted');
	} catch (e) {
		bump(provider, 'errors');
		// Activate circuit breaker for 60s on repeated errors
		circuit.set(provider, Date.now() + 60000);
	}
}

async function drain() {
	while (running.size < conc && q.length) {
		const job = q.shift()!;
		const p = processOne(job).finally(() => running.delete(p));
		running.add(p);
	}
}


