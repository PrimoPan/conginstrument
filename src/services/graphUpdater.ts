import { config } from "../server/config.js";
import type { CDG, GraphPatch } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";
import {
  buildTravelIntentStatement,
  extractIntentSignals,
  mergeIntentSignals,
  normalizeDestination,
  isLikelyDestinationCandidate,
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

function selectBestNodeByKey(graph: CDG, slotKey: string): any | null {
  const nodes = (graph.nodes || []).filter((n: any) => String((n as any)?.key || "") === slotKey);
  if (!nodes.length) return null;
  const rankStatus = (x: any) =>
    x?.status === "confirmed" ? 3 : x?.status === "proposed" ? 2 : x?.status === "disputed" ? 1 : 0;
  return nodes
    .slice()
    .sort((a, b) => {
      const rs = rankStatus(b) - rankStatus(a);
      if (rs !== 0) return rs;
      const conf = (Number((b as any)?.confidence) || 0) - (Number((a as any)?.confidence) || 0);
      if (conf !== 0) return conf;
      return String((a as any)?.id || "").localeCompare(String((b as any)?.id || ""));
    })[0] as any;
}

function parseCnyAmountFromStatement(statement: string): number | undefined {
  const s = cleanStatement(String(statement || ""), 140).replace(/[,，\s]/g, "");
  if (!s) return undefined;
  const m = s.match(/([0-9]{1,12}(?:\.[0-9]{1,2})?)/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

type GraphBudgetSnapshot = {
  totalCny?: number;
  spentCny?: number;
  remainingCny?: number;
  pendingCny?: number;
  totalEvidence?: string;
  spentEvidence?: string;
  pendingEvidence?: string;
};

function readGraphBudgetSnapshot(graph: CDG): GraphBudgetSnapshot {
  const budgetNode = selectBestNodeByKey(graph, "slot:budget");
  const spentNode = selectBestNodeByKey(graph, "slot:budget_spent");
  const remainingNode = selectBestNodeByKey(graph, "slot:budget_remaining");
  const pendingNode = selectBestNodeByKey(graph, "slot:budget_pending");

  const totalCny = parseCnyAmountFromStatement(String(budgetNode?.statement || ""));
  const spentCny = parseCnyAmountFromStatement(String(spentNode?.statement || ""));
  const remainingCny = parseCnyAmountFromStatement(String(remainingNode?.statement || ""));
  const pendingCny = parseCnyAmountFromStatement(String(pendingNode?.statement || ""));

  const snapshot: GraphBudgetSnapshot = {
    totalCny,
    spentCny,
    remainingCny,
    pendingCny,
    totalEvidence: cleanStatement(String(budgetNode?.statement || ""), 80) || undefined,
    spentEvidence: cleanStatement(String(spentNode?.statement || ""), 80) || undefined,
    pendingEvidence: cleanStatement(String(pendingNode?.statement || ""), 80) || undefined,
  };

  if (snapshot.spentCny == null && snapshot.totalCny != null && snapshot.remainingCny != null) {
    snapshot.spentCny = Math.max(0, Math.round(snapshot.totalCny - snapshot.remainingCny));
  }
  if (snapshot.remainingCny == null && snapshot.totalCny != null && snapshot.spentCny != null) {
    snapshot.remainingCny = Math.max(0, Math.round(snapshot.totalCny - snapshot.spentCny));
  }
  return snapshot;
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

function readGraphDestinationSlots(graph: CDG): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of graph.nodes || []) {
    const key = String((node as any)?.key || "");
    if (!key.startsWith("slot:destination:")) continue;
    const city = normalizeDestination(key.slice("slot:destination:".length));
    if (!city || !isLikelyDestinationCandidate(city) || seen.has(city)) continue;
    seen.add(city);
    out.push(city);
  }
  return out;
}

function isLodgingFocusRefinement(text: string): boolean {
  return /(多住一点|住久一点|多待一点|多留一点|重点住|优先住|主要住)/.test(String(text || ""));
}

function hasStructuredDestinationProgress(signals: IntentSignals): boolean {
  const destinations = (signals.destinations || [])
    .map((x) => normalizeDestination(x))
    .filter((x) => x && isLikelyDestinationCandidate(x));
  if (destinations.length) return true;
  if (
    (signals.cityDurations || []).some((seg) => {
      const city = normalizeDestination(seg?.city || "");
      return !!city && isLikelyDestinationCandidate(city);
    })
  ) {
    return true;
  }
  if (
    (signals.subLocations || []).some((seg) => {
      const parentCity = normalizeDestination(seg?.parentCity || "");
      return !!parentCity && isLikelyDestinationCandidate(parentCity);
    })
  ) {
    return true;
  }
  const criticalCity = normalizeDestination(signals.criticalPresentation?.city || "");
  return !!criticalCity && isLikelyDestinationCandidate(criticalCity);
}

function hasExplicitDestinationUpdateCue(userText: string, signals: IntentSignals): boolean {
  const destinations = (signals.destinations || [])
    .map((x) => normalizeDestination(x))
    .filter((x) => x && isLikelyDestinationCandidate(x));
  if (destinations.length) return true;
  const primary = normalizeDestination(signals.destination || "");
  if (primary && isLikelyDestinationCandidate(primary)) return true;

  const text = cleanStatement(userText, 240);
  if (!text) return false;
  return (
    /(?:目的地|改成|改为|改到|换成|换到|换去|换成去|先按|就按|那就按|先以|想去|想安排|安排|规划|计划|去|到|前往|飞到|抵达)[^\n，。,；;]{0,20}[A-Za-z\u4e00-\u9fff]{2,20}/i.test(
      text
    ) ||
    /(?:这次|这趟|这轮)[^\n，。,；;]{0,8}[A-Za-z\u4e00-\u9fff]{2,20}/i.test(text)
  );
}

function preserveGraphDestinationScope(params: {
  graph: CDG;
  userText: string;
  signals: IntentSignals;
  latestSignals: IntentSignals;
}): IntentSignals {
  const graphDestinations = readGraphDestinationSlots(params.graph);
  if (!graphDestinations.length) return params.signals;
  if (hasExplicitDestinationUpdateCue(params.userText, params.latestSignals)) return params.signals;
  if (hasStructuredDestinationProgress(params.latestSignals)) return params.signals;

  const currentDestinations = Array.from(
    new Set(
      (params.signals.destinations || [])
        .map((x) => normalizeDestination(x))
        .filter((x) => x && isLikelyDestinationCandidate(x))
    )
  ).slice(0, 8);
  const polluted = currentDestinations.some((city) => !graphDestinations.includes(city));
  if (currentDestinations.length && !polluted) return params.signals;

  const evidenceByCity = new Map<string, string>();
  (params.signals.destinations || []).forEach((city, index) => {
    const normalized = normalizeDestination(city);
    const evidence = cleanStatement(
      params.signals.destinationEvidences?.[index] || params.signals.destinationEvidence || city || "",
      60
    );
    if (normalized && evidence && !evidenceByCity.has(normalized)) evidenceByCity.set(normalized, evidence);
  });

  return {
    ...params.signals,
    destinations: graphDestinations.slice(0, 8),
    destination: graphDestinations[0],
    destinationEvidences: graphDestinations.slice(0, 8).map((city) => evidenceByCity.get(city) || city),
    destinationEvidence: evidenceByCity.get(graphDestinations[0]) || graphDestinations[0],
  };
}

function mergeRemovedDestinations(...lists: Array<string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const item of list || []) {
      const city = normalizeDestination(String(item || ""));
      if (!city || !isLikelyDestinationCandidate(city) || seen.has(city)) continue;
      seen.add(city);
      merged.push(city);
    }
  }
  return merged.length ? merged : undefined;
}

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter(
    (n) => n.type === "belief" && (String((n as any).key || "").startsWith("slot:goal") || n.layer === "intent")
  );
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
            type: "belief",
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
          type: "factual_assertion",
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
    accumulatedHistorySignals = mergeIntentSignals(accumulatedHistorySignals, turnSignals, params.locale);
  }
  const latestSignals = extractIntentSignals(params.userText, { locale: params.locale });
  const textSignals = mergeIntentSignals(accumulatedHistorySignals, latestSignals, params.locale);
  const explicitRemovedDestinations = mergeRemovedDestinations(
    latestSignals.removedDestinations,
    textSignals.removedDestinations
  );
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
        signals = mergeIntentSignals(slotResult.signals, textSignals, params.locale);
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
          signals.durationEvidence =
            textSignals.durationEvidence ||
            signals.durationEvidence ||
            (isEnglishLocale(params.locale) ? `${textDays} days` : `${textDays}天`);
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

  if (explicitRemovedDestinations?.length) {
    signals.removedDestinations = mergeRemovedDestinations(
      signals.removedDestinations,
      explicitRemovedDestinations
    );
  }

  signals = sanitizeIntentSignals(signals);

  if (isLodgingFocusRefinement(params.userText)) {
    const removed = new Set((signals.removedDestinations || []).map((x) => normalizeDestination(x)).filter(Boolean));
    const preservedGraphDestinations = readGraphDestinationSlots(params.graph).filter((x) => !removed.has(x));
    if (preservedGraphDestinations.length) {
      const evidenceByCity = new Map<string, string>();
      (signals.destinations || []).forEach((city, index) => {
        const normalized = normalizeDestination(city);
        const evidence = String(signals.destinationEvidences?.[index] || signals.destinationEvidence || city || "");
        if (normalized && evidence && !evidenceByCity.has(normalized)) evidenceByCity.set(normalized, evidence);
      });
      for (const city of preservedGraphDestinations) {
        if (!evidenceByCity.has(city)) evidenceByCity.set(city, city);
      }
      const mergedDestinations = Array.from(
        new Set([...preservedGraphDestinations, ...(signals.destinations || []).map((x) => normalizeDestination(x)).filter(Boolean)])
      ).filter((x) => !removed.has(x));
      if (mergedDestinations.length) {
        signals.destinations = mergedDestinations.slice(0, 8);
        signals.destination = signals.destinations[0];
        signals.destinationEvidences = signals.destinations.map((city) => evidenceByCity.get(city) || city);
        signals.destinationEvidence = signals.destinationEvidences[0] || signals.destination;
      }
    }
  }

  signals = preserveGraphDestinationScope({
    graph: params.graph,
    userText: params.userText,
    signals,
    latestSignals,
  });

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

  const latestBudgetTouched =
    latestSignals.budgetCny != null ||
    latestSignals.budgetDeltaCny != null ||
    latestSignals.budgetSpentCny != null ||
    latestSignals.budgetSpentDeltaCny != null ||
    latestSignals.budgetRemainingCny != null ||
    latestSignals.budgetPendingCny != null;

  // If the latest user turn does not mention budget, keep budget slots from the
  // currently saved graph as source of truth. This preserves manual graph edits
  // (e.g., manually corrected remaining budget) across non-budget turns.
  if (!latestBudgetTouched) {
    const graphBudget = readGraphBudgetSnapshot(params.graph);
    if (graphBudget.totalCny != null) {
      signals.budgetCny = graphBudget.totalCny;
      signals.budgetEvidence = graphBudget.totalEvidence || signals.budgetEvidence;
    }
    if (graphBudget.spentCny != null) {
      signals.budgetSpentCny = graphBudget.spentCny;
      signals.budgetSpentEvidence = graphBudget.spentEvidence || signals.budgetSpentEvidence;
    }
    if (graphBudget.remainingCny != null) {
      signals.budgetRemainingCny = graphBudget.remainingCny;
    } else if (signals.budgetCny != null && signals.budgetSpentCny != null) {
      signals.budgetRemainingCny = Math.max(0, Math.round(Number(signals.budgetCny) - Number(signals.budgetSpentCny)));
    }
    if (graphBudget.pendingCny != null) {
      signals.budgetPendingCny = graphBudget.pendingCny;
      signals.budgetPendingEvidence = graphBudget.pendingEvidence || signals.budgetPendingEvidence;
    }
    signals.budgetImportance = Math.max(Number(signals.budgetImportance) || 0, 0.88);
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
