// src/services/llm.ts
import type { CDG, GraphPatch } from "../core/graph.js";
import { streamAssistantText, generateAssistantTextNonStreaming } from "./chatResponder.js";
import { generateGraphPatch } from "./graphUpdater.js";
import { buildExtremeWeatherAdvisory } from "./weather/advisor.js";
import { buildFxRateAdvisory } from "./fx/advisor.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][turn]", ...args);
}

function normalizeRecentTurns(
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>,
  maxEach = 1400
) {
  return (recentTurns || [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxEach) }));
}

function appendWeatherAdvisory(baseText: string, advisory: string | null): string {
  const text = String(baseText || "");
  const adv = String(advisory || "").trim();
  if (!adv) return text;
  if (!text.trim()) return adv;
  if (text.includes(adv)) return text;
  if (/天气风险提醒|极端天气|强降雨|雷暴|高温|低温|强风|大风/i.test(text)) return text;
  return `${text}\n\n${adv}`;
}

function appendFxAdvisory(baseText: string, advisory: string | null): string {
  const text = String(baseText || "");
  const adv = String(advisory || "").trim();
  if (!adv) return text;
  if (!text.trim()) return adv;
  if (text.includes(adv)) return text;
  if (/实时汇率参考|1CNY|兑换|换算/i.test(text)) return text;
  return `${text}\n\n${adv}`;
}

export async function generateTurn(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
}): Promise<{ assistant_text: string; graph_patch: GraphPatch }> {
  const safeRecent = normalizeRecentTurns(params.recentTurns);

  let assistant_text = await generateAssistantTextNonStreaming({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
    systemPrompt: params.systemPrompt,
  });

  const fxAdvisory = await buildFxRateAdvisory({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
  }).catch(() => null);
  assistant_text = appendFxAdvisory(assistant_text, fxAdvisory);

  const weatherAdvisory = await buildExtremeWeatherAdvisory({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
  }).catch(() => null);
  assistant_text = appendWeatherAdvisory(assistant_text, weatherAdvisory);

  let graph_patch: GraphPatch;
  try {
    graph_patch = await generateGraphPatch({
      graph: params.graph,
      userText: params.userText,
      recentTurns: safeRecent,
      assistantText: assistant_text,
      systemPrompt: params.systemPrompt,
    });
  } catch (e: any) {
    graph_patch = { ops: [], notes: [`graph_patch_exception:${e?.message || "unknown"}`] };
  }

  dlog("turn done. assistant_len=", assistant_text.length, "ops=", graph_patch.ops?.length || 0);

  return { assistant_text, graph_patch };
}

export async function generateTurnStreaming(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}): Promise<{ assistant_text: string; graph_patch: GraphPatch }> {
  const safeRecent = normalizeRecentTurns(params.recentTurns);

  let assistant_text = await streamAssistantText({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
    systemPrompt: params.systemPrompt,
    onToken: params.onToken,
    signal: params.signal,
  });

  const fxAdvisory = await buildFxRateAdvisory({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
  }).catch(() => null);
  const fxAppended = appendFxAdvisory(assistant_text, fxAdvisory);
  if (fxAppended !== assistant_text) {
    const delta = fxAppended.slice(assistant_text.length);
    if (delta) params.onToken(delta);
    assistant_text = fxAppended;
  }

  const weatherAdvisory = await buildExtremeWeatherAdvisory({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
  }).catch(() => null);
  const appended = appendWeatherAdvisory(assistant_text, weatherAdvisory);
  if (appended !== assistant_text) {
    const delta = appended.slice(assistant_text.length);
    if (delta) params.onToken(delta);
    assistant_text = appended;
  }

  let graph_patch: GraphPatch;
  try {
    graph_patch = await generateGraphPatch({
      graph: params.graph,
      userText: params.userText,
      recentTurns: safeRecent,
      assistantText: assistant_text,
      systemPrompt: params.systemPrompt,
    });
  } catch (e: any) {
    graph_patch = { ops: [], notes: [`graph_patch_exception:${e?.message || "unknown"}`] };
  }

  dlog("stream turn done. assistant_len=", assistant_text.length, "ops=", graph_patch.ops?.length || 0);

  return { assistant_text, graph_patch };
}
