import type { CDG, ConceptEdge, ConceptNode } from "../../core/graph.js";

export type UncertaintyTarget = {
  nodeId: string;
  score: number;
  reason: string;
  slotFamily: string;
  statement: string;
};

export type UncertaintyQuestionPlan = {
  question: string | null;
  targets: UncertaintyTarget[];
  rationale: string;
};

type GraphSlots = {
  totalDuration?: number;
  cityDurations: Array<{ city: string; days: number }>;
  destinations: string[];
  budget?: number;
  limitingFactors: string[];
  criticalDays: string[];
};

function cleanText(input: any, max = 120): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clamp01(x: any, fallback = 0.68): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function slotFamilyFromNode(node: ConceptNode): string {
  const key = cleanText(node.key || "", 80);
  const statement = cleanText(node.statement || "", 160);

  if (key.startsWith("slot:destination:") || /^目的地[:：]/.test(statement)) return "destination";
  if (key.startsWith("slot:duration_city:") || /^(城市时长|停留时长)[:：]/.test(statement)) return "duration_city";
  if (key === "slot:duration_total" || /^(总行程时长|行程时长)[:：]/.test(statement)) return "duration_total";
  if (key === "slot:budget" || /^预算(?:上限)?[:：]/.test(statement)) return "budget";
  if (key === "slot:people" || /^同行人数[:：]/.test(statement)) return "people";
  if (key.startsWith("slot:meeting_critical:") || /^关键日[:：]/.test(statement)) return "critical_day";
  if (key.startsWith("slot:constraint:limiting:") || /^限制因素[:：]/.test(statement)) return "limiting_factor";
  if (key.startsWith("slot:conflict:") || /^冲突提示[:：]/.test(statement)) return "conflict";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:scenic_preference") return "scenic_preference";
  if (node.type === "goal" || key === "slot:goal") return "goal";
  if (node.type === "question") return "question";
  return "other";
}

function parseSlots(graph: CDG): GraphSlots {
  const out: GraphSlots = {
    cityDurations: [],
    destinations: [],
    limitingFactors: [],
    criticalDays: [],
  };

  for (const n of graph.nodes || []) {
    const statement = cleanText(n.statement || "", 200);
    if (!statement) continue;

    let m = statement.match(/^总行程时长[:：]\s*([0-9]{1,3})\s*天$/);
    if (m?.[1]) out.totalDuration = Number(m[1]);

    m = statement.match(/^(城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    if (m?.[2] && m?.[3]) {
      out.cityDurations.push({ city: cleanText(m[2], 20), days: Number(m[3]) });
    }

    m = statement.match(/^目的地[:：]\s*(.+)$/);
    if (m?.[1]) out.destinations.push(cleanText(m[1], 20));

    m = statement.match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
    if (m?.[1]) out.budget = Number(m[1]);

    m = statement.match(/^限制因素[:：]\s*(.+)$/);
    if (m?.[1]) out.limitingFactors.push(cleanText(m[1], 80));

    m = statement.match(/^关键日[:：]\s*(.+)$/);
    if (m?.[1]) out.criticalDays.push(cleanText(m[1], 80));
  }

  out.destinations = Array.from(new Set(out.destinations.filter(Boolean))).slice(0, 8);
  out.cityDurations = out.cityDurations
    .filter((x) => x.city && Number.isFinite(x.days) && x.days > 0)
    .slice(0, 12);
  out.limitingFactors = Array.from(new Set(out.limitingFactors.filter(Boolean))).slice(0, 8);
  out.criticalDays = Array.from(new Set(out.criticalDays.filter(Boolean))).slice(0, 4);
  return out;
}

function edgeMaps(edges: ConceptEdge[]) {
  const incoming = new Map<string, ConceptEdge[]>();
  const outgoing = new Map<string, ConceptEdge[]>();
  for (const e of edges || []) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }
  return { incoming, outgoing };
}

function statusPenalty(node: ConceptNode): number {
  if (node.status === "disputed") return 0.28;
  if (node.status === "proposed") return 0.2;
  if (node.status === "confirmed") return -0.04;
  if (node.status === "rejected") return -0.25;
  return 0;
}

function layerWeight(node: ConceptNode): number {
  if (node.layer === "risk") return 0.14;
  if (node.layer === "requirement") return 0.09;
  if (node.layer === "preference") return 0.04;
  if (node.layer === "intent") return 0.06;
  return 0.05;
}

function edgeUncertainty(nodeId: string, incoming: Map<string, ConceptEdge[]>, outgoing: Map<string, ConceptEdge[]>) {
  const inE = incoming.get(nodeId) || [];
  const outE = outgoing.get(nodeId) || [];
  const all = [...inE, ...outE];
  if (!all.length) return 0.06;
  let score = 0;
  for (const e of all) {
    if (e.type === "conflicts_with") score += 0.14;
    else if (e.type === "constraint") score += 0.08;
    else if (e.type === "determine") score += 0.03;
    score += (1 - clamp01(e.confidence, 0.68)) * 0.1;
  }
  return Math.min(0.32, score / all.length + (all.length >= 4 ? 0.05 : 0));
}

function reasonFromSlot(slotFamily: string): string {
  if (slotFamily === "duration_total") return "总时长与分段时长可能未对齐";
  if (slotFamily === "duration_city") return "分城市时长仍有歧义";
  if (slotFamily === "destination") return "目的地与层级关系仍需确认";
  if (slotFamily === "budget") return "预算硬度与可浮动范围未确认";
  if (slotFamily === "critical_day") return "关键日是否锁定仍不够明确";
  if (slotFamily === "limiting_factor") return "限制因素是否硬约束仍需确认";
  if (slotFamily === "conflict") return "存在冲突提示，需要优先级确认";
  return "核心槽位仍有不确定性";
}

function normalizeForMatch(s: string): string {
  return cleanText(s, 400).toLowerCase().replace(/\s+/g, "");
}

function wasAskedRecently(question: string, recentTurns: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  const q = normalizeForMatch(question);
  if (!q) return false;
  const recentAssistant = (recentTurns || [])
    .filter((x) => x.role === "assistant")
    .slice(-4)
    .map((x) => normalizeForMatch(x.content || ""))
    .filter(Boolean);
  return recentAssistant.some((x) => x.includes(q) || q.includes(x.slice(0, Math.min(18, x.length))));
}

function questionForTarget(target: UncertaintyTarget, slots: GraphSlots): string {
  if (target.slotFamily === "duration_total") {
    const total = slots.totalDuration;
    const sum = slots.cityDurations.reduce((acc, x) => acc + x.days, 0);
    if (total && sum > 0 && total !== sum) {
      return `请确认总时长以哪个为准：总行程${total}天，还是分城市合计${sum}天？`;
    }
    if (total) return `请确认总时长${total}天是否为硬约束，还是允许微调？`;
    return "请先确认你的总行程时长（几天）是否固定。";
  }

  if (target.slotFamily === "destination") {
    const dests = slots.destinations.slice(0, 3);
    if (dests.length >= 2) {
      return `请确认多城市是并列主计划吗：${dests.join(" / ")}，并分别给每城天数。`;
    }
    if (dests.length === 1) return `请确认目的地目前锁定为“${dests[0]}”吗？`;
    return "请确认本轮核心目的地（城市级）是什么？";
  }

  if (target.slotFamily === "duration_city") {
    return "请确认城市分段时长是否固定（例如 米兰3天 / 巴塞5天）。";
  }

  if (target.slotFamily === "budget") {
    if (slots.budget) return `请确认预算上限${slots.budget}元是硬约束，还是可上下浮动？`;
    return "请确认预算上限是否存在（若有请给一个数值范围）。";
  }

  if (target.slotFamily === "critical_day") {
    const one = slots.criticalDays[0];
    if (one) return `请确认关键日“${one}”是否必须锁定且不可挪动？`;
    return "请确认是否有必须预留且不可挪动的关键日。";
  }

  if (target.slotFamily === "limiting_factor") {
    const one = slots.limitingFactors[0];
    if (one) return `请确认限制因素“${one}”是硬约束，还是可协商偏好？`;
    return "请确认限制因素里哪些属于硬约束（必须满足）。";
  }

  if (target.slotFamily === "conflict") {
    return "当前存在约束冲突，你希望优先满足哪一项（预算/时长/舒适度）？";
  }

  return `请确认这条信息是否是硬约束：“${cleanText(target.statement, 28)}”？`;
}

export function planUncertaintyQuestion(params: {
  graph: CDG;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
}): UncertaintyQuestionPlan {
  const graph = params.graph || { id: "", version: 0, nodes: [], edges: [] };
  const slots = parseSlots(graph);
  const { incoming, outgoing } = edgeMaps(graph.edges || []);

  const candidates: UncertaintyTarget[] = [];
  for (const node of graph.nodes || []) {
    if (!node || !node.id) continue;
    if (node.type === "goal" || node.type === "question") continue;
    if (node.status === "rejected") continue;

    const slotFamily = slotFamilyFromNode(node);
    const confPenalty = (1 - clamp01(node.confidence, 0.68)) * 0.42;
    const impPenalty = (1 - clamp01(node.importance, 0.66)) * 0.14;
    const evidencePenalty = (node.evidenceIds && node.evidenceIds.length > 0) ? 0 : 0.08;
    const edgePenalty = edgeUncertainty(node.id, incoming, outgoing);
    const statusP = statusPenalty(node);
    const layerP = layerWeight(node);
    const total = Math.max(0, Math.min(1.2, confPenalty + impPenalty + evidencePenalty + edgePenalty + statusP + layerP));

    if (total < 0.24) continue;
    candidates.push({
      nodeId: node.id,
      score: total,
      reason: reasonFromSlot(slotFamily),
      slotFamily,
      statement: cleanText(node.statement || "", 120),
    });
  }

  const sorted = candidates.sort((a, b) => b.score - a.score).slice(0, 6);
  let pickedQuestion: string | null = null;
  for (const c of sorted) {
    const q = questionForTarget(c, slots);
    if (!wasAskedRecently(q, params.recentTurns)) {
      pickedQuestion = q;
      break;
    }
  }
  if (!pickedQuestion && sorted.length) pickedQuestion = questionForTarget(sorted[0], slots);

  const rationale = sorted.length
    ? sorted
        .slice(0, 3)
        .map((x) => `${x.slotFamily}:${x.score.toFixed(2)}`)
        .join(" | ")
    : "no_uncertainty_target";

  return {
    question: pickedQuestion,
    targets: sorted,
    rationale,
  };
}

export function enforceTargetedQuestion(text: string, targetedQuestion: string | null): string {
  const base = cleanText(text || "", 5000);
  const q = cleanText(targetedQuestion || "", 120);
  if (!q) return base;
  if (!base) return q;

  const normBase = normalizeForMatch(base);
  const normQ = normalizeForMatch(q);
  if (normQ && normBase.includes(normQ)) return base;

  return `${base}\n${q}`;
}
