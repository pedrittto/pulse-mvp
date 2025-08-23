const http = require('http');
const crypto = require('crypto');
const port = process.env.PORT || 4000;
const provider = process.argv[2] || 'prnewswire';
const body = JSON.stringify({ id: 'demo-123', headline: 'Demo headline', url: 'https://example.com', published_at: new Date().toISOString(), tickers: ['AAPL'] });
const algo = process.env.WEBHOOK_HMAC_ALGO || 'sha256';
const secret = process.env.WEBHOOK_SHARED_SECRET_PRNEWSWIRE || 'testsecret';
const ts = new Date().toISOString();
const mac = crypto.createHmac(algo, secret).update(body + ts).digest('hex');
const sig = `${algo}=${mac}`;
const req = http.request({ host: '127.0.0.1', port, path: `/ingest/webhook/${provider}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-Timestamp': ts } }, res => {
  let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{
    console.log('POST status', res.statusCode, d);
    http.get({ host:'127.0.0.1', port, path: '/metrics-lite' }, r2 => { let d2=''; r2.on('data', c=>d2+=c); r2.on('end', ()=> console.log('metrics:', (d2||'').slice(0,500))); });
  });
});
req.on('error', e=> console.error(e));
req.write(body); req.end();


