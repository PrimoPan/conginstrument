// src/services/graphUpdater.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG, GraphPatch, Severity, Strength } from "../core/graph.js";
import { inferNodeLayer, normalizeNodeLayer } from "../core/nodeLayer.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";
import {
  HARD_CONSTRAINT_RE,
  ITINERARY_NOISE_RE,
  RISK_HEALTH_RE,
  STRUCTURED_PREFIX_RE,
} from "./graphUpdater/constants.js";
import { cleanStatement, mergeEvidence, mergeTags, mergeTextSegments } from "./graphUpdater/text.js";
import {
  buildTravelIntentStatement,
  extractIntentSignals,
  extractIntentSignalsWithRecency,
  mergeIntentSignals,
  type IntentSignals,
  normalizePreferenceStatement,
} from "./graphUpdater/intentSignals.js";
import { resolveIntentSignalsGeo } from "./graphUpdater/geoResolver.js";
import {
  isHealthConstraintNode,
  isValidAtomicNode,
  isValidBudgetStatement,
  isValidCityDurationStatement,
  isValidDestinationStatement,
  isValidPeopleStatement,
  isValidTotalDurationStatement,
  normalizeIncomingNode,
  scoreHealthNode,
} from "./graphUpdater/nodeNormalization.js";
import { extractBetween, makeTempId, safeJsonParse } from "./graphUpdater/common.js";
import { extractIntentSignalsByFunctionCall } from "./graphUpdater/slotFunctionCall.js";
import {
  buildHeuristicIntentOps,
  shouldNormalizeGoalStatement,
} from "./graphUpdater/heuristicOps.js";
import {
  inferEvidenceFromStatement,
  pickRootGoalId,
  statementDedupKey,
} from "./graphUpdater/graphOpsHelpers.js";
import { GRAPH_SYSTEM_PROMPT } from "./graphUpdater/prompt.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph]", ...args);
}

const PATCH_START = "<<<PATCH_JSON>>>";
const PATCH_END = "<<<END_PATCH_JSON>>>";

// 你可以给建图单独指定模型（更稳/更便宜都行）
const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;
const USE_FUNCTION_SLOT_EXTRACTION = process.env.CI_GRAPH_USE_FUNCTION_SLOTS !== "0";
const ALLOW_PATCH_LLM_WITH_SLOTS = process.env.CI_GRAPH_PATCH_LLM_WITH_SLOTS === "1";

function withNodeLayer<T extends Record<string, any>>(node: T): T {
  const layer = normalizeNodeLayer(node?.layer) || inferNodeLayer(node);
  return { ...node, layer } as T;
}

function inferRiskMeta(statement: string): { severity: Severity; importance: number; tags: string[] } | null {
  const s = cleanStatement(statement, 300);
  if (!s) return null;
  if (!RISK_HEALTH_RE.test(s)) return null;

  const critical = /心脏|冠心|心血管|急救|cardiac|heart/i.test(s);
  return {
    severity: critical ? "critical" : "high",
    importance: 0.9,
    tags: ["health"],
  };
}

function inferFallbackNodeType(userText: string): "constraint" | "fact" {
  const s = cleanStatement(userText, 300);
  if (HARD_CONSTRAINT_RE.test(s) || RISK_HEALTH_RE.test(s)) return "constraint";
  return "fact";
}


function isStructuredStatement(statement: string) {
  return STRUCTURED_PREFIX_RE.test(cleanStatement(statement, 200));
}

function isLikelyNarrativeNoise(statement: string, type?: string) {
  const s = cleanStatement(statement, 240);
  if (!s) return true;
  if (type === "goal") return false;
  if (isStructuredStatement(s)) return false;
  if (RISK_HEALTH_RE.test(s) || normalizePreferenceStatement(s)) return false;
  if (s.length >= 30) return true;
  if (ITINERARY_NOISE_RE.test(s) && s.length >= 16) return true;
  return false;
}

function isStrategicNode(node: any) {
  const s = cleanStatement(node?.statement || "", 160);
  if (!s) return false;
  if (String(node?.type || "") === "goal") return true;
  if (isHealthConstraintNode(node)) return true;
  if (isStructuredStatement(s)) return true;
  return false;
}

function shouldAutoAttachToRoot(node: {
  type?: string;
  statement?: string;
  severity?: string;
  importance?: number;
}) {
  const s = cleanStatement(node?.statement || "", 180);
  if (!s) return false;
  if (/^子地点[:：]/.test(s)) return false;
  if (isStructuredStatement(s)) return true;
  if (/^健康约束[:：]/.test(s)) return true;
  if (String(node?.severity || "") === "high" || String(node?.severity || "") === "critical") return true;
  if ((Number(node?.importance) || 0) >= 0.82) return true;
  if (String(node?.type || "") === "preference" && /偏好|喜欢|不喜欢|人文|自然/.test(s)) return true;
  return false;
}


function enrichNodeRisk(node: any) {
  if (!node || typeof node !== "object") return node;

  const statement = cleanStatement(node.statement);
  if (!statement) return node;

  const out: any = { ...node, statement };
  const risk = inferRiskMeta(statement);

  if (risk) {
    out.severity = out.severity || risk.severity;
    out.importance = out.importance != null ? Math.max(Number(out.importance) || 0, risk.importance) : risk.importance;
    out.tags = mergeTags(out.tags, risk.tags);
  }

  if (out.type === "constraint" && HARD_CONSTRAINT_RE.test(statement) && !out.strength) {
    out.strength = "hard";
  }

  return out;
}

function enrichPatchRiskAndText(patch: GraphPatch, latestUserText: string): GraphPatch {
  const ops = (patch.ops || []).map((op: any) => {
    if (op?.op === "add_node" && op.node) {
      const node = enrichNodeRisk(op.node);
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, node?.statement || "");
      return {
        ...op,
        node: {
          ...node,
          evidenceIds: mergeEvidence(node?.evidenceIds, inferredEvidence),
          sourceMsgIds: mergeEvidence(node?.sourceMsgIds, ["latest_user"]),
        },
      };
    }
    if (op?.op === "update_node" && op.patch && typeof op.patch === "object") {
      const p = { ...op.patch };
      if (typeof p.statement === "string") p.statement = cleanStatement(p.statement);
      const risk = inferRiskMeta(p.statement);
      if (risk) {
        p.severity = p.severity || risk.severity;
        p.importance = p.importance != null ? Math.max(Number(p.importance) || 0, risk.importance) : risk.importance;
        p.tags = mergeTags(p.tags, risk.tags);
      }
      if (p.statement && HARD_CONSTRAINT_RE.test(p.statement) && !p.strength) p.strength = "hard";
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, p.statement || "");
      p.evidenceIds = mergeEvidence(p.evidenceIds, inferredEvidence);
      p.sourceMsgIds = mergeEvidence(p.sourceMsgIds, ["latest_user"]);
      return { ...op, patch: p };
    }
    return op;
  });

  return { ...patch, ops };
}

function fallbackPatch(graph: CDG, userText: string, reason: string): GraphPatch {
  const root = pickRootGoalId(graph);
  const short = cleanStatement(userText, 140);
  const signals = extractIntentSignals(userText);
  const canonicalIntent = buildTravelIntentStatement(signals, userText);

  if (!root) {
    return {
      ops: [
        {
          op: "add_node",
          node: withNodeLayer({
            id: makeTempId("n"),
            type: "goal",
            statement: canonicalIntent || short || "未提供任务",
            status: "proposed",
            confidence: canonicalIntent ? 0.85 : 0.55,
            evidenceIds: [signals.destinationEvidence, signals.durationEvidence, signals.budgetEvidence, signals.peopleEvidence].filter(
              (x): x is string => Boolean(x)
            ),
            sourceMsgIds: ["latest_user"],
          }),
        },
      ],
      notes: [`fallback_patch:${reason}`],
    };
  }

  const nid = makeTempId("n");
  const nodeType = inferFallbackNodeType(short);
  const risk = inferRiskMeta(short);
  return {
    ops: [
      {
        op: "add_node",
        node: withNodeLayer({
          id: nid,
          type: nodeType,
          statement: short || "未提供补充信息",
          status: "proposed",
          confidence: 0.55,
          strength: (nodeType === "constraint" ? "hard" : undefined) as Strength | undefined,
          severity: risk?.severity,
          importance: risk?.importance,
          tags: risk?.tags,
          evidenceIds: [signals.healthEvidence, signals.budgetEvidence, signals.durationEvidence, signals.destinationEvidence, signals.peopleEvidence].filter(
            (x): x is string => Boolean(x)
          ),
          sourceMsgIds: ["latest_user"],
        }),
      },
      {
        op: "add_edge",
        edge: {
          id: makeTempId("e"),
          from: nid,
          to: root,
          type: nodeType === "constraint" ? "constraint" : "enable",
          confidence: 0.55,
        },
      },
    ],
    notes: [`fallback_patch:${reason}`],
  };
}

/** 后处理：去重 + 自动补边 + 限制 op 数量 */
async function postProcessPatch(
  graph: CDG,
  patch: GraphPatch,
  latestUserText: string,
  recentTurns?: Array<{ role: "user" | "assistant"; content: string }>,
  seedSignals?: IntentSignals
): Promise<GraphPatch> {
  const signalText = mergeTextSegments([
    ...((recentTurns || [])
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .slice(-6)),
    latestUserText,
  ]);
  const enriched = enrichPatchRiskAndText(patch, latestUserText);
  const textSignals = extractIntentSignalsWithRecency(signalText, latestUserText);
  // Prefer deterministic text parser on conflicting scalar slots (e.g., total duration),
  // while still preserving function-call slots as fallback for missing values.
  let signals = seedSignals ? mergeIntentSignals(seedSignals, textSignals) : textSignals;
  try {
    signals = await resolveIntentSignalsGeo({
      signals,
      latestUserText,
      recentTurns,
    });
  } catch (e: any) {
    dlog("geo resolver failed:", e?.message || e);
  }
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);
  const existingByStmt = new Map<string, string>();
  for (const n of graph.nodes || []) {
    const key = statementDedupKey(n.statement, (n as any).type);
    if (key) existingByStmt.set(key, n.id);
  }

  const knownStmt = new Set<string>(existingByStmt.keys());
  for (const op of enriched.ops || []) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = statementDedupKey(op.node.statement, op.node.type);
      if (key) knownStmt.add(key);
    }
  }

  const heuristicOps = buildHeuristicIntentOps({
    graph,
    signalText,
    latestUserText,
    knownStmt,
    seedOps: enriched.ops || [],
    signals,
    withNodeLayer,
    isStrategicNode,
  });
  const mergedOps = [...(enriched.ops || []), ...heuristicOps].map((op: any) => {
    if (
      canonicalIntent &&
      op?.op === "add_node" &&
      op?.node?.type === "goal" &&
      typeof op?.node?.statement === "string" &&
      shouldNormalizeGoalStatement(op.node.statement, signals, signalText)
    ) {
      return {
        ...op,
        node: {
          ...op.node,
          statement: canonicalIntent,
          layer: "intent",
          confidence: Math.max(Number(op.node.confidence) || 0.6, 0.85),
          importance: op.node.importance != null ? Math.max(Number(op.node.importance) || 0, 0.8) : 0.8,
        },
      };
    }
    return op;
  });

  const existingHealthId = (graph.nodes || []).find(isHealthConstraintNode)?.id || null;
  const healthAdds = (mergedOps || []).filter(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any[];
  const keepHealthAddId =
    !existingHealthId && healthAdds.length
      ? [...healthAdds].sort((a, b) => scoreHealthNode(b.node) - scoreHealthNode(a.node))[0]?.node?.id || null
      : null;
  const healthMainId = existingHealthId || keepHealthAddId;
  const idRemap = new Map<string, string>();
  if (healthMainId) {
    for (const op of healthAdds) {
      const sid = String(op?.node?.id || "");
      if (!sid || sid === healthMainId) continue;
      idRemap.set(sid, healthMainId);
    }
  }

  const root = pickRootGoalId(graph);
  const newStmt = new Set<string>();
  const newStmtId = new Map<string, string>();
  const newNodes: Array<{
    id: string;
    type: string;
    layer?: string;
    statement: string;
    severity?: string;
    importance?: number;
  }> = [];
  const keptAddIds = new Set<string>();
  const edgePairs = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  const prepped = (mergedOps || []).reduce<any[]>((acc, op: any) => {
    if (op?.op === "add_node" && op?.node) {
      const normalizedNode = normalizeIncomingNode(op.node, {
        signalText,
        latestUserText,
        withNodeLayer,
        isLikelyNarrativeNoise,
        isStructuredStatement,
      });
      if (!normalizedNode) return acc;
      if (!isValidAtomicNode(normalizedNode)) return acc;
      const sid = String(normalizedNode.id || op.node.id || "");
      if (sid && idRemap.has(sid)) return acc;
      acc.push({
        ...op,
        node: { ...normalizedNode, id: sid || op.node.id },
      });
      return acc;
    }
    if (op?.op === "update_node" && op?.patch && typeof op.patch === "object") {
      const patchObj: any = { ...op.patch };
      if (typeof patchObj.statement === "string") {
        const normalizedPatch = normalizeIncomingNode(
          { type: patchObj.type || "fact", ...patchObj, statement: patchObj.statement },
          {
            signalText,
            latestUserText,
            withNodeLayer,
            isLikelyNarrativeNoise,
            isStructuredStatement,
          }
        );
        if (!normalizedPatch) {
          delete patchObj.statement;
        } else {
          const s = cleanStatement(normalizedPatch.statement);
          if (
            !isValidDestinationStatement(s) ||
            !isValidPeopleStatement(s) ||
            !isValidBudgetStatement(s) ||
            !isValidTotalDurationStatement(s) ||
            !isValidCityDurationStatement(s)
          ) {
            delete patchObj.statement;
          } else {
            patchObj.statement = s;
            if (normalizedPatch.layer) patchObj.layer = normalizedPatch.layer;
            if (normalizedPatch.strength) patchObj.strength = normalizedPatch.strength;
            if (normalizedPatch.severity) patchObj.severity = normalizedPatch.severity;
            if (normalizedPatch.importance != null) patchObj.importance = normalizedPatch.importance;
            if (normalizedPatch.tags) patchObj.tags = normalizedPatch.tags;
            if (normalizedPatch.locked != null) patchObj.locked = normalizedPatch.locked;
          }
        }
      }
      if (!Object.keys(patchObj).length) return acc;
      acc.push({
        ...op,
        id: idRemap.get(String(op.id || "")) || op.id,
        patch: patchObj,
      });
      return acc;
    }
    if (op?.op === "add_edge" && op?.edge) {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) return acc;
      const key = `${from}|${to}|${op.edge.type}`;
      if (edgePairs.has(key)) return acc;
      edgePairs.add(key);
      acc.push({
        ...op,
        edge: { ...op.edge, from, to },
      });
      return acc;
    }
    acc.push(op);
    return acc;
  }, []);

  const determineOutCount = new Map<string, number>();
  const sparsePrepped: any[] = [];
  for (const op of prepped) {
    if (op?.op !== "add_edge" || op?.edge?.type !== "determine") {
      sparsePrepped.push(op);
      continue;
    }
    const from = String(op.edge.from || "");
    const next = (determineOutCount.get(from) || 0) + 1;
    if (next > 2) continue;
    determineOutCount.set(from, next);
    sparsePrepped.push(op);
  }

  for (const op of sparsePrepped) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = statementDedupKey(op.node.statement, op.node.type);
      if (!key) continue;
      const existedId = existingByStmt.get(key);
      if (existedId) {
        idRemap.set(op.node.id, existedId);
        continue;
      }
      if (newStmt.has(key)) {
        const mapped = newStmtId.get(key);
        if (mapped) idRemap.set(op.node.id, mapped);
        continue;
      }
      newStmt.add(key);
      newStmtId.set(key, op.node.id);
      keptAddIds.add(op.node.id);
      newNodes.push({
        id: op.node.id,
        type: op.node.type,
        layer: op.node.layer,
        statement: cleanStatement(op.node.statement || "", 180),
        severity: op.node.severity,
        importance: op.node.importance,
      });
      continue;
    }
  }

  const kept: any[] = [];
  const addedEdgeKeys = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  for (const op of sparsePrepped) {
    if (op?.op === "add_node") {
      if (keptAddIds.has(op.node.id)) kept.push(op);
      continue;
    }
    if (op?.op === "update_node") {
      const mappedId = idRemap.get(String(op.id || "")) || op.id;
      if (!mappedId) continue;
      kept.push({ ...op, id: mappedId });
      continue;
    }
    if (op?.op === "add_edge") {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) continue;
      const key = `${from}|${to}|${op.edge.type}`;
      if (addedEdgeKeys.has(key)) continue;
      addedEdgeKeys.add(key);
      kept.push({ ...op, edge: { ...op.edge, from, to } });
      continue;
    }
    kept.push(op);
  }

  const rootForEdge =
    root ||
    (kept.find((x: any) => x?.op === "add_node" && x?.node?.type === "goal" && typeof x?.node?.id === "string")
      ?.node?.id as string | undefined) ||
    null;

  if (rootForEdge) {
    const hasEdge = (from: string, to: string) =>
      kept.some((x) => x?.op === "add_edge" && x?.edge?.from === from && x?.edge?.to === to);

    let k = 1;
    let autoAttachCount = 0;
    for (const n of newNodes) {
      if (autoAttachCount >= 4) break;
      if (!["constraint", "preference", "fact", "belief"].includes(n.type)) continue;
      if (!shouldAutoAttachToRoot(n)) continue;
      if (hasEdge(n.id, rootForEdge)) continue;
      kept.push({
        op: "add_edge",
        edge: {
          id: makeTempId(`e_auto${k++}`),
          from: n.id,
          to: rootForEdge,
          type: n.type === "constraint" ? "constraint" : "enable",
          confidence: 0.65,
        },
      });
      autoAttachCount += 1;
    }
  }

  return { ops: kept.slice(0, 24), notes: (enriched.notes || []).slice(0, 16) };
}

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const rootGoalId = pickRootGoalId(params.graph);

  let slotSignals: IntentSignals | undefined;
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
        slotSignals = slotResult.signals;
      }
    } catch (e: any) {
      dlog("slot function call failed:", e?.message || e);
    }
  }

  const modelInput = {
    root_goal_id: rootGoalId,
    current_graph: params.graph,
    recent_dialogue: params.recentTurns,
    latest_turn: { user: params.userText, assistant: params.assistantText },
  };

  let basePatch: GraphPatch;
  const shouldRunPatchLlm = !slotSignals || ALLOW_PATCH_LLM_WITH_SLOTS;
  if (!shouldRunPatchLlm) {
    basePatch = { ops: [], notes: ["slot_function_call_only"] };
  } else {
    const resp = await openai.chat.completions.create({
      model: GRAPH_MODEL,
      messages: [
        { role: "system", content: GRAPH_SYSTEM_PROMPT },
        ...(params.systemPrompt
          ? [{ role: "system" as const, content: `任务补充（可参考）：\n${String(params.systemPrompt).trim()}` }]
          : []),
        {
          role: "user",
          content:
            `输入如下（JSON）。只输出分隔符包裹的 patch JSON：\n` + JSON.stringify(modelInput),
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
    });

    const raw = String(resp.choices?.[0]?.message?.content ?? "");
    dlog("raw_len=", raw.length, "finish=", resp.choices?.[0]?.finish_reason);

    const jsonText = extractBetween(raw, PATCH_START, PATCH_END);
    if (!jsonText) {
      dlog("missing markers -> fallback");
      basePatch = fallbackPatch(params.graph, params.userText, "missing_markers");
    } else {
      const parsed = safeJsonParse(jsonText);
      if (!parsed) {
        dlog("invalid json -> fallback");
        basePatch = fallbackPatch(params.graph, params.userText, "invalid_json");
      } else {
        // ✅ 核心：严格白名单清洗（默认禁止 remove）
        const strict = sanitizeGraphPatchStrict(parsed);
        if (!strict.ops.length) {
          dlog("empty strict ops -> fallback");
          basePatch = fallbackPatch(params.graph, params.userText, "empty_ops");
        } else {
          basePatch = strict;
        }
      }
    }
  }

  const post = await postProcessPatch(
    params.graph,
    basePatch,
    params.userText,
    params.recentTurns,
    slotSignals
  );
  if (!post.ops.length) {
    return fallbackPatch(params.graph, params.userText, "post_empty_ops");
  }

  // 打印 op 概览，定位“为什么图被清空”
  if (DEBUG) {
    const counts: Record<string, number> = {};
    for (const op of post.ops) counts[op.op] = (counts[op.op] || 0) + 1;
    dlog("ops_counts=", counts, "notes=", post.notes);
  }

  return post;
}
