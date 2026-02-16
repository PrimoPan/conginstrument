import { config } from "../server/config.js";
import type { CDG, GraphPatch } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";
import {
  buildTravelIntentStatement,
  extractIntentSignalsWithRecency,
  mergeIntentSignals,
  type IntentSignals,
} from "./graphUpdater/intentSignals.js";
import { resolveIntentSignalsGeo } from "./graphUpdater/geoResolver.js";
import { extractIntentSignalsByFunctionCall } from "./graphUpdater/slotFunctionCall.js";
import { buildSlotStateMachine } from "./graphUpdater/slotStateMachine.js";
import { compileSlotStateToPatch } from "./graphUpdater/slotGraphCompiler.js";
import { cleanStatement, mergeTextSegments } from "./graphUpdater/text.js";
import { makeTempId } from "./graphUpdater/common.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph-v2]", ...args);
}

const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;
const USE_FUNCTION_SLOT_EXTRACTION = process.env.CI_GRAPH_USE_FUNCTION_SLOTS !== "0";

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n) => n.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((n) => n.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((n) => n.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals
    .slice()
    .sort(
      (a, b) =>
        (Number(b.importance) || 0) - (Number(a.importance) || 0) ||
        (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
    )[0]?.id;
}

function fallbackPatch(graph: CDG, userText: string, reason: string): GraphPatch {
  const root = pickRootGoalId(graph);
  const short = cleanStatement(userText, 140);
  if (!root) {
    return {
      ops: [
        {
          op: "add_node",
          node: {
            id: makeTempId("n"),
            type: "goal",
            layer: "intent",
            statement: short || "意图：制定任务计划",
            status: "proposed",
            confidence: 0.7,
            importance: 0.78,
            key: "slot:goal",
            motifType: "expectation",
            claim: short || "制定任务计划",
            revisionHistory: [
              {
                at: new Date().toISOString(),
                action: "created",
                by: "system",
                reason: `fallback:${reason}`,
              },
            ],
          } as any,
        },
      ],
      notes: [`fallback:${reason}`],
    };
  }

  const nid = makeTempId("n");
  return {
    ops: [
      {
        op: "add_node",
        node: {
          id: nid,
          type: "fact",
          layer: "requirement",
          statement: short || "用户补充信息",
          status: "proposed",
          confidence: 0.55,
          importance: 0.55,
          motifType: "cognitive_step",
          claim: short || "用户补充信息",
          sourceMsgIds: ["latest_user"],
          revisionHistory: [
            {
              at: new Date().toISOString(),
              action: "created",
              by: "system",
              reason: `fallback:${reason}`,
            },
          ],
        } as any,
      },
      {
        op: "add_edge",
        edge: {
          id: makeTempId("e"),
          from: nid,
          to: root,
          type: "enable",
          confidence: 0.6,
        },
      },
    ],
    notes: [`fallback:${reason}`],
  };
}

async function buildSignals(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
}): Promise<IntentSignals> {
  const signalText = mergeTextSegments([
    ...((params.recentTurns || [])
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .slice(-8)),
    params.userText,
  ]);

  const textSignals = extractIntentSignalsWithRecency(signalText, params.userText);
  let signals = textSignals;

  if (USE_FUNCTION_SLOT_EXTRACTION) {
    try {
      const slotResult = await extractIntentSignalsByFunctionCall({
        model: GRAPH_MODEL,
        latestUserText: params.userText,
        recentTurns: params.recentTurns,
        systemPrompt: params.systemPrompt,
        debug: DEBUG,
      });
      if (slotResult?.signals) {
        // deterministic parser优先处理冲突标量（例如总时长），function slots用于补齐缺失语义
        signals = mergeIntentSignals(slotResult.signals, textSignals);
      }
    } catch (e: any) {
      dlog("function-call slot extraction failed:", e?.message || e);
    }
  }

  try {
    signals = await resolveIntentSignalsGeo({
      signals,
      latestUserText: params.userText,
      recentTurns: params.recentTurns,
    });
  } catch (e: any) {
    dlog("geo resolver failed:", e?.message || e);
  }

  const canonicalIntent = buildTravelIntentStatement(signals, signalText);
  if (canonicalIntent && !signals.destinationEvidence) {
    signals.destinationEvidence = canonicalIntent;
  }
  return signals;
}

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const signals = await buildSignals(params);
  const state = buildSlotStateMachine({
    userText: params.userText,
    recentTurns: params.recentTurns,
    signals,
  });

  const rawPatch = compileSlotStateToPatch({
    graph: params.graph,
    state,
  });

  const strictPatch = sanitizeGraphPatchStrict(rawPatch);
  if (strictPatch.ops.length > 0) {
    if (DEBUG) {
      const counts: Record<string, number> = {};
      for (const op of strictPatch.ops) counts[op.op] = (counts[op.op] || 0) + 1;
      dlog("compiled patch ops:", counts, "notes:", strictPatch.notes);
    }
    return strictPatch;
  }

  return fallbackPatch(params.graph, params.userText, "empty_compiled_patch");
}
