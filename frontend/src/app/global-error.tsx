"use client";
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void; }) {
  return (
    <html>
      <body style={{ padding: 24 }}>
        <h1>App Error</h1>
        <pre style={{ whiteSpace: "pre-wrap" }}>{String(error?.message ?? "Unknown error")}</pre>
        <button onClick={reset} style={{ marginTop: 12 }}>Reload</button>
      </body>
    </html>
  );
}


