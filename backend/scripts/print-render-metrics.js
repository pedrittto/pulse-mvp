const http = require('http');

function get(path) {
  const port = process.env.PORT || 4000;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c.toString('utf8'));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  try {
    const res = await get('/metrics-lite');
    const json = JSON.parse(res.body || '{}');
    const r = json.render || {};
    console.log('render:', r);
    process.exit(0);
  } catch (e) {
    console.error('error', e?.message || String(e));
    process.exit(1);
  }
})();


