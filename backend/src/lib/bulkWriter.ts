import { getDb } from './firestore';
import type { Firestore, BulkWriter, BulkWriterError } from '@google-cloud/firestore';

export type BulkWriterConfig = {
	enabled: boolean;
	maxOpsPerSecond?: number;
};

let writer: BulkWriter | null = null;
let enqueued = 0;
let errors = 0;

export function getBulkWriter(cfg: BulkWriterConfig): BulkWriter | null {
	if (!cfg.enabled) return null;
	if (writer) return writer;
	const db = getDb() as unknown as Firestore;
	writer = (db as any).bulkWriter({});
	try {
		// Retry policy - retriable codes with capped attempts; add jittered delay
		(writer as any).onWriteError((err: BulkWriterError) => {
			try {
				const code = (err as any).code as string;
				const retriable = ['aborted','deadline-exceeded','unavailable','internal'].includes(String(code));
				if (!retriable || (err.failedAttempts || 0) >= 5) { errors++; return false; }
				const base = Math.min(1000 * Math.pow(2, Math.max(0, (err.failedAttempts || 1) - 1)), 8000);
				const jitter = Math.floor(Math.random() * 300);
				(err as any).delayRetry(base + jitter);
				return true;
			} catch { errors++; return false; }
		});
	} catch {}
	return writer;
}

export function incEnqueued(count: number = 1) { enqueued += count; }
export function getBulkWriterCounters() { return { enqueued, errors }; }

export async function flushAndClose(): Promise<void> {
	if (!writer) return;
	try { await (writer as any).close(); } catch {}
	writer = null;
}


