import type { IntentSignals } from "./intentSignals.js";
import { buildTravelIntentStatement, isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";
import { cleanStatement } from "./text.js";
import { analyzeConstraintConflicts, type LimitingFactorInput } from "./conflictAnalyzer.js";
import type { SlotEdgeSpec, SlotGraphState, SlotNodeSpec } from "./slotTypes.js";

function clamp01(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function slug(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[省市县区州郡]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 28);
}

function motifEvidence(quote?: string, source = "dialogue"): Array<{ quote: string; source?: string }> | undefined {
  const q = cleanStatement(quote || "", 120);
  if (!q) return undefined;
  return [{ quote: q, source }];
}

function nowISO() {
  return new Date().toISOString();
}

type DurationState = {
  totalDays?: number;
  totalEvidence?: string;
  cityDurations: Array<{ city: string; days: number; kind: "travel" | "meeting"; evidence: string; importance: number }>;
  emitCityDurationSlots: Set<string>;
};

type DurationCandidate = {
  days: number;
  weight: number;
  evidence: string;
  source: "explicit_total" | "city_sum" | "max_segment";
};

function isDetailLikeDurationEvidence(evidence: string): boolean {
  const s = cleanStatement(evidence || "", 100);
  if (!s) return false;
  return /第[一二三四五六七八九十0-9两]+天|首日|第一天|落地|抵达|转机|机场|当日|当天|晚上到|早上到/i.test(s);
}

function likelyNestedDuration(parentCity: string, childCity: string): boolean {
  const p = normalizeDestination(parentCity || "");
  const c = normalizeDestination(childCity || "");
  if (!p || !c || p === c) return false;
  if (p.includes(c) || c.includes(p)) return true;
  return false;
}

function compactCityDurations(
  cityDurations: Array<{ city: string; days: number; kind: "travel" | "meeting"; evidence: string; importance: number }>
): Array<{ city: string; days: number; kind: "travel" | "meeting"; evidence: string; importance: number }> {
  if (cityDurations.length <= 1) return cityDurations;

  const sorted = cityDurations
    .slice()
    .sort((a, b) => b.days - a.days || a.city.localeCompare(b.city));
  const kept: typeof cityDurations = [];

  for (const seg of sorted) {
    const nestedInKept = kept.some(
      (k) => k.days >= seg.days && likelyNestedDuration(k.city, seg.city)
    );
    if (!nestedInKept) kept.push(seg);
  }

  const maxSeg = sorted[0];
  const sumAll = sorted.reduce((acc, x) => acc + x.days, 0);
  const detailSegments = sorted.filter(
    (x) =>
      x !== maxSeg &&
      x.days <= 2 &&
      (isDetailLikeDurationEvidence(x.evidence) || x.kind === "travel")
  );
  if (maxSeg && detailSegments.length && maxSeg.days >= sumAll - 2) {
    return [maxSeg];
  }

  return kept.length ? kept : cityDurations;
}

function weightedMedian(candidates: DurationCandidate[]): DurationCandidate | null {
  const list = candidates
    .filter((x) => Number.isFinite(x.days) && x.days > 0 && Number.isFinite(x.weight) && x.weight > 0)
    .sort((a, b) => a.days - b.days);
  if (!list.length) return null;
  const totalW = list.reduce((acc, x) => acc + x.weight, 0);
  let acc = 0;
  for (const item of list) {
    acc += item.weight;
    if (acc >= totalW / 2) return item;
  }
  return list[list.length - 1];
}

function buildDurationState(signals: IntentSignals): DurationState {
  const byCity = new Map<string, { city: string; days: number; kind: "travel" | "meeting"; evidence: string; importance: number }>();
  for (const seg of signals.cityDurations || []) {
    const city = normalizeDestination(seg.city || "");
    if (!city || !isLikelyDestinationCandidate(city)) continue;
    const days = Number(seg.days);
    if (!Number.isFinite(days) || days <= 0 || days > 120) continue;
    const key = slug(city);
    const prev = byCity.get(key);
    const next: { city: string; days: number; kind: "travel" | "meeting"; evidence: string; importance: number } = {
      city,
      days,
      kind: seg.kind === "meeting" ? "meeting" : "travel",
      evidence: cleanStatement(seg.evidence || `${city}${days}天`, 64),
      importance:
        clamp01(
          signals.cityDurationImportanceByCity?.[city],
          seg.kind === "meeting" ? 0.82 : 0.72
        ),
    };
    if (!prev || next.days > prev.days || (next.days === prev.days && next.kind === "meeting")) {
      byCity.set(key, next);
    }
  }

  const explicitTotal = Number(signals.durationDays || 0) || undefined;
  let cityDurations = compactCityDurations(Array.from(byCity.values()));
  if (
    explicitTotal &&
    cityDurations.length === 1 &&
    cityDurations[0].kind === "meeting" &&
    !signals.hasDurationUpdateCue &&
    Math.abs(cityDurations[0].days - explicitTotal) <= 2
  ) {
    cityDurations = [
      {
        ...cityDurations[0],
        days: explicitTotal,
        evidence: cleanStatement(signals.durationEvidence || cityDurations[0].evidence, 64),
      },
    ];
  }
  const citySum = cityDurations.reduce((acc, x) => acc + x.days, 0);
  const cityCount = cityDurations.length;
  const hasTravelSegment = cityDurations.some((x) => x.kind === "travel");

  const candidates: DurationCandidate[] = [];
  if (explicitTotal) {
    const explicitWeight = clamp01(
      signals.hasDurationUpdateCue ? 0.98 : signals.hasExplicitTotalCue ? 0.94 : signals.durationStrength,
      0.78
    );
    candidates.push({
      days: explicitTotal,
      weight: explicitWeight,
      evidence: cleanStatement(signals.durationEvidence || `${explicitTotal}天`, 80),
      source: "explicit_total",
    });
  }
  if (citySum > 0) {
    const sumWeight =
      cityCount >= 2
        ? clamp01(hasTravelSegment ? 0.9 : 0.84, 0.86)
        : clamp01(hasTravelSegment ? 0.76 : 0.72, 0.74);
    candidates.push({
      days: citySum,
      weight: sumWeight,
      evidence: cityDurations.map((x) => `${x.city}${x.days}天`).join(" + "),
      source: "city_sum",
    });
  }
  const maxSeg = cityDurations.slice().sort((a, b) => b.days - a.days)[0];
  if (maxSeg) {
    candidates.push({
      days: maxSeg.days,
      weight: clamp01(maxSeg.kind === "meeting" ? 0.62 : 0.68, 0.66),
      evidence: cleanStatement(`${maxSeg.city}${maxSeg.days}天`, 64),
      source: "max_segment",
    });
  }

  const consensus = weightedMedian(candidates);
  let totalDays = consensus?.days;
  let totalEvidence = consensus?.evidence;

  // 会议日期区间常出现“含首尾”的 1 天偏差（如 4/13-4/18 vs 5天）。
  // 若用户显式总时长存在且仅有单一会议段，优先采用显式总时长。
  if (
    explicitTotal &&
    cityDurations.length === 1 &&
    cityDurations[0].kind === "meeting" &&
    !signals.hasDurationUpdateCue &&
    Math.abs(cityDurations[0].days - explicitTotal) <= 2
  ) {
    totalDays = explicitTotal;
    totalEvidence = cleanStatement(signals.durationEvidence || `${explicitTotal}天`, 80);
  }

  // 防止“显式总时长”在无总时长语气下明显偏离城市时长和（例如 14 vs 7）时占优。
  if (
    explicitTotal &&
    citySum > 0 &&
    !signals.hasExplicitTotalCue &&
    !signals.hasDurationUpdateCue &&
    (explicitTotal >= Math.ceil(citySum * 1.6) || explicitTotal <= Math.floor(citySum * 0.45))
  ) {
    totalDays = citySum;
    totalEvidence = cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
  }

  // 多城市且至少有一个“旅行段”时，优先满足分段总和，避免漏算“会议+旅行”这类组合行程。
  if (cityDurations.length >= 2 && hasTravelSegment && citySum > 0) {
    const explicitStrong =
      !!explicitTotal &&
      (signals.hasExplicitTotalCue || clamp01(signals.durationStrength, 0.55) >= 0.88);
    const underEstimate = !totalDays || totalDays < citySum;
    const shouldUseSum = underEstimate || (signals.hasDurationUpdateCue && !explicitStrong);
    if (shouldUseSum) {
      totalDays = citySum;
      totalEvidence = cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
    }
  }

  if (totalDays != null && totalDays <= 0) totalDays = undefined;
  if (totalDays != null && totalDays > 365) totalDays = 365;

  const emitCityDurationSlots = new Set(cityDurations.map((x) => slug(x.city)));
  if (cityDurations.length === 1 && totalDays != null) {
    const only = cityDurations[0];
    if (only.kind === "travel" && only.days === totalDays) {
      emitCityDurationSlots.delete(slug(only.city));
    }
  }

  return { totalDays, totalEvidence, cityDurations, emitCityDurationSlots };
}

function compactIntentDuration(intent: string, totalDays?: number): string {
  const s = cleanStatement(intent || "", 96);
  if (!s) return s;
  const out = s
    .replace(/(旅游|旅行|出行|度假|玩)\s*(旅游|旅行|出行|度假|玩)/g, "$1")
    .replace(/[，,\s]{2,}/g, " ")
    .replace(/^[，,\s]+|[，,\s]+$/g, "");
  return out || s;
}

function buildGoalNode(params: {
  userText: string;
  signals: IntentSignals;
  totalDays?: number;
  now: string;
}): SlotNodeSpec {
  // 目标标题里的时长强制对齐状态机总时长，避免“意图6天 vs 总时长3天”这类显示分叉。
  const signalsForIntent: IntentSignals = {
    ...params.signals,
    durationDays: params.totalDays || params.signals.durationDays,
  };
  const rawIntent = buildTravelIntentStatement(signalsForIntent, params.userText) || cleanStatement(params.userText, 88);
  const intent = compactIntentDuration(rawIntent, params.totalDays);
  const successCriteria: string[] = [];
  if (params.signals.destinations?.length) {
    successCriteria.push(`覆盖目的地：${params.signals.destinations.join("、")}`);
  }
  if (params.totalDays) {
    successCriteria.push(`总时长满足：${params.totalDays}天`);
  }
  if (params.signals.budgetCny) {
    successCriteria.push(`预算不超过：${params.signals.budgetCny}元`);
  }
  return {
    slotKey: "slot:goal",
    type: "goal",
    layer: "intent",
    statement: intent || "意图：制定任务计划",
    confidence: 0.86,
    importance: clamp01(params.signals.goalImportance, 0.84),
    strength: "hard",
    tags: ["intent", "cg"],
    evidenceIds: [cleanStatement(params.userText, 60)],
    sourceMsgIds: ["latest_user"],
    key: "slot:goal",
    motifType: "expectation",
    claim: intent || "制定任务计划",
    evidence: motifEvidence(params.userText, "latest_user"),
    linkedIntentIds: [],
    revisionHistory: [{ at: params.now, action: "updated", by: "system", reason: "slot_state_machine" }],
    priority: 0.9,
    successCriteria: successCriteria.length ? successCriteria : undefined,
  };
}

function pushEdge(edges: SlotEdgeSpec[], fromSlot: string, toSlot: string, type: SlotEdgeSpec["type"], confidence: number) {
  if (!fromSlot || !toSlot || fromSlot === toSlot) return;
  const key = `${fromSlot}|${toSlot}|${type}`;
  const exists = edges.some((e) => `${e.fromSlot}|${e.toSlot}|${e.type}` === key);
  if (exists) return;
  edges.push({ fromSlot, toSlot, type, confidence: clamp01(confidence, 0.78) });
}

type LimitingFactor = {
  text: string;
  evidence: string;
  hard: boolean;
  severity?: "medium" | "high" | "critical";
  importance: number;
  kind: string;
};

function normalizeLimitingText(raw: string): string {
  return cleanStatement(raw || "", 140)
    .toLowerCase()
    .replace(/[，。,；;！!？?\s]+/g, "")
    .replace(/^(我|我们|家人|父母|父亲|母亲)+/, "")
    .replace(/(需要|必须|尽量|注意|请|希望|可以|不能|不要|避免)/g, "");
}

function isExperienceLikeConstraint(text: string): boolean {
  const s = cleanStatement(text || "", 120);
  if (!s) return false;
  const hasEvent = /球迷|看球|观赛|比赛|球赛|球票|门票|圣西罗|stadium|arena|演唱会|音乐会|演出|展览|看展|concert|match|game/i.test(
    s
  );
  const hasRisk =
    /心脏|慢性病|过敏|医疗|安全|危险|签证|护照|法律|宗教|礼拜|饮食|清真|不会英语|语言障碍/i.test(
      s
    );
  return hasEvent && !hasRisk;
}

function collectLimitingFactors(signals: IntentSignals): LimitingFactor[] {
  const map = new Map<string, LimitingFactor>();
  const upsert = (raw: {
    text?: string;
    evidence?: string;
    hard?: boolean;
    severity?: "medium" | "high" | "critical";
    importance?: number;
    kind?: string;
  }) => {
    const text = cleanStatement(raw.text || "", 120);
    if (!text) return;
    const key = text.toLowerCase();
    const next: LimitingFactor = {
      text,
      evidence: cleanStatement(raw.evidence || text, 80),
      hard: !!raw.hard,
      severity: raw.severity,
      importance: clamp01(raw.importance, raw.hard ? 0.84 : 0.74),
      kind: cleanStatement(raw.kind || "other", 20).toLowerCase() || "other",
    };
    const prev = map.get(key);
    if (!prev) {
      map.set(key, next);
      return;
    }
    map.set(key, {
      text,
      evidence: next.evidence || prev.evidence,
      hard: prev.hard || next.hard,
      severity:
        prev.severity === "critical" || next.severity === "critical"
          ? "critical"
          : prev.severity === "high" || next.severity === "high"
            ? "high"
            : prev.severity || next.severity,
      importance: Math.max(prev.importance, next.importance),
      kind: prev.kind === "other" ? next.kind : prev.kind,
    });
  };

  if (signals.healthConstraint) {
    upsert({
      text: signals.healthConstraint,
      evidence: signals.healthEvidence || signals.healthConstraint,
      hard: true,
      severity: "critical",
      importance: signals.healthImportance,
      kind: "health",
    });
  }

  if (signals.languageConstraint) {
    upsert({
      text: signals.languageConstraint,
      evidence: signals.languageEvidence || signals.languageConstraint,
      hard: true,
      severity: "high",
      importance: signals.languageImportance,
      kind: "language",
    });
  }

  for (const gc of signals.genericConstraints || []) {
    if (isExperienceLikeConstraint(gc.text || "")) continue;
    upsert({
      text: gc.text,
      evidence: gc.evidence || gc.text,
      hard: !!gc.hard,
      severity: gc.severity,
      importance: gc.importance,
      kind: gc.kind || "other",
    });
  }

  const ranked = Array.from(map.values())
    .sort((a, b) => {
      const sevRank = (x?: "medium" | "high" | "critical") =>
        x === "critical" ? 3 : x === "high" ? 2 : x === "medium" ? 1 : 0;
      const sevDiff = sevRank(b.severity) - sevRank(a.severity);
      if (sevDiff !== 0) return sevDiff;
      const hardDiff = (b.hard ? 1 : 0) - (a.hard ? 1 : 0);
      if (hardDiff !== 0) return hardDiff;
      return b.importance - a.importance;
    })
    .slice(0, 12);

  // near-duplicate suppression: same kind and high textual overlap keep the strongest one.
  const deduped: LimitingFactor[] = [];
  for (const cur of ranked) {
    const curNorm = normalizeLimitingText(cur.text);
    const dupIdx = deduped.findIndex((x) => {
      if (x.kind !== cur.kind) return false;
      const xNorm = normalizeLimitingText(x.text);
      if (!xNorm || !curNorm) return false;
      return xNorm === curNorm || xNorm.includes(curNorm) || curNorm.includes(xNorm);
    });
    if (dupIdx < 0) {
      deduped.push(cur);
      continue;
    }
    const prev = deduped[dupIdx];
    const pickCur =
      (cur.severity === "critical" && prev.severity !== "critical") ||
      (cur.severity === "high" && prev.severity === "medium") ||
      (cur.hard && !prev.hard) ||
      cur.importance > prev.importance;
    if (pickCur) deduped[dupIdx] = cur;
  }
  return deduped.slice(0, 8);
}

export function buildSlotStateMachine(params: {
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  signals: IntentSignals;
}): SlotGraphState {
  const latestUserText = cleanStatement(params.userText, 1200);
  const nodes: SlotNodeSpec[] = [];
  const edges: SlotEdgeSpec[] = [];
  const now = nowISO();

  const durationState = buildDurationState(params.signals);
  const goal = buildGoalNode({
    userText: latestUserText,
    signals: params.signals,
    totalDays: durationState.totalDays,
    now,
  });
  nodes.push(goal);

  const destinationMap = new Map<string, string>();
  const pushDestination = (raw?: string) => {
    const city = normalizeDestination(raw || "");
    if (!city || !isLikelyDestinationCandidate(city)) return;
    const key = slug(city);
    if (!key || destinationMap.has(key)) return;
    destinationMap.set(key, city);
  };
  for (const d of params.signals.destinations || []) pushDestination(d);
  for (const seg of durationState.cityDurations) pushDestination(seg.city);
  if (params.signals.criticalPresentation?.city) pushDestination(params.signals.criticalPresentation.city);
  const destinations = Array.from(destinationMap.values()).slice(0, 8);

  const destinationSlotKeys: string[] = [];
  const limitingFactorSlotKeys: string[] = [];
  let peopleSlotKey: string | null = null;
  let budgetSlotKey: string | null = null;
  let budgetSpentSlotKey: string | null = null;
  let budgetPendingSlotKey: string | null = null;
  let durationTotalSlotKey: string | null = null;
  let lodgingSlotKey: string | null = null;
  let scenicSlotKey: string | null = null;
  let activitySlotKey: string | null = null;

  for (const city of destinations) {
    const slotKey = `slot:destination:${slug(city)}`;
    destinationSlotKeys.push(slotKey);
    const imp = clamp01(params.signals.destinationImportanceByCity?.[city], 0.8);
    nodes.push({
      slotKey,
      type: "fact",
      layer: "requirement",
      statement: `目的地: ${city}`,
      confidence: 0.9,
      importance: imp,
      tags: ["destination"],
      evidenceIds: [params.signals.destinationEvidence || city].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "cognitive_step",
      claim: `目的地是${city}`,
      evidence: motifEvidence(params.signals.destinationEvidence || city),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
    });
    pushEdge(edges, slotKey, "slot:goal", "enable", 0.86);
  }

  if (params.signals.activityPreference) {
    const statement = cleanStatement(params.signals.activityPreference, 80);
    if (statement) {
      const hard = !!params.signals.activityPreferenceHard;
      const imp = clamp01(params.signals.activityPreferenceImportance, hard ? 0.84 : 0.7);
      activitySlotKey = "slot:activity_preference";
      nodes.push({
        slotKey: activitySlotKey,
        type: "preference",
        layer: "preference",
        strength: hard ? "hard" : "soft",
        statement: statement.startsWith("活动偏好") ? statement : `活动偏好: ${statement}`,
        confidence: hard ? 0.84 : 0.76,
        importance: imp,
        tags: ["preference", "activity"],
        evidenceIds: [params.signals.activityPreferenceEvidence || statement].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: activitySlotKey,
        motifType: "belief",
        claim: statement,
        evidence: motifEvidence(params.signals.activityPreferenceEvidence || statement),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: imp,
      });
      pushEdge(edges, activitySlotKey, "slot:goal", hard ? "constraint" : "enable", 0.78);
    }
  }

  if (durationState.totalDays) {
    durationTotalSlotKey = "slot:duration_total";
    nodes.push({
      slotKey: "slot:duration_total",
      type: "constraint",
      layer: "requirement",
      strength: "hard",
      statement: `总行程时长: ${durationState.totalDays}天`,
      confidence: clamp01(params.signals.durationStrength, 0.88),
      importance: clamp01(params.signals.durationImportance, 0.84),
      tags: ["duration", "total"],
      evidenceIds: [durationState.totalEvidence || params.signals.durationEvidence || `${durationState.totalDays}天`].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:duration_total",
      motifType: "cognitive_step",
      claim: `总时长约${durationState.totalDays}天`,
      evidence: motifEvidence(durationState.totalEvidence || params.signals.durationEvidence),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: clamp01(params.signals.durationImportance, 0.84),
      successCriteria: [`行程总时长控制在${durationState.totalDays}天`],
    });
    pushEdge(edges, "slot:duration_total", "slot:goal", "constraint", 0.9);
  }

  for (const seg of durationState.cityDurations) {
    const cityKey = slug(seg.city);
    if (!durationState.emitCityDurationSlots.has(cityKey)) continue;
    const slotKey = `slot:duration_city:${cityKey}`;
    nodes.push({
      slotKey,
      type: "fact",
      layer: "requirement",
      statement: `城市时长: ${seg.city} ${seg.days}天`,
      confidence: seg.kind === "meeting" ? 0.88 : 0.84,
      importance: seg.importance,
      tags: ["duration_city", seg.kind],
      evidenceIds: [seg.evidence],
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "cognitive_step",
      claim: `${seg.city}停留${seg.days}天`,
      evidence: motifEvidence(seg.evidence),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: seg.importance,
    });
    const parentDestinationKey = `slot:destination:${cityKey}`;
    if (destinationSlotKeys.includes(parentDestinationKey)) {
      pushEdge(edges, slotKey, parentDestinationKey, "determine", 0.86);
    } else {
      pushEdge(edges, slotKey, "slot:goal", "determine", 0.82);
    }
  }

  for (const sub of params.signals.subLocations || []) {
    const name = cleanStatement(sub.name || "", 40);
    if (!name) continue;
    const parentCity = normalizeDestination(sub.parentCity || "");
    const parentKey =
      parentCity && isLikelyDestinationCandidate(parentCity)
        ? `slot:destination:${slug(parentCity)}`
        : destinations.length
          ? `slot:destination:${slug(destinations[0])}`
          : "slot:goal";
    const slotKey = `slot:sub_location:${slug(parentCity || "root")}:${slug(name)}`;
    const hard = !!sub.hard;
    const importance = clamp01(sub.importance, hard ? 0.86 : 0.62);
    const looksLikeVenueNeed = /(看球|观赛|比赛|球场|stadium|arena|演唱会|演出|展览|看展|concert|match|game)/i.test(
      `${name} ${sub.evidence || ""}`
    );
    nodes.push({
      slotKey,
      type: hard ? "constraint" : "fact",
      layer: "requirement",
      strength: hard ? "hard" : undefined,
      severity: undefined,
      statement: parentCity ? `子地点: ${name}（${parentCity}）` : `子地点: ${name}`,
      confidence: hard ? 0.9 : 0.74,
      importance,
      tags: ["sub_location", sub.kind || "other"],
      evidenceIds: [sub.evidence || name].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: hard ? "hypothesis" : "cognitive_step",
      claim: parentCity ? `${name}归属${parentCity}` : name,
      evidence: motifEvidence(sub.evidence || name),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: importance,
    });
    pushEdge(edges, slotKey, parentKey, hard ? "constraint" : "determine", hard ? 0.92 : 0.78);
    if (activitySlotKey && looksLikeVenueNeed) {
      pushEdge(edges, activitySlotKey, slotKey, "determine", hard ? 0.86 : 0.78);
    }
  }

  if (params.signals.peopleCount) {
    const count = Number(params.signals.peopleCount);
    if (Number.isFinite(count) && count > 0) {
      const importance = clamp01(params.signals.peopleImportance, 0.72);
      nodes.push({
        slotKey: "slot:people",
        type: "fact",
        layer: "requirement",
        statement: `同行人数: ${count}人`,
        confidence: 0.9,
        importance,
        tags: ["people"],
        evidenceIds: [params.signals.peopleEvidence || `${count}人`].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:people",
        motifType: "cognitive_step",
        claim: `同行人数${count}`,
        evidence: motifEvidence(params.signals.peopleEvidence || `${count}人`),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: importance,
      });
      peopleSlotKey = "slot:people";
      pushEdge(edges, "slot:people", "slot:goal", "determine", 0.84);
    }
  }

  if (params.signals.budgetCny) {
    const budget = Number(params.signals.budgetCny);
    if (Number.isFinite(budget) && budget >= 100) {
      const importance = clamp01(params.signals.budgetImportance, 0.84);
      nodes.push({
        slotKey: "slot:budget",
        type: "constraint",
        layer: "requirement",
        strength: "hard",
        statement: `预算上限: ${budget}元`,
        confidence: 0.92,
        importance,
        tags: ["budget"],
        evidenceIds: [params.signals.budgetEvidence || `${budget}元`].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget",
        motifType: "hypothesis",
        claim: `预算约束${budget}元`,
        evidence: motifEvidence(params.signals.budgetEvidence || `${budget}元`),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: importance,
        successCriteria: [`预算不超${budget}元`],
      });
      budgetSlotKey = "slot:budget";
      pushEdge(edges, "slot:budget", "slot:goal", "constraint", 0.92);
    }
  }
  if (params.signals.budgetSpentCny != null || params.signals.budgetSpentDeltaCny != null) {
    const spent = Number(params.signals.budgetSpentCny);
    const spentFromDelta = Number(params.signals.budgetSpentDeltaCny);
    const normalizedSpent =
      Number.isFinite(spent) && spent >= 0
        ? Math.round(spent)
        : Number.isFinite(spentFromDelta) && spentFromDelta > 0
          ? Math.round(spentFromDelta)
          : 0;
    if (normalizedSpent > 0) {
      const spentImportance = clamp01(params.signals.budgetImportance, 0.78);
      nodes.push({
        slotKey: "slot:budget_spent",
        type: "fact",
        layer: "requirement",
        statement: `已花预算: ${normalizedSpent}元`,
        confidence: 0.88,
        importance: spentImportance,
        tags: ["budget", "spent"],
        evidenceIds: [params.signals.budgetSpentEvidence || `${normalizedSpent}元`].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget_spent",
        motifType: "cognitive_step",
        claim: `当前已花费${normalizedSpent}元`,
        evidence: motifEvidence(params.signals.budgetSpentEvidence || `${normalizedSpent}元`),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: spentImportance,
      });
      budgetSpentSlotKey = "slot:budget_spent";
      pushEdge(edges, "slot:budget_spent", "slot:goal", "determine", 0.86);
    }
  }
  if (params.signals.budgetPendingCny != null) {
    const pending = Number(params.signals.budgetPendingCny);
    const normalizedPending = Number.isFinite(pending) && pending > 0 ? Math.round(pending) : 0;
    if (normalizedPending > 0) {
      const pendingImportance = clamp01(params.signals.budgetImportance, 0.7);
      nodes.push({
        slotKey: "slot:budget_pending",
        type: "constraint",
        layer: "requirement",
        strength: "soft",
        statement: `待确认预算: ${normalizedPending}元`,
        confidence: 0.8,
        importance: pendingImportance,
        tags: ["budget", "pending"],
        evidenceIds: [params.signals.budgetPendingEvidence || `${normalizedPending}元`].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget_pending",
        motifType: "hypothesis",
        claim: `待确认支出约${normalizedPending}元`,
        evidence: motifEvidence(params.signals.budgetPendingEvidence || `${normalizedPending}元`),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: pendingImportance,
      });
      budgetPendingSlotKey = "slot:budget_pending";
      pushEdge(edges, "slot:budget_pending", "slot:goal", "determine", 0.76);
    }
  }

  const totalBudgetForRemaining =
    Number.isFinite(Number(params.signals.budgetCny)) && Number(params.signals.budgetCny) > 0
      ? Math.round(Number(params.signals.budgetCny))
      : 0;
  const spentBudgetForRemaining =
    Number.isFinite(Number(params.signals.budgetSpentCny)) && Number(params.signals.budgetSpentCny) >= 0
      ? Math.round(Number(params.signals.budgetSpentCny))
      : 0;
  const remainingByCalc =
    totalBudgetForRemaining > 0 ? Math.max(0, totalBudgetForRemaining - spentBudgetForRemaining) : 0;
  const remainingBySignal =
    Number.isFinite(Number(params.signals.budgetRemainingCny)) && Number(params.signals.budgetRemainingCny) >= 0
      ? Math.round(Number(params.signals.budgetRemainingCny))
      : 0;
  const remainingBudget = Math.max(remainingByCalc, remainingBySignal);
  if (totalBudgetForRemaining > 0) {
    const remainingImportance = clamp01(params.signals.budgetImportance, 0.86);
    const remainingEvidence =
      spentBudgetForRemaining > 0
        ? cleanStatement(
            `${params.signals.budgetEvidence || `${totalBudgetForRemaining}元`}；${params.signals.budgetSpentEvidence || `${spentBudgetForRemaining}元`}`,
            80
          )
        : cleanStatement(
            `${params.signals.budgetEvidence || `${totalBudgetForRemaining}元`}；尚未记录已花预算`,
            80
          );
    nodes.push({
      slotKey: "slot:budget_remaining",
      type: "constraint",
      layer: "requirement",
      strength: "hard",
      statement: `剩余预算: ${remainingBudget}元`,
      confidence: 0.9,
      importance: remainingImportance,
      tags: ["budget", "remaining"],
      evidenceIds: [remainingEvidence].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:budget_remaining",
      motifType: "hypothesis",
      claim: `可用预算还剩${remainingBudget}元`,
      evidence: motifEvidence(`总预算${totalBudgetForRemaining}元，已花${spentBudgetForRemaining}元，剩余${remainingBudget}元`),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: remainingImportance,
      successCriteria: [`剩余预算不少于${Math.round(remainingBudget * 0.2)}元用于机动安排`],
    });
    pushEdge(edges, "slot:budget_remaining", "slot:goal", "constraint", 0.92);
    if (budgetSlotKey) pushEdge(edges, budgetSlotKey, "slot:budget_remaining", "determine", 0.9);
    if (budgetSpentSlotKey) pushEdge(edges, budgetSpentSlotKey, "slot:budget_remaining", "determine", 0.9);
    if (budgetPendingSlotKey) pushEdge(edges, budgetPendingSlotKey, "slot:budget_remaining", "determine", 0.72);
  }

  const limitingFactors = collectLimitingFactors(params.signals);
  for (const factor of limitingFactors) {
    const kind = factor.kind || "other";
    const slotKey = `slot:constraint:limiting:${slug(kind)}:${slug(factor.text)}`;
    const severity = factor.severity || (factor.hard ? "high" : "medium");
    const riskKind = new Set(["health", "safety", "legal", "mobility"]);
    const imp = clamp01(factor.importance, factor.hard ? 0.84 : 0.74);
    const rebuttalPoints =
      kind === "health"
        ? ["若忽略此限制，行程安全风险显著上升"]
        : kind === "language"
          ? ["若忽略此限制，沟通与执行效率会明显下降"]
          : kind === "diet"
            ? ["若忽略此限制，饮食可执行性与舒适度会下降"]
            : kind === "religion"
              ? ["若忽略此限制，关键活动安排可能与信仰冲突"]
              : undefined;

    nodes.push({
      slotKey,
      type: "constraint",
      layer: riskKind.has(kind) && (severity === "critical" || severity === "high") ? "risk" : "requirement",
      strength: factor.hard ? "hard" : "soft",
      severity,
      statement: `限制因素: ${factor.text}`,
      confidence: factor.hard ? 0.9 : 0.82,
      importance: imp,
      tags: ["limiting_factor", kind],
      evidenceIds: [factor.evidence || factor.text].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "hypothesis",
      claim: factor.text,
      evidence: motifEvidence(factor.evidence || factor.text),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
      rebuttalPoints,
    });
    limitingFactorSlotKeys.push(slotKey);
    pushEdge(edges, slotKey, "slot:goal", factor.hard ? "constraint" : "determine", factor.hard ? 0.92 : 0.82);
  }

  if (params.signals.criticalPresentation) {
    const p = params.signals.criticalPresentation;
    const city = normalizeDestination(p.city || "");
    const detail = city ? `${p.reason}（${city}，${p.days}天）` : `${p.reason}（${p.days}天）`;
    const k = `slot:meeting_critical:${slug(city || p.reason || "critical")}`;
    const imp = clamp01(params.signals.criticalImportance, 0.95);
    nodes.push({
      slotKey: k,
      type: "constraint",
      layer: "risk",
      strength: "hard",
      severity: "critical",
      statement: `关键日: ${detail}`,
      confidence: 0.95,
      importance: imp,
      tags: ["critical_day", "risk"],
      evidenceIds: [p.evidence || p.reason].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: k,
      motifType: "expectation",
      claim: detail,
      evidence: motifEvidence(p.evidence || p.reason),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
      successCriteria: [`保留${p.days}天用于关键任务`],
    });
    if (city && destinations.some((x) => slug(x) === slug(city))) {
      pushEdge(edges, k, `slot:destination:${slug(city)}`, "constraint", 0.94);
    } else {
      pushEdge(edges, k, "slot:goal", "constraint", 0.94);
    }
  }

  if (params.signals.scenicPreference) {
    const imp = clamp01(params.signals.scenicPreferenceImportance, params.signals.scenicPreferenceHard ? 0.8 : 0.68);
    nodes.push({
      slotKey: "slot:scenic_preference",
      type: "preference",
      layer: "preference",
      strength: params.signals.scenicPreferenceHard ? "hard" : "soft",
      statement: `景点偏好: ${params.signals.scenicPreference}`,
      confidence: 0.76,
      importance: imp,
      tags: ["preference", "scenic"],
      evidenceIds: [params.signals.scenicPreferenceEvidence || params.signals.scenicPreference].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:scenic_preference",
      motifType: "belief",
      claim: params.signals.scenicPreference,
      evidence: motifEvidence(params.signals.scenicPreferenceEvidence || params.signals.scenicPreference),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
    });
    scenicSlotKey = "slot:scenic_preference";
    pushEdge(edges, "slot:scenic_preference", "slot:goal", params.signals.scenicPreferenceHard ? "constraint" : "enable", 0.76);
  }

  if (params.signals.lodgingPreference) {
    const imp = clamp01(params.signals.lodgingPreferenceImportance, params.signals.lodgingPreferenceHard ? 0.82 : 0.68);
    nodes.push({
      slotKey: "slot:lodging",
      type: "preference",
      layer: "preference",
      strength: params.signals.lodgingPreferenceHard ? "hard" : "soft",
      statement: `住宿偏好: ${params.signals.lodgingPreference}`,
      confidence: 0.76,
      importance: imp,
      tags: ["preference", "lodging"],
      evidenceIds: [params.signals.lodgingPreferenceEvidence || params.signals.lodgingPreference].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:lodging",
      motifType: "belief",
      claim: params.signals.lodgingPreference,
      evidence: motifEvidence(params.signals.lodgingPreferenceEvidence || params.signals.lodgingPreference),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
    });
    lodgingSlotKey = "slot:lodging";
    pushEdge(edges, "slot:lodging", "slot:goal", params.signals.lodgingPreferenceHard ? "constraint" : "enable", 0.76);
  }

  const conflictInputs: LimitingFactorInput[] = limitingFactors.map((x) => ({
    text: x.text,
    kind: x.kind,
    hard: x.hard,
    severity: x.severity,
    importance: x.importance,
  }));
  const conflicts = analyzeConstraintConflicts({
    budgetCny: params.signals.budgetCny,
    lodgingPreference: params.signals.lodgingPreference,
    scenicPreference: params.signals.scenicPreference,
    peopleCount: params.signals.peopleCount,
    totalDays: durationState.totalDays,
    destinations,
    limitingFactors: conflictInputs,
  });

  const relatedSlotMap: Record<
    "budget" | "lodging" | "duration_total" | "destination" | "scenic_preference" | "limiting_factor" | "people",
    string[]
  > = {
    budget: budgetSlotKey ? [budgetSlotKey] : [],
    lodging: lodgingSlotKey ? [lodgingSlotKey] : [],
    duration_total: durationTotalSlotKey ? [durationTotalSlotKey] : [],
    destination: destinationSlotKeys.slice(),
    scenic_preference: scenicSlotKey ? [scenicSlotKey] : [],
    limiting_factor: limitingFactorSlotKeys.slice(),
    people: peopleSlotKey ? [peopleSlotKey] : [],
  };

  for (const c of conflicts) {
    const slotKey = `slot:conflict:${slug(c.key)}`;
    nodes.push({
      slotKey,
      type: "constraint",
      layer: c.severity === "critical" || c.severity === "high" ? "risk" : "requirement",
      strength: "hard",
      severity: c.severity,
      statement: `冲突提示: ${cleanStatement(c.statement, 120)}`,
      confidence: 0.88,
      importance: clamp01(c.importance, 0.8),
      tags: ["conflict", "planner"],
      evidenceIds: c.evidence.map((x) => cleanStatement(x, 60)).filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "hypothesis",
      claim: cleanStatement(c.statement, 120),
      evidence: c.evidence.length ? c.evidence.map((x) => ({ quote: cleanStatement(x, 80), source: "dialogue" })) : undefined,
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "conflict_analyzer" }],
      priority: clamp01(c.importance, 0.8),
      rebuttalPoints: ["可通过调整预算/时长/约束优先级来消解冲突"],
    });
    pushEdge(edges, slotKey, "slot:goal", "constraint", 0.9);

    for (const related of c.relatedTypes) {
      for (const targetSlot of relatedSlotMap[related] || []) {
        pushEdge(edges, slotKey, targetSlot, "conflicts_with", 0.84);
      }
    }
  }

  return {
    nodes,
    edges,
    notes: ["slot_state_machine_v3_limiting_conflict_aware"],
  };
}
