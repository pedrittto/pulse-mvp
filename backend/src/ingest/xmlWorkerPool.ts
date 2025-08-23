import { Worker } from 'node:worker_threads';
import path from 'node:path';

type Task = { xml: string; resolve: (v: any) => void; reject: (e: any) => void; timer?: NodeJS.Timeout };

export class XmlWorkerPool {
  private size: number;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private started = false;

  constructor(size = parseInt(process.env.XML_WORKERS || '2', 10)) {
    this.size = Math.max(1, size);
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      this.spawnOne();
    }
  }

  private makeWorker(): Worker {
    // Compiled worker path (dist)
    const file = path.join(__dirname, 'xmlWorker.js');
    const w = new Worker(file);
    w.on('message', (msg: any) => {
      (w as any)._busyResolve?.(msg);
      (w as any)._busyResolve = null;
      this.idle.push(w);
      this.pump();
    });
    w.on('error', () => {
      try { w.terminate().catch(() => {}); } catch {}
      // Replace crashed worker
      const nw = this.makeWorker();
      this.workers = this.workers.filter(x => x !== w);
      this.workers.push(nw);
      this.idle.push(nw);
      this.pump();
    });
    return w;
  }

  private spawnOne() {
    const w = this.makeWorker();
    this.workers.push(w);
    this.idle.push(w);
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const task = this.queue.shift()!;
      (w as any)._busyResolve = (msg: any) => {
        clearTimeout(task.timer!);
        if (msg?.ok) task.resolve(msg.result);
        else task.reject(new Error(msg?.error || 'xml worker parse failed'));
      };
      w.postMessage(task.xml);
    }
  }

  parse(xml: string, fallback: () => Promise<any>, timeoutMs = 1500): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.started || this.workers.length === 0) {
        fallback().then(resolve).catch(reject);
        return;
      }
      const t: Task = { xml, resolve, reject };
      t.timer = setTimeout(() => {
        const idx = this.queue.indexOf(t);
        if (idx >= 0) this.queue.splice(idx, 1);
        fallback().then(resolve).catch(reject);
      }, timeoutMs);
      this.queue.push(t);
      this.pump();
    });
  }
}

let _pool: XmlWorkerPool | null = null;
export function getXmlPool(): XmlWorkerPool {
  if (!_pool) { _pool = new XmlWorkerPool(); _pool.start(); }
  return _pool;
}


