import "dotenv/config";import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const CORS = process.env.CORS_ORIGIN?.split(",") ?? true;
const DISABLE_JOBS = process.env.DISABLE_JOBS === "1";

app.use(cors({ origin: CORS }));
app.get("/health", (_req, res) => res.json({ ok: true, env: "blue", ts: Date.now() }));
app.get("/metrics-lite", (_req, res) => res.json({ service: "backend", version: "v2", ts: Date.now() }));

if (!DISABLE_JOBS) console.log("[boot] jobs enabled (shadow/off by default)");

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] backend listening on ${PORT}, DISABLE_JOBS=${DISABLE_JOBS ? "1" : "0"}`);
});

