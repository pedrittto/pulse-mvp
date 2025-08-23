const http = require('http');
function get(p){ return new Promise((res,rej)=>{ const req = http.request({host:'127.0.0.1', port: process.env.PORT||4000, path:p, method:'GET'}, r=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({s:r.statusCode,b:d})); }); req.on('error',rej); req.end(); }); }
(async()=>{ try{ const m=await get('/metrics-lite'); console.log('DRIFT', m.s, (m.b||'').slice(0,500)); process.exit(0);} catch(e){ console.error(e?.message||String(e)); process.exit(1);} })();


