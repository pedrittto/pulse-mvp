type RenderDoc = {
  source?: string;
  delta_receive_ms?: number;
  delta_render_ms?: number;
  ingested_at: string;
};

const ring: RenderDoc[] = [];
const CAP = 10000;

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

export function ingestRenderSample(doc: RenderDoc) {
  try {
    ring.push(doc);
    if (ring.length > CAP) ring.shift();
  } catch {}
}

export function getRenderAgg() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recent = ring.filter(e => {
    const t = Date.parse(e.ingested_at);
    return Number.isFinite(t) && t >= cutoff;
  });
  const recv: number[] = [];
  const rend: number[] = [];
  for (const e of recent) {
    if (typeof e.delta_receive_ms === 'number') recv.push(e.delta_receive_ms);
    if (typeof e.delta_render_ms === 'number') rend.push(e.delta_render_ms);
  }
  return {
    receive_p50_ms: pct(recv, 0.5),
    receive_p90_ms: pct(recv, 0.9),
    render_p50_ms: pct(rend, 0.5),
    render_p90_ms: pct(rend, 0.9),
    samples: recent.length
  };
}


