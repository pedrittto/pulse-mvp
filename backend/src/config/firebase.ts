import { getDb } from '../lib/firestore.js';

// Initialize Firestore (validation happens in getDb())
export const db = getDb();
