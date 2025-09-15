"use client";
import { useEffect, useRef, useState, useMemo } from "react";
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

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "down";

export default function Home() {
  const API_BASE = getApiBase();
  // Connection and data state
  const [conn, setConn] = useState<ConnectionState>("idle");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [items, setItems] = useState<BreakingItem[]>([]);

  // UI state
  const [query, setQuery] = useState<string>("");
  const [priorityTerms, setPriorityTerms] = useState<string[]>([]);
  const [priorityInput, setPriorityInput] = useState<string>("");
  const [priorityFirst, setPriorityFirst] = useState<boolean>(true);

  // Derived ticking value to update "seconds since last event" display
  const [nowTick, setNowTick] = useState<number>(Date.now());

  // Internals (not in React state)
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffMsRef = useRef<number>(1000); // start 1s

  const SSE_PATH = process.env.NEXT_PUBLIC_SSE_PATH ?? "/sse/breaking";
  const METRICS_PATH = process.env.NEXT_PUBLIC_METRICS_PATH ?? "/metrics-summary";
  const SSE_URL = API_BASE ? `${API_BASE}${SSE_PATH}` : null;

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

  // Load persisted priority terms on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("priorityTerms");
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) {
          setPriorityTerms(arr);
          setPriorityInput(arr.join(", "));
        }
      }
    } catch {}
  }, []);

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem("priorityTerms", JSON.stringify(priorityTerms));
    } catch {}
  }, [priorityTerms]);

  useEffect(() => {
    if (!API_BASE) return; // no-op until we have a valid API base
    // UI seconds ticker
    const intervalId: ReturnType<typeof setInterval> = setInterval(() => setNowTick(Date.now()), 1000);

    // Single-connection SSE with long backoff and jitter
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const BASE_BACKOFF_MS = 60_000; // 60s
    const JITTER_MS = 30_000;       // 0..30s

    const sseUrl = `${API_BASE}${SSE_PATH}`;

    const open = () => {
      // Only one live EventSource per tab
      if (es || (typeof window !== "undefined" && window.__PULSE_SSE__)) return;
      setConn("reconnecting");
      const next = new EventSource(sseUrl);
      es = next;
      if (typeof window !== "undefined") window.__PULSE_SSE__ = next;

      next.addEventListener("open", () => setConn("live"));

      next.addEventListener("hello", () => setLastEventAt(Date.now()));
      next.addEventListener("ping", () => setLastEventAt(Date.now()));

      next.addEventListener("breaking", (ev: MessageEvent) => {
        setLastEventAt(Date.now());
        try {
          const raw = JSON.parse(ev.data);
          const item = coerceBreaking(raw);
          if (!item) return;
          setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [item, ...prev].slice(0, 300)));
        } catch {}
      });

      // Fallback default message
      next.addEventListener("message", (ev: MessageEvent) => {
        if (process.env.NODE_ENV !== "production") {
          try { console.debug("SSE message", ev.data); } catch {}
        }
        try {
          const raw = JSON.parse(ev.data);
          const item = coerceBreaking(raw);
          if (!item) return;
          setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [item, ...prev].slice(0, 300)));
          setLastEventAt(Date.now());
        } catch {}
      });

      next.addEventListener("error", () => {
        setConn("reconnecting");
        try { next.close(); } catch {}
        es = null;
        if (typeof window !== "undefined" && window.__PULSE_SSE__) window.__PULSE_SSE__ = undefined;
        const delay = BASE_BACKOFF_MS + Math.floor(Math.random() * JITTER_MS);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, delay);
      });
    };

    // Optional jitter on first connect to avoid herding
    const firstDelay = Math.floor(Math.random() * 1500);
    const firstTimer = setTimeout(open, firstDelay);

    const handleOnline = () => {
      if (!es && !(typeof window !== "undefined" && window.__PULSE_SSE__)) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, 0);
      }
    };
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener("online", handleOnline);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(firstTimer);
      if (es) { try { es.close(); } catch {} es = null; }
      if (typeof window !== "undefined" && window.__PULSE_SSE__) window.__PULSE_SSE__ = undefined;
    };
  }, [API_BASE, SSE_PATH]);

  // Env guard: show setup message when API base is missing (after hooks)
  if (!API_BASE) {
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

  const secondsSince = lastEventAt ? Math.max(0, Math.floor((nowTick - lastEventAt) / 1000)) : null;

  // Derived lists
  const normalizedTerms = useMemo(
    () => priorityTerms.map((t) => t.trim().toLowerCase()).filter(Boolean),
    [priorityTerms]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
    const withHit = base.map((it) => ({ it, hit: normalizedTerms.some((t) => t && it.title.toLowerCase().includes(t)) }));
    withHit.sort((a, b) => {
      if (priorityFirst) {
        const pd = Number(b.hit) - Number(a.hit);
        if (pd !== 0) return pd;
      }
      return (b.it.visible_at_ms ?? 0) - (a.it.visible_at_ms ?? 0);
    });
    return withHit;
  }, [items, query, normalizedTerms, priorityFirst]);

  const applyPriorityInput = () => {
    const parts = priorityInput.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    setPriorityTerms(parts);
  };

  const hasOverride = typeof window !== "undefined" && (() => { try { return !!localStorage.getItem("apiBaseOverride"); } catch { return false; } })();

  return (
    <main style={{ padding: 24 }}>
      <h1>Pulse MVP</h1>
      <p>
        <b>Connection:</b> {conn} | <b>Last event:</b> {secondsSince === null ? "—" : `${secondsSince}s`} | <b>Items:</b> {items.length} | {" "}
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
          value={priorityInput}
          onChange={(e) => setPriorityInput(e.target.value)}
          onBlur={applyPriorityInput}
          placeholder="Priority terms (comma-separated)"
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 4, minWidth: 320 }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={priorityFirst} onChange={(e) => setPriorityFirst(e.target.checked)} />
          Priority first
        </label>
        <button onClick={applyPriorityInput} style={{ padding: "8px 10px", border: "1px solid #ccc", borderRadius: 4, background: "#f6f6f6" }}>Save terms</button>
      </section>

      <section style={{ marginTop: 8 }}>
        {filtered.map(({ it, hit }) => (
          <NewsCard key={it.id} item={it} priorityMatch={hit} />
        ))}
      </section>
    </main>
  );
}
