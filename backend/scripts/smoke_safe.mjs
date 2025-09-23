// Smoke: with no ENV, app must not start ingest, make outbound HTTP, or spam WARNs
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const env = { ...process.env, DEBUG_FETCH_STATS: '1' };
  delete env.JOBS_ENABLED;
  delete env.INGEST_SOURCES;

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('../..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { err += b.toString(); });

  // wait up to 8s, then curl health and metrics-summary
  await delay(8000);

  // quick health check
  const ok = await fetch('http://localhost:4000/health').then(r => r.text()).catch(()=>null);
  if (ok !== 'ok') throw new Error('health failed');

  // ensure debug says disabled
  const schedStr = out + err;
  if (!/\[sched\] disabled/.test(schedStr)) throw new Error('scheduler should be disabled');

  // ensure no intervals started by checking absence of ingest timers in /debug/ingest
  const diag = await fetch('http://localhost:4000/debug/ingest').then(r => r.json()).catch(()=>({}));
  if (diag.started) throw new Error('ingest started unexpectedly');
  if ((diag.adapters||[]).some(a => (a.timers||0) > 0)) throw new Error('found active timers');

  // zero outbound HTTP
  const fetchStats = await fetch('http://localhost:4000/_debug/fetch-stats').then(r => r.json()).catch(()=>({ count: 0 }));
  if (fetchStats.count !== 0) throw new Error('outbound HTTP observed');

  // no WARN spam at boot (allow at most one)
  const warns = (schedStr.match(/\bwarn\b|\[boot\]|\[ingest:/gi) || []).length;
  if (warns > 1) throw new Error('warn spam at boot');

  console.log('[smoke_safe] PASS');
  child.kill('SIGTERM');
}

main().catch((e) => { console.error('[smoke_safe] FAIL', e?.message || e); process.exit(1); });


