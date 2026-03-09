import { normalizeConversationModel } from "./conversationModel.js";

function parseCsv(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((x) => x.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    )
  );
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int >= 1 ? int : fallback;
}

const plainChatHistoryTurnLimit = readPositiveInt(process.env.CI_PLAIN_CHAT_HISTORY_TURN_LIMIT, 18);

export const config = {
  port: Number(process.env.PORT || 3001),
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGO_DB || "conginstrument",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  model: normalizeConversationModel(process.env.MODEL || "gpt-4o"),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 7),
  timezone: process.env.TZ || process.env.TIMEZONE || "Asia/Shanghai",
  corsOrigins: parseCsv(process.env.CORS_ORIGINS || ""),
  corsAllowAll: String(process.env.CORS_ALLOW_ALL || "1") !== "0",
  plainChatHistoryTurnLimit,
  plainChatHistoryMessageLimit: readPositiveInt(
    process.env.CI_PLAIN_CHAT_HISTORY_MESSAGE_LIMIT,
    plainChatHistoryTurnLimit * 2
  ),
  plainChatMaxCharsPerMessage: readPositiveInt(process.env.CI_PLAIN_CHAT_MAX_CHARS_PER_MESSAGE, 1400),
  plainChatMaxTokens: readPositiveInt(process.env.CI_PLAIN_CHAT_MAX_TOKENS, 900),
  plainChatFallbackMaxTokens: readPositiveInt(process.env.CI_PLAIN_CHAT_FALLBACK_MAX_TOKENS, 700),
};
