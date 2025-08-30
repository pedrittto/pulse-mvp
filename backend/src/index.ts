import "dotenv/config";import express from "express";
import cors from "cors";
import { registerSSE } from "./sse.js";

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

if (!DISABLE_JOBS) console.log("[boot] jobs enabled (shadow/off by default)");

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] backend listening on ${PORT}, DISABLE_JOBS=${DISABLE_JOBS ? "1" : "0"}`);
});

