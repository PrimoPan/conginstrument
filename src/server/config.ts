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

export const config = {
  port: Number(process.env.PORT || 3001),
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGO_DB || "conginstrument",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  model: process.env.MODEL || "gpt-4o",
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 7),
  corsOrigins: parseCsv(process.env.CORS_ORIGINS || ""),
  corsAllowAll: String(process.env.CORS_ALLOW_ALL || "1") !== "0",
};
