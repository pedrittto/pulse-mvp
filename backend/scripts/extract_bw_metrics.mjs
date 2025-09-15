#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const inPath = process.argv[2] || 'ARTIFACTS/bw_metrics_after.json';
const outPath = process.argv[3] || 'ARTIFACTS/bw_metrics_compact.json';

function extract(m) {
  const by = (m && m.by_source) || {};
  const bw = by.businesswire || {};
  const publisher_p50_ms = (bw.publisher_p50_ms ?? bw.p50_ms ?? null);
  const publisher_p90_ms = (bw.publisher_p90_ms ?? bw.p90_ms ?? null);
  const pulse_p50_ms = (bw.pulse_p50_ms ?? null);
  const pulse_p90_ms = (bw.pulse_p90_ms ?? null);
  return { publisher_p50_ms, publisher_p90_ms, pulse_p50_ms, pulse_p90_ms };
}

const obj = JSON.parse(readFileSync(inPath, 'utf8'));
const out = extract(obj);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('[extract] wrote', outPath);


