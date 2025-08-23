const http = require('http');
const PORT = process.env.PORT || 4000;
const PATHS = ['/health', '/healthz', '/readyz', '/metrics-lite', '/metrics-summary', '/feed?limit=5', '/breaking-feed?limit=5', '/kpi-breaking?window_min=30'];

function get(path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve({ error: 'timeout' });
    });
  });
}

(async () => {
  for (const p of PATHS) {
    const r = await get(p);
    console.log('>>>', p);
    if (r.error) console.log('ERR', r.error);
    else console.log(r.status, (r.body || '').slice(0, 400));
    console.log();
  }
})();


