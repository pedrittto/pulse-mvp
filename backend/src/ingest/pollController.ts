type PerSourceStats = Record<string, { p50: number | null; samples: number; http200?: number; http304?: number; host?: string; lastActiveAt?: number }>;

type CtlState = {
  enabled: boolean;
  target_p50_ms: number;
  global_rps_est: number;
  per_host_rps_est: Record<string, number>;
  overrides: Record<string, number>;
  last_eval_at?: string;
};

export function startPollController(getMetrics: () => Promise<PerSourceStats>, apply: (changes: Record<string, number>) => void) {
  const enabled = String(process.env.CTRL_ENABLED || '0') === '1';
  const target = Math.max(1000, parseInt(process.env.CTRL_TARGET_P50_MS || '60000', 10));
  const rpsMax = Math.max(1, parseInt(process.env.CTRL_GLOBAL_RPS_MAX || '8', 10));
  const rpsHostMax = Math.max(1, parseInt(process.env.CTRL_PER_HOST_RPS_MAX || '3', 10));
  const intMin = Math.max(500, parseInt(process.env.CTRL_INTERVAL_MIN_MS || '1500', 10));
  const intMax = Math.max(intMin, parseInt(process.env.CTRL_INTERVAL_MAX_MS || '30000', 10));
  const step = Math.max(100, parseInt(process.env.CTRL_STEP_MS || '1000', 10));
  const hyst = Math.max(0, parseInt(process.env.CTRL_HYST_MS || '3000', 10));
  const cooldownSec = Math.max(5, parseInt(process.env.CTRL_COOLDOWN_SEC || '60', 10));

  const state: CtlState = { enabled, target_p50_ms: target, global_rps_est: 0, per_host_rps_est: {}, overrides: {} };
  let timer: NodeJS.Timeout | null = null;

  async function tick() {
    if (!enabled) return;
    try {
      const stats = await getMetrics();
      const next: Record<string, number> = { ...state.overrides };
      const hostMap: Record<string, string> = {};
      // 1) Adjust per-source toward target using hysteresis
      for (const [src, s] of Object.entries(stats)) {
        if (typeof s.p50 !== 'number' || s.samples < 3) continue; // need samples
        const cur = state.overrides[src] || intMax; // default conservative
        let ni = cur;
        if (s.p50 > target + hyst) ni = Math.max(intMin, cur - step);
        else if (s.p50 < target - hyst) {
          const total = (s.http200 || 0) + (s.http304 || 0);
          const r304 = total ? (s.http304 || 0) / total : 0;
          if (r304 > 0.6) ni = Math.min(intMax, cur + step);
        }
        next[src] = ni;
        if (s.host) hostMap[src] = s.host;
      }
      // 2) Enforce RPS caps
      const perHostRps: Record<string, number> = {};
      let globalRps = 0;
      for (const [src, ms] of Object.entries(next)) {
        const r = 1000 / Math.max(intMin, ms);
        const h = hostMap[src] || 'unknown';
        perHostRps[h] = (perHostRps[h] || 0) + r;
        globalRps += r;
      }
      // Scale up (increase intervals) if over caps: least-recently-active first (approx by missing lastActiveAt)
      const entries = Object.entries(next).map(([src, ms]) => ({ src, ms, last: stats[src]?.lastActiveAt || 0, host: hostMap[src] || 'unknown' }));
      entries.sort((a,b)=> (a.last||0) - (b.last||0));
      function scaleIfNeeded() {
        let changed = false;
        if (globalRps > rpsMax) {
          for (const e of entries) {
            if (globalRps <= rpsMax) break;
            const old = next[e.src];
            const inc = Math.min(intMax, old + step);
            if (inc !== old) {
              next[e.src] = inc;
              const rOld = 1000 / old; const rNew = 1000 / inc;
              globalRps += (rNew - rOld);
              perHostRps[e.host] += (rNew - rOld);
              changed = true;
            }
          }
        }
        for (const [h, rps] of Object.entries(perHostRps)) {
          if (rps <= rpsHostMax) continue;
          for (const e of entries.filter(x=>x.host===h)) {
            if (perHostRps[h] <= rpsHostMax) break;
            const old = next[e.src]; const inc = Math.min(intMax, old + step);
            if (inc !== old) {
              next[e.src] = inc;
              const rOld = 1000 / old; const rNew = 1000 / inc;
              perHostRps[h] += (rNew - rOld);
              globalRps += (rNew - rOld);
              changed = true;
            }
          }
        }
        return changed;
      }
      scaleIfNeeded();
      state.overrides = next;
      state.per_host_rps_est = perHostRps;
      state.global_rps_est = globalRps;
      state.last_eval_at = new Date().toISOString();
      // Apply
      apply(next);
    } catch (e) { /* best effort */ }
  }

  if (enabled) timer = setInterval(tick, Math.max(5000, parseInt(process.env.CTRL_COOLDOWN_SEC || '60', 10) * 1000));

  return {
    getState() { return { ...state }; },
    stop() { if (timer) clearInterval(timer); }
  };
}


