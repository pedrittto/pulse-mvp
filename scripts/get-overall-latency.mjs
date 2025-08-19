// Polls /metrics-lite until latency samples appear, then prints two lines:
// p50 = XXX ms
// p90 = YYY ms
const BASE = process.env.BASE_URL || 'http://localhost:4000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function fetchLatency() {
  const res = await fetch(`${BASE}/metrics-lite`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.latency || {};
}

async function main() {
  // Retry until at least one source has non-zero samples
  let lat = {};
  for (;;) {
    lat = await fetchLatency();
    const names = Object.keys(lat);
    const hasSamples = names.some((n) => (lat[n]?.count || 0) > 0 && (lat[n]?.p50 || 0) > 0);
    if (hasSamples) break;
    await sleep(3000);
  }
  const names = Object.keys(lat);
  const p50s = [];
  const p90s = [];
  for (const n of names) {
    const e = lat[n];
    if (!e) continue;
    if (typeof e.p50 === 'number' && e.p50 > 0) p50s.push(e.p50);
    if (typeof e.p90 === 'number' && e.p90 > 0) p90s.push(e.p90);
  }
  const mP50 = median(p50s);
  const mP90 = median(p90s);
  console.log(`p50 = ${mP50} ms`);
  console.log(`p90 = ${mP90} ms`);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });


