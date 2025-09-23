const counts = new Map<string, number>();

export function ingestOutcome(source: string, outcome: string): void {
  try {
    const k = `${String(source)}:${String(outcome)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  } catch {}
}

export function getIngestCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counts) out[k] = v;
  return out;
}


