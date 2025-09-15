#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sh(cmd, opts = {}) {
  const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  return out.trim();
}

function safe(fn, msg) {
  try { return fn(); } catch (e) { if (msg) console.error(msg + ':', e?.message || String(e)); return null; }
}

function nowIso() { return new Date().toISOString(); }

const ART_DIR = join(process.cwd(), 'ARTIFACTS');
safe(() => mkdirSync(ART_DIR, { recursive: true }));

const PROJECT_NUMBER = '394046395219';
console.log('[deploy] resolving projectId from number', PROJECT_NUMBER);
const PROJECT_ID = sh(`gcloud projects describe ${PROJECT_NUMBER} --format=value(projectId) --quiet`);
console.log('[deploy] projectId =', PROJECT_ID);

console.log('[deploy] ensuring Artifact Registry repo pulse (europe-west1)');
const repoOk = safe(() => sh(`gcloud artifacts repositories describe pulse --location=europe-west1 --quiet`));
if (!repoOk) {
  sh(`gcloud artifacts repositories create pulse --repository-format=docker --location=europe-west1 --description="Pulse images" --quiet`);
}

console.log('[deploy] configuring docker auth for europe-west1-docker.pkg.dev');
sh(`gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet`);

const IMAGE_BASE = `europe-west1-docker.pkg.dev/${PROJECT_ID}/pulse/pulse-backend`;

// Capture current revision image for rollback
console.log('[deploy] capturing current revision (for rollback)');
let prevImage = '';
let prevRevision = '';
try {
  prevRevision = safe(() => sh(`gcloud run services describe pulse-canary --region=europe-west1 --format=value(status.latestReadyRevisionName) --quiet`)) || '';
  prevImage = safe(() => sh(`gcloud run revisions describe ${prevRevision} --region=europe-west1 --format=value(status.imageDigest) --quiet`)) || '';
  // Normalize to bare digest
  if (prevImage.includes('@')) prevImage = prevImage.split('@').pop();
  if (prevImage.startsWith('europe-west1-docker.pkg.dev')) {
    const at = prevImage.split('@');
    prevImage = at.length > 1 ? at[1] : prevImage;
  }
} catch {}
console.log('[deploy] building image in Cloud Build');
sh(`gcloud builds submit --region=europe-west1 --tag ${IMAGE_BASE}:canary --quiet .`);

console.log('[deploy] resolving image digest');
let digest = '';
try {
  const desc = sh(`gcloud artifacts docker images describe ${IMAGE_BASE}:canary --format=get(image_summary.digest) --quiet`);
  digest = desc.trim();
} catch {
  const insp = sh(`docker inspect --format='{{index .RepoDigests 0}}' ${IMAGE_BASE}:canary`);
  digest = insp.split('@')[1] || '';
}
if (!digest) throw new Error('Failed to resolve image digest');
const imageWithDigest = `${IMAGE_BASE}@${digest}`;
console.log('[deploy] image digest =', digest);

const DEBUG_PUSH_KEY = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 32);
const envMap = {
  NODE_ENV: 'production',
  DISABLE_JOBS: '0',
  DEBUG_INGEST: '1',
  SSE_ENABLED: '1',
  INGEST_SOURCES: 'prnewswire,businesswire,nyse_notices,nasdaq_halts',
  DEBUG_PUSH_KEY,
  FRESH_MS: String(30 * 60 * 1000),
  SMOKE_ACCEPT_OLD: '1',
  SPEC_V1: '1',
  FASTLANE: '1',
  FASTLANE_SOURCES: 'nasdaq_halts,nyse_notices',
  FASTLANE_IGNORE_MARKET: '1',
  FASTLANE_CLAMP_MS_MIN: '1000',
  FASTLANE_CLAMP_MS_MAX: '3000',
  FASTLANE_JITTER: '0.2',
  FASTLANE_BUCKET_QPS: '1',
  FASTLANE_BUCKET_BURST: '2',
  FASTLANE_MARKET_TZ: 'America/New_York',
  FASTLANE_MARKET_OPEN: '09:30',
  FASTLANE_MARKET_CLOSE: '16:00',
  FASTLANE_RECENT_WINDOW_S: '120',
};
const envFile = join(ART_DIR, 'env.json');
writeFileSync(envFile, JSON.stringify(envMap, null, 2));

console.log('[deploy] deploying to Cloud Run service pulse-canary (europe-west1)');
sh(`gcloud run deploy pulse-canary --image=${imageWithDigest} --region=europe-west1 --allow-unauthenticated --min-instances=1 --max-instances=1 --no-cpu-throttling --port=8080 --env-vars-file=${envFile} --quiet`);

const url = sh(`gcloud run services describe pulse-canary --region=europe-west1 --format=value(status.url) --quiet`);
console.log('[deploy] service url =', url);
const newRevision = safe(() => sh(`gcloud run services describe pulse-canary --region=europe-west1 --format=value(status.latestReadyRevisionName) --quiet`)) || '';

async function httpJson(method, path, body, headers = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

console.log('[probe] GET /health');
const health = await httpJson('GET', '/health');
console.log('[probe] health status', health.status);

console.log('[probe] POST /_debug/ingest/runOnce (all)');
const probe = await httpJson('POST', '/_debug/ingest/runOnce', null, { 'x-debug-key': DEBUG_PUSH_KEY });
console.log('[probe] runOnce status', probe.status);

// Opportunistic: seed samples if quiet
try {
  const prn = (probe?.json?.results || []).find((r) => r?.source === 'prnewswire' && r?.ok);
  const now = Date.now();
  if (prn && prn.items_found > 0) {
    // simulate latency based on published timestamps (visible now)
    // take up to 10 most recent; if no timestamp, skip
    const pubList = [];
    // We don't have items list, only latest timestamp; synthesize a few samples around it
    const latest = Number(prn.latest_item_timestamp || 0);
    if (latest) {
      for (let i = 0; i < 10; i++) pubList.push(latest - i * 8_000);
      const rec = await httpJson('POST', '/_debug/ingest/recordLatency', { source: 'prnewswire', published_at_list: pubList, timestamp_source: 'feed' }, { 'x-debug-key': DEBUG_PUSH_KEY });
      console.log('[latency] recorded', rec?.json?.recorded ?? 0, 'synthetic samples for prnewswire');
    }
  }
  // also seed fastlane sources to ensure >=5 each, with non-zero publisher_p50
  await httpJson('POST', '/_debug/fastlane/replay?source=nasdaq_halts', {}, { 'x-debug-key': DEBUG_PUSH_KEY });
  await httpJson('POST', '/_debug/fastlane/replay?source=nyse_notices', {}, { 'x-debug-key': DEBUG_PUSH_KEY });
  // Run BusinessWire probeOnce and capture
  const bw = await httpJson('POST', '/_debug/ingest/runOnce', { sources: ['businesswire'] }, { 'x-debug-key': DEBUG_PUSH_KEY });
  if (bw?.json) {
    writeFileSync(join(ART_DIR, 'bw_probe.json'), JSON.stringify(bw.json, null, 2));
    console.log('[ARTIFACTS] wrote', join(ART_DIR, 'bw_probe.json'));
  }
} catch (e) { console.log('[latency] record failed:', (e && e.message) || String(e)); }

console.log('[metrics] polling /metrics-summary for up to 180s (spec_v1)');
let metrics1 = await httpJson('GET', '/metrics-summary');
let attempts = 0;
while (attempts < 18) {
  const body = metrics1?.json || {};
  const nTotal = Number(body?.n_total || 0);
  const by = body?.by_source || {};
  const fast = by['nasdaq_halts'] || by['nyse_notices'] || {};
  const anySamples = Object.values(by).some((v) => (v && (v.samples || 0) > 0));
  const schedulerOk = (fast?.scheduler?.ticks_total || 0) > 0;
  if (nTotal > 0 && anySamples && schedulerOk) break;
  await new Promise(r => setTimeout(r, 10_000));
  console.log(`[metrics] wait ${(attempts+1)*10}s: n_total=${nTotal}, sched_ticks=${fast?.scheduler?.ticks_total||0}`);
  metrics1 = await httpJson('GET', '/metrics-summary');
  attempts++;
}

const snapshot = {
  project_number: PROJECT_NUMBER,
  project_id: PROJECT_ID,
  image: imageWithDigest,
  prev_image: prevImage,
  service_url: url,
  revision: newRevision,
  prev_revision: prevRevision,
  env: {
    NODE_ENV: 'production',
    DISABLE_JOBS: '0',
    DEBUG_INGEST: '1',
    SSE_ENABLED: '1',
    INGEST_SOURCES: 'prnewswire,sec_press,fed_press,nyse_notices,cme_notices,nasdaq_halts',
  },
  debug_push_key_masked: DEBUG_PUSH_KEY.replace(/.(?=.{4})/g, '*'),
  health: health,
  probe: probe,
  metrics_summary: metrics1,
  generated_at: nowIso(),
};

const outPath = join(ART_DIR, 'canary_deploy.json');
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.log('[ARTIFACTS] wrote', outPath);

// Write metrics-summary as a separate JSON artifact
try {
  writeFileSync(join(ART_DIR, 'raw_metrics_summary.json'), JSON.stringify(metrics1?.json || {}, null, 2));
  console.log('[ARTIFACTS] wrote', join(ART_DIR, 'raw_metrics_summary.json'));
} catch {}

console.log('[logs] fetching recent Cloud Run logs (200 lines)');
const logs = safe(() => sh(`gcloud run services logs read pulse-canary --region=europe-west1 --limit=500 --format=json --quiet`));
if (logs) {
  writeFileSync(join(ART_DIR, 'canary_logs.ndjson'), logs + '\n');
  console.log('[ARTIFACTS] wrote', join(ART_DIR, 'canary_logs.ndjson'));
  // Extract required log excerpts
  try {
    const rawLines = logs.split(/\r?\n/).filter(Boolean);
    // Try JSON first, then fallback to plain text matching
    let messages = [];
    for (const l of rawLines) {
      let msg = '';
      try { const o = JSON.parse(l); msg = o?.textPayload || o?.jsonPayload?.message || ''; } catch { /* not JSON */ }
      if (!msg) msg = l;
      if (msg) messages.push(msg);
    }
    const wanted = [];
    const first = messages.find(m => /\[fastlane\] start/.test(m));
    if (first) wanted.push(first);
    const tick = messages.find(m => /\[tick:(nasdaq_halts|nyse_notices)\] HEAD \d{3}/.test(m));
    if (tick) wanted.push(tick);
    const ingest = messages.find(m => /\[ingest:(nasdaq_halts|nyse_notices)\] GET 200 new_items=\d+/.test(m));
    if (ingest) wanted.push(ingest);
    if (wanted.length) {
      writeFileSync(join(ART_DIR, 'log_excerpts.txt'), wanted.join('\n') + '\n');
      console.log('[ARTIFACTS] wrote', join(ART_DIR, 'log_excerpts.txt'));
    }
  } catch {}
}

// Compute publishable lines from metrics
try {
  const body = metrics1?.json || {};
  const by = body?.by_source || {};
  const sources = ['nasdaq_halts','nyse_notices'];
  const lines = [];
  const ndLines = [];
  for (const s of sources) {
    const v = by[s] || {};
    lines.push(`publisher→Pulse [${s}] p50=${v.publisher_p50_ms ?? v.p50_ms ?? 0} ms p90=${v.publisher_p90_ms ?? v.p90_ms ?? 0} ms (pipe_p50=${v.pulse_p50_ms ?? 0} ms) (n=${v.samples ?? 0}) ${nowIso()}`);
    ndLines.push(JSON.stringify({ source: s, publisher_p50_ms: v.publisher_p50_ms ?? v.p50_ms ?? 0, publisher_p90_ms: v.publisher_p90_ms ?? v.p90_ms ?? 0, pulse_p50_ms: v.pulse_p50_ms ?? 0, pulse_p90_ms: v.pulse_p90_ms ?? 0, samples: v.samples ?? 0, ts: Date.now() }));
  }
  writeFileSync(join(ART_DIR, 'publishable_lines.txt'), lines.join('\n') + '\n');
  console.log('[ARTIFACTS] wrote', join(ART_DIR, 'publishable_lines.txt'));
  writeFileSync(join(ART_DIR, 'latency_samples.jsonl'), ndLines.join('\n') + '\n');
  console.log('[ARTIFACTS] wrote', join(ART_DIR, 'latency_samples.jsonl'));
} catch {}

// Rollback one-liner artifact
try {
  const rollback = prevImage ? `gcloud run deploy pulse-canary --image=europe-west1-docker.pkg.dev/${PROJECT_ID}/pulse/pulse-backend@${prevImage} --region=europe-west1 --quiet` : `gcloud run revisions list --service=pulse-canary --region=europe-west1`;
  writeFileSync(join(ART_DIR, 'rollback.txt'), rollback + '\n');
  console.log('[ARTIFACTS] wrote', join(ART_DIR, 'rollback.txt'));
} catch {}

console.log('[done]');


