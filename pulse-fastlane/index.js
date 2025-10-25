import http from "http";
const TICK_URL = process.env.TICK_URL;
const TICK_KEY = process.env.TICK_KEY;
const PERIOD_MS = Number(process.env.PERIOD_MS || 2000);
const TIMEOUT_MS = Math.max(1000, Math.floor(PERIOD_MS * 0.8));
const ERROR_PAUSE_MS = Number(process.env.ERROR_PAUSE_MS || 60000);
const MAX_SEQ_ERRORS = Number(process.env.MAX_SEQ_ERRORS || 5);
let seqErrors = 0, pausedUntil = 0;
async function tick(){
  const now = Date.now(); if (now < pausedUntil) return;
  try{
    const r = await fetch(TICK_URL,{method:"POST",
      headers:{ "Content-Type":"application/json","X-Tick-Key":TICK_KEY },
      body:"{}", signal: AbortSignal.timeout(TIMEOUT_MS)});
    if (r.status===200){ seqErrors=0; return; }
    if (++seqErrors>=MAX_SEQ_ERRORS || r.status===429){
      pausedUntil = now + ERROR_PAUSE_MS;
      console.error("fastlane-backoff",{status:r.status,until:new Date(pausedUntil).toISOString()});
      seqErrors=0;
    }
  }catch(e){
    if (++seqErrors>=MAX_SEQ_ERRORS){
      pausedUntil = now + ERROR_PAUSE_MS;
      console.error("fastlane-error-backoff",{err:String(e),until:new Date(pausedUntil).toISOString()});
      seqErrors=0;
    }
  }
}
setInterval(tick, PERIOD_MS);
http.createServer((_,res)=>res.end("ok")).listen(process.env.PORT||8080);