import * as fs from 'fs';
import * as path from 'path';

type FetchedRecord = { source: string | null; id: string; fetched_at_ms: number; fetched_at_iso: string; fetched_at_mono_ms?: number | null; seen_ms: number };

// Lightweight, flag-guarded probes (default OFF). Non-blocking, batched file IO.
class Probes {
  private fetchedById: Map<string, FetchedRecord> = new Map();
  private writeQueue: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private maxBytes: number = Math.max(10_000_000, parseInt(process.env.FASTLANE_PROBE_MAX_BYTES || '50000000', 10)); // ~50 MB default
  private filePath: string;
  private ttlMs: number = Math.max(60_000, parseInt(process.env.FASTLANE_PROBE_TTL_MS || '21600000', 10)); // 6h default
  private firstSeenById: Map<string, { wall_ms: number; mono_ms: number | null; seen: number; source: string | null }> = new Map();
  private recentDeltas: Array<{ ts: number; d: number } > = [];

  private httpErrorsByHost: Map<string, number[]> = new Map(); // timestamps (ms) for 429/5xx/403 treated as error

  // Join diagnostics
  private joinHit: number = 0;
  private joinMissNoIngest: number = 0;

  constructor() {
    let diagDir = path.join(process.cwd(), 'backend', 'diagnostics');
    try { if (!fs.existsSync(diagDir)) { diagDir = path.join(process.cwd(), 'diagnostics'); } } catch {}
    try { fs.mkdirSync(diagDir, { recursive: true }); } catch {}
    this.filePath = path.join(diagDir, 'latency_samples.jsonl');
    this.bootstrapFromFiles();
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
      const ms = Date.parse(fetchedAtIso);
      if (!Number.isFinite(ms)) return;
      const rec: FetchedRecord = { id, source: source || null, fetched_at_ms: ms, fetched_at_iso: new Date(ms).toISOString(), fetched_at_mono_ms: null, seen_ms: Date.now() };
      const prev = this.fetchedById.get(id);
      if (!prev || ms < prev.fetched_at_ms) this.fetchedById.set(id, rec);
      // Emit canonical JSONL sink for fetched milestone (visible/delta null)
      const payload = {
        id,
        source: rec.source,
        fetched_at_ms: rec.fetched_at_ms,
        fetched_at_iso: rec.fetched_at_iso,
        visible_at_ms: null as any,
        delta_ms: null as any,
        delta_mono_ms: null as any
      };
      this.enqueueWrite(JSON.stringify(payload));
      this.pruneStale();
    } catch {}
  }

  public recordEmitted(id: string, source: string | null, emittedAtIso: string): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!id) return;
    try {
      const f = this.fetchedById.get(id);
      const fetchedMs = f?.fetched_at_ms ?? null;
      const payload: any = {
        source: source || f?.source || null,
        id,
        fetched_at_ms: fetchedMs,
        visible_at_ms: Date.parse(emittedAtIso),
        delta_ms: (fetchedMs != null ? Math.max(0, Date.parse(emittedAtIso) - fetchedMs) : null),
        delta_mono_ms: null
      };
      this.enqueueWrite(JSON.stringify(payload));
      if (payload.delta_ms != null) this.joinHit++; else this.joinMissNoIngest++;
      // Best-effort: clean map to bound memory
      if (this.fetchedById.size > 50000) {
        this.fetchedById.clear();
      } else {
        this.fetchedById.delete(id);
      }
      this.pruneStale();
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
      if (this.writeQueue.length >= 100) {
        // opportunistic early flush when queue is large
        const t = this.flushTimer; this.flushTimer = null; if (t) { try { clearTimeout(t); } catch {} }
        void this.flush();
      }
    } catch {}
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.writeQueue.length === 0) return;
    const lines = this.writeQueue.splice(0, this.writeQueue.length);
    try {
      // Rotate if file exceeds cap (keep simple numeric suffixes)
      let size = 0;
      try { size = fs.statSync(this.filePath).size; } catch { size = 0; }
      if (size > this.maxBytes) {
        try {
          const base = this.filePath;
          const r1 = base + '.1';
          const r2 = base + '.2';
          // simple rotate: .1 -> .2, current -> .1
          if (fs.existsSync(r2)) { try { fs.rmSync(r2); } catch {} }
          if (fs.existsSync(r1)) { try { fs.renameSync(r1, r2); } catch {} }
          fs.renameSync(base, r1);
        } catch {}
      }
      // Append asynchronously
      await fs.promises.appendFile(this.filePath, lines.map(l => l + '\n').join(''), { encoding: 'utf8' });
    } catch {}
  }

  private pruneStale(): void {
    try {
      const now = Date.now();
      if (this.fetchedById.size === 0) return;
      // Light pruning: iterate a subset
      let scanned = 0;
      for (const [key, rec] of this.fetchedById.entries()) {
        if (++scanned > 2000) break; // bound work per call
        if (now - (rec.seen_ms || now) > this.ttlMs) {
          this.fetchedById.delete(key);
        }
      }
    } catch {}
  }

  public getJoinCounters(): { join_hit: number; join_miss_ingest: number; cache_size: number }{
    return { join_hit: this.joinHit, join_miss_ingest: this.joinMissNoIngest, cache_size: this.fetchedById.size };
  }

  // --- Single-point publisher→pulse probe (first_seen_ms captured at accept; delta at SSE emit) ---
  public recordFirstSeenMs(id: string, source: string|null, firstSeenMs: number): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!id || !Number.isFinite(firstSeenMs)) return;
    try {
      this.firstSeenById.set(id, { wall_ms: Math.max(0, Math.floor(firstSeenMs)), mono_ms: null, seen: Date.now(), source: source || null });
      this.pruneStaleFirstSeen();
    } catch {}
  }

  public recordVisibleMs(id: string, source: string|null, visibleAtMs: number): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!id || !Number.isFinite(visibleAtMs)) return;
    try {
      const fsRec = this.firstSeenById.get(id) || null;
      const firstSeenWall = fsRec?.wall_ms ?? null;
      const firstSeenMono = fsRec?.mono_ms ?? null;
      const delta = (firstSeenWall!=null) ? Math.max(0, Math.floor(visibleAtMs) - firstSeenWall) : null;
      const payload = {
        id,
        source: (source || fsRec?.source || null),
        fetched_at_ms: firstSeenWall,
        visible_at_ms: Math.floor(visibleAtMs),
        delta_ms: delta,
        delta_mono_ms: null as number | null
      } as any;
      this.enqueueWrite(JSON.stringify(payload));
      if (delta!=null) {
        this.recentDeltas.push({ ts: Date.now(), d: delta });
        if (this.recentDeltas.length > 5000) this.recentDeltas.splice(0, this.recentDeltas.length - 5000);
        this.pruneRecentDeltas();
        this.firstSeenById.delete(id);
      }
    } catch {}
  }

  private pruneStaleFirstSeen(): void {
    try {
      const now = Date.now();
      let scanned = 0;
      for (const [k, v] of this.firstSeenById.entries()) {
        if (++scanned > 2000) break;
        if (now - (v.seen || now) > this.ttlMs) this.firstSeenById.delete(k);
      }
    } catch {}
  }

  private pruneRecentDeltas(): void {
    try {
      const cutoff = Date.now() - 15*60*1000;
      if (this.recentDeltas.length === 0) return;
      let idx = 0; // find first idx >= cutoff assuming roughly chronological appends
      while (idx < this.recentDeltas.length && this.recentDeltas[idx].ts < cutoff) idx++;
      if (idx > 0) this.recentDeltas.splice(0, idx);
    } catch {}
  }

  public getProbeSummary(): { delta_count: number; delta_p50_ms: number|null; delta_p90_ms: number|null }{
    this.pruneRecentDeltas();
    const arr = this.recentDeltas.map(x=>x.d).slice().sort((a,b)=>a-b);
    const n = arr.length;
    const pick = (q:number)=> (n? arr[Math.floor((n-1)*q)] : null);
    return { delta_count: n, delta_p50_ms: pick(0.5), delta_p90_ms: pick(0.9) };
  }

  // --- New: canonical fetched-at API with monotonic capture ---
  public recordFetchedAt(args: { id: string; source: string | null; fetchedAtMs: number; fetchedAtMonoMs?: number | null }): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!args.id || !Number.isFinite(args.fetchedAtMs)) return;
    try {
      const iso = new Date(Math.floor(args.fetchedAtMs)).toISOString();
      const rec: FetchedRecord = { id: args.id, source: args.source || null, fetched_at_ms: Math.floor(args.fetchedAtMs), fetched_at_iso: iso, fetched_at_mono_ms: (args.fetchedAtMonoMs != null && Number.isFinite(args.fetchedAtMonoMs)) ? Math.floor(args.fetchedAtMonoMs!) : null, seen_ms: Date.now() };
      const prev = this.fetchedById.get(args.id);
      if (!prev || rec.fetched_at_ms < prev.fetched_at_ms) this.fetchedById.set(args.id, rec);
      this.enqueueWrite(JSON.stringify({ id: rec.id, source: rec.source, fetched_at_ms: rec.fetched_at_ms, fetched_at_iso: rec.fetched_at_iso, visible_at_ms: null, delta_ms: null, delta_mono_ms: null }));
      // also seed firstSeen map with both wall and mono (for accept→SSE path)
      this.firstSeenById.set(args.id, { wall_ms: rec.fetched_at_ms, mono_ms: (rec.fetched_at_mono_ms ?? null), seen: Date.now(), source: rec.source });
      this.pruneStale(); this.pruneStaleFirstSeen();
    } catch {}
  }

  public recordVisibleAt(args: { id: string; source: string | null; visibleAtMs: number; visibleAtMonoMs?: number | null }): void {
    if (!this.isLatencyProbeEnabled()) return;
    if (!args.id || !Number.isFinite(args.visibleAtMs)) return;
    try {
      const f = this.fetchedById.get(args.id) || null;
      const fsRec = this.firstSeenById.get(args.id) || null;
      const fetchedWall = f?.fetched_at_ms ?? fsRec?.wall_ms ?? null;
      const fetchedMono = (f?.fetched_at_mono_ms ?? fsRec?.mono_ms) ?? null;
      const deltaWall = (fetchedWall != null) ? Math.max(0, Math.floor(args.visibleAtMs) - fetchedWall) : null;
      const deltaMono = (fetchedMono != null && args.visibleAtMonoMs != null && Number.isFinite(args.visibleAtMonoMs)) ? Math.max(0, Math.floor(args.visibleAtMonoMs!) - fetchedMono) : null;
      const payload: any = {
        id: args.id,
        source: (args.source || f?.source || fsRec?.source || null),
        fetched_at_ms: fetchedWall,
        visible_at_ms: Math.floor(args.visibleAtMs),
        delta_ms: deltaWall,
        delta_mono_ms: deltaMono
      };
      this.enqueueWrite(JSON.stringify(payload));
      if (deltaWall != null) this.recentDeltas.push({ ts: Date.now(), d: deltaWall });
      if (this.recentDeltas.length > 5000) this.recentDeltas.splice(0, this.recentDeltas.length - 5000);
      this.pruneRecentDeltas();
      // cleanup per-id caches once visible observed
      this.fetchedById.delete(args.id);
      this.firstSeenById.delete(args.id);
    } catch {}
  }

  // --- Resume cache from existing JSONL (tail ~5MB across current and rotated siblings) ---
  private bootstrapFromFiles(): void {
    try {
      const files: string[] = [this.filePath, this.filePath + '.1', this.filePath + '.2'].filter(f => fs.existsSync(f));
      for (const f of files) {
        let data: Buffer;
        try {
          const st = fs.statSync(f);
          const start = Math.max(0, st.size - 5_000_000);
          const fd = fs.openSync(f, 'r');
          try {
            data = Buffer.alloc(st.size - start);
            fs.readSync(fd, data, 0, data.length, start);
          } finally { try { fs.closeSync(fd); } catch {}
          }
        } catch { continue; }
        const text = data.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          let j: any;
          try { j = JSON.parse(line); } catch { continue; }
          const id = j?.id; if (!id) continue;
          const src = j?.source ?? null;
          const fat = (typeof j?.fetched_at_ms === 'number') ? j.fetched_at_ms : (typeof j?.first_seen_ms === 'number' ? j.first_seen_ms : null);
          const fam = (typeof j?.fetched_at_mono_ms === 'number') ? j.fetched_at_mono_ms : (typeof j?.first_seen_ms_mono === 'number' ? j.first_seen_ms_mono : null);
          if (fat != null && Number.isFinite(fat)) {
            const iso = new Date(fat).toISOString();
            const prev = this.fetchedById.get(id);
            if (!prev || fat < prev.fetched_at_ms) {
              this.fetchedById.set(id, { id, source: src, fetched_at_ms: fat, fetched_at_iso: iso, fetched_at_mono_ms: (fam ?? null), seen_ms: Date.now() });
            }
            // seed firstSeen map with earliest
            const fsPrev = this.firstSeenById.get(id);
            if (!fsPrev || fat < fsPrev.wall_ms) this.firstSeenById.set(id, { wall_ms: fat, mono_ms: (fam ?? null), seen: Date.now(), source: src });
          }
        }
      }
    } catch {}
  }
}

export const probes = new Probes();

// Optional ergonomic wrappers (epoch ms)
export function recordIngest(args: { id: string; source: string|null; fetchedAt: number }): void {
  try { probes.recordFetched(args.id, args.source, new Date(args.fetchedAt).toISOString()); } catch {}
}
export function recordSSE(args: { id: string; source: string|null; visibleAt: number }): void {
  try { probes.recordEmitted(args.id, args.source, new Date(args.visibleAt).toISOString()); } catch {}
}

export function recordFirstSeen(args: { id: string; source: string|null; firstSeenMs: number }): void {
  try { probes.recordFirstSeenMs(args.id, args.source, args.firstSeenMs); } catch {}
}
export function recordVisible(args: { id: string; source: string|null; visibleAtMs: number }): void {
  try { probes.recordVisibleMs(args.id, args.source, args.visibleAtMs); } catch {}
}

// New ergonomic wrappers with monotonic support (epoch ms)
export function recordFetchedAt(args: { id: string; source: string | null; fetchedAtMs: number; fetchedAtMonoMs?: number | null }): void {
  try { probes.recordFetchedAt(args); } catch {}
}
export function recordVisibleAt(args: { id: string; source: string | null; visibleAtMs: number; visibleAtMonoMs?: number | null }): void {
  try { probes.recordVisibleAt(args); } catch {}
}


