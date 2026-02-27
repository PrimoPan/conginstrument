import { config } from "../server/config.js";
import type { CDG, GraphPatch } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";
import {
  buildTravelIntentStatement,
  extractIntentSignals,
  mergeIntentSignals,
  type IntentSignals,
} from "./graphUpdater/intentSignals.js";
import { resolveIntentSignalsGeo } from "./graphUpdater/geoResolver.js";
import { extractIntentSignalsByFunctionCall } from "./graphUpdater/slotFunctionCall.js";
import { buildSlotStateMachine } from "./graphUpdater/slotStateMachine.js";
import { compileSlotStateToPatch } from "./graphUpdater/slotGraphCompiler.js";
import { sanitizeIntentSignals } from "./graphUpdater/signalSanitizer.js";
import { cleanStatement, mergeTextSegments } from "./graphUpdater/text.js";
import { makeTempId } from "./graphUpdater/common.js";
import { enrichPatchWithMotifFoundation } from "./motif/motifGrounding.js";
import { buildBudgetLedgerFromUserTurns } from "./travelPlan/budgetLedger.js";
import type { AppLocale } from "../i18n/locale.js";
import { isEnglishLocale } from "../i18n/locale.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph-v2]", ...args);
}

const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;
const USE_FUNCTION_SLOT_EXTRACTION = process.env.CI_GRAPH_USE_FUNCTION_SLOTS !== "0";

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function normalizeUtterance(input: any): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasDirectDurationCue(text: string): boolean {
  const s = String(text || "");
  if (!s) return false;
  // 用户直接表达时长（尤其是“玩X天/旅行X天/停留X天”）时，优先信任规则解析结果。
  if (/(玩|旅游|旅行|出行|行程|停留|待)\s*[0-9一二三四五六七八九十两]{1,3}\s*天/i.test(s)) return true;
  if (/(我|我们|计划|准备|想|打算).{0,20}[0-9一二三四五六七八九十两]{1,3}\s*天/i.test(s)) return true;
  return false;
}

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

function fallbackPatch(
  graph: CDG,
  userText: string,
  reason: string,
  locale?: AppLocale
): GraphPatch {
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
            statement: short || t(locale, "意图：制定任务计划", "Intent: plan this task"),
            status: "proposed",
            confidence: 0.7,
            importance: 0.78,
            key: "slot:goal",
            motifType: "expectation",
            claim: short || t(locale, "制定任务计划", "Plan this task"),
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
          statement: short || t(locale, "用户补充信息", "User added details"),
          status: "proposed",
          confidence: 0.55,
          importance: 0.55,
          motifType: "cognitive_step",
          claim: short || t(locale, "用户补充信息", "User added details"),
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
  stateContextUserTurns?: string[];
  systemPrompt?: string;
  locale?: AppLocale;
}): Promise<IntentSignals> {
  const recentTurns = params.recentTurns || [];
  const fallbackRecentUserTexts = recentTurns
    .filter((t) => t.role === "user")
    .map((t) => String(t.content || ""))
    .slice(-8);
  const stateContextUserTurns = (params.stateContextUserTurns || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(-160);
  const recentUserTexts = stateContextUserTurns.length ? stateContextUserTurns : fallbackRecentUserTexts;
  const historyUserTexts = recentUserTexts.slice();
  const tailTurn = recentTurns[recentTurns.length - 1];
  if (
    tailTurn?.role === "user" &&
    normalizeUtterance(tailTurn.content) &&
    normalizeUtterance(tailTurn.content) === normalizeUtterance(params.userText) &&
    historyUserTexts.length
  ) {
    historyUserTexts.pop();
  }

  const signalText = mergeTextSegments([...historyUserTexts.slice(-16), params.userText]);

  // 按轮次顺序累计历史信号，避免把历史增量（例如“再加5000预算”）在后续轮次重复累计。
  let accumulatedHistorySignals: IntentSignals = {};
  for (const turnText of historyUserTexts) {
    const turnSignals = extractIntentSignals(turnText, { historyMode: true, locale: params.locale });
    accumulatedHistorySignals = mergeIntentSignals(accumulatedHistorySignals, turnSignals);
  }
  const latestSignals = extractIntentSignals(params.userText, { locale: params.locale });
  const textSignals = mergeIntentSignals(accumulatedHistorySignals, latestSignals);
  let signals = textSignals;

  if (USE_FUNCTION_SLOT_EXTRACTION) {
    try {
      const slotResult = await extractIntentSignalsByFunctionCall({
        model: GRAPH_MODEL,
        latestUserText: params.userText,
        recentTurns: params.recentTurns,
        systemPrompt: params.systemPrompt,
        locale: params.locale,
        debug: DEBUG,
      });
      if (slotResult?.signals) {
        // deterministic parser优先处理冲突标量（例如总时长），function slots用于补齐缺失语义
        signals = mergeIntentSignals(slotResult.signals, textSignals);
        const textDays = Number(textSignals.durationDays) || 0;
        const mergedDays = Number(signals.durationDays) || 0;
        const singleCityStable =
          (textSignals.cityDurations || []).length === 1 &&
          Number((textSignals.cityDurations || [])[0]?.days || 0) === textDays &&
          textDays > 0;
        const shouldPreferTextDuration =
          textDays > 0 &&
          (hasDirectDurationCue(params.userText) || singleCityStable) &&
          (mergedDays <= 0 || mergedDays !== textDays);
        if (shouldPreferTextDuration) {
          signals.durationDays = textDays;
          signals.durationEvidence = textSignals.durationEvidence || signals.durationEvidence || `${textDays}天`;
          signals.durationStrength = Math.max(Number(textSignals.durationStrength) || 0.78, 0.78);
        }
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

  signals = sanitizeIntentSignals(signals);

  const budgetLedger = buildBudgetLedgerFromUserTurns(
    [...historyUserTexts, params.userText].map((text, i) => ({
      text,
      turnId: `u_${i + 1}`,
    }))
  );
  if (budgetLedger.summary.totalCny != null) {
    signals.budgetCny = Math.max(100, Math.round(Number(budgetLedger.summary.totalCny)));
    signals.budgetEvidence =
      budgetLedger.latestTotalEvidence ||
      signals.budgetEvidence ||
      (isEnglishLocale(params.locale) ? `${signals.budgetCny} CNY` : `${signals.budgetCny}元`);
    signals.budgetImportance = Math.max(Number(signals.budgetImportance) || 0, 0.9);
  }
  if (budgetLedger.summary.spentCny > 0) {
    signals.budgetSpentCny = Math.max(0, Math.round(Number(budgetLedger.summary.spentCny)));
    signals.budgetSpentEvidence =
      budgetLedger.latestSpentEvidence ||
      signals.budgetSpentEvidence ||
      (isEnglishLocale(params.locale) ? `${signals.budgetSpentCny} CNY` : `${signals.budgetSpentCny}元`);
    signals.budgetImportance = Math.max(Number(signals.budgetImportance) || 0, 0.88);
  }
  if (budgetLedger.summary.remainingCny != null) {
    signals.budgetRemainingCny = Math.max(0, Math.round(Number(budgetLedger.summary.remainingCny)));
  }
  if (budgetLedger.summary.pendingCny > 0) {
    signals.budgetPendingCny = Math.max(0, Math.round(Number(budgetLedger.summary.pendingCny)));
    signals.budgetPendingEvidence =
      budgetLedger.latestPendingEvidence ||
      signals.budgetPendingEvidence ||
      (isEnglishLocale(params.locale) ? `${signals.budgetPendingCny} CNY` : `${signals.budgetPendingCny}元`);
  } else {
    signals.budgetPendingCny = undefined;
    signals.budgetPendingEvidence = undefined;
  }

  const canonicalIntent = buildTravelIntentStatement(signals, signalText, params.locale);
  if (canonicalIntent && !signals.destinationEvidence) {
    signals.destinationEvidence = canonicalIntent;
  }
  return signals;
}

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  stateContextUserTurns?: string[];
  assistantText: string;
  systemPrompt?: string;
  locale?: AppLocale;
}): Promise<GraphPatch> {
  const signals = await buildSignals(params);
  const state = buildSlotStateMachine({
    userText: params.userText,
    recentTurns: params.recentTurns,
    signals,
    locale: params.locale,
  });

  const rawPatch = compileSlotStateToPatch({
    graph: params.graph,
    state,
  });

  const motifGroundedPatch = enrichPatchWithMotifFoundation(rawPatch, {
    reason: "slot_state_machine_pipeline",
    by: "system",
  });
  const strictPatch = sanitizeGraphPatchStrict(motifGroundedPatch);
  if (strictPatch.ops.length > 0) {
    if (DEBUG) {
      const counts: Record<string, number> = {};
      for (const op of strictPatch.ops) counts[op.op] = (counts[op.op] || 0) + 1;
      dlog("compiled patch ops:", counts, "notes:", strictPatch.notes);
    }
    return strictPatch;
  }

  return fallbackPatch(params.graph, params.userText, "empty_compiled_patch", params.locale);
}
