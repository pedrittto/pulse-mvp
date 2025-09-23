// Simulate adapter failure and show reduced WARN rate
// Usage: node backend/scripts/smoke_fail.mjs http://localhost:4000
const base = process.argv[2] || 'http://localhost:4000';

async function main() {
  const url = new URL('/_debug/ingest/runOnce?source=prnewswire', base).toString();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'x-debug-key': process.env.DEBUG_PUSH_KEY || 'dev' } });
    const text = await res.text();
    console.log('[smoke-fail] status', res.status, 'body', text.slice(0, 200));
  } catch (e) {
    console.error('[smoke-fail] error', e?.message || String(e));
  }
}

main();


