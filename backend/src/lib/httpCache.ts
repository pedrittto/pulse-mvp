import { getDb } from './firestore';

export type Validator = { etag?: string; lastModified?: string; updated_at: string };

function normId(name: string): string {
  return String(name || '').toLowerCase().replace(/\s+/g, '_');
}

export async function getValidator(sourceName: string): Promise<Validator | null> {
  try {
    const db = getDb();
    const doc = await db.collection('http_validators').doc(normId(sourceName)).get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    return {
      etag: data.etag || undefined,
      lastModified: data.lastModified || undefined,
      updated_at: data.updated_at || new Date().toISOString()
    };
  } catch {
    return null;
  }
}

export async function setValidator(sourceName: string, v: Validator): Promise<void> {
  try {
    const db = getDb();
    await db.collection('http_validators').doc(normId(sourceName)).set({
      etag: v.etag || null,
      lastModified: v.lastModified || null,
      updated_at: v.updated_at || new Date().toISOString()
    }, { merge: true });
  } catch { /* ignore */ }
}

export async function listValidators(): Promise<Record<string, Validator>> {
  const out: Record<string, Validator> = {};
  try {
    const db = getDb();
    const snap = await db.collection('http_validators').get();
    if (snap && Array.isArray((snap as any).docs)) {
      (snap as any).docs.forEach((d: any) => {
        const data = d.data() || {};
        out[d.id] = { etag: data.etag || undefined, lastModified: data.lastModified || undefined, updated_at: data.updated_at || new Date().toISOString() };
      });
    } else if (snap && typeof (snap as any).forEach === 'function') {
      (snap as any).forEach((d: any) => {
        const data = d.data() || {};
        out[d.id] = { etag: data.etag || undefined, lastModified: data.lastModified || undefined, updated_at: data.updated_at || new Date().toISOString() };
      });
    }
  } catch { /* ignore */ }
  return out;
}


