import type { CDG, ConceptEdge, ConceptNode, EdgeType } from "../../core/graph.js";
import { buildCognitiveModel, type CognitiveModel } from "../cognitiveModel.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import type {
  LongTermScenarioState,
  LongTermRecentTurn,
  LongTermSegmentKey,
  LongTermTaskState,
} from "./state.js";
import {
  getLongTermSourceMapEntry,
  longTermTaskHasProgress,
  longTermTaskHasUserGroundedEvidence,
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
  evidenceIds?: string[];
  sourceMsgIds?: string[];
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
    evidenceIds: (params.evidenceIds || []).slice(0, 8),
    sourceMsgIds: (params.sourceMsgIds || []).slice(0, 12),
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

function sourceTokenForVisualTurn(turnId: unknown, index: number) {
  const token = clean(turnId, 120);
  if (!token) return `turn_u_${index + 1}`;
  if (
    token.includes("user") ||
    token === "latest_user" ||
    token.startsWith("msg_u") ||
    token.startsWith("u_") ||
    token.startsWith("turn_u") ||
    token.startsWith("turn_") ||
    token.startsWith("manual_")
  ) {
    return token;
  }
  return `turn_u_${token}`;
}

type VisualUserTurn = {
  sourceMsgId: string;
  text: string;
};

function collectVisualUserTurns(turns: LongTermRecentTurn[] | undefined): VisualUserTurn[] {
  const out: VisualUserTurn[] = [];
  let index = 0;
  for (const turn of turns || []) {
    const text = clean(turn?.userText, 800);
    if (!text) continue;
    out.push({
      sourceMsgId: sourceTokenForVisualTurn(turn?.turnId, index),
      text,
    });
    index += 1;
  }
  return out;
}

type VisualEvidence = {
  sourceMsgIds: string[];
  evidenceIds: string[];
};

function collectVisualEvidence(turns: VisualUserTurn[], patterns: RegExp[]): VisualEvidence | null {
  const sourceMsgIds: string[] = [];
  const evidenceIds: string[] = [];
  const seenSources = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const turn of turns) {
    for (const pattern of patterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const matcher = new RegExp(pattern.source, flags);
      for (const match of turn.text.matchAll(matcher)) {
        const evidence = clean(match?.[1] || match?.[0], 160);
        if (!evidence) continue;
        if (!seenSources.has(turn.sourceMsgId)) {
          seenSources.add(turn.sourceMsgId);
          sourceMsgIds.push(turn.sourceMsgId);
        }
        if (!seenEvidence.has(evidence)) {
          seenEvidence.add(evidence);
          evidenceIds.push(evidence);
        }
      }
    }
  }
  if (!sourceMsgIds.length) return null;
  return {
    sourceMsgIds: sourceMsgIds.slice(0, 12),
    evidenceIds: evidenceIds.slice(0, 8),
  };
}

function findNodeByKey(nodes: ConceptNode[], key: string): ConceptNode | null {
  const normalizedKey = clean(key, 180);
  return nodes.find((node) => clean((node as any).key, 180) === normalizedKey) || null;
}

function buildTurnGroundedSupportNodes(params: {
  segment: LongTermSegmentKey;
  locale?: AppLocale;
  recentTurns?: LongTermRecentTurn[];
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}) {
  const turns = collectVisualUserTurns(params.recentTurns);
  if (!turns.length) return;

  const goalNode = findNodeByKey(params.nodes, `lt:goal:${params.segment}`);
  const habitAnchor = collectVisualEvidence(turns, [
    /养成[^，。；！？!?]{0,18}习惯/giu,
    /固定[^，。；！？!?]{0,18}习惯/giu,
    /长期计划/giu,
    /长期[^，。；！？!?]{0,18}习惯/giu,
    /long-term plan/giu,
    /long-term habit/giu,
    /sustainable habit/giu,
  ]);
  let habitNode: ConceptNode | null = null;
  if (habitAnchor) {
    habitNode = buildNode({
      key: "lt:shared:habit:sustainable_low_pressure_habit",
      statement: t(
        params.locale,
        "长期目标：养成固定、轻松的长期习惯",
        "Long-term aim: build a sustainable low-pressure habit"
      ),
      type: "belief",
      layer: "intent",
      confidence: 0.88,
      importance: 0.9,
      tags: ["shared", "habit"],
      sourceMsgIds: habitAnchor.sourceMsgIds,
      evidenceIds: habitAnchor.evidenceIds,
    });
    pushUniqueNode(params.nodes, habitNode);
    if (goalNode && params.segment === "fitness") {
      pushUniqueEdge(params.edges, buildEdge(habitNode.id, goalNode.id, "enable", 0.82));
    }
  }

  const derivedNodes = [
    {
      key: "lt:shared:preference:interest_driven_learning",
      statement: t(params.locale, "学习偏好：更适合兴趣驱动的学习", "Learning preference: interest-driven learning works better"),
      type: "preference" as const,
      layer: "preference" as const,
      confidence: 0.84,
      importance: 0.78,
      tags: ["shared", "learning_style"],
      evidence: collectVisualEvidence(turns, [/兴趣中学习/giu, /兴趣驱动[^，。；！？!?]{0,12}学习/giu, /interest[- ]driven learning/giu]),
    },
    {
      key: "lt:shared:trait:introverted",
      statement: t(params.locale, "个人特征：内向", "Personal trait: introverted"),
      type: "belief" as const,
      layer: "preference" as const,
      confidence: 0.82,
      importance: 0.7,
      tags: ["shared", "personality"],
      evidence: collectVisualEvidence(turns, [/内向/giu, /\bintrovert(?:ed)?\b/giu]),
    },
    {
      key: "lt:shared:preference:avoid_interaction",
      statement: t(params.locale, "学习偏好：避免高互动、社交消耗", "Learning preference: avoid high-interaction social settings"),
      type: "constraint" as const,
      layer: "requirement" as const,
      confidence: 0.84,
      importance: 0.8,
      tags: ["shared", "social"],
      evidence: collectVisualEvidence(turns, [/(不喜欢|避免)[^，。；！？!?]{0,12}(互动|和人互动|社交)/giu, /avoid[^,.!?]{0,16}interaction/giu]),
    },
    {
      key: "lt:shared:preference:solo_mode",
      statement: t(params.locale, "学习偏好：更适合独立完成", "Learning preference: works better in solo mode"),
      type: "preference" as const,
      layer: "preference" as const,
      confidence: 0.86,
      importance: 0.82,
      tags: ["shared", "social"],
      evidence: collectVisualEvidence(turns, [/一个人[^，。；！？!?]{0,12}(学习|训练|完成|方法)/giu, /solo[^,.!?]{0,12}(study|learning|training|work)/giu]),
    },
    {
      key: "lt:fitness:background:sedentary",
      statement: t(params.locale, "身体背景：长期久坐", "Physical background: prolonged sitting"),
      type: "factual_assertion" as const,
      layer: "requirement" as const,
      confidence: 0.86,
      importance: 0.8,
      tags: ["fitness", "body"],
      evidence: collectVisualEvidence(turns, [/久坐/giu, /sedentary/giu]),
    },
    {
      key: "lt:fitness:body:muscle_stiffness",
      statement: t(params.locale, "身体反馈：肌肉僵硬", "Body signal: muscle stiffness"),
      type: "constraint" as const,
      layer: "requirement" as const,
      confidence: 0.88,
      importance: 0.84,
      tags: ["fitness", "body"],
      evidence: collectVisualEvidence(turns, [/肌肉[^，。；！？!?]{0,10}(僵硬|锁死)/giu, /muscle[^,.!?]{0,12}stiff/giu]),
    },
    {
      key: "lt:fitness:body:reduced_mobility",
      statement: t(params.locale, "身体反馈：关节活动度下降", "Body signal: reduced joint mobility"),
      type: "constraint" as const,
      layer: "requirement" as const,
      confidence: 0.88,
      importance: 0.86,
      tags: ["fitness", "body"],
      evidence: collectVisualEvidence(turns, [/关节[^，。；！？!?]{0,10}活动度/giu, /活动度下降/giu, /joint mobility/giu]),
    },
    {
      key: "lt:fitness:body:posture_impacted",
      statement: t(params.locale, "身体影响：体态健康受影响", "Physical impact: posture health is affected"),
      type: "constraint" as const,
      layer: "requirement" as const,
      confidence: 0.84,
      importance: 0.82,
      tags: ["fitness", "body"],
      evidence: collectVisualEvidence(turns, [/体态健康[^，。；！？!?]{0,8}(不利|受影响)/giu, /posture health/giu]),
    },
    {
      key: "lt:fitness:outcome:restore_energy",
      statement: t(params.locale, "训练诉求：希望恢复精力", "Training outcome: restore energy"),
      type: "belief" as const,
      layer: "intent" as const,
      confidence: 0.82,
      importance: 0.8,
      tags: ["fitness", "outcome"],
      evidence: collectVisualEvidence(turns, [/精力恢复/giu, /恢复精力/giu, /restore energy/giu]),
    },
    {
      key: "lt:fitness:outcome:restore_focus",
      statement: t(params.locale, "训练诉求：希望恢复专注度", "Training outcome: restore focus"),
      type: "belief" as const,
      layer: "intent" as const,
      confidence: 0.82,
      importance: 0.8,
      tags: ["fitness", "outcome"],
      evidence: collectVisualEvidence(turns, [/专注度恢复/giu, /恢复专注/giu, /提升专注/giu, /restore focus/giu]),
    },
    {
      key: "lt:fitness:outcome:prefrontal_support",
      statement: t(params.locale, "训练诉求：希望运动有助于前额叶功能", "Training outcome: support prefrontal function"),
      type: "belief" as const,
      layer: "intent" as const,
      confidence: 0.8,
      importance: 0.78,
      tags: ["fitness", "outcome"],
      evidence: collectVisualEvidence(turns, [/前额叶[^，。；！？!?]{0,10}(锻炼|训练|作用|有益)/giu, /prefrontal/giu]),
    },
  ] as const;

  const nodeIndex = new Map<string, ConceptNode>();
  for (const item of derivedNodes) {
    if (!item.evidence) continue;
    const node = buildNode({
      key: item.key,
      statement: item.statement,
      type: item.type,
      layer: item.layer,
      confidence: item.confidence,
      importance: item.importance,
      tags: [...item.tags],
      sourceMsgIds: item.evidence.sourceMsgIds,
      evidenceIds: item.evidence.evidenceIds,
    });
    pushUniqueNode(params.nodes, node);
    nodeIndex.set(item.key, node);
  }

  const lowPressureNode =
    findNodeByKey(params.nodes, `lt:${params.segment}:constraint:keep_the_process_low_pressure`) ||
    findNodeByKey(params.nodes, "lt:shared:process:low_pressure");
  const timeLimitedNode = findNodeByKey(params.nodes, `lt:${params.segment}:constraint:time_becomes_more_limited`);
  const introvertNode = nodeIndex.get("lt:shared:trait:introverted") || null;
  const avoidInteractionNode = nodeIndex.get("lt:shared:preference:avoid_interaction") || null;
  const soloModeNode = nodeIndex.get("lt:shared:preference:solo_mode") || null;
  const interestDrivenNode = nodeIndex.get("lt:shared:preference:interest_driven_learning") || null;

  if (habitNode && interestDrivenNode) {
    pushUniqueEdge(params.edges, buildEdge(interestDrivenNode.id, habitNode.id, "enable", 0.8));
  }
  if (habitNode && lowPressureNode) {
    pushUniqueEdge(params.edges, buildEdge(lowPressureNode.id, habitNode.id, "enable", 0.82));
  }
  if (habitNode && soloModeNode) {
    pushUniqueEdge(params.edges, buildEdge(soloModeNode.id, habitNode.id, "enable", 0.78));
  }
  if (introvertNode && avoidInteractionNode) {
    pushUniqueEdge(params.edges, buildEdge(introvertNode.id, avoidInteractionNode.id, "determine", 0.8));
  }
  if (avoidInteractionNode && soloModeNode) {
    pushUniqueEdge(params.edges, buildEdge(avoidInteractionNode.id, soloModeNode.id, "determine", 0.84));
  }
  if (interestDrivenNode && lowPressureNode) {
    pushUniqueEdge(params.edges, buildEdge(interestDrivenNode.id, lowPressureNode.id, "enable", 0.76));
  }

  if (goalNode && params.segment === "fitness") {
    if (habitNode) pushUniqueEdge(params.edges, buildEdge(habitNode.id, goalNode.id, "enable", 0.82));
    if (timeLimitedNode) pushUniqueEdge(params.edges, buildEdge(timeLimitedNode.id, goalNode.id, "constraint", 0.9));
    for (const key of [
      "lt:fitness:background:sedentary",
      "lt:fitness:body:muscle_stiffness",
      "lt:fitness:body:reduced_mobility",
    ]) {
      const node = nodeIndex.get(key);
      if (node) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "determine", 0.86));
    }
    const postureNode = nodeIndex.get("lt:fitness:body:posture_impacted");
    if (postureNode) pushUniqueEdge(params.edges, buildEdge(postureNode.id, goalNode.id, "constraint", 0.82));
    for (const key of [
      "lt:fitness:outcome:restore_energy",
      "lt:fitness:outcome:restore_focus",
      "lt:fitness:outcome:prefrontal_support",
    ]) {
      const node = nodeIndex.get(key);
      if (node) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.8));
    }
  }

  if (goalNode && params.segment === "study") {
    if (habitNode) pushUniqueEdge(params.edges, buildEdge(habitNode.id, goalNode.id, "enable", 0.82));
    if (lowPressureNode) pushUniqueEdge(params.edges, buildEdge(lowPressureNode.id, goalNode.id, "constraint", 0.84));
    if (interestDrivenNode) pushUniqueEdge(params.edges, buildEdge(interestDrivenNode.id, goalNode.id, "enable", 0.8));
    if (soloModeNode) pushUniqueEdge(params.edges, buildEdge(soloModeNode.id, goalNode.id, "enable", 0.8));
    if (avoidInteractionNode) pushUniqueEdge(params.edges, buildEdge(avoidInteractionNode.id, goalNode.id, "constraint", 0.78));
  }
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

function sourceNodeMeta(task: LongTermTaskState, field: string, value?: string) {
  const entry = getLongTermSourceMapEntry(task, field, value);
  if (!entry || !(entry.source_msg_ids || []).length) return null;
  return {
    sourceMsgIds: entry.source_msg_ids,
    evidenceIds: entry.evidence_terms,
  };
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
  const goalSource = clean(task.goal_summary, 220) ? sourceNodeMeta(task, "goal_summary") : null;
  const goalNode = goalSource
    ? buildNode({
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
        sourceMsgIds: goalSource.sourceMsgIds,
        evidenceIds: goalSource.evidenceIds,
      })
    : null;
  if (goalNode) pushUniqueNode(params.nodes, goalNode);

  if (clean(task.weekly_time_or_frequency, 160)) {
    const cadenceSource = sourceNodeMeta(task, "weekly_time_or_frequency");
    if (cadenceSource) {
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
        sourceMsgIds: cadenceSource.sourceMsgIds,
        evidenceIds: cadenceSource.evidenceIds,
      });
      pushUniqueNode(params.nodes, cadenceNode);
      if (goalNode) pushUniqueEdge(params.edges, buildEdge(cadenceNode.id, goalNode.id, "determine", 0.84));
    }
  }

  for (const method of task.methods_or_activities || []) {
    const methodSource = sourceNodeMeta(task, "methods_or_activities", method);
    if (!methodSource) continue;
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
      sourceMsgIds: methodSource.sourceMsgIds,
      evidenceIds: methodSource.evidenceIds,
    });
    pushUniqueNode(params.nodes, methodNode);
    if (goalNode) pushUniqueEdge(params.edges, buildEdge(methodNode.id, goalNode.id, "enable", 0.82));
  }

  for (const adjustment of task.diet_sleep_adjustments || []) {
    const adjustmentSource = sourceNodeMeta(task, "diet_sleep_adjustments", adjustment);
    if (!adjustmentSource) continue;
    const label = localizeLongTermAdjustment(adjustment, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:adjustment:${slug(adjustment) || stableHash(adjustment)}`,
      statement: t(params.locale, `作息 / 饮食调整：${label}`, `Diet / sleep adjustment: ${label}`),
      type: "factual_assertion",
      layer: "requirement",
      confidence: 0.8,
      importance: 0.76,
      tags: [params.segment, "adjustment"],
      sourceMsgIds: adjustmentSource.sourceMsgIds,
      evidenceIds: adjustmentSource.evidenceIds,
    });
    pushUniqueNode(params.nodes, node);
    if (goalNode) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.78));
  }

  for (const constraint of task.constraints || []) {
    const constraintSource = sourceNodeMeta(task, "constraints", constraint);
    if (!constraintSource) continue;
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
      sourceMsgIds: constraintSource.sourceMsgIds,
      evidenceIds: constraintSource.evidenceIds,
    });
    pushUniqueNode(params.nodes, node);
    if (goalNode) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "constraint", 0.9));
  }

  for (const strategy of task.adherence_strategy || []) {
    const strategySource = sourceNodeMeta(task, "adherence_strategy", strategy);
    if (!strategySource) continue;
    const label = localizeLongTermStrategy(strategy, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:strategy:${slug(strategy) || stableHash(strategy)}`,
      statement: t(params.locale, `坚持策略：${label}`, `Adherence strategy: ${label}`),
      type: "belief",
      layer: "preference",
      confidence: 0.82,
      importance: 0.8,
      tags: [params.segment, "strategy"],
      sourceMsgIds: strategySource.sourceMsgIds,
      evidenceIds: strategySource.evidenceIds,
    });
    pushUniqueNode(params.nodes, node);
    if (goalNode) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.84));
  }

  for (const fallback of task.fallback_plan || []) {
    const fallbackSource = sourceNodeMeta(task, "fallback_plan", fallback);
    if (!fallbackSource) continue;
    const label = localizeLongTermFallback(fallback, params.locale);
    const node = buildNode({
      key: `lt:${params.segment}:fallback:${slug(fallback) || stableHash(fallback)}`,
      statement: t(params.locale, `兜底方案：${label}`, `Fallback plan: ${label}`),
      type: "belief",
      layer: "preference",
      confidence: 0.8,
      importance: 0.76,
      tags: [params.segment, "fallback"],
      sourceMsgIds: fallbackSource.sourceMsgIds,
      evidenceIds: fallbackSource.evidenceIds,
    });
    pushUniqueNode(params.nodes, node);
    if (goalNode) pushUniqueEdge(params.edges, buildEdge(node.id, goalNode.id, "enable", 0.78));
  }
}

export function buildLongTermVisualGraph(params: {
  scenario: LongTermScenarioState;
  locale?: AppLocale;
  previousGraph?: CDG | null;
  allowSyntheticGraphFromScenario?: boolean;
  recentTurns?: LongTermRecentTurn[];
}): CDG {
  const activeSegment = params.scenario.active_segment;
  const activeTask = params.scenario.segments[activeSegment];
  const nodes: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];
  const previousGraph = params.previousGraph && typeof params.previousGraph === "object" ? params.previousGraph : null;
  const allowSyntheticGraphFromScenario = params.allowSyntheticGraphFromScenario !== false;

  if (
    !allowSyntheticGraphFromScenario ||
    !longTermTaskHasProgress(activeTask) ||
    !longTermTaskHasUserGroundedEvidence(activeTask)
  ) {
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
  buildTurnGroundedSupportNodes({
    segment: activeSegment,
    locale: params.locale,
    recentTurns: params.recentTurns,
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
  recentTurns?: LongTermRecentTurn[];
}): CognitiveModel {
  const graph = buildLongTermVisualGraph({
    scenario: params.scenario,
    locale: params.locale,
    previousGraph: params.previousGraph,
    allowSyntheticGraphFromScenario: params.allowSyntheticGraphFromScenario,
    recentTurns: params.recentTurns,
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
