const http = require('http');
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function get(pathname) {
  const port = process.env.PORT || 4000;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function tick() {
  const kpi = await get('/kpi-breaking?window_min=30');
  const sum = await get('/metrics-summary');
  const brk = await get('/breaking-feed?limit=1');
  const kpiJson = safeJson(kpi.body) || {};
  const ts = nowIso();
  const p50 = kpiJson?.slo?.breaking_p50_ms ?? null;
  const p90 = kpiJson?.slo?.breaking_p90_ms ?? null;
  const passes = !!kpiJson?.slo?.passes;
  const demotedCnt = Array.isArray(kpiJson?.demoted) ? kpiJson.demoted.length : 0;
  const eligibleCnt = (kpiJson?.sources && typeof kpiJson.sources === 'object')
    ? Object.values(kpiJson.sources).filter((v) => v && typeof v === 'object' && v.eligible === true).length
    : 0;
  return {
    ts,
    breaking_p50_ms: (typeof p50 === 'number') ? p50 : null,
    breaking_p90_ms: (typeof p90 === 'number') ? p90 : null,
    passes,
    eligible_cnt: eligibleCnt,
    demoted_cnt: demotedCnt,
    kpi_status: kpi.status,
    sum_status: sum.status,
    brk_status: brk.status
  };
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function toCsv(rows) {
  const header = ['ts','breaking_p50_ms','breaking_p90_ms','passes','eligible_cnt','demoted_cnt'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.ts,
      r.breaking_p50_ms ?? '',
      r.breaking_p90_ms ?? '',
      r.passes ? 1 : 0,
      r.eligible_cnt,
      r.demoted_cnt
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

(async () => {
  const intervalSec = Math.max(5, parseInt(process.env.SOAK_INTERVAL_SEC || '60', 10));
  const durationMin = Math.max(1, parseInt(process.env.SOAK_DURATION_MIN || '30', 10));
  const iterations = Math.ceil((durationMin * 60) / intervalSec);
  const results = [];
  console.log(`[soak] starting: interval=${intervalSec}s duration=${durationMin}min iterations=${iterations}`);

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      const r = await tick();
      results.push(r);
      console.log(`[soak][${i+1}/${iterations}] ts=${r.ts} p50=${r.breaking_p50_ms ?? 'null'} p90=${r.breaking_p90_ms ?? 'null'} passes=${r.passes} eligible=${r.eligible_cnt} demoted=${r.demoted_cnt}`);
    } catch (e) {
      const ts = nowIso();
      console.error(`[soak][${i+1}/${iterations}] error`, e?.message || e);
      results.push({ ts, breaking_p50_ms: null, breaking_p90_ms: null, passes: false, eligible_cnt: 0, demoted_cnt: 0, error: String(e?.message || e) });
    }
    const elapsed = Date.now() - start;
    const waitMs = Math.max(0, intervalSec * 1000 - elapsed);
    if (i < iterations - 1) await sleep(waitMs);
  }

  const overallPass = results.every(r => r.passes === true);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'artifacts');
  ensureDir(outDir);
  const csvPath = path.join(outDir, `soak_breaking_${stamp}.csv`);
  const jsonPath = path.join(outDir, `soak_breaking_${stamp}.json`);
  fs.writeFileSync(csvPath, toCsv(results), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: { interval_sec: intervalSec, duration_min: durationMin }, results }, null, 2), 'utf8');
  console.log(`[soak] written CSV=${csvPath}`);
  console.log(`[soak] written JSON=${jsonPath}`);
  console.log(`[soak] RESULT: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });


