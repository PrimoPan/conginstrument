import type { IntentSignals } from "./intentSignals.js";
import { buildTravelIntentStatement, isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";
import { cleanStatement } from "./text.js";
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

  const cityDurations = Array.from(byCity.values());
  const citySum = cityDurations.reduce((acc, x) => acc + x.days, 0);
  const cityCount = cityDurations.length;
  const explicitTotal = Number(signals.durationDays || 0) || undefined;

  let totalDays = explicitTotal;
  let totalEvidence = cleanStatement(signals.durationEvidence || "", 80);
  if (cityCount >= 2 && citySum > 0) {
    totalDays = Math.max(Number(explicitTotal || 0), citySum) || citySum;
    totalEvidence = cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
  } else if (!totalDays && citySum > 0) {
    totalDays = citySum;
    totalEvidence = cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
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
  if (!s || !totalDays) return s;
  const out = s
    .replace(new RegExp(`${totalDays}\\s*天`, "g"), "")
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
  const rawIntent = buildTravelIntentStatement(params.signals, params.userText) || cleanStatement(params.userText, 88);
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

function genericConstraintPrefix(kind?: string): string {
  if (kind === "legal") return "法律约束";
  if (kind === "safety") return "安全约束";
  if (kind === "mobility") return "出行约束";
  if (kind === "logistics") return "行程约束";
  return "关键约束";
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

  const destinations = (params.signals.destinations || [])
    .map((x) => normalizeDestination(x))
    .filter((x) => x && isLikelyDestinationCandidate(x))
    .slice(0, 8);

  for (const city of destinations) {
    const slotKey = `slot:destination:${slug(city)}`;
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

  if (durationState.totalDays) {
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
    if (destinations.some((x) => slug(x) === cityKey)) {
      pushEdge(edges, slotKey, parentDestinationKey, "determine", 0.86);
    } else {
      pushEdge(edges, slotKey, "slot:goal", "determine", 0.82);
    }
  }

  for (const sub of params.signals.subLocations || []) {
    const name = cleanStatement(sub.name || "", 40);
    if (!name) continue;
    const parentCity = normalizeDestination(sub.parentCity || "");
    const parentKey = parentCity && isLikelyDestinationCandidate(parentCity)
      ? `slot:destination:${slug(parentCity)}`
      : "slot:goal";
    const slotKey = `slot:sub_location:${slug(parentCity || "root")}:${slug(name)}`;
    const hard = !!sub.hard;
    const importance = clamp01(sub.importance, hard ? 0.86 : 0.62);
    nodes.push({
      slotKey,
      type: hard ? "constraint" : "fact",
      layer: hard ? "risk" : "requirement",
      strength: hard ? "hard" : undefined,
      severity: hard ? "high" : undefined,
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
      pushEdge(edges, "slot:budget", "slot:goal", "constraint", 0.92);
    }
  }

  if (params.signals.healthConstraint) {
    const imp = clamp01(params.signals.healthImportance, 0.95);
    nodes.push({
      slotKey: "slot:health",
      type: "constraint",
      layer: "risk",
      strength: "hard",
      severity: "critical",
      statement: `健康约束: ${params.signals.healthConstraint}`,
      confidence: 0.95,
      importance: imp,
      tags: ["health", "risk"],
      evidenceIds: [params.signals.healthEvidence || params.signals.healthConstraint].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:health",
      motifType: "hypothesis",
      claim: params.signals.healthConstraint,
      evidence: motifEvidence(params.signals.healthEvidence || params.signals.healthConstraint),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
      rebuttalPoints: ["若取消该约束，行程风险明显上升"],
    });
    pushEdge(edges, "slot:health", "slot:goal", "constraint", 0.96);
  }

  if (params.signals.languageConstraint) {
    const imp = clamp01(params.signals.languageImportance, 0.82);
    nodes.push({
      slotKey: "slot:language",
      type: "constraint",
      layer: "requirement",
      strength: "hard",
      statement: `语言约束: ${params.signals.languageConstraint}`,
      confidence: 0.9,
      importance: imp,
      tags: ["language", "communication"],
      evidenceIds: [params.signals.languageEvidence || params.signals.languageConstraint].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:language",
      motifType: "hypothesis",
      claim: params.signals.languageConstraint,
      evidence: motifEvidence(params.signals.languageEvidence || params.signals.languageConstraint),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
      rebuttalPoints: ["若不处理语言沟通，执行效率与安全性会下降"],
    });
    pushEdge(edges, "slot:language", "slot:goal", "constraint", 0.9);
  }

  for (const gc of (params.signals.genericConstraints || []).slice(0, 6)) {
    const text = cleanStatement(gc.text || "", 120);
    if (!text) continue;
    const prefix = genericConstraintPrefix(gc.kind);
    const slotKey = `slot:constraint:${slug(gc.kind || "other")}:${slug(text)}`;
    const hard = !!gc.hard;
    const severity = gc.severity || (hard ? "high" : "medium");
    const imp = clamp01(gc.importance, hard ? 0.84 : 0.74);
    nodes.push({
      slotKey,
      type: "constraint",
      layer: severity === "critical" || severity === "high" ? "risk" : "requirement",
      strength: hard ? "hard" : "soft",
      severity,
      statement: `${prefix}: ${text}`,
      confidence: hard ? 0.9 : 0.8,
      importance: imp,
      tags: ["generic_constraint", gc.kind || "other"],
      evidenceIds: [gc.evidence || gc.text].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "hypothesis",
      claim: text,
      evidence: motifEvidence(gc.evidence || gc.text),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: imp,
    });
    pushEdge(edges, slotKey, "slot:goal", hard ? "constraint" : "determine", hard ? 0.9 : 0.8);
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
    pushEdge(edges, "slot:lodging", "slot:goal", params.signals.lodgingPreferenceHard ? "constraint" : "enable", 0.76);
  }

  return {
    nodes,
    edges,
    notes: ["slot_state_machine_v1"],
  };
}
