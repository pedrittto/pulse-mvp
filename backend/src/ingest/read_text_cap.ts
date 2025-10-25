export async function readTextWithCap(res: Response, capBytes: number): Promise<string> {
  const clHeader = res.headers?.get?.("content-length");
  const contentLength = clHeader ? Number(clHeader) : NaN;
  const body = (res as any).body;

  // If Content-Length is present and over cap, abort immediately
  if (Number.isFinite(contentLength) && contentLength > capBytes) {
    try { await (body?.cancel?.()); } catch {}
    throw new Error("cap_exceeded");
  }

  // Stream via reader when available
  const reader = body?.getReader?.();
  if (reader && typeof reader.read === 'function') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk: Uint8Array = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > capBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error("cap_exceeded");
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks, total);
    return new TextDecoder("utf-8").decode(buf);
  }

  // Fallback 1: async iterator (Node/web streams without getReader)
  const asyncIt = (body as any)?.[Symbol.asyncIterator];
  if (typeof asyncIt === 'function') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      for await (const chunk of (body as any)) {
        const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        total += buf.byteLength;
        if (total > capBytes) { try { await (body as any)?.cancel?.(); } catch {} throw new Error("cap_exceeded"); }
        chunks.push(buf);
      }
    } catch (e) {
      try { await (body as any)?.cancel?.(); } catch {}
      throw e;
    }
    const buf = Buffer.concat(chunks, total);
    return new TextDecoder("utf-8").decode(buf);
  }

  // Fallback 2: arrayBuffer() — last resort (may spike memory); still enforce cap after
  const ab: ArrayBuffer = await (res as any).arrayBuffer?.();
  const total = ab?.byteLength ?? 0;
  if (total > capBytes) {
    throw new Error("cap_exceeded");
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(ab));
}


