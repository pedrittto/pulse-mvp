#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const baseUrl = process.argv[2];
const outPath = process.argv[3] || 'ARTIFACTS/bw_sse_sample.json';
const timeoutMs = Number(process.argv[4] || 20000);
if (!baseUrl) {
  console.error('[sse-first-bw] usage: node sse_first_bw.mjs <baseUrl> <outPath> [timeoutMs]');
  process.exit(2);
}

const ctrl = new AbortController();
const to = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);

try {
  const res = await fetch(`${baseUrl}/sse/breaking`, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
  if (!res.ok || !res.body) {
    console.error('[sse-first-bw] bad status', res.status);
    process.exit(3);
  }
  const reader = res.body.getReader();
  let buf = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split('\n');
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s?/, '')).join('\n');
      if (!data) continue;
      try {
        const evt = JSON.parse(data);
        if (evt && evt.source === 'businesswire') {
          writeFileSync(outPath, JSON.stringify(evt, null, 2));
          clearTimeout(to);
          try { ctrl.abort(); } catch {}
          console.log('[sse-first-bw] captured and wrote', outPath);
          process.exit(0);
        }
      } catch {}
    }
  }
  console.error('[sse-first-bw] stream ended without BW event');
  process.exit(4);
} catch (e) {
  console.error('[sse-first-bw] error', e?.message || String(e));
  process.exit(5);
}


