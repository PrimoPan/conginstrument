import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import { config } from "../server/config.js";

export type UserDoc = {
  _id?: ObjectId;
  username: string;
  createdAt: Date;
  lastLoginAt: Date;
};

export type SessionDoc = {
  _id?: ObjectId;
  token: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
};

export type ConversationDoc = {
  _id?: ObjectId;
  userId: ObjectId;
  title: string;
  systemPrompt: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  graph: any; // 先用 any，后面换成你CDG类型
  concepts?: any[];
};

export type TurnDoc = {
  _id?: ObjectId;
  conversationId: ObjectId;
  userId: ObjectId;
  createdAt: Date;
  userText: string;
  assistantText: string;
  graphPatch: any;
  graphVersion: number;
};

let client: MongoClient;
let db: Db;

export const collections = {} as {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  conversations: Collection<ConversationDoc>;
  turns: Collection<TurnDoc>;
};

export async function connectMongo() {
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.mongoDb);

  collections.users = db.collection<UserDoc>("users");
  collections.sessions = db.collection<SessionDoc>("sessions");
  collections.conversations = db.collection<ConversationDoc>("conversations");
  collections.turns = db.collection<TurnDoc>("turns");

  // indexes
  await collections.users.createIndex({ username: 1 }, { unique: true });
  await collections.sessions.createIndex({ token: 1 }, { unique: true });
  // TTL：到期自动删 session
  await collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  await collections.conversations.createIndex({ userId: 1, updatedAt: -1 });
  await collections.turns.createIndex({ conversationId: 1, createdAt: 1 });

  return db;
}
