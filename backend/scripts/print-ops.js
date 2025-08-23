const http = require('http');
function get(path){
  const port = process.env.PORT || 4000;
  return new Promise((res, rej)=>{
    const req = http.request({ host:'127.0.0.1', port, path, method:'GET' }, r=>{
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode, body:d}));
    });
    req.on('error',rej); req.end();
  });
}
(async()=>{
  try{
    const m = await get('/metrics-lite');
    console.log('OPS', m.status, (m.body||'').slice(0,400));
    process.exit(0);
  }catch(e){ console.error(e?.message||String(e)); process.exit(1); }
})();


