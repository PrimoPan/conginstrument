import type { CDG, ConceptEdge, ConceptNode, EdgeType } from "../../core/graph.js";
import { buildCognitiveModel, type CognitiveModel } from "../cognitiveModel.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import type {
  LongTermScenarioState,
  LongTermSegmentKey,
  LongTermTaskState,
} from "./state.js";
import {
  longTermTaskHasProgress,
  localizeLongTermAdjustment,
  localizeLongTermConstraint,
  localizeLongTermFallback,
  localizeLongTermMethod,
  localizeLongTermStrategy,
} from "./state.js";

function t(locale: AppLocale | undefined, zh: string, en: string) {
  return isEnglishLocale(locale) ? en : zh;
}

function clean(input: unknown, max = 220): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function slug(input: string, max = 64): string {
  return clean(input, 240)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (const ch of String(input || "")) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function nodeIdFor(key: string) {
  return `lt_n_${slug(key, 72) || stableHash(key)}`;
}

function edgeIdFor(from: string, to: string, type: EdgeType) {
  return `lt_e_${stableHash(`${from}|${to}|${type}`)}`;
}

function stageLabel(segment: LongTermSegmentKey, locale?: AppLocale) {
  return segment === "fitness"
    ? t(locale, "健身", "Fitness")
    : t(locale, "学习", "Study");
}

function buildNode(params: {
  key: string;
  statement: string;
  type: ConceptNode["type"];
  layer: ConceptNode["layer"];
  confidence?: number;
  importance?: number;
  tags?: string[];
  severity?: ConceptNode["severity"];
}): ConceptNode {
  return {
    id: nodeIdFor(params.key),
    key: params.key,
    statement: clean(params.statement, 220),
    type: params.type,
    layer: params.layer,
    status: "confirmed",
    confidence: Number.isFinite(Number(params.confidence)) ? Number(params.confidence) : 0.84,
    importance: Number.isFinite(Number(params.importance)) ? Number(params.importance) : 0.82,
    tags: params.tags || [],
    severity: params.severity,
    value: {
      presentation: {
        tone_key:
          params.type === "constraint"
            ? "requirement"
            : params.layer === "intent"
            ? "goal"
            : params.layer === "preference"
            ? "preference"
            : "default",
      },
    },
  };
}

function buildEdge(from: string, to: string, type: EdgeType, confidence = 0.82): ConceptEdge {
  return {
    id: edgeIdFor(from, to, type),
    from,
    to,
    type,
    confidence,
  };
}

function pushUniqueNode(target: ConceptNode[], node: ConceptNode) {
  if (target.some((item) => item.id === node.id || clean(item.key, 180) === clean(node.key, 180))) return;
  target.push(node);
}

function pushUniqueEdge(target: ConceptEdge[], edge: ConceptEdge) {
  if (target.some((item) => item.from === edge.from && item.to === edge.to && item.type === edge.type)) return;
  target.push(edge);
}

function isTravelLeakKey(key: string): boolean {
  return /^slot:(destination|duration|budget|people|lodging|sub_location|meeting_critical|scenic_preference|activity_preference|health|language)/.test(
    key
  );
}

function isTravelishStatement(statement: string): boolean {
  return /旅行|行程|目的地|景点|酒店|住宿|航班|机票|高铁|地铁|餐厅|美食|travel|trip|destination|hotel|flight|itinerary/i.test(
    statement
  );
}

function isLongTermSystemStatement(statement: string): boolean {
  return (
    /^当前阶段[:：]/u.test(statement) ||
    /^Current stage[:：]/i.test(statement) ||
    /^长期个人计划[:：]/u.test(statement) ||
    /^Long-term (personal )?plan[:：]/i.test(statement) ||
    (/Task\s*3/i.test(statement) && /Task\s*4/i.test(statement) && /->/.test(statement)) ||
    (/健身计划/.test(statement) && /学习计划/.test(statement) && /->/.test(statement))
  );
}

function shouldCarryForwardNode(node: ConceptNode, autoKeys: Set<string>) {
  const key = clean(node.key, 180);
  if (key && autoKeys.has(key)) return false;
  if (key.startsWith("lt:")) return false;
  if (isTravelLeakKey(key)) return false;
  const statement = clean(node.statement, 220);
  if (isTravelishStatement(statement)) return false;
  if (isLongTermSystemStatement(statement)) return false;
  return true;
}

function localizeTaskGoal(task: LongTermTaskState, locale?: AppLocale) {
  return clean(task.goal_summary, 220) || t(locale, "待进一步澄清目标", "Goal still needs clarification");
}

function buildSegmentNodes(params: {
  scenario: LongTermScenarioState;
  segment: LongTermSegmentKey;
  locale?: AppLocale;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}) {
  const task = params.scenario.segments[params.segment];
  const goalKey = `lt:goal:${params.segment}`;
  const goalNode = buildNode({
    key: goalKey,
    statement:
      params.segment === "fitness"
        ? t(params.locale, `健身目标：${localizeTaskGoal(task, params.locale)}`, `Fitness goal: ${localizeTaskGoal(task, params.locale)}`)
        : t(params.locale, `学习目标：${localizeTaskGoal(task, params.locale)}`, `Study goal: ${localizeTaskGoal(task, params.locale)}`),
    type: "belief",
    layer: "intent",
    confidence: 0.92,
    importance: 0.96,
    tags: [params.segment, "goal"],
  });
  pushUniqueNode(params.nodes, goalNode);

  if (clean(task.weekly_time_or_frequency, 160)) {
    const cadenceNode = buildNode({
      key: `lt:${params.segment}:cadence`,
      statement: t(
        params.locale,
        `${stageLabel(params.segment, params.locale)}节奏：${clean(task.weekly_time_or_frequency, 160)}`,
        `${stageLabel(params.segment, params.locale)} cadence: ${clean(task.weekly_time_or_frequency, 160)}`
      ),
      type: "factual_assertion",
      layer: "requirement",
      confidence: 0.86,
      importance: 0.82,
      tags: [params.segment, "cadence"],
    });
    pushUniqueNode(params.nodes, cadenceNode);
    pushUniqueEdge(params.edges, buildEdge(cadenceNode.id, goalNode.id, "determine", 0.84));
  }

  for (const method of task.methods_or_activities || []) {
    const label = localizeLongTermMethod(method, params.locale);
    const methodNode = buildNode({
      key: `lt:${params.segment}:method:${slug(method) || stableHash(method)}`,
      statement:
        params.segment === "fitness"
          ? t(params.locale, `更适合的运动方式：${label}`, `Preferred exercise format: ${label}`)
          : t(params.locale, `更适合的学习方式：${label}`, `Preferred study method: ${label}`),
      type: "preference",
      layer: "preference",
      confidence: 0.84,
      importance: 0.8,
      tags: [params.segment, "method"],
    });
    pushUniqueNode(params.nodes, methodNode);
    pushUniqueEdge(params.edges, buildEdge(methodNode.id, goalNode.id, "enable", 0.82));
  }

  for (const adjustment of task.diet_sleep_adjustments || []) {
    const label = localizeLongTermAdjustment(adjustment, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:adjustment:${slug(adjustment) || stableHash(adjustment)}`,
      statement: t(params.locale, `作息 / 饮食调整：${label}`, `Diet / sleep adjustment: ${label}`),
      type: "factual_assertion",
      layer: "requirement",
      confidence: 0.8,
      importance: 0.76,
      tags: [params.segment, "adjustment"],
    });
    pushUniqueNode(params.nodes, node);
    pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.78));
  }

  for (const constraint of task.constraints || []) {
    const label = localizeLongTermConstraint(constraint, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:constraint:${slug(constraint) || stableHash(constraint)}`,
      statement: t(params.locale, `当前约束：${label}`, `Current constraint: ${label}`),
      type: "constraint",
      layer: "requirement",
      confidence: 0.88,
      importance: 0.88,
      severity: constraint === "energy is limited" ? "medium" : undefined,
      tags: [params.segment, "constraint"],
    });
    pushUniqueNode(params.nodes, node);
    pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "constraint", 0.9));
  }

  for (const strategy of task.adherence_strategy || []) {
    const label = localizeLongTermStrategy(strategy, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:strategy:${slug(strategy) || stableHash(strategy)}`,
      statement: t(params.locale, `坚持策略：${label}`, `Adherence strategy: ${label}`),
      type: "belief",
      layer: "preference",
      confidence: 0.82,
      importance: 0.8,
      tags: [params.segment, "strategy"],
    });
    pushUniqueNode(params.nodes, node);
    pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.84));
  }

  for (const fallback of task.fallback_plan || []) {
    const label = localizeLongTermFallback(fallback, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:fallback:${slug(fallback) || stableHash(fallback)}`,
      statement: t(params.locale, `兜底方案：${label}`, `Fallback plan: ${label}`),
      type: "belief",
      layer: "preference",
      confidence: 0.8,
      importance: 0.76,
      tags: [params.segment, "fallback"],
    });
    pushUniqueNode(params.nodes, node);
    pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.78));
  }
}

export function buildLongTermVisualGraph(params: {
  scenario: LongTermScenarioState;
  locale?: AppLocale;
  previousGraph?: CDG | null;
  allowSyntheticGraphFromScenario?: boolean;
}): CDG {
  const activeSegment = params.scenario.active_segment;
  const activeTask = params.scenario.segments[activeSegment];
  const nodes: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];
  const previousGraph = params.previousGraph && typeof params.previousGraph === "object" ? params.previousGraph : null;
  const allowSyntheticGraphFromScenario = params.allowSyntheticGraphFromScenario !== false;

  if (!allowSyntheticGraphFromScenario || !longTermTaskHasProgress(activeTask)) {
    return {
      id: params.scenario.scenario_id,
      version: Number(previousGraph?.version || 0),
      nodes: [],
      edges: [],
    };
  }

  buildSegmentNodes({
    scenario: params.scenario,
    segment: activeSegment,
    locale: params.locale,
    nodes,
    edges,
  });

  const autoKeys = new Set(nodes.map((node) => clean(node.key, 180)).filter(Boolean));
  const mergedNodes = nodes.slice();
  const mergedEdges = edges.slice();
  const seenNodeIds = new Set(mergedNodes.map((node) => node.id));
  const seenEdges = new Set(mergedEdges.map((edge) => `${edge.from}|${edge.to}|${edge.type}`));

  if (previousGraph) {
    const carriedNodeIds = new Set<string>();
    for (const node of previousGraph.nodes || []) {
      if (!shouldCarryForwardNode(node, autoKeys)) continue;
      const nextNode = { ...node };
      if (seenNodeIds.has(nextNode.id)) continue;
      carriedNodeIds.add(nextNode.id);
      seenNodeIds.add(nextNode.id);
      mergedNodes.push(nextNode);
    }
    for (const edge of previousGraph.edges || []) {
      const signature = `${edge.from}|${edge.to}|${edge.type}`;
      if (seenEdges.has(signature)) continue;
      if (!seenNodeIds.has(edge.from) || !seenNodeIds.has(edge.to)) continue;
      seenEdges.add(signature);
      mergedEdges.push({ ...edge });
    }
  }

  return {
    id: params.scenario.scenario_id,
    version: Number(previousGraph?.version || 0),
    nodes: mergedNodes,
    edges: mergedEdges,
  };
}

export function buildLongTermVisualConversationModel(params: {
  scenario: LongTermScenarioState;
  locale?: AppLocale;
  previousGraph?: CDG | null;
  prevConcepts?: any[];
  baseConcepts?: any[];
  prevMotifs?: any[];
  baseMotifLinks?: any[];
  baseContexts?: any[];
  allowSyntheticGraphFromScenario?: boolean;
}): CognitiveModel {
  const graph = buildLongTermVisualGraph({
    scenario: params.scenario,
    locale: params.locale,
    previousGraph: params.previousGraph,
    allowSyntheticGraphFromScenario: params.allowSyntheticGraphFromScenario,
  });
  return buildCognitiveModel({
    graph,
    prevConcepts: params.prevConcepts || [],
    baseConcepts: params.baseConcepts || params.prevConcepts || [],
    baseMotifs: params.prevMotifs || [],
    baseMotifLinks: params.baseMotifLinks || [],
    baseContexts: params.baseContexts || [],
    locale: params.locale,
  });
}
