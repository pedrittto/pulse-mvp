import { Firestore } from "@google-cloud/firestore";
import { registerAfterEmit } from "../core/emit.js";

type BreakingItem = Record<string, any>;

const PERSIST_ENABLED = process.env.PERSIST_ENABLED === "1";
const COLLECTION = process.env.FIRESTORE_COLLECTION_NAME || "pulse_items_v1";
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 10000);
const DRAIN_DELAY_MS = Number(process.env.DRAIN_DELAY_MS || 250);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 5000);

let firestore: Firestore | null = null;
let queue: BreakingItem[] = [];
let dropped = 0;
let drainTimer: NodeJS.Timeout | null = null;

function enqueue(it: BreakingItem) {
  if (queue.length >= MAX_QUEUE) {
    queue.shift(); // drop oldest
    dropped++;
  }
  queue.push(sanitize(it));
  if (!drainTimer) {
    drainTimer = setTimeout(() => { drainTimer = null; void flush(); }, DRAIN_DELAY_MS);
    (drainTimer as any)?.unref?.();
  }
}

function sanitize(it: BreakingItem): BreakingItem {
  // Keep ms fields numeric; do not expand payload
  const out: any = { ...it };
  const now = Date.now();
  if (!("visible_at_ms" in out) && !("visible_at" in out)) out.visible_at_ms = now;
  return out as BreakingItem;
}

async function flush() {
  if (!PERSIST_ENABLED || queue.length === 0) return;
  const items = queue;
  queue = [];
  try {
    const fsInstance = getFirestoreInstance();
    const batch = fsInstance.batch();
    const col = fsInstance.collection(COLLECTION);
    for (const item of items) {
      const id = String((item as any).id || "");
      if (!id) continue; // skip invalid
      batch.set(col.doc(id), item, { merge: true });
    }
    await batch.commit();
  } catch (e: any) {
    // Log once per interval to avoid spam
    try { console.error("[persist] batch failed:", e?.message || e); } catch {}
    // MVP: drop on failure (no requeue)
  }
}

export function setupPersistence() {
  if (!PERSIST_ENABLED) return;
  registerAfterEmit((item) => { enqueue(item); }); // non-blocking
  const t = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  (t as any)?.unref?.();
}

function getFirestoreInstance() {
  if (!firestore) {
    if (!PERSIST_ENABLED) throw new Error("Persistence is disabled.");
    try {
      firestore = new Firestore();
    } catch (e: any) {
      console.error("[persist] Failed to initialize Firestore:", e?.message || e);
      throw e; // Re-throw to fail the operation
    }
  }
  return firestore;
}


