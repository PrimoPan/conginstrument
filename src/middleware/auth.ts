import { Request, Response, NextFunction } from "express";
import { collections } from "../db/mongo.js";
import { ObjectId } from "mongodb";

export type AuthedRequest = Request & { userId?: ObjectId; username?: string };

export async function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

  const session = await collections.sessions.findOne({ token });
  if (!session) return res.status(401).json({ error: "Invalid session" });

  const user = await collections.users.findOne({ _id: session.userId });
  if (!user) return res.status(401).json({ error: "User not found" });

  req.userId = user._id;
  req.username = user.username;
  next();
}
