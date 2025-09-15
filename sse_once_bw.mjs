const CANARY = process.env.CANARY || process.argv[2];
if (!CANARY) { console.error("usage: node sse_once_bw.mjs <canary_url>"); process.exit(2); }

const controller = new AbortController();
const timeoutMs = 180000; // 3 min

setTimeout(() => { console.error("timeout: no businesswire event"); controller.abort(); process.exit(1); }, timeoutMs);

const res = await fetch(`${CANARY}/sse/breaking`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
    const lines = chunk.split("\n");
    let data = "";
    for (const line of lines) if (line.startsWith("data:")) data += line.slice(5).trim();
    if (!data) continue;
    try {
      const ev = JSON.parse(data);
      if (ev?.source === "businesswire") {
        console.log(JSON.stringify({
          ok: true,
          id: ev.id,
          source: ev.source,
          title: ev.title,
          url: ev.url,
          publisher_ts: ev.publisher_ts,
          first_seen_at: ev.first_seen_at,
          fetched_at: ev.fetched_at,
          visible_at: ev.visible_at,
          publisher_latency_ms: ev.publisher_latency_ms,
          pulse_latency_ms: ev.pulse_latency_ms,
          timestamp_source: ev.timestamp_source
        }, null, 2));
        controller.abort();
        process.exit(0);
      }
    } catch {}
  }
}
