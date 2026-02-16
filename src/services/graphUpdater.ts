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
  type IntentSignals,
  isTravelIntentText,
  normalizeDestination,
  normalizePreferenceStatement,
} from "./graphUpdater/intentSignals.js";
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

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph]", ...args);
}

const PATCH_START = "<<<PATCH_JSON>>>";
const PATCH_END = "<<<END_PATCH_JSON>>>";

// 你可以给建图单独指定模型（更稳/更便宜都行）
const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;

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

function inferEvidenceFromStatement(userText: string, statement: string): string[] | undefined {
  const t = String(userText || "");
  const s = cleanStatement(statement, 120);
  if (!t || !s) return undefined;

  const colonIdx = s.indexOf("：");
  if (colonIdx > 0) {
    const rhs = cleanStatement(s.slice(colonIdx + 1), 40);
    if (rhs && t.includes(rhs)) return [rhs];
  }

  const words = s
    .split(/[，。,；;、\s]/)
    .map((x) => cleanStatement(x, 24))
    .filter((x) => x.length >= 2);

  const hit = words.find((w) => t.includes(w));
  if (hit) return [hit];

  if (t.includes(s)) return [s];
  return undefined;
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
  if (isStructuredStatement(s)) return true;
  if (/^健康约束[:：]/.test(s)) return true;
  if (String(node?.severity || "") === "high" || String(node?.severity || "") === "critical") return true;
  if ((Number(node?.importance) || 0) >= 0.82) return true;
  if (String(node?.type || "") === "preference" && /偏好|喜欢|不喜欢|人文|自然/.test(s)) return true;
  return false;
}


function statementDedupKey(statement: string, type?: string) {
  const core = normalizeForMatch(statement);
  if (!core) return "";
  const t = String(type || "").trim().toLowerCase();
  return t ? `${t}|${core}` : core;
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

function shouldNormalizeGoalStatement(statement: string, signals: IntentSignals, userText: string) {
  const s = cleanStatement(statement, 240);
  const tooLong = s.length >= 26;
  const mixed = /预算|一家|同行|元|天|计划|制定|一起|人|心脏|健康|限制/i.test(s);
  return isTravelIntentText(userText, signals) && (tooLong || mixed);
}

function buildHeuristicIntentOps(
  graph: CDG,
  signalText: string,
  latestUserText: string,
  knownStmt: Set<string>,
  seedOps: GraphPatch["ops"]
): GraphPatch["ops"] {
  const ops: GraphPatch["ops"] = [];
  const signals = extractIntentSignalsWithRecency(signalText, latestUserText);
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);

  const edgePairs = new Set<string>();
  for (const e of graph.edges || []) {
    edgePairs.add(`${e.from}|${e.to}|${e.type}`);
  }

  let rootId: string | null = pickRootGoalId(graph);
  const layer2Set = new Set<string>();
  if (rootId) {
    const nodesById = new Map((graph.nodes || []).map((n: any) => [n.id, n]));
    for (const e of graph.edges || []) {
      if (e?.to === rootId && (e.type === "enable" || e.type === "constraint" || e.type === "determine")) {
        const n = nodesById.get(e.from);
        if (isStrategicNode(n)) layer2Set.add(e.from);
      }
    }
  }

  const pushNode = (node: any): string | null => {
    const statement = cleanStatement(node.statement);
    if (!statement) return null;
    const key = statementDedupKey(statement, node?.type);
    if (!key || knownStmt.has(key)) return null;
    knownStmt.add(key);
    const id = makeTempId("n");
    const nodeWithLayer = withNodeLayer({ ...node, statement });
    const evidenceIds = mergeEvidence(
      nodeWithLayer.evidenceIds,
      inferEvidenceFromStatement(latestUserText, statement) || inferEvidenceFromStatement(signalText, statement)
    );
    const sourceMsgIds = mergeEvidence(nodeWithLayer.sourceMsgIds, ["latest_user"]);
    ops.push({
      op: "add_node",
      node: { ...nodeWithLayer, id, statement, evidenceIds, sourceMsgIds },
    });
    return id;
  };

  const pushEdge = (from: string, to: string, type: "enable" | "constraint" | "determine") => {
    const k = `${from}|${to}|${type}`;
    if (edgePairs.has(k)) return;
    edgePairs.add(k);
    ops.push({
      op: "add_edge",
      edge: {
        id: makeTempId("e"),
        from,
        to,
        type,
        confidence: 0.75,
      },
    });
  };

  // 无 root 时强制补一个目标节点，避免图断连。
  if (!rootId) {
    const fallbackIntent = canonicalIntent || "意图：制定旅行计划";
    const existingGoal = (graph.nodes || []).find(
      (n: any) => n?.type === "goal" && normalizeForMatch(n.statement) === normalizeForMatch(fallbackIntent)
    );
    if (existingGoal?.id) {
      rootId = existingGoal.id;
    } else {
      rootId = pushNode({
        type: "goal",
        statement: fallbackIntent,
        layer: "intent",
        status: "proposed",
        confidence: 0.9,
        importance: 0.85,
        evidenceIds: [
          ...(signals.destinationEvidences || []),
          signals.destinationEvidence,
          signals.durationEvidence,
          signals.durationUnknownEvidence,
          signals.budgetEvidence,
          signals.peopleEvidence,
        ].filter((x): x is string => Boolean(x)),
      });
    }
  }
  if (rootId && canonicalIntent) {
    const rootNode = (graph.nodes || []).find((n: any) => n.id === rootId);
    if (rootNode?.statement && shouldNormalizeGoalStatement(rootNode.statement, signals, signalText)) {
      ops.push({
        op: "update_node",
        id: rootId,
        patch: {
          statement: canonicalIntent,
          layer: "intent",
          confidence: Math.max(Number(rootNode.confidence) || 0.6, 0.85),
          importance: Math.max(Number(rootNode.importance) || 0, 0.8),
          evidenceIds: mergeEvidence(
            rootNode.evidenceIds,
            [
              ...(signals.destinationEvidences || []),
              signals.destinationEvidence,
              signals.durationEvidence,
              signals.durationUnknownEvidence,
              signals.budgetEvidence,
              signals.peopleEvidence,
            ].filter((x): x is string => Boolean(x))
          ),
          sourceMsgIds: mergeEvidence(rootNode.sourceMsgIds, ["latest_user"]),
        },
      } as any);
    }
  }

  if (signals.peopleCount) {
    const id = pushNode({
      type: "fact",
      statement: `同行人数：${signals.peopleCount}人`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.72,
      evidenceIds: [signals.peopleEvidence || `${signals.peopleCount}人`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "enable");
  }

  const destinationNodeIds = new Map<string, string>();
  const destinationList = ([...(signals.destinations || []), ...(signals.destination ? [signals.destination] : [])] as string[])
    .map((x) => normalizeDestination(x))
    .filter((x, i, arr) => x && arr.indexOf(x) === i);
  for (let i = 0; i < destinationList.length; i += 1) {
    const city = destinationList[i];
    const evidence = signals.destinationEvidences?.[i] || signals.destinationEvidence || city;
    const id = pushNode({
      type: "fact",
      statement: `目的地：${city}`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.8,
      evidenceIds: [evidence],
    });
    if (!id) continue;
    destinationNodeIds.set(city, id);
    layer2Set.add(id);
    if (rootId) pushEdge(id, rootId, "enable");
  }

  if (signals.durationDays) {
    const id = pushNode({
      type: "constraint",
      statement: `总行程时长：${signals.durationDays}天`,
      strength: "hard",
      status: "proposed",
      confidence: 0.88,
      importance: 0.78,
      evidenceIds: [signals.durationEvidence || `${signals.durationDays}天`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }
  if (!signals.durationDays && signals.durationUnknown) {
    const id = pushNode({
      type: "question",
      statement: "行程时长：待确认",
      status: "proposed",
      confidence: 0.78,
      importance: 0.62,
      evidenceIds: [signals.durationUnknownEvidence || "几天"],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "determine");
  }

  for (const seg of signals.cityDurations || []) {
    const city = normalizeDestination(seg.city);
    if (!city) continue;
    const stmt = `城市时长：${city} ${seg.days}天`;
    const id = pushNode({
      type: "fact",
      statement: stmt,
      status: "proposed",
      confidence: seg.kind === "meeting" ? 0.9 : 0.84,
      importance: seg.kind === "meeting" ? 0.82 : 0.72,
      tags: seg.kind === "meeting" ? ["meeting"] : ["travel"],
      evidenceIds: [seg.evidence || `${city}${seg.days}天`],
    });
    if (!id) continue;
    layer2Set.add(id);
    const cityDestinationId = destinationNodeIds.get(city);
    if (cityDestinationId) pushEdge(id, cityDestinationId, "determine");
    else if (rootId) pushEdge(id, rootId, "determine");
  }

  if (signals.criticalPresentation) {
    const p = signals.criticalPresentation;
    const city = p.city ? normalizeDestination(p.city) : "";
    const reason = cleanStatement(p.reason || "关键事项", 20);
    const label = city ? `${city}${reason}（${p.days}天）` : `${reason}（${p.days}天）`;
    const reasonTags = /会议|汇报|论文|演讲|报告|presentation|talk/i.test(reason)
      ? ["meeting", "presentation", "deadline"]
      : ["hard_day", "must_do"];
    const id = pushNode({
      type: "constraint",
      statement: `会议关键日：${label}`,
      strength: "hard",
      status: "proposed",
      confidence: 0.94,
      severity: "critical",
      importance: 0.98,
      tags: reasonTags,
      evidenceIds: [p.evidence || `${reason}${p.days}天`],
    });
    if (id) {
      layer2Set.add(id);
      if (rootId) pushEdge(id, rootId, "constraint");
      if (city) {
        const cityDestinationId = destinationNodeIds.get(city);
        if (cityDestinationId) pushEdge(id, cityDestinationId, "determine");
      }
    }
  }

  if (signals.budgetCny) {
    const id = pushNode({
      type: "constraint",
      statement: `预算上限：${signals.budgetCny}元`,
      strength: "hard",
      status: "proposed",
      confidence: 0.92,
      importance: 0.86,
      evidenceIds: [signals.budgetEvidence || `${signals.budgetCny}元`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }

  if (signals.scenicPreference) {
    const hardPref = !!signals.scenicPreferenceHard;
    const prefType = hardPref ? "constraint" : "preference";
    const id = pushNode({
      type: prefType,
      statement: signals.scenicPreference,
      strength: hardPref ? "hard" : "soft",
      status: "proposed",
      confidence: hardPref ? 0.88 : 0.82,
      severity: "medium",
      importance: hardPref ? 0.8 : 0.68,
      tags: ["preference", "culture"],
      evidenceIds: [signals.scenicPreferenceEvidence || signals.scenicPreference],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, hardPref ? "constraint" : "enable");
  }

  let healthId: string | null = null;
  const existingHealth = (graph.nodes || []).find(isHealthConstraintNode);
  const existingHealthInSeed = (seedOps || []).find(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any;
  if (existingHealthInSeed?.node?.id) {
    healthId = existingHealthInSeed.node.id;
  } else if (existingHealth?.id) {
    healthId = existingHealth.id;
  }

  if (signals.healthConstraint) {
    const healthStatement = `健康约束：${signals.healthConstraint}`;
    const healthEvidence = mergeEvidence(
      [signals.healthEvidence || signals.healthConstraint],
      inferEvidenceFromStatement(latestUserText, signals.healthConstraint) ||
        inferEvidenceFromStatement(signalText, signals.healthConstraint)
    );

    if (healthId) {
      ops.push({
        op: "update_node",
        id: healthId,
        patch: {
          statement: healthStatement,
          layer: "risk",
          strength: "hard",
          status: "proposed",
          confidence: 0.95,
          severity: "critical",
          importance: 0.98,
          tags: ["health", "safety"],
          locked: true,
          evidenceIds: healthEvidence,
          sourceMsgIds: ["latest_user"],
        },
      } as any);
    } else {
      const id = pushNode({
        type: "constraint",
        statement: healthStatement,
        strength: "hard",
        status: "proposed",
        confidence: 0.95,
        severity: "critical",
        importance: 0.98,
        tags: ["health", "safety"],
        locked: true,
        evidenceIds: healthEvidence,
      });
      if (id) healthId = id;
    }
  }

  if (healthId && rootId) {
    pushEdge(healthId, rootId, "constraint");
  }
  if (healthId) {
    for (const sid of Array.from(layer2Set)) {
      if (!sid || sid === healthId) continue;
      pushEdge(sid, healthId, "determine");
    }
  }

  return ops;
}

function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^用户任务[:：]\s*/g, "")
    .replace(/^任务[:：]\s*/g, "")
    .replace(/[“”"]/g, "")
    .toLowerCase();
}

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n: any) => n?.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((g: any) => g.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((g: any) => g.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals[0].id;
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
function postProcessPatch(
  graph: CDG,
  patch: GraphPatch,
  latestUserText: string,
  recentTurns?: Array<{ role: "user" | "assistant"; content: string }>
): GraphPatch {
  const signalText = mergeTextSegments([
    ...((recentTurns || [])
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .slice(-6)),
    latestUserText,
  ]);
  const enriched = enrichPatchRiskAndText(patch, latestUserText);
  const signals = extractIntentSignalsWithRecency(signalText, latestUserText);
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

  const heuristicOps = buildHeuristicIntentOps(graph, signalText, latestUserText, knownStmt, enriched.ops || []);
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

const GRAPH_SYSTEM_PROMPT = `
你是“用户意图图（CDG）更新器”。你不与用户对话，只输出用于更新图的增量 patch。

输出协议（必须严格遵守）：
<<<PATCH_JSON>>>
{ "ops": [ ... ], "notes": [ ... ] }
<<<END_PATCH_JSON>>>
不要输出任何其他文字，不要 Markdown，不要解释。

规则：
- 默认只使用 add_node / update_node / add_edge 三种操作。
- 禁止 remove_node/remove_edge（除非用户明确要求删除且你非常确定）。
- 节点类型：goal / constraint / preference / belief / fact / question
- 节点分层：layer 可选，取值 intent / requirement / preference / risk（未提供时后端会自动推断）
- 建议映射：goal -> intent；硬约束/结构化事实 -> requirement；偏好表达 -> preference；高风险/健康/安全 -> risk
- constraint 可带 strength: hard|soft
- 若信息包含健康/安全/法律等高风险因素，务必设置 severity（high 或 critical），并可补 tags（如 ["health"]）。
- 若信息表达“不能/必须/禁忌”等限制，优先用 constraint，且 strength 优先 hard。
- 若出现“喜欢/更喜欢/不感兴趣”这类景点偏好，优先生成 preference；若用户明确“硬性要求”，可升为 constraint（通常 severity=medium）。
- statement 保持简洁，不要加“用户补充：/用户任务：”前缀。
- 旅行类请求优先拆分成原子节点：人数、目的地、时长、预算、健康限制、住宿偏好，不要把所有信息塞进一个节点。
- 目的地节点只能是地名（城市/地区名），禁止写成描述短语（如“其他时间我想逛…”）。
- “必须留一天做某事/发表/见人”属于关键约束，不等于总行程时长，不能覆盖 total duration。
- 避免把“第一天/第二天/详细行程建议”这类叙事文本直接建成节点。
- 对同一槽位（预算/时长/人数/目的地/住宿偏好）优先 update 旧节点，不要重复 add。
- 意图（goal）作为根节点，子节点尽量与根节点连通，避免孤立节点。
- 若有健康/安全硬约束，可作为第三层约束节点，第二层关键节点可用 determine 指向它。
- 非核心细节节点优先挂到相关二级节点（determine），不要全部直接连到根节点。
- 节点尽量附 evidenceIds（来自用户原句的短片段），用于前端高亮证据文本。
- 边类型：enable / constraint / determine / conflicts_with
- 去重：已有等价节点优先 update_node
- 连边克制：有 root_goal_id 时，constraint/preference/fact/belief 可以连到 root_goal_id
- 每轮 op 建议 1~6 个，少而准。
`.trim();

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const rootGoalId = pickRootGoalId(params.graph);

  const modelInput = {
    root_goal_id: rootGoalId,
    current_graph: params.graph,
    recent_dialogue: params.recentTurns,
    latest_turn: { user: params.userText, assistant: params.assistantText },
  };

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

  let basePatch: GraphPatch;
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

  const post = postProcessPatch(params.graph, basePatch, params.userText, params.recentTurns);
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
