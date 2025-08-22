const { spawn } = require('child_process');
const http = require('http');

function get(path){ const port=process.env.PORT||4000; return new Promise((res,rej)=>{ const req=http.request({host:'127.0.0.1',port,path,method:'GET'},r=>{let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode,body:d}));}); req.on('error',rej); req.end(); }); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async()=>{
  try{
    const rps = parseFloat(process.env.LT_RPS || '2');
    const dur = parseInt(process.env.LT_DURATION_SEC || '600', 10);
    const provider = (process.env.LT_PROVIDER || 'prnewswire').toLowerCase();
    const child = spawn(process.execPath, ['./tools/synth-publisher/cli.js', '--mode','webhook','--provider',provider,'--rps',String(rps),'--duration-sec',String(dur)], { stdio:'inherit' });
    let fails=0, passes=0;
    const start = Date.now();
    while (Date.now() - start < dur*1000) {
      await sleep(30000);
      try { const r = await get('/kpi-breaking?window_min=30'); const j = JSON.parse(r.body||'{}'); if (j?.slo?.passes) { passes++; fails=0; } else { fails++; } } catch { fails++; }
      if (fails>=2) { console.error('FAIL: Breaking SLO not met for 2 consecutive checks'); try{child.kill();}catch{} process.exit(1); }
    }
    try{child.kill();}catch{}
    const r = await get('/kpi-breaking?window_min=30'); const j = JSON.parse(r.body||'{}');
    console.log('RESULT', { p50: j?.slo?.breaking_p50_ms, p90: j?.slo?.breaking_p90_ms, p50c: j?.slo?.breaking_p50_ms_corrected, p90c: j?.slo?.breaking_p90_ms_corrected });
    process.exit(0);
  }catch(e){ console.error(e?.message||String(e)); process.exit(1); }
})();


