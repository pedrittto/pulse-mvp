import admin from "firebase-admin";

let db: FirebaseFirestore.Firestore | null = null;

export function getDb() {
  if (db) return db;

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
