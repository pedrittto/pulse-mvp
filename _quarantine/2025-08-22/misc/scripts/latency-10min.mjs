// Poll /metrics-lite every 5s for 10 minutes, collect p50/p90 across all sources and snapshots,
// then print final results as plain text numbers.
const BASE = process.env.BASE_URL || 'http://localhost:4000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function average(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function grab() {
  const res = await fetch(`${BASE}/metrics-lite`);
  if (!res.ok) return null;
  const j = await res.json();
  return j?.latency || null;
}

async function main() {
  const p50s = [];
  const p90s = [];
  const iterations = 120; // 10 minutes @ 5s
  for (let i = 0; i < iterations; i++) {
    try {
      const lat = await grab();
      if (lat) {
        for (const name of Object.keys(lat)) {
          const e = lat[name];
          if (e && Number.isFinite(e.p50) && e.p50 >= 0) p50s.push(e.p50);
          if (e && Number.isFinite(e.p90) && e.p90 >= 0) p90s.push(e.p90);
        }
      }
    } catch {}
    await sleep(5000);
  }
  const medP50 = median(p50s);
  const medP90 = median(p90s);
  const avgP50 = average(p50s);
  const avgP90 = average(p90s);
  const total = Math.min(p50s.length, p90s.length);
  console.log(`median_p50_ms=${medP50}`);
  console.log(`median_p90_ms=${medP90}`);
  console.log(`average_p50_ms=${avgP50}`);
  console.log(`average_p90_ms=${avgP90}`);
  console.log(`total_samples=${total}`);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });


