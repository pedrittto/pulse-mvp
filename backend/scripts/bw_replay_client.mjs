#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function loadJson(path) { return JSON.parse(readFileSync(path,'utf8')); }
async function httpJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers||{}) } });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

const canary = loadJson('ARTIFACTS/canary_deploy.json');
const env = loadJson('ARTIFACTS/env.json');
const url = canary.service_url;
const key = env.DEBUG_PUSH_KEY || 'canary-debug';

const replayUrl = `${url}/_debug/ingest/replay?source=businesswire&n=5`;
const metricsUrl = `${url}/metrics-summary`;
const itemsUrl = `${url}/api/v0/items?limit=5&sources=businesswire`;

const replay = await httpJson(replayUrl, { method: 'POST', headers: { 'x-debug-key': key } });
const metrics = await httpJson(metricsUrl);
const items = await httpJson(itemsUrl);

writeFileSync('ARTIFACTS/bw_replay_result.json', JSON.stringify(replay, null, 2));
writeFileSync('ARTIFACTS/bw_metrics.json', JSON.stringify(metrics, null, 2));
writeFileSync('ARTIFACTS/bw_items.json', JSON.stringify(items, null, 2));

console.log('[ARTIFACTS] wrote ARTIFACTS/bw_replay_result.json');
console.log('[ARTIFACTS] wrote ARTIFACTS/bw_metrics.json');
console.log('[ARTIFACTS] wrote ARTIFACTS/bw_items.json');
