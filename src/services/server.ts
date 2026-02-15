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

  app.use(
    cors({
      origin: true,
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
