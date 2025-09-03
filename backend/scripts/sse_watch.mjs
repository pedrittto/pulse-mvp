// backend/scripts/sse_watch.mjs
// Usage: node backend/scripts/sse_watch.mjs --base https://pulse-mvp-production.up.railway.app --path /sse/breaking --maxSeconds 300
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a,i,arr)=>a.startsWith("--")?[a.slice(2),arr[i+1]]:[]).filter(Boolean));
const BASE = args.base || process.env.PROD_BASE_URL;
const SSE_PATH = args.path || "/sse/breaking";
const MAX_S = Number(args.maxSeconds || 300);
if (!BASE) { console.error("Missing --base or PROD_BASE_URL"); process.exit(2); }

const OUTDIR = path.resolve("ARTIFACTS");
fs.mkdirSync(OUTDIR, { recursive: true });
const OUT = path.join(OUTDIR, "latency_samples.jsonl");

const ctrl = new AbortController();
setTimeout(()=>ctrl.abort(), MAX_S*1000);

(async () => {
  const url = BASE.replace(/\/$/, "") + SSE_PATH;
  const res = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    },
    signal: ctrl.signal
  });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);

  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream:true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx); buf = buf.slice(idx+2);
      const dataLine = block.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        const toMs = (x) => typeof x === 'number' ? x : (Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN);
        const pub = payload?.published_at_ms ?? payload?.published_at ?? payload?.publishedAt;
        const vis = payload?.visible_at_ms ?? payload?.visible_at ?? payload?.visibleAt;
        const source = payload?.source || payload?.wire || "unknown";
        const rec = { source, published_at_ms: toMs(pub), visible_at_ms: toMs(vis) };
        if (Number.isFinite(rec.published_at_ms) && Number.isFinite(rec.visible_at_ms)) {
          fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
          console.log("sample+", rec);
        } else {
          try { console.log("evt-keys", Object.keys(payload)); } catch {}
        }
      } catch {}
    }
  }
})().catch(e => { if (e.name!=="AbortError") console.error(e); });


