"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [status, setStatus] = useState<"pending"|"ok"|"fail">("pending");

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/health`)
      .then(r => r.json())
      .then(() => setStatus("ok"))
      .catch(() => setStatus("fail"));
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1>Pulse MVP (blue)</h1>
      <p>Backend URL: <code>{process.env.NEXT_PUBLIC_API_BASE_URL}</code></p>
      <p>Backend health: <b>{status}</b></p>
    </main>
  );
}
