// Prints latency metrics in a compact table with a Tier-1+Wires summary
const BASE = process.env.BASE_URL || 'http://localhost:4000';

async function main() {
  const res = await fetch(`${BASE}/metrics-lite`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const lat = j.latency || {};
  const names = Object.keys(lat).sort();
  const line = (...cols) => console.log(cols.join(' | '));
  line('source', 'p50', 'p90', 'samples');
  line('---', '---', '---', '---');
  for (const n of names) {
    const e = lat[n];
    line(n.replace(/\|/g, '/'), String(e.p50), String(e.p90), String(e.count));
  }
  const T1 = ['Bloomberg Markets','Reuters Business','AP Business','CNBC','Financial Times'];
  const W = ['PRNewswire','GlobeNewswire','SEC Filings','BLS Releases','BEA News','NASDAQ Trader News','NYSE Notices'];
  const include = new Set([...T1, ...W]);
  const p50s = [];
  const p90s = [];
  for (const n of names) {
    if (include.has(n)) {
      const e = lat[n];
      if (e && Number.isFinite(e.p50) && Number.isFinite(e.p90)) {
        p50s.push(e.p50);
        p90s.push(e.p90);
      }
    }
  }
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a,b)=>a-b);
    const m = Math.floor(s.length/2);
    return (s.length % 2) ? s[m] : Math.round((s[m-1] + s[m]) / 2);
  };
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : null;
  const mP50 = median(p50s), aP50 = avg(p50s), mP90 = median(p90s), aP90 = avg(p90s);
  console.log('');
  console.log(`Overall (Tier-1+Wires): median_p50_ms=${mP50 ?? 'n/a'} avg_p50_ms=${aP50 ?? 'n/a'} median_p90_ms=${mP90 ?? 'n/a'} avg_p90_ms=${aP90 ?? 'n/a'}`);
}

main().catch((e)=>{ console.error(e.message || String(e)); process.exit(1); });


