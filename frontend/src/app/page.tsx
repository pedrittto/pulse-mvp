"use client";
import { useEffect, useState, useMemo } from "react";
import NewsCard from "./components/NewsCard";
import MetricsBar from "./components/MetricsBar";

declare global {
  interface Window { __PULSE_SSE__?: EventSource }
}

// Runtime API base override helpers
function readApiOverrideFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const val = url.searchParams.get("api");
    if (!val) return null;
    if (!/^https?:\/\//i.test(val)) return null;
    try { localStorage.setItem("apiBaseOverride", val); } catch {}
    // clean URL (no reload)
    try {
      url.searchParams.delete("api");
      window.history.replaceState({}, document.title, url.toString());
    } catch {}
    return val;
  } catch { return null; }
}

function getApiBase(): string | null {
  const fromUrl = readApiOverrideFromUrl();
  if (fromUrl) return fromUrl;
  if (typeof window !== "undefined") {
    try {
      const v = localStorage.getItem("apiBaseOverride");
      if (v && /^https?:\/\//i.test(v)) return v;
    } catch {}
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? null;
}

// Event payload expected from the backend for breaking items
type BreakingItem = {
  id: string;
  source: string;
  title: string;
  url: string;
  published_at_ms?: number;
  visible_at_ms: number;
};

type ConnModel = { state: "connecting" | "connected" | "reconnecting"; lastEventSec: number };

export default function Home() {
  const API_BASE = getApiBase();
  // Connection and data state
  const [conn, setConn] = useState<ConnModel>({ state: "connecting", lastEventSec: 0 });
  const [items, setItems] = useState<BreakingItem[]>([]);

  // UI state
  const [query, setQuery] = useState<string>("");
  const [termsText, setTermsText] = useState<string>("");
  const [priorityFirst, setPriorityFirst] = useState<boolean>(true);

  const METRICS_PATH = process.env.NEXT_PUBLIC_METRICS_PATH ?? "/metrics-summary";
  const apiBaseMissing = !API_BASE;

  // Normalize various incoming payload shapes to BreakingItem
  function coerceBreaking(data: any): BreakingItem | null {
    if (!data) return null;

    const id =
      data.id ?? data.event_id ?? data.guid ?? data.uuid ?? data.hash ?? null;
    const title =
      data.title ?? data.headline ?? data.text ?? data.body ?? "";
    const url =
      data.url ?? data.link ?? data.href ?? data.source_url ?? "";

    if (!id || !title || !url) return null;

    const source =
      data.source ?? data.feed ?? data.publisher ?? "unknown";

    const published_at_ms =
      data.published_at_ms ??
      (typeof data.published_at_s === "number" ? data.published_at_s * 1000 : undefined) ??
      (typeof data.published_at === "string" ? Date.parse(data.published_at) : undefined);

    const visible_at_ms =
      data.visible_at_ms ??
      (typeof data.visible_at_s === "number" ? data.visible_at_s * 1000 : undefined) ??
      (typeof data.visible_at === "string" ? Date.parse(data.visible_at) : Date.now());

    return {
      id: String(id),
      source: String(source),
      title: String(title),
      url: String(url),
      published_at_ms,
      visible_at_ms,
    };
  }

  // Priority terms rehydrate
  useEffect(() => {
    try {
      const t = localStorage.getItem("pulse_terms");
      if (t !== null) setTermsText(t);
    } catch {}
  }, []);

  useEffect(() => {
    // Simple explicit SSE lifecycle using env URL
    const url = `${process.env.NEXT_PUBLIC_API_BASE_URL!}${process.env.NEXT_PUBLIC_SSE_PATH ?? "/sse/breaking"}`;
    const es = new EventSource(url);

    const onOpen = () => setConn({ state: "connected", lastEventSec: 0 });
    const onError = () => setConn((c) => ({ ...c, state: "reconnecting" }));
    const handleItem = (data: any) => {
      const item = coerceBreaking(data);
      if (!item) return;
      setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [item, ...prev].slice(0, 300)));
    };
    const onMessage = (e: MessageEvent) => {
      try { handleItem(JSON.parse(e.data)); } catch {}
      setConn((c) => ({ ...c, lastEventSec: 0 }));
    };
    const onBreaking = (e: MessageEvent) => {
      try { handleItem(JSON.parse(e.data)); } catch {}
      setConn((c) => ({ ...c, lastEventSec: 0 }));
    };
    const onHello = () => setConn((c) => ({ ...c, lastEventSec: 0 }));
    const onPing = () => setConn((c) => ({ ...c, lastEventSec: 0 }));

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onMessage);
    es.addEventListener("breaking", onBreaking);
    es.addEventListener("hello", onHello);
    es.addEventListener("ping", onPing);

    const tick = setInterval(() => setConn((c) => ({ ...c, lastEventSec: c.lastEventSec + 1 })), 1000);
    return () => {
      clearInterval(tick);
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onMessage);
      es.removeEventListener("breaking", onBreaking);
      es.removeEventListener("hello", onHello);
      es.removeEventListener("ping", onPing);
      try { es.close(); } catch {}
    };
  }, []);

  // Note: Avoid early return before hooks to preserve stable hook order

  // Derived lists
  const terms = useMemo(
    () => termsText.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    [termsText]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
    const withHit = base.map((it) => ({ it, hit: terms.some((t) => t && it.title.toLowerCase().includes(t)) }));
    withHit.sort((a, b) => {
      if (priorityFirst) {
        const pd = Number(b.hit) - Number(a.hit);
        if (pd !== 0) return pd;
      }
      return (b.it.visible_at_ms ?? 0) - (a.it.visible_at_ms ?? 0);
    });
    return withHit;
  }, [items, query, terms, priorityFirst]);

  const saveTerms = () => {
    try { localStorage.setItem("pulse_terms", termsText); } catch {}
  };
  const canSave = termsText.trim().length > 0;

  const hasOverride = typeof window !== "undefined" && (() => { try { return !!localStorage.getItem("apiBaseOverride"); } catch { return false; } })();

  if (apiBaseMissing) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 640, textAlign: "center" }}>
          <h1>Pulse MVP</h1>
          <p>Please create <code>.env.local</code> with <code>NEXT_PUBLIC_API_BASE_URL</code> set to your backend base URL.</p>
          <p style={{ marginTop: 8 }}>
            Example: <code>NEXT_PUBLIC_API_BASE_URL=http://localhost:4000</code>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>Pulse MVP</h1>
      <p>
        <b>Connection:</b> {conn.state} | <b>Last event:</b> {`${conn.lastEventSec}s`} | <b>Items:</b> {items.length} | {" "}
        <b>API_BASE:</b> <code>{API_BASE}</code>
        {hasOverride && (
          <>
            <span style={{ fontSize: 12, color: "#60a5fa", marginLeft: 8 }}>override</span>
            <button
              onClick={() => { try { localStorage.removeItem("apiBaseOverride"); location.reload(); } catch {} }}
              style={{ marginLeft: 8, fontSize: 12 }}
              title="Clear API override"
            >
              reset
            </button>
          </>
        )}
      </p>

      {/* Metrics summary bar */}
      <MetricsBar base={API_BASE} path={METRICS_PATH} />

      <section style={{ margin: "12px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title..."
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 4, minWidth: 220 }}
        />
        <input
          value={termsText}
          onChange={(e) => setTermsText(e.target.value)}
          placeholder="Priority terms (comma-separated)"
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 4, minWidth: 320 }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={priorityFirst} onChange={(e) => setPriorityFirst(e.target.checked)} />
          Priority first
        </label>
        <button onClick={saveTerms} disabled={!canSave} style={{ padding: "8px 10px", border: "1px solid #ccc", borderRadius: 4, background: "#f6f6f6", opacity: canSave ? 1 : 0.6 }}>Save terms</button>
      </section>

      <section style={{ marginTop: 8 }}>
        {filtered.map(({ it, hit }) => (
          <NewsCard key={it.id} item={it} priorityMatch={hit} />
        ))}
      </section>
    </main>
  );
}
