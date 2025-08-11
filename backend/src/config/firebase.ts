import { getDb } from '../lib/firestore';

// Initialize Firestore (validation happens in getDb())
export const db = getDb();
