// Smoke: JOBS_ENABLED=1 but no INGEST_SOURCES => ingest must not start
import { spawn } from 'node:child_process';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const env = { ...process.env, JOBS_ENABLED: '1' };
  delete env.INGEST_SOURCES;

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('../..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', (b) => { buf += b.toString(); });
  child.stderr.on('data', (b) => { buf += b.toString(); });

  await delay(6000);
  const diag = await fetch('http://localhost:4000/debug/ingest').then(r => r.json()).catch(()=>({}));
  if (diag.started) throw new Error('ingest started unexpectedly');
  if ((diag.adapters||[]).some(a => (a.timers||0) > 0)) throw new Error('found active timers');
  console.log('[smoke_gate] PASS');
  child.kill('SIGTERM');
}

main().catch((e) => { console.error('[smoke_gate] FAIL', e?.message || e); process.exit(1); });


