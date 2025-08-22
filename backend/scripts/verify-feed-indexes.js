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

function pluckCursor(json) {
  if (!json || typeof json !== 'object') return null;
  const c = json.page && json.page.cursor;
  return (typeof c === 'string' && c.length > 0) ? c : null;
}

(async () => {
  try {
    const feed = await get('/feed?limit=5');
    if (feed.status < 200 || feed.status >= 300) { console.error('FEED status', feed.status); process.exit(1); }
    const feedJson = JSON.parse(feed.body || '{}');
    console.log('FEED', feed.status, (feed.body || '').slice(0,200));
    const c1 = pluckCursor(feedJson);
    if (c1) {
      const next = await get(`/feed?limit=5&cursor=${encodeURIComponent(c1)}`);
      console.log('FEED next', next.status, (next.body || '').slice(0,200));
      if (next.status < 200 || next.status >= 300) process.exit(1);
    }

    const br = await get('/breaking-feed?limit=5');
    if (br.status < 200 || br.status >= 300) { console.error('BREAKING status', br.status); process.exit(1); }
    const brJson = JSON.parse(br.body || '{}');
    console.log('BREAKING', br.status, (br.body || '').slice(0,200));
    const c2 = pluckCursor(brJson);
    if (c2) {
      const next2 = await get(`/breaking-feed?limit=5&cursor=${encodeURIComponent(c2)}`);
      console.log('BREAKING next', next2.status, (next2.body || '').slice(0,200));
      if (next2.status < 200 || next2.status >= 300) process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();


