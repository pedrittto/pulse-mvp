// Smoke: one source enabled => one cycle runs; backoff >=30s; no payload logs
import { spawn } from 'node:child_process';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const env = {
    ...process.env,
    JOBS_ENABLED: '1',
    INGEST_SOURCES: process.env.INGEST_SOURCES || 'businesswire',
    LOG_LEVEL: 'error',
    LOG_SAMPLING: '0',
    WARN_COOLDOWN_MS: '60000',
  };

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('../..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', (b) => { buf += b.toString(); });
  child.stderr.on('data', (b) => { buf += b.toString(); });

  await delay(7000);
  const before = await fetch('http://localhost:4000/debug/ingest').then(r => r.json()).catch(()=>({}));
  if (!before.started) throw new Error('ingest not started');
  const adapters = before.adapters || [];
  const bw = adapters.find(a => a.name === 'businesswire') || adapters[0];
  if (!bw) throw new Error('adapter missing');
  if ((bw.inFlight||0) > 1) throw new Error('more than 1 inflight');

  // ensure no payload/HTML appeared in logs
  if (/</.test(buf) && /http|html|rss/i.test(buf)) throw new Error('payload logged');

  // ensure backoff >=30s on errors via governor (peek nextInMs)
  if (typeof bw.nextInMs === 'number' && bw.scheduler?.consecutive_failures > 0) {
    if (bw.nextInMs < 30_000) throw new Error('backoff too small');
  }

  console.log('[smoke_ingest_one] PASS');
  child.kill('SIGTERM');
}

main().catch((e) => { console.error('[smoke_ingest_one] FAIL', e?.message || e); process.exit(1); });


