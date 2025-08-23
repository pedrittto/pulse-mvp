#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=');
      args[k] = (v !== undefined) ? v : (argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : '');
    }
  }
  return args;
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function hmac(algo, secret, data){ return crypto.createHmac(algo, secret).update(data).digest('hex'); }

function makeId(seq){ return `synth-${Date.now().toString(36)}-${seq.toString(36)}`; }

function writeNdjson(dir, row){ try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, `synth_pub_${Date.now()}.ndjson`), JSON.stringify(row)+'\n'); } catch {}
}

function sendWebhook(provider, body, headers, port=4000){
  return new Promise((resolve, reject)=>{
    const req = http.request({ host:'127.0.0.1', port, path:`/ingest/webhook/${provider}`, method:'POST', headers }, res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({ status:res.statusCode, body:d }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function runWebhook(args){
  const provider = (args.provider || 'prnewswire').toLowerCase();
  const port = parseInt(process.env.PORT || '4000', 10);
  const rps = parseFloat(args.rps || '1') || 1;
  const burst = parseInt(args.burst || '0', 10) || 0;
  const durationSec = parseInt(args['duration-sec'] || '60', 10);
  const publishOffsetMs = parseInt(args['publish-offset-ms'] || '0', 10);
  const headlinePrefix = args['headline-prefix'] || 'SYNTH';
  const tickers = (args.tickers || 'AAPL').split(',').map(s=>s.trim()).filter(Boolean);
  const algo = (process.env.WEBHOOK_HMAC_ALGO || 'sha256').toLowerCase();
  const secretMap = {
    prnewswire: process.env.WEBHOOK_SHARED_SECRET_PRNEWSWIRE,
    globenewswire: process.env.WEBHOOK_SHARED_SECRET_GLOBENEWSWIRE,
    businesswire: process.env.WEBHOOK_SHARED_SECRET_BUSINESSWIRE,
  };
  const secret = secretMap[provider] || 'testsecret';
  const start = Date.now();
  let sent = 0;
  const intervalMs = Math.max(1, Math.floor(1000 / Math.max(0.01, rps)));
  while (Date.now() - start < durationSec * 1000) {
    const batch = Math.max(1, burst || 1);
    for (let i=0; i<batch; i++) {
      const id = makeId(sent);
      const publishedAt = new Date(Date.now() + publishOffsetMs).toISOString();
      const headline = `${headlinePrefix} ${id}`;
      const payload = { id, headline, url:`https://example.com/${id}`, published_at: publishedAt, tickers };
      const body = JSON.stringify(payload);
      const ts = new Date().toISOString();
      const sig = `${algo}=${hmac(algo, secret, body + ts)}`;
      const headers = { 'Content-Type':'application/json', 'X-Signature': sig, 'X-Timestamp': ts };
      try { await sendWebhook(provider, body, headers, port); } catch {}
      writeNdjson(path.join('backend','artifacts'), { id, provider, published_at: publishedAt, sent_at: new Date().toISOString(), mode:'webhook', headline, tickers });
      sent++;
    }
    await sleep(intervalMs);
  }
}

async function runRssFile(args){
  const file = args.file || path.join(__dirname, 'sample.xml');
  const xmlBase = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : `<?xml version="1.0"?><rss><channel><title>Synth</title></channel></rss>`;
  let items = [];
  const server = http.createServer((req,res)=>{
    if (req.url && req.url.endsWith('/feed.xml')){
      const now = new Date().toUTCString();
      const body = `<?xml version="1.0"?><rss><channel><title>Synth</title>${items.map(it=>`<item><title>${it.title}</title><link>${it.link}</link><pubDate>${it.pubDate}</pubDate></item>`).join('')}</channel></rss>`;
      res.writeHead(200, {'Content-Type':'application/rss+xml'}); res.end(body);
    } else { res.writeHead(404).end(); }
  });
  await new Promise(r=>server.listen(8899,'127.0.0.1',r));
  console.log('RSS synth feed at http://127.0.0.1:8899/feed.xml');
  const rps = parseFloat(args.rps || '0.5');
  const durationSec = parseInt(args['duration-sec'] || '60', 10);
  const headlinePrefix = args['headline-prefix'] || 'SYNTH';
  const start = Date.now();
  let sent = 0;
  const intervalMs = Math.max(1, Math.floor(1000 / Math.max(0.01, rps)));
  while (Date.now() - start < durationSec * 1000) {
    const id = makeId(sent);
    const title = `${headlinePrefix} ${id}`;
    const link = `http://127.0.0.1:8899/item/${id}`;
    const pubDate = new Date().toUTCString();
    items.unshift({ title, link, pubDate }); items = items.slice(0,100);
    writeNdjson(path.join('backend','artifacts'), { id, provider:'rss-file', published_at: new Date().toISOString(), sent_at: new Date().toISOString(), mode:'rss-file', headline:title, tickers:[] });
    sent++;
    await sleep(intervalMs);
  }
  server.close();
}

(async () => {
  const args = parseArgs(process.argv);
  const mode = (args.mode || 'webhook').toLowerCase();
  if (mode === 'webhook') await runWebhook(args);
  else if (mode === 'rss-file') await runRssFile(args);
  else { console.error('Unknown mode'); process.exit(1); }
})();


