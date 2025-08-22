import * as fs from 'fs';
import * as path from 'path';

type FetchedRecord = { source: string | null; id: string; fetched_at: string };

// Lightweight, flag-guarded probes (default OFF). Non-blocking, batched file IO.
class Probes {
  private fetchedById: Map<string, FetchedRecord> = new Map();
  private writeQueue: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private maxBytes: number = Math.max(1_000_000, parseInt(process.env.FASTLANE_PROBE_MAX_BYTES || '10000000', 10)); // 10 MB default
  private filePath: string;

  private httpErrorsByHost: Map<string, number[]> = new Map(); // timestamps (ms) for 429/5xx/403 treated as error

  constructor() {
    const diagDir = path.join(process.cwd(), 'diagnostics');
    try { fs.mkdirSync(diagDir, { recursive: true }); } catch {}
    this.filePath = path.join(diagDir, 'latency_samples.jsonl');
  }

  private isLatencyProbeEnabled(): boolean {
    return String(process.env.FASTLANE_PROBE || '0') === '1';
  }

  private isHttpRateProbeEnabled(): boolean {
    return String(process.env.HTTP_RATE_PROBE || '0') === '1';
  }

  public recordFetched(id: string, source: string | null, fetchedAtIso: string): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!id) return;
    try {
      const rec: FetchedRecord = { id, source: source || null, fetched_at: fetchedAtIso };
      // Only keep first seen per id
      if (!this.fetchedById.has(id)) this.fetchedById.set(id, rec);
    } catch {}
  }

  public recordEmitted(id: string, source: string | null, emittedAtIso: string): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!id) return;
    try {
      const f = this.fetchedById.get(id);
      const fetchedIso = f?.fetched_at || null;
      const payload: any = {
        source: source || f?.source || null,
        id,
        fetched_at: fetchedIso,
        visible_at: emittedAtIso,
        delta_ms: (fetchedIso ? Math.max(0, Date.parse(emittedAtIso) - Date.parse(fetchedIso)) : null)
      };
      this.enqueueWrite(JSON.stringify(payload));
      // Best-effort: clean map to bound memory
      if (this.fetchedById.size > 50000) {
        this.fetchedById.clear();
      } else {
        this.fetchedById.delete(id);
      }
    } catch {}
  }

  public recordHttpStatus(host: string, status: number): void {
    if (!this.isHttpRateProbeEnabled()) return;
    // Track only throttling/server errors (429/5xx) and 403 (treated as throttling)
    if (![429, 403].includes(status) && (status < 500 || status > 599)) return;
    try {
      const now = Date.now();
      const key = (host || 'unknown').toLowerCase();
      const arr = this.httpErrorsByHost.get(key) || [];
      arr.push(now);
      // prune older than 15m
      const cutoff = now - 15 * 60 * 1000;
      const pruned = arr.filter(ts => ts >= cutoff);
      this.httpErrorsByHost.set(key, pruned);
    } catch {}
  }

  public getHttpRates(): Record<string, { r1m: number; r5m: number; r15m: number; samples: number }>{
    const out: Record<string, { r1m: number; r5m: number; r15m: number; samples: number }> = {};
    try {
      const now = Date.now();
      for (const [host, arr] of this.httpErrorsByHost.entries()) {
        const c1 = arr.filter(ts => ts >= now - 60 * 1000).length;
        const c5 = arr.filter(ts => ts >= now - 5 * 60 * 1000).length;
        const c15 = arr.length; // already pruned to 15m
        out[host] = { r1m: c1, r5m: c5, r15m: c15, samples: arr.length };
      }
    } catch {}
    return out;
  }

  private enqueueWrite(line: string): void {
    try {
      this.writeQueue.push(line);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush().catch(()=>{}), 500);
        (this.flushTimer as any).unref?.();
      }
    } catch {}
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.writeQueue.length === 0) return;
    const lines = this.writeQueue.splice(0, this.writeQueue.length);
    try {
      // Rotate if file exceeds cap
      let size = 0;
      try { size = fs.statSync(this.filePath).size; } catch { size = 0; }
      if (size > this.maxBytes) {
        try {
          const backup = this.filePath.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
          fs.renameSync(this.filePath, backup);
        } catch {}
      }
      // Append asynchronously
      await fs.promises.appendFile(this.filePath, lines.map(l => l + '\n').join(''), { encoding: 'utf8' });
    } catch {}
  }
}

export const probes = new Probes();


