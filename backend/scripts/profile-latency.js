const fs = require('fs');
const path = require('path');
const http = require('http');

function get(pathname){ const port=process.env.PORT||4000; return new Promise((res,rej)=>{ const req=http.request({host:'127.0.0.1',port,path:pathname,method:'GET'},r=>{let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode,body:d}));}); req.on('error',rej); req.end(); }); }

function safeJson(s){ try{ return JSON.parse(s); }catch{ return null; } }

(async()=>{
  try{
    const artifactsDir = path.join('backend','artifacts');
    const files = fs.readdirSync(artifactsDir).filter(f=>/^synth_pub_.*\.ndjson$/.test(f)).sort();
    if (!files.length) { console.error('No synth NDJSON found'); process.exit(1); }
    const nd = fs.readFileSync(path.join(artifactsDir, files[files.length-1]),'utf8').trim().split(/\r?\n/).map(l=>{ try{return JSON.parse(l);}catch{return null;} }).filter(Boolean);
    // Fetch metrics
    const ml = await get('/metrics-lite'); const mj = safeJson(ml.body) || {};
    const slo = (await get('/kpi-breaking?window_min=30')); const sj = safeJson(slo.body) || {};
    // Build simple summary using available aggregates
    const summary = {
      samples: nd.length,
      publish_to_ingest_p50_ms: mj?.global_publisher?.p50 ?? null,
      publish_to_ingest_p90_ms: mj?.global_publisher?.p90 ?? null,
      breaking_slo_p50_ms: sj?.slo?.breaking_p50_ms ?? null,
      breaking_slo_p90_ms: sj?.slo?.breaking_p90_ms ?? null,
      e2e_receive_p50_ms: mj?.render?.receive_p50_ms ?? null,
      e2e_receive_p90_ms: mj?.render?.receive_p90_ms ?? null,
      e2e_render_p50_ms: mj?.render?.render_p50_ms ?? null,
      e2e_render_p90_ms: mj?.render?.render_p90_ms ?? null
    };
    const csvPath = path.join(artifactsDir, `latency_profile_${Date.now()}.csv`);
    const jsonPath = path.join(artifactsDir, `latency_profile_${Date.now()}.json`);
    // Minimal CSV with synth id/published/sent (placeholders for ingest/render if not directly observable)
    const header = 'id,provider,published_at,sent_at\n';
    fs.writeFileSync(csvPath, header + nd.map(r=>`${r.id},${r.provider},${r.published_at},${r.sent_at}`).join('\n'));
    fs.writeFileSync(jsonPath, JSON.stringify(summary,null,2));
    const pass = (typeof summary.breaking_slo_p50_ms==='number' && summary.breaking_slo_p50_ms<=60000) && (typeof summary.breaking_slo_p90_ms==='number' && summary.breaking_slo_p90_ms<=120000);
    console.log('SUMMARY', summary);
    if (!pass) { console.error('FAIL: SLO not met'); process.exit(1); }
    process.exit(0);
  }catch(e){ console.error(e?.message||String(e)); process.exit(1); }
})();


