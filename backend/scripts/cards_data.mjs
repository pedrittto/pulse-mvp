import fs from "node:fs";
import path from "node:path";
import { argv } from "node:process";

const args = Object.fromEntries(
  argv.slice(2).map((a,i,arr)=> a.startsWith("--") ? [a.slice(2), arr[i+1]] : []).filter(Boolean)
);
const BASE = args.base || process.env.PROD_BASE_URL;
const WINDOW_H = Number(args.window || 24);
if (!BASE) {
  console.error("Missing --base or PROD_BASE_URL");
  process.exit(2);
}

const ART = path.resolve("ARTIFACTS");
fs.mkdirSync(ART, { recursive: true });

async function fetchJson(url){
  const res = await fetch(url, { headers: { "Accept": "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function quantiles(arr){
  if(!arr.length) return {p50:null,p90:null};
  const a=[...arr].sort((x,y)=>x-y);
  const q=(p)=>{ const idx=(a.length-1)*p; const lo=Math.floor(idx), hi=Math.ceil(idx); if(lo===hi) return a[lo]; const w=idx-lo; return a[lo]*(1-w)+a[hi]*w; };
  return { p50:q(0.5), p90:q(0.9) };
}
function msToSec(ms){ return Math.round((ms/1000)*10)/10; }

function writeAll(data, stopwatch){
  const md = [
    `Window: ${data.window_hours}h`,
    data.insufficient_data ? `No data: ${data.reason}` : `n=${data.n_total} · p50=${data.p50_s ?? "—"}s · p90=${data.p90_s ?? "—"}s`,
    `Per-source: ${Object.keys(data.per_source||{}).length ? JSON.stringify(data.per_source) : "—"}`,
    `Source: ${data.source_of_truth ?? "none"}`
  ].join("\n");
  fs.writeFileSync(path.join(ART, "cards_data.json"), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(ART, "cards_data.md"), md + "\n");
  fs.writeFileSync(path.join(ART, "stopwatch_mock.json"), JSON.stringify(stopwatch, null, 2));
  console.log(md);
}

async function main(){
  let sourceOfTruth = "metrics_summary";
  try {
    const ms = await fetchJson(`${BASE}/metrics-summary`);
    fs.writeFileSync(path.join(ART, "raw_metrics_summary.json"), JSON.stringify(ms, null, 2));
    const per = ms.by_source || {};
    const entries = Object.entries(per).filter(([,v]) => (v?.samples||0) > 0);
    if (entries.length) {
      const totalN = entries.reduce((s,[,v]) => s + (v.samples||0), 0);
      const gP50 = ms?.sse?.p50_ms ?? null;
      const gP90 = ms?.sse?.p90_ms ?? null;
      const data = {
        window_hours: WINDOW_H,
        n_total: totalN,
        p50_s: gP50!=null ? msToSec(gP50) : null,
        p90_s: gP90!=null ? msToSec(gP90) : null,
        per_source: Object.fromEntries(entries.map(([k,v])=>[k,{ n: v.samples, p50_s: v.p50_ms!=null? msToSec(v.p50_ms): null, p90_s: v.p90_ms!=null? msToSec(v.p90_ms): null }])),
        source_of_truth: sourceOfTruth,
        base: BASE
      };
      writeAll(data, { type:"illustrative", wire_s:2.1, pulse_s:1.3, note:"illustrative only; replace when measured" });
      return;
    }
  } catch(e) {
    // fall through
  }

  // Fallback: JSONL offline
  sourceOfTruth = "jsonl_report";
  const candidates = [
    "backend/diagnostics/latency_samples.jsonl",
    "diagnostics/latency_samples.jsonl",
    "ARTIFACTS/latency_samples.jsonl"
  ];
  const file = candidates.find(p=>fs.existsSync(p));
  if (!file) {
    writeAll({ window_hours: WINDOW_H, insufficient_data: true, reason: "no metrics_summary samples and no local JSONL", source_of_truth: "none", base: BASE }, { type:"none", wire_s:null, pulse_s:null, note:"no sample" });
    return;
  }
  const now = Date.now();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let samples=[];
  for (const line of lines) {
    try { const j = JSON.parse(line); if (!j?.published_at_ms || !j?.visible_at_ms) continue; const age = now - j.visible_at_ms; if (age <= WINDOW_H*3600*1000) samples.push(j); } catch {}
  }
  let windowUsed = WINDOW_H;
  if (samples.length < 10) { samples = lines.map(l=>{ try { return JSON.parse(l) } catch { return null }}).filter(Boolean); windowUsed = 72; }
  const deltas = samples.map(s=> s.visible_at_ms - s.published_at_ms).filter(x=>x>0);
  const {p50, p90} = quantiles(deltas);
  const grouped = new Map();
  for (const s of samples) {
    const k = s.source || "unknown"; const list = grouped.get(k) || []; const d = s.visible_at_ms - s.published_at_ms; if (d>0) list.push(d); grouped.set(k, list);
  }
  const perSrc={};
  for (const [k, arr] of grouped) { const q = quantiles(arr); perSrc[k] = { n: arr.length, p50_s: q.p50!=null? msToSec(q.p50): null, p90_s: q.p90!=null? msToSec(q.p90): null }; }
  const data = { window_hours: windowUsed, n_total: deltas.length, p50_s: p50!=null? msToSec(p50): null, p90_s: p90!=null? msToSec(p90): null, per_source: perSrc, source_of_truth: sourceOfTruth, base: BASE, note: windowUsed!==WINDOW_H ? `insufficient 24h samples; expanded to ${windowUsed}h` : undefined };
  writeAll(data, { type: deltas.length? "measured":"none", wire_s:null, pulse_s: deltas.length? msToSec(p50): null, note: deltas.length? "pulse median from samples" : "no sample" });
}

main().catch(e=>{ console.error(e); process.exit(1); });
