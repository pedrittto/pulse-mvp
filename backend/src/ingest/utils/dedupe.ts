export const DEDUPE_HARD_MAX = 3000;
export const DEDUPE_PRUNE_TO = 2000; // default; adapters may override up to 2500 maximum

/** Mutates the input Set in insertion order.
 * If size > hardMax, removes oldest entries until size === pruneTo. */
export function trimSetInPlace<T>(
  s: Set<T>,
  hardMax: number = DEDUPE_HARD_MAX,
  pruneTo: number = DEDUPE_PRUNE_TO
) {
  if (s.size <= hardMax) return;
  const toRemove = s.size - pruneTo;
  let i = 0;
  for (const v of s) {
    s.delete(v);
    if (++i >= toRemove) break;
  }
}


