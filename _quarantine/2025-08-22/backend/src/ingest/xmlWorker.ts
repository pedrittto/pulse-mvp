import { parentPort } from 'node:worker_threads';
import { parseStringPromise } from 'xml2js';

if (!parentPort) process.exit(1);

parentPort.on('message', async (xml: string) => {
  try {
    // Preserve existing behavior: use default xml2js options
    const result = await parseStringPromise(xml);
    parentPort!.postMessage({ ok: true, result });
  } catch (err: any) {
    parentPort!.postMessage({ ok: false, error: String(err?.message || err) });
  }
});


