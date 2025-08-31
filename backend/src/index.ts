import "dotenv/config";import express from "express";
import cors from "cors";
import { registerSSE, getSSEStats, broadcastBreaking } from "./sse.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const DISABLE_JOBS = process.env.DISABLE_JOBS === "1";

// Build allow-list from env
const ALLOWED = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

registerSSE(app);

app.get("/_debug/env", (_req, res) => {
  res.json({ allowed: ALLOWED, raw: process.env.CORS_ORIGIN });
});

console.log("[env] CORS_ORIGIN allow-list:", ALLOWED);
app.get("/health", (_req, res) => res.json({ ok: true, env: "blue", ts: Date.now() }));
app.get("/metrics-lite", (_req, res) => res.json({ service: "backend", version: "v2", ts: Date.now() }));

app.post("/_debug/push", express.json(), (req, res) => {
  const key = req.get("x-debug-key");
  const expected = process.env.DEBUG_PUSH_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, reason: "UNAUTHORIZED" });
  }
  const sent = broadcastBreaking({ ts: Date.now(), ...req.body });
  return res.json({ ok: true, sent });
});

app.get('/metrics-summary', (_req, res) => {
  const sse = getSSEStats()
  const by_source = {} as Record<string, unknown>
  res.json({ sse, by_source })
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] backend listening on ${PORT}, DISABLE_JOBS=${DISABLE_JOBS ? "1" : "0"}`);
});



