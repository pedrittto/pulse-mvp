export function startMemWatch(
  { warnMb = 300, hardMb = 900, intervalMs = 15000 }:
  { warnMb?: number; hardMb?: number; intervalMs?: number } = {}
) {
  const tick = () => {
    const mu = process.memoryUsage();
    const heap = mu.heapUsed / 1048576;
    if (heap > warnMb) console.warn(`[mem] heap=${heap.toFixed(0)}MB`);
    if (heap > hardMb) {
      console.error(`[mem]>${hardMb}MB → GC`);
      (global as any).gc?.();
      const after = process.memoryUsage().heapUsed / 1048576;
      console.error(`[mem] afterGC=${after.toFixed(0)}MB`);
      if (after > hardMb) {
        console.error('[mem] still high → exit(1)'); process.exit(1);
      }
    }
  };
  const t = setInterval(tick, intervalMs);
  (t as any).unref?.();
}


