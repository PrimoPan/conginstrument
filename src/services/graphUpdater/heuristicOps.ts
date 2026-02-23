import type { CDG, GraphPatch } from "../../core/graph.js";
import { cleanStatement, mergeEvidence } from "./text.js";
import {
  buildTravelIntentStatement,
  type IntentSignals,
  isTravelIntentText,
  normalizeDestination,
} from "./intentSignals.js";
import { isHealthConstraintNode } from "./nodeNormalization.js";
import { makeTempId } from "./common.js";
import {
  inferEvidenceFromStatement,
  normalizeForMatch,
  pickRootGoalId,
  statementDedupKey,
} from "./graphOpsHelpers.js";

export function shouldNormalizeGoalStatement(statement: string, signals: IntentSignals, userText: string) {
  const s = cleanStatement(statement, 240);
  const tooLong = s.length >= 26;
  const mixed = /预算|一家|同行|元|天|计划|制定|一起|人|心脏|健康|限制/i.test(s);
  return isTravelIntentText(userText, signals) && (tooLong || mixed);
}

function importanceWithHint(hint: any, fallback: number) {
  const n = Number(hint);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function importanceForCity(
  map: Record<string, number> | undefined,
  city: string,
  fallback: number
) {
  const key = normalizeDestination(city || "");
  if (!key || !map) return fallback;
  return importanceWithHint(map[key], fallback);
}

export function buildHeuristicIntentOps(params: {
  graph: CDG;
  signalText: string;
  latestUserText: string;
  knownStmt: Set<string>;
  seedOps: GraphPatch["ops"];
  signals: IntentSignals;
  withNodeLayer: <T extends Record<string, any>>(node: T) => T;
  isStrategicNode: (node: any) => boolean;
}): GraphPatch["ops"] {
  const {
    graph,
    signalText,
    latestUserText,
    knownStmt,
    seedOps,
    signals,
    withNodeLayer,
    isStrategicNode,
  } = params;

  const ops: GraphPatch["ops"] = [];
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
        importance: importanceWithHint(signals.goalImportance, 0.85),
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
      importance: importanceWithHint(signals.peopleImportance, 0.72),
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
      importance: importanceForCity(
        signals.destinationImportanceByCity,
        city,
        importanceWithHint(signals.destinationImportance, 0.8)
      ),
      evidenceIds: [evidence],
    });
    if (!id) continue;
    destinationNodeIds.set(city, id);
    layer2Set.add(id);
    if (rootId) pushEdge(id, rootId, "enable");
  }

  let totalDurationNodeId = "";
  if (signals.durationDays) {
    const id = pushNode({
      type: "constraint",
      statement: `总行程时长：${signals.durationDays}天`,
      strength: "hard",
      status: "proposed",
      confidence: 0.88,
      importance: importanceWithHint(signals.durationImportance, 0.78),
      evidenceIds: [signals.durationEvidence || `${signals.durationDays}天`],
    });
    if (id) totalDurationNodeId = id;
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }
  if (signals.durationBoundaryAmbiguous && signals.durationBoundaryQuestion) {
    const id = pushNode({
      type: "question",
      statement: signals.durationBoundaryQuestion,
      status: "proposed",
      confidence: 0.82,
      importance: 0.68,
      evidenceIds: [signals.durationEvidence || "日期跨度"],
    });
    if (id) layer2Set.add(id);
    if (id && totalDurationNodeId) pushEdge(id, totalDurationNodeId, "determine");
    else if (id && rootId) pushEdge(id, rootId, "determine");
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

  const cityDurationNodeIds = new Map<string, string>();
  for (const seg of signals.cityDurations || []) {
    const city = normalizeDestination(seg.city);
    if (!city) continue;
    const id = pushNode({
      type: "fact",
      statement: `城市时长：${city} ${seg.days}天`,
      status: "proposed",
      confidence: seg.kind === "meeting" ? 0.9 : 0.84,
      importance: importanceForCity(
        signals.cityDurationImportanceByCity,
        city,
        seg.kind === "meeting" ? 0.82 : 0.72
      ),
      tags: seg.kind === "meeting" ? ["meeting"] : ["travel"],
      evidenceIds: [seg.evidence || `${city}${seg.days}天`],
    });
    if (!id) continue;
    cityDurationNodeIds.set(city, id);
    layer2Set.add(id);
    const cityDestinationId = destinationNodeIds.get(city);
    if (cityDestinationId) pushEdge(id, cityDestinationId, "determine");
    else if (rootId) pushEdge(id, rootId, "determine");
  }

  for (const sub of signals.subLocations || []) {
    const name = cleanStatement(sub?.name || "", 28);
    if (!name) continue;
    const parentCity = sub?.parentCity ? normalizeDestination(sub.parentCity) : "";
    const evidence = cleanStatement(sub?.evidence || name, 64);
    const hard = !!sub?.hard;
    const id = pushNode({
      type: hard ? "constraint" : "fact",
      statement: `子地点：${name}${parentCity ? `（${parentCity}）` : ""}`,
      strength: hard ? "hard" : undefined,
      status: "proposed",
      confidence: hard ? 0.86 : 0.76,
      importance: importanceWithHint(sub?.importance, hard ? 0.78 : 0.62),
      tags: ["sub_location", sub?.kind || "other"].filter(Boolean),
      evidenceIds: [evidence],
    });
    if (!id) continue;

    const parentDurationId = parentCity ? cityDurationNodeIds.get(parentCity) : null;
    const parentDestinationId = parentCity ? destinationNodeIds.get(parentCity) : null;
    if (parentDurationId) {
      pushEdge(id, parentDurationId, hard ? "constraint" : "determine");
    } else if (parentDestinationId) {
      pushEdge(id, parentDestinationId, hard ? "constraint" : "determine");
    } else if (rootId) {
      pushEdge(id, rootId, hard ? "constraint" : "enable");
    }
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
      importance: importanceWithHint(signals.criticalImportance, 0.98),
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
      importance: importanceWithHint(signals.budgetImportance, 0.86),
      evidenceIds: [signals.budgetEvidence || `${signals.budgetCny}元`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }

  if (signals.scenicPreference) {
    const hardPref = !!signals.scenicPreferenceHard;
    const id = pushNode({
      type: hardPref ? "constraint" : "preference",
      statement: signals.scenicPreference,
      strength: hardPref ? "hard" : "soft",
      status: "proposed",
      confidence: hardPref ? 0.88 : 0.82,
      severity: "medium",
      importance: importanceWithHint(
        signals.scenicPreferenceImportance,
        hardPref ? 0.8 : 0.68
      ),
      tags: ["preference", "culture"],
      evidenceIds: [signals.scenicPreferenceEvidence || signals.scenicPreference],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, hardPref ? "constraint" : "enable");
  }

  if (signals.lodgingPreference) {
    const hardLodging = !!signals.lodgingPreferenceHard;
    const id = pushNode({
      type: hardLodging ? "constraint" : "preference",
      statement: signals.lodgingPreference,
      strength: hardLodging ? "hard" : "soft",
      status: "proposed",
      confidence: hardLodging ? 0.88 : 0.8,
      severity: hardLodging ? "medium" : undefined,
      importance: importanceWithHint(
        signals.lodgingPreferenceImportance,
        hardLodging ? 0.82 : 0.66
      ),
      tags: ["lodging", "accommodation"],
      evidenceIds: [signals.lodgingPreferenceEvidence || signals.lodgingPreference],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, hardLodging ? "constraint" : "enable");
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
          importance: importanceWithHint(signals.healthImportance, 0.98),
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
        importance: importanceWithHint(signals.healthImportance, 0.98),
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
