import admin from "firebase-admin";
import { createMockDb } from './mockFirestore';

let db: any | null = null;

export function getDb() {
  if (db) return db;

  // Allow local dev without real credentials
  // In non-production, default to mock unless explicitly configured
  const fakeFlag = process.env.FAKE_FIRESTORE === '1' || process.env.USE_FAKE_FIRESTORE === '1';
  if (
    fakeFlag || (process.env.NODE_ENV !== 'production')
  ) {
    console.log('[firestore] MOCK_DB_ACTIVE', { reason: fakeFlag ? 'FAKE_FIRESTORE' : 'non-production' });
    db = createMockDb();
    return db;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(`Missing FIREBASE_* envs: pid=${!!projectId} email=${!!clientEmail} key=${!!privateKey}`);
  }

  // Convert escaped newlines safely
  privateKey = privateKey.replace(/\\n/g, "\n");

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
