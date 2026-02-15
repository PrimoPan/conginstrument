// src/services/llmClient.ts
import OpenAI from "openai";
import { config } from "../server/config.js";

export const openai = new OpenAI({
  apiKey: config.openaiKey,
  baseURL: config.openaiBaseUrl,
});
