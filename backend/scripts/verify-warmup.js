const http = require('http');

function get(path) {
  const port = process.env.PORT || 4000;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

(async () => {
  try {
    const r = await get('/warmup-status');
    console.log('WARMUP', r.status, (r.body || '').slice(0, 500));
    if (r.status < 200 || r.status >= 300) process.exit(1);
    const js = JSON.parse(r.body || '{}');
    if (js && js.ran === true && Array.isArray(js.results) && js.results.length === 0) {
      console.error('Warmup ran but results empty');
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();


