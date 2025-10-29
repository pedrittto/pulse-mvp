import * as sse from "../sse.js";

export type BreakingItem = Record<string, any>;
type AfterEmitHook = (item: BreakingItem) => void;

const afterEmitHooks: AfterEmitHook[] = [];

export function registerAfterEmit(h: AfterEmitHook) {
  afterEmitHooks.push(h);
}

export function emitBreaking(item: BreakingItem): number {
  // Ensure timestamps in ms for downstream consumers
  const now = Date.now();
  if (!('visible_at_ms' in item) && !('visible_at' in item)) {
    (item as any).visible_at_ms = now;
  }

  // Hot path: synchronous and lean; do not await anything
  const delivered = (sse as any).broadcastBreaking ? (sse as any).broadcastBreaking(item) : sse.broadcast(item);

  try {
    for (const h of afterEmitHooks) h(item);
  } catch (_e) {
    // Swallow hook errors in MVP; hot path must not crash
  }
  return delivered;
}


