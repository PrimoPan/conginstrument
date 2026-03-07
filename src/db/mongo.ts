import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import { config } from "../server/config.js";
import { DEFAULT_LOCALE, type AppLocale } from "../i18n/locale.js";

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
  locale?: AppLocale;
  systemPrompt: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  graph: any; // 先用 any，后面换成你CDG类型
  concepts?: any[];
  motifs?: any[];
  motifLinks?: any[];
  contexts?: any[];
  travelPlanState?: any;
  taskLifecycle?: {
    status: "active" | "closed";
    endedAt?: string;
    endedTaskId?: string;
    reopenedAt?: string;
    updatedAt?: string;
  };
  manualGraphOverrides?: any;
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

export type MotifLibraryVersion = {
  version_id: string;
  version: number;
  title: string;
  dependency: string;
  reusable_description: string;
  abstraction_levels: {
    L1?: string;
    L2?: string;
    L3?: string;
  };
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  source_task_id?: string;
  source_conversation_id?: string;
  created_at: string;
  updated_at: string;
};

export type MotifLibraryDoc = {
  _id?: ObjectId;
  userId: ObjectId;
  locale: AppLocale;
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  abstraction_levels: ("L1" | "L2" | "L3")[];
  current_version_id: string;
  versions: MotifLibraryVersion[];
  source_task_ids: string[];
  usage_stats: {
    adopted_count: number;
    ignored_count: number;
    feedback_negative_count: number;
    transfer_confidence: number;
    last_used_at?: string;
  };
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
};

let client: MongoClient;
let db: Db;

export const collections = {} as {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  conversations: Collection<ConversationDoc>;
  turns: Collection<TurnDoc>;
  motifLibrary: Collection<MotifLibraryDoc>;
};

export async function connectMongo() {
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.mongoDb);

  collections.users = db.collection<UserDoc>("users");
  collections.sessions = db.collection<SessionDoc>("sessions");
  collections.conversations = db.collection<ConversationDoc>("conversations");
  collections.turns = db.collection<TurnDoc>("turns");
  collections.motifLibrary = db.collection<MotifLibraryDoc>("motif_library");

  // Legacy docs predate locale partitioning and should remain on zh-CN behavior.
  await collections.conversations.updateMany(
    { locale: { $exists: false } as any },
    { $set: { locale: DEFAULT_LOCALE } as any }
  );
  await collections.motifLibrary.updateMany(
    { locale: { $exists: false } as any },
    { $set: { locale: DEFAULT_LOCALE } as any }
  );

  // indexes
  await collections.users.createIndex({ username: 1 }, { unique: true });
  await collections.sessions.createIndex({ token: 1 }, { unique: true });
  // TTL：到期自动删 session
  await collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  await collections.conversations.createIndex({ userId: 1, updatedAt: -1 });
  await collections.conversations.createIndex({ userId: 1, locale: 1, updatedAt: -1 });
  await collections.turns.createIndex({ conversationId: 1, createdAt: 1 });
  await collections.motifLibrary.createIndex({ userId: 1, locale: 1, motif_type_id: 1 }, { unique: true });
  await collections.motifLibrary.createIndex({ userId: 1, locale: 1, updatedAt: -1 });
  try {
    await collections.motifLibrary.dropIndex("userId_1_motif_type_id_1");
  } catch {
    // ignore when the legacy index is already absent
  }
  try {
    await collections.motifLibrary.dropIndex("userId_1_updatedAt_-1");
  } catch {
    // ignore when the legacy index is already absent
  }

  return db;
}
