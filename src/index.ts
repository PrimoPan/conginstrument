import "dotenv/config";
import OpenAI from "openai";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.MODEL || "gpt-4o"; // Model you choose

  if (!apiKey) throw new Error("Miss OPENAI_API_KEY（check .env）"); // env check
  if (!baseURL) throw new Error("Miss OPENAI_BASE_URL（check .env）"); // env check

  const client = new OpenAI({ apiKey, baseURL });

  const prompt = process.argv.slice(2).join(" ").trim() || "hi";

  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  console.log(resp.choices[0]?.message?.content ?? "");
}

main().catch((e) => {
  console.error(e?.status ? `HTTP ${e.status}` : "");
  console.error(e?.message || e);
  process.exit(1);
});
