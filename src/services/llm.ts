// src/services/llm.ts
import type { CDG, GraphPatch } from "../core/graph.js";
import { streamAssistantText, generateAssistantTextNonStreaming } from "./chatResponder.js";
import { generateGraphPatch } from "./graphUpdater.js";

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

export async function generateTurn(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
}): Promise<{ assistant_text: string; graph_patch: GraphPatch }> {
  const safeRecent = normalizeRecentTurns(params.recentTurns);

  const assistant_text = await generateAssistantTextNonStreaming({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
    systemPrompt: params.systemPrompt,
  });

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

  const assistant_text = await streamAssistantText({
    graph: params.graph,
    userText: params.userText,
    recentTurns: safeRecent,
    systemPrompt: params.systemPrompt,
    onToken: params.onToken,
    signal: params.signal,
  });

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
