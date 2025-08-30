"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [health, setHealth] = useState<"pending"|"ok"|"fail">("pending");
  const [sse, setSse] = useState<"disconnected"|"connecting"|"connected">("disconnected");
  const [last, setLast] = useState<string>("-");

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/health`)
      .then(r => r.json()).then(() => setHealth("ok")).catch(() => setHealth("fail"));

    const url = `${process.env.NEXT_PUBLIC_API_BASE_URL}/sse/breaking`;
    setSse("connecting");
    const es = new EventSource(url, { withCredentials: true });

    es.onopen = () => setSse("connected");
    es.addEventListener("hello", () => setLast(`hello @ ${new Date().toLocaleTimeString()}`));
    es.addEventListener("ping",  () => setLast(`ping @ ${new Date().toLocaleTimeString()}`));
    es.onerror = () => setSse("disconnected");

    return () => es.close();
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1>Pulse MVP (blue)</h1>
      <p>Backend URL: <code>{process.env.NEXT_PUBLIC_API_BASE_URL}</code></p>
      <p>Backend health: <b>{health}</b></p>
      <p>SSE status: <b>{sse}</b> | Last event: {last}</p>
    </main>
  );
}
