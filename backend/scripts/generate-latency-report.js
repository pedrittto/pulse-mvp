/*
  Generate latency report by querying live endpoints and writing artifacts.
  This is read-only for the server; writes under backend/artifacts/latency_oneclick/.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

function get(pathname) {
  const port = process.env.PORT || 4000;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 5000 }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
    req.on('error', reject);
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function toSeconds1(ms) { if (ms == null) return null; return Math.round((ms/1000) * 10) / 10; }

(async () => {
  const art = path.join(__dirname, '..', 'artifacts', 'latency_oneclick');
  ensureDir(art);
  const kpiPath = path.join(art, 'kpi_breaking_final.json');
  const sumPath = path.join(art, 'metrics_summary_final.json');
  const reportPath = path.join(art, 'LATENCY_REPORT.txt');

  let kpi = null, sum = null;
  try {
    const r1 = await get('/kpi-breaking?window_min=30');
    if (r1.status >= 200 && r1.status < 300) { kpi = safeJson(r1.body); }
  } catch {}
  try {
    const r2 = await get('/metrics-summary');
    if (r2.status >= 200 && r2.status < 300) { sum = safeJson(r2.body); }
  } catch {}

  if (kpi) fs.writeFileSync(kpiPath, JSON.stringify(kpi, null, 2), 'utf8');
  if (sum) fs.writeFileSync(sumPath, JSON.stringify(sum, null, 2), 'utf8');

  const windowMin = (kpi && kpi.window_min) || 'unknown';
  const gP50 = (kpi && (kpi.breaking_p50_ms ?? (kpi.slo && kpi.slo.breaking_p50_ms))) ?? null;
  const gP90 = (kpi && (kpi.breaking_p90_ms ?? (kpi.slo && kpi.slo.breaking_p90_ms))) ?? null;
  const gP50c = (kpi && (kpi.breaking_p50_ms_corrected ?? (kpi.slo && kpi.slo.breaking_p50_ms_corrected))) ?? null;
  const gP90c = (kpi && (kpi.breaking_p90_ms_corrected ?? (kpi.slo && kpi.slo.breaking_p90_ms_corrected))) ?? null;

  const lines = [];
  lines.push('=== GLOBAL LATENCY (Pulse Exposure) ===');
  lines.push(`window_min: ${Number.isFinite(windowMin) ? windowMin : (typeof windowMin === 'number' ? windowMin : 'unknown')}`);
  lines.push(`p50_ms: ${gP50 != null ? Math.trunc(gP50) : 'null'}`);
  lines.push(`p90_ms: ${gP90 != null ? Math.trunc(gP90) : 'null'}`);
  lines.push(`p50_corrected_ms: ${gP50c != null ? Math.trunc(gP50c) : 'null'}`);
  lines.push(`p90_corrected_ms: ${gP90c != null ? Math.trunc(gP90c) : 'null'}`);
  lines.push(`p50_s: ${gP50 != null ? toSeconds1(gP50) : 'n/a'}`);
  lines.push(`p90_s: ${gP90 != null ? toSeconds1(gP90) : 'n/a'}`);
  lines.push(`p50c_s: ${gP50c != null ? toSeconds1(gP50c) : 'n/a'}`);
  lines.push(`p90c_s: ${gP90c != null ? toSeconds1(gP90c) : 'n/a'}`);
  lines.push('');
  lines.push('--- PER-SOURCE (Pulse Exposure) ---');

  if (sum && sum.by_source && typeof sum.by_source === 'object') {
    for (const [name, rec] of Object.entries(sum.by_source)) {
      const p50 = rec && (rec.pulse_p50 ?? rec.publisher_p50);
      const p90 = rec && (rec.pulse_p90 ?? rec.publisher_p90);
      const p50s = p50 != null ? toSeconds1(p50) : 'n/a';
      const p90s = p90 != null ? toSeconds1(p90) : 'n/a';
      lines.push(`${name}: p50_ms=${p50 != null ? Math.trunc(p50) : 'null'}, p90_ms=${p90 != null ? Math.trunc(p90) : 'null'}, p50_s=${p50s}, p90_s=${p90s}`);
    }
  } else {
    lines.push('(no per-source metrics found)');
  }

  if (gP50 == null && gP90 == null && gP50c == null && gP90c == null) {
    lines.push('NO SAMPLES IN WINDOW');
  }

  const content = lines.join('\r\n') + '\r\n';
  fs.writeFileSync(reportPath, content, 'utf8');
  process.stdout.write(content);
})().catch(err => {
  try {
    const art = path.join(__dirname, '..', 'artifacts', 'latency_oneclick');
    ensureDir(art);
    const reportPath = path.join(art, 'LATENCY_REPORT.txt');
    const msg = '=== GLOBAL LATENCY (Pulse Exposure) ===\r\nwindow_min: unknown\r\np50_ms: null\r\np90_ms: null\r\np50_corrected_ms: null\r\np90_corrected_ms: null\r\np50_s: n/a\r\np90_s: n/a\r\np50c_s: n/a\r\np90c_s: n/a\r\n\r\n--- PER-SOURCE (Pulse Exposure) ---\r\n(no per-source metrics found)\r\nNO SAMPLES IN WINDOW\r\n';
    fs.writeFileSync(reportPath, msg + `error: ${err && err.message ? err.message : String(err)}\r\n`, 'utf8');
    process.stdout.write(msg);
  } catch {}
  process.exit(1);
});


