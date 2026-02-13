import "dotenv/config";
import OpenAI from "openai";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.MODEL || "gpt-5-nano"; // Model you choose

  if (!apiKey) throw new Error("Miss OPENAI_API_KEY（check .env）"); //Primo Check ENV
  if (!baseURL) throw new Error("Miss OPENAI_BASE_URL（check .env）"); //Primo Check ENV

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
