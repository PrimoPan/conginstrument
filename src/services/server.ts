import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { config } from "../server/config.js";
import { connectMongo } from "../db/mongo.js";
import { authRouter } from "../routes/auth.js";
import { convRouter } from "../routes/conversations.js";

async function main() {
  await connectMongo();

  const app = express();

  app.use(helmet());

  const allowedOrigins = new Set(
    (config.corsOrigins || []).map((x) => String(x || "").trim().replace(/\/+$/, ""))
  );

  app.use(
    cors({
      origin(origin, callback) {
        const normalized = String(origin || "").trim().replace(/\/+$/, "");
        if (!origin) {
          // Non-browser clients / same-origin server requests
          return callback(null, true);
        }
        if (config.corsAllowAll || allowedOrigins.size === 0) {
          return callback(null, true);
        }
        if (allowedOrigins.has(normalized)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked origin: ${origin}`));
      },
      credentials: false,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    })
  );

  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/conversations", convRouter);

  app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
