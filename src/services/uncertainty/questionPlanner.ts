import type { CDG, ConceptEdge, ConceptNode } from "../../core/graph.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

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

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

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

  if (key.startsWith("slot:destination:") || /^(目的地|destination)[:：]/i.test(statement)) return "destination";
  if (
    key.startsWith("slot:duration_city:") ||
    /^(城市时长|停留时长|city duration|stay duration)[:：]/i.test(statement)
  )
    return "duration_city";
  if (
    key === "slot:duration_total" ||
    /^(总行程时长|行程时长|total duration|trip duration)[:：]/i.test(statement)
  )
    return "duration_total";
  if (key === "slot:budget" || /^(预算(?:上限)?|budget(?:\s+cap)?)[:：]/i.test(statement)) return "budget";
  if (key === "slot:people" || /^(同行人数|people count|travel party)[:：]/i.test(statement)) return "people";
  if (key.startsWith("slot:meeting_critical:") || /^(关键日|critical day)[:：]/i.test(statement)) return "critical_day";
  if (key.startsWith("slot:constraint:limiting:") || /^(限制因素|limiting factor)[:：]/i.test(statement))
    return "limiting_factor";
  if (key.startsWith("slot:conflict:") || /^(冲突提示|conflict warning)[:：]/i.test(statement)) return "conflict";
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

    let m = statement.match(/^(?:总行程时长|行程时长|total duration|trip duration)[:：]\s*([0-9]{1,3})\s*(?:天|days?)$/i);
    if (m?.[1]) out.totalDuration = Number(m[1]);

    m = statement.match(
      /^(?:城市时长|停留时长|city duration|stay duration)[:：]\s*(.+?)\s+([0-9]{1,3})\s*(?:天|days?)$/i
    );
    if (m?.[1] && m?.[2]) {
      out.cityDurations.push({ city: cleanText(m[1], 20), days: Number(m[2]) });
    }

    m = statement.match(/^(?:目的地|destination)[:：]\s*(.+)$/i);
    if (m?.[1]) out.destinations.push(cleanText(m[1], 20));

    m = statement.match(/^(?:预算(?:上限)?|budget(?:\s+cap)?)[:：]\s*([0-9]{2,})\s*(?:元|cny)?$/i);
    if (m?.[1]) out.budget = Number(m[1]);

    m = statement.match(/^(?:限制因素|limiting factor)[:：]\s*(.+)$/i);
    if (m?.[1]) out.limitingFactors.push(cleanText(m[1], 80));

    m = statement.match(/^(?:关键日|critical day)[:：]\s*(.+)$/i);
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

function reasonFromSlot(slotFamily: string, locale?: AppLocale): string {
  if (slotFamily === "duration_total") return t(locale, "总时长与分段时长可能未对齐", "Total duration may be misaligned with city segments");
  if (slotFamily === "duration_city") return t(locale, "分城市时长仍有歧义", "City-level duration is still ambiguous");
  if (slotFamily === "destination") return t(locale, "目的地与层级关系仍需确认", "Destination hierarchy still needs confirmation");
  if (slotFamily === "budget") return t(locale, "预算硬度与可浮动范围未确认", "Budget hardness vs. flexibility is unclear");
  if (slotFamily === "critical_day") return t(locale, "关键日是否锁定仍不够明确", "Critical-day locking is still unclear");
  if (slotFamily === "limiting_factor") return t(locale, "限制因素是否硬约束仍需确认", "Whether limiting factors are hard constraints is unclear");
  if (slotFamily === "conflict") return t(locale, "存在冲突提示，需要优先级确认", "Conflict signals detected; priority confirmation needed");
  return t(locale, "核心槽位仍有不确定性", "Core slots still have unresolved uncertainty");
}

function normalizeForMatch(s: string): string {
  return cleanText(s, 400).toLowerCase().replace(/\s+/g, "");
}

function hasHardnessDecision(text: string): boolean {
  return /(硬约束|可协商偏好|可协商|软约束|偏好|不是硬约束|hard constraint|soft preference|negotiable|not hard)/i.test(
    cleanText(text, 200)
  );
}

function normalizeLimitingStatement(statement: string): string {
  return cleanText(statement || "", 120)
    .replace(/^(限制因素|limiting factor)[:：]\s*/i, "")
    .replace(/^“|”$/g, "")
    .trim();
}

function isLimitingFactorResolved(
  target: UncertaintyTarget,
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const phrase = normalizeLimitingStatement(target.statement);
  if (!phrase) return false;

  const recentUsers = (recentTurns || [])
    .filter((x) => x.role === "user")
    .slice(-8)
    .map((x) => cleanText(x.content || "", 240))
    .filter(Boolean);
  const recentAssistants = (recentTurns || [])
    .filter((x) => x.role === "assistant")
    .slice(-6)
    .map((x) => cleanText(x.content || "", 240))
    .filter(Boolean);

  const explicitByPhrase = recentUsers.some(
    (u) => hasHardnessDecision(u) && (u.includes(phrase) || phrase.includes(cleanText(u, 40)))
  );
  if (explicitByPhrase) return true;

  const askedRecently = recentAssistants.some(
    (a) => /(限制因素|limiting factor)/i.test(a) && (a.includes(phrase) || phrase.includes(cleanText(a, 40)))
  );
  const lastUser = recentUsers[recentUsers.length - 1] || "";
  if (askedRecently && hasHardnessDecision(lastUser)) return true;

  return false;
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

function questionForTarget(target: UncertaintyTarget, slots: GraphSlots, locale?: AppLocale): string {
  if (target.slotFamily === "duration_total") {
    const total = slots.totalDuration;
    const sum = slots.cityDurations.reduce((acc, x) => acc + x.days, 0);
    if (total && sum > 0 && total !== sum) {
      return t(
        locale,
        `请确认总时长以哪个为准：总行程${total}天，还是分城市合计${sum}天？`,
        `Please confirm which duration should win: total trip ${total} days, or city segments summed ${sum} days?`
      );
    }
    if (total)
      return t(
        locale,
        `请确认总时长${total}天是否为硬约束，还是允许微调？`,
        `Please confirm whether total duration ${total} days is a hard constraint or can be adjusted.`
      );
    return t(locale, "请先确认你的总行程时长（几天）是否固定。", "Please confirm whether total trip duration is fixed.");
  }

  if (target.slotFamily === "destination") {
    const dests = slots.destinations.slice(0, 3);
    if (dests.length >= 2) {
      return t(
        locale,
        `请确认多城市是并列主计划吗：${dests.join(" / ")}，并分别给每城天数。`,
        `Please confirm whether these cities are parallel main destinations: ${dests.join(" / ")}, and provide days per city.`
      );
    }
    if (dests.length === 1)
      return t(locale, `请确认目的地目前锁定为“${dests[0]}”吗？`, `Please confirm destination is currently locked to "${dests[0]}".`);
    return t(locale, "请确认本轮核心目的地（城市级）是什么？", "Please confirm the core city-level destination for this turn.");
  }

  if (target.slotFamily === "duration_city") {
    return t(locale, "请确认城市分段时长是否固定（例如 米兰3天 / 巴塞5天）。", "Please confirm whether city-level duration splits are fixed (e.g., Milan 3 days / Barcelona 5 days).");
  }

  if (target.slotFamily === "budget") {
    if (slots.budget)
      return t(
        locale,
        `请确认预算上限${slots.budget}元是硬约束，还是可上下浮动？`,
        `Please confirm whether budget cap ${slots.budget} CNY is hard or flexible.`
      );
    return t(locale, "请确认预算上限是否存在（若有请给一个数值范围）。", "Please confirm whether there is a budget cap, and provide a range if yes.");
  }

  if (target.slotFamily === "critical_day") {
    const one = slots.criticalDays[0];
    if (one)
      return t(locale, `请确认关键日“${one}”是否必须锁定且不可挪动？`, `Please confirm whether critical day "${one}" must be locked and non-movable.`);
    return t(locale, "请确认是否有必须预留且不可挪动的关键日。", "Please confirm whether there is any must-reserve, non-movable critical day.");
  }

  if (target.slotFamily === "limiting_factor") {
    const one = slots.limitingFactors[0];
    if (one)
      return t(locale, `请确认限制因素“${one}”是硬约束，还是可协商偏好？`, `Please confirm whether limiting factor "${one}" is a hard constraint or a negotiable preference.`);
    return t(locale, "请确认限制因素里哪些属于硬约束（必须满足）。", "Please confirm which limiting factors are hard constraints (must satisfy).");
  }

  if (target.slotFamily === "conflict") {
    return t(locale, "当前存在约束冲突，你希望优先满足哪一项（预算/时长/舒适度）？", "There is an active constraint conflict. Which should be prioritized first (budget / duration / comfort)?");
  }

  return t(
    locale,
    `请确认这条信息是否是硬约束：“${cleanText(target.statement, 28)}”？`,
    `Please confirm whether this is a hard constraint: "${cleanText(target.statement, 28)}".`
  );
}

export function planUncertaintyQuestion(params: {
  graph: CDG;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  locale?: AppLocale;
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
    const evidencePenalty = node.evidenceIds && node.evidenceIds.length > 0 ? 0 : 0.08;
    const edgePenalty = edgeUncertainty(node.id, incoming, outgoing);
    const statusP = statusPenalty(node);
    const layerP = layerWeight(node);
    const total = Math.max(0, Math.min(1.2, confPenalty + impPenalty + evidencePenalty + edgePenalty + statusP + layerP));

    if (total < 0.24) continue;
    candidates.push({
      nodeId: node.id,
      score: total,
      reason: reasonFromSlot(slotFamily, params.locale),
      slotFamily,
      statement: cleanText(node.statement || "", 120),
    });
  }

  const sorted = candidates.sort((a, b) => b.score - a.score).slice(0, 6);
  const unresolvedSorted = sorted.filter(
    (x) => !(x.slotFamily === "limiting_factor" && isLimitingFactorResolved(x, params.recentTurns))
  );
  let pickedQuestion: string | null = null;
  for (const c of unresolvedSorted) {
    const q = questionForTarget(c, slots, params.locale);
    if (!wasAskedRecently(q, params.recentTurns)) {
      pickedQuestion = q;
      break;
    }
  }
  if (!pickedQuestion && unresolvedSorted.length)
    pickedQuestion = questionForTarget(unresolvedSorted[0], slots, params.locale);

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
