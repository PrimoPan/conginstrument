import { Router } from "express";
import { collections } from "../db/mongo.js";
import { randomUUID } from "node:crypto";
import { config } from "../server/config.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const usernameRaw = String(req.body?.username ?? "").trim();
  if (!usernameRaw) return res.status(400).json({ error: "username required" });

  // 限制长度，避免奇怪输入
  const username = usernameRaw.slice(0, 32);

  const now = new Date();

  // 1) upsert：保证用户存在
  await collections.users.updateOne(
    { username },
    {
      $setOnInsert: { username, createdAt: now },
      $set: { lastLoginAt: now },
    },
    { upsert: true }
  );

  // 2) 再取一次用户（类型稳定、不会出现 result.value 的类型问题）
  const user = await collections.users.findOne({ username });
  if (!user || !user._id) {
    return res.status(500).json({ error: "failed to create/find user" });
  }

  // 3) 生成 session token
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000);

  await collections.sessions.insertOne({
    token,
    userId: user._id,
    createdAt: now,
    expiresAt,
  });

  return res.json({
    userId: String(user._id),
    username: user.username,
    sessionToken: token,
  });
});
