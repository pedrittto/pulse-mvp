const http = require('http');
const PORT = process.env.PORT || 4000;
const path = '/admin/scheduler/poke';
const opts = { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'X-Admin-Token': process.env.ADMIN_API_TOKEN || '' } };
const req = http.request(opts, res => {
  let d='';
  res.on('data', c => d += c);
  res.on('end', () => { console.log(res.statusCode, d.slice(0, 400)); });
});
req.on('error', e => console.error('ERR', e.message));
req.setTimeout(4000, () => { req.destroy(new Error('timeout')); console.error('ERR timeout'); });
req.end();


