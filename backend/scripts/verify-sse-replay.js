const http = require('http');

function connect(path) {
  const port = process.env.PORT || 4000;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      resolve(res);
    });
    req.on('error', reject); req.end();
  });
}

function readSomeEvents(res, max = 5, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let buf = ''; const events = []; let timer = setTimeout(() => done(), timeoutMs);
    function done() { try { res.destroy(); } catch {} clearTimeout(timer); resolve(events); }
    res.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const lines = block.split(/\r?\n/);
        const ev = { id: '', event: 'message', data: '' };
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith('id:')) ev.id = line.slice(3).trim();
          else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5);
        }
        if (ev.event === 'new' || ev.event === 'message') events.push(ev);
        if (events.length >= max) return done();
      }
    });
    res.on('end', () => done());
    res.on('error', () => done());
  });
}

(async () => {
  try {
    // Open first connection and read a few events
    const res1 = await connect('/sse/new-items');
    const first = await readSomeEvents(res1, 3, 4000);
    console.log('FIRST', first.length, first.map(e => e.id).join(','));
    const lastId = first.length ? first[first.length - 1].id : '';

    // Reconnect with lastEventId
    const path = lastId ? `/sse/new-items?lastEventId=${encodeURIComponent(lastId)}` : '/sse/new-items';
    const res2 = await connect(path);
    const second = await readSomeEvents(res2, 3, 4000);
    console.log('SECOND', second.length, second.map(e => e.id).join(','));

    if (lastId) {
      const ok = second.every(e => !e.id || parseInt(e.id, 10) > parseInt(lastId, 10));
      if (!ok) { console.error('Replay did not respect Last-Event-ID'); process.exit(1); }
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();


