import { openai } from "../llmClient.js";
import { cleanStatement } from "./text.js";
import {
  type IntentSignals,
  isLikelyDestinationCandidate,
  normalizeDestination,
} from "./intentSignals.js";
import { LANGUAGE_CONSTRAINT_RE, MEDICAL_HEALTH_RE } from "./constants.js";
import { classifyConstraintText, dedupeClassifiedConstraints } from "./constraintClassifier.js";

type SlotExtractionResult = {
  intent_summary?: string;
  intent_importance?: number;
  total_duration?: {
    days?: number;
    evidence?: string;
    importance?: number;
    confidence?: number;
  };
  destinations?: Array<{
    name?: string;
    evidence?: string;
    importance?: number;
    confidence?: number;
    role?: "travel" | "meeting" | "transit" | "other";
    granularity?: "country" | "region" | "city" | "district" | "venue" | "poi" | "other";
    parent_city?: string;
  }>;
  city_durations?: Array<{
    city?: string;
    days?: number;
    kind?: "travel" | "meeting";
    evidence?: string;
    importance?: number;
    confidence?: number;
  }>;
  sub_locations?: Array<{
    name?: string;
    parent_city?: string;
    kind?: "district" | "venue" | "poi" | "landmark" | "area" | "other";
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  }>;
  budget?: {
    cny?: number;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  };
  people?: {
    count?: number;
    evidence?: string;
    importance?: number;
    confidence?: number;
  };
  critical_days?: Array<{
    days?: number;
    reason?: string;
    city?: string;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  }>;
  health_constraints?: Array<{
    text?: string;
    evidence?: string;
    severity?: "medium" | "high" | "critical";
    importance?: number;
    confidence?: number;
  }>;
  language_constraints?: Array<{
    text?: string;
    evidence?: string;
    severity?: "medium" | "high" | "critical";
    importance?: number;
    confidence?: number;
  }>;
  constraints?: Array<{
    text?: string;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  }>;
  scenic_preference?: {
    text?: string;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  };
  lodging_preference?: {
    text?: string;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
  };
  confidence?: number;
};

function clamp01(x: any, fallback = 0.7) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampImportance(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function parseJsonSafe(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const SUB_LOCATION_HINT_RE =
  /(球场|体育场|会展中心|会议中心|大学|学院|博物馆|公园|海滩|车站|机场|码头|教堂|广场|大道|街区|酒店|剧院|stadium|arena|museum|park|beach|district|quarter|square|centre|center|ccib|fira)/i;

function toInt(x: any): number | undefined {
  const n = Number(x);
  if (!Number.isFinite(n)) return undefined;
  const v = Math.round(n);
  return v;
}

function pickTopCritical(
  list: NonNullable<SlotExtractionResult["critical_days"]>
): NonNullable<IntentSignals["criticalPresentation"]> | null {
  const candidates = list
    .map((x) => {
      const days = toInt(x.days);
      const reason = cleanStatement(x.reason || "", 28);
      if (!days || days <= 0 || days > 14 || !reason) return null;
      const city = normalizeDestination(x.city || "");
      const cityOk = city && isLikelyDestinationCandidate(city) ? city : undefined;
      const imp = clampImportance(x.importance, x.hard ? 0.95 : 0.84);
      const conf = clamp01(x.confidence, 0.86);
      const hard = !!x.hard;
      const score = (hard ? 0.22 : 0) + imp * 0.55 + conf * 0.23;
      return {
        days,
        reason,
        city: cityOk,
        evidence: cleanStatement(x.evidence || `${reason}${days}天`, 64),
        score,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const best = candidates[0];
  return {
    days: best.days,
    reason: best.reason,
    city: best.city,
    evidence: best.evidence,
  };
}

function slotsToSignals(slots: SlotExtractionResult): IntentSignals {
  const out: IntentSignals = {};
  const subLocationChildToParent = new Map<string, string>();
  const subLocationDedup = new Set<string>();
  const ensureSubLocation = (params: {
    name: string;
    parentCity?: string;
    evidence?: string;
    kind?: "district" | "venue" | "poi" | "landmark" | "area" | "other";
    hard?: boolean;
    importance?: number;
  }) => {
    const name = cleanStatement(params.name || "", 32);
    if (!name) return;
    const nameNorm = normalizeDestination(name) || name.toLowerCase();
    const parentCity = normalizeDestination(params.parentCity || "");
    const parentOk = parentCity && isLikelyDestinationCandidate(parentCity) ? parentCity : undefined;
    const key = `${nameNorm.toLowerCase()}|${(parentOk || "").toLowerCase()}`;
    if (subLocationDedup.has(key)) return;
    subLocationDedup.add(key);
    if (!out.subLocations) out.subLocations = [];
    if (parentOk) subLocationChildToParent.set(nameNorm.toLowerCase(), parentOk);
    out.subLocations.push({
      name,
      parentCity: parentOk,
      evidence: cleanStatement(params.evidence || name, 60),
      kind: params.kind || "other",
      hard: !!params.hard,
      importance: clampImportance(params.importance, params.hard ? 0.78 : 0.62),
    });
  };

  if (Array.isArray(slots.sub_locations) && slots.sub_locations.length) {
    for (const s of slots.sub_locations) {
      ensureSubLocation({
        name: s?.name || "",
        parentCity: s?.parent_city || "",
        evidence: s?.evidence || s?.name || "",
        kind: (s?.kind as any) || "other",
        hard: !!s?.hard,
        importance: s?.importance,
      });
    }
    if (out.subLocations?.length) out.subLocations = out.subLocations.slice(0, 12);
  }

  if (slots.intent_importance != null) {
    out.goalImportance = clampImportance(slots.intent_importance, 0.82);
  }

  const destinationImportanceByCity: Record<string, number> = {};
  if (Array.isArray(slots.destinations)) {
    const seen = new Set<string>();
    const dests: string[] = [];
    const evidences: string[] = [];

    for (const d of slots.destinations) {
      const city = normalizeDestination(d?.name || "");
      if (!city || !isLikelyDestinationCandidate(city) || seen.has(city)) continue;
      const granularity = d?.granularity || "city";
      const isSubGranularity =
        granularity === "district" || granularity === "venue" || granularity === "poi" || granularity === "other";
      const parentCity = normalizeDestination(d?.parent_city || "");
      const parentOk = parentCity && isLikelyDestinationCandidate(parentCity) ? parentCity : undefined;
      const shouldTreatAsSub = isSubGranularity || d?.role === "other" || SUB_LOCATION_HINT_RE.test(city);
      if (shouldTreatAsSub) {
        ensureSubLocation({
          name: city,
          parentCity: parentOk,
          evidence: d?.evidence || d?.name || city,
          kind: isSubGranularity ? ((d?.granularity as any) || "other") : "venue",
          hard: false,
          importance: d?.importance,
        });
        continue;
      }
      if (subLocationChildToParent.has(city.toLowerCase())) continue;
      seen.add(city);
      dests.push(city);
      evidences.push(cleanStatement(d?.evidence || d?.name || city, 40));
      destinationImportanceByCity[city] = clampImportance(d?.importance, 0.8);
    }

    if (dests.length) {
      out.destinations = dests.slice(0, 6);
      out.destination = out.destinations[0];
      out.destinationEvidences = evidences.slice(0, 6);
      out.destinationEvidence = out.destinationEvidences[0];
      out.destinationImportanceByCity = destinationImportanceByCity;
      const avgImp =
        Object.values(destinationImportanceByCity).reduce((a, b) => a + b, 0) /
        Math.max(1, Object.keys(destinationImportanceByCity).length);
      out.destinationImportance = clampImportance(avgImp, 0.8);
    }
  }

  if (out.subLocations?.length) {
    const blocked = new Set(
      out.subLocations
        .filter((x) => x.parentCity)
        .map((x) => normalizeDestination(x.name || "").toLowerCase())
        .filter(Boolean)
    );
    const kept = (out.destinations || []).filter(
      (x) => x && !blocked.has(normalizeDestination(x).toLowerCase())
    );
    for (const sub of out.subLocations) {
      if (!sub.parentCity) continue;
      const parent = normalizeDestination(sub.parentCity);
      if (!parent || !isLikelyDestinationCandidate(parent)) continue;
      if (!kept.includes(parent)) kept.push(parent);
      if (out.destinationImportanceByCity) {
        out.destinationImportanceByCity[parent] = Math.max(
          Number(out.destinationImportanceByCity[parent]) || 0,
          clampImportance(sub.importance, 0.76)
        );
      }
    }
    if (kept.length) {
      out.destinations = kept.slice(0, 6);
      out.destination = out.destinations[0];
      if (!out.destinationEvidence) out.destinationEvidence = out.destinations[0];
    }
  }

  const cityDurationImportanceByCity: Record<string, number> = {};
  if (Array.isArray(slots.city_durations)) {
    const map = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting" }>();
    for (const seg of slots.city_durations) {
      const rawCity = normalizeDestination(seg?.city || "");
      const city = rawCity ? subLocationChildToParent.get(rawCity.toLowerCase()) || rawCity : "";
      const days = toInt(seg?.days);
      if (!city || !days || days <= 0 || days > 120 || !isLikelyDestinationCandidate(city)) continue;
      const kind: "travel" | "meeting" = seg?.kind === "meeting" ? "meeting" : "travel";
      const evidence = cleanStatement(seg?.evidence || `${city}${days}天`, 54);
      const cur = map.get(city);
      const shouldReplace =
        !cur ||
        days > cur.days ||
        (days === cur.days && kind === "meeting" && cur.kind !== "meeting");
      if (shouldReplace) {
        map.set(city, { city, days, evidence, kind });
      }
      cityDurationImportanceByCity[city] = clampImportance(seg?.importance, kind === "meeting" ? 0.82 : 0.72);
    }
    if (map.size) {
      out.cityDurations = Array.from(map.values()).slice(0, 8);
      out.cityDurationImportanceByCity = cityDurationImportanceByCity;

      const hasTravel = out.cityDurations.some((x) => x.kind === "travel");
      const distinctCities = new Set(out.cityDurations.map((x) => x.city)).size;
      const sumDays = out.cityDurations.reduce((acc, x) => acc + x.days, 0);
      if (hasTravel && distinctCities >= 2 && (!out.durationDays || sumDays >= out.durationDays)) {
        out.durationDays = sumDays;
        out.durationEvidence = out.cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
        out.durationStrength = 0.88;
        out.durationImportance = clampImportance(
          Object.values(cityDurationImportanceByCity).reduce((a, b) => a + b, 0) /
            Math.max(1, Object.keys(cityDurationImportanceByCity).length),
          0.8
        );
      }
    }
  }

  if (slots.total_duration && toInt(slots.total_duration.days)) {
    const days = toInt(slots.total_duration.days)!;
    if (days > 0 && days <= 120) {
      out.durationDays = days;
      out.durationEvidence = cleanStatement(slots.total_duration.evidence || `${days}天`, 54);
      out.durationStrength = Math.max(0.84, clamp01(slots.total_duration.confidence, 0.9));
      out.durationImportance = clampImportance(slots.total_duration.importance, 0.8);
      out.hasTemporalAnchor = true;
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
    }
  }

  if (slots.budget && toInt(slots.budget.cny)) {
    const cny = toInt(slots.budget.cny)!;
    if (cny >= 100 && cny <= 50_000_000) {
      out.budgetCny = cny;
      out.budgetEvidence = cleanStatement(slots.budget.evidence || `${cny}元`, 40);
      out.budgetImportance = clampImportance(slots.budget.importance, slots.budget.hard ? 0.88 : 0.78);
    }
  }

  if (slots.people && toInt(slots.people.count)) {
    const count = toInt(slots.people.count)!;
    if (count > 0 && count <= 200) {
      out.peopleCount = count;
      out.peopleEvidence = cleanStatement(slots.people.evidence || `${count}人`, 36);
      out.peopleImportance = clampImportance(slots.people.importance, 0.72);
    }
  }

  if (Array.isArray(slots.critical_days) && slots.critical_days.length) {
    const best = pickTopCritical(slots.critical_days);
    if (best) {
      out.criticalPresentation = best;
      const imp = Math.max(
        ...slots.critical_days.map((x) => clampImportance(x?.importance, x?.hard ? 0.95 : 0.84)),
        0.9
      );
      out.criticalImportance = clampImportance(imp, 0.95);
    }
  }

  const rawConstraints: Array<{
    text: string;
    evidence: string;
    hard?: boolean;
    importance?: number;
    score: number;
  }> = [];
  const pushRawConstraint = (params: {
    text?: string;
    evidence?: string;
    hard?: boolean;
    importance?: number;
    confidence?: number;
    severity?: "medium" | "high" | "critical";
  }) => {
    const text = cleanStatement(params.text || "", 96);
    if (!text) return;
    const evidence = cleanStatement(params.evidence || params.text || "", 60);
    const imp = clampImportance(params.importance, params.hard ? 0.84 : 0.76);
    const score =
      (params.severity === "critical" ? 0.25 : params.severity === "high" ? 0.16 : params.severity === "medium" ? 0.08 : 0) +
      imp * 0.55 +
      clamp01(params.confidence, 0.82) * 0.2 +
      (params.hard ? 0.1 : 0);
    rawConstraints.push({
      text,
      evidence,
      hard: !!params.hard,
      importance: imp,
      score,
    });
  };

  for (const x of slots.health_constraints || []) {
    pushRawConstraint({
      text: x?.text,
      evidence: x?.evidence,
      hard: true,
      importance: x?.importance,
      confidence: x?.confidence,
      severity: x?.severity,
    });
  }
  for (const x of slots.language_constraints || []) {
    pushRawConstraint({
      text: x?.text,
      evidence: x?.evidence,
      hard: !!x?.severity && x.severity !== "medium",
      importance: x?.importance,
      confidence: x?.confidence,
      severity: x?.severity,
    });
  }
  for (const x of slots.constraints || []) {
    pushRawConstraint({
      text: x?.text,
      evidence: x?.evidence,
      hard: !!x?.hard,
      importance: x?.importance,
      confidence: x?.confidence,
      severity: undefined,
    });
  }

  const classified = rawConstraints
    .map((x) => {
      const c = classifyConstraintText({
        text: x.text,
        evidence: x.evidence,
        hardHint: x.hard,
        importance: x.importance,
      });
      if (!c) return null;
      return { raw: x, c };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const healthBest = classified
    .filter((x) => x.c.family === "health")
    .sort((a, b) => b.raw.score - a.raw.score)[0];
  if (healthBest) {
    out.healthConstraint = healthBest.c.text;
    out.healthEvidence = healthBest.c.evidence;
    out.healthImportance = healthBest.c.importance;
  }

  const languageBest = classified
    .filter((x) => x.c.family === "language")
    .sort((a, b) => b.raw.score - a.raw.score)[0];
  if (languageBest) {
    out.languageConstraint = languageBest.c.text;
    out.languageEvidence = languageBest.c.evidence;
    out.languageImportance = languageBest.c.importance;
  }

  const genericClassified = dedupeClassifiedConstraints(
    classified
      .filter((x) => x.c.family === "generic")
      .sort((a, b) => b.raw.score - a.raw.score)
      .map((x) => ({
        text: x.c.text,
        evidence: x.c.evidence,
        kind: x.c.kind,
        hard: x.c.hard,
        severity: x.c.severity,
        importance: x.c.importance,
      }))
  );
  if (genericClassified.length) {
    out.genericConstraints = genericClassified.slice(0, 6);
  }

  // Backward-compatible safety net for older model outputs.
  if (!out.healthConstraint && Array.isArray(slots.health_constraints)) {
    const fallbackHealth = slots.health_constraints.find((x) => MEDICAL_HEALTH_RE.test(String(x?.text || "")));
    if (fallbackHealth?.text) {
      out.healthConstraint = cleanStatement(fallbackHealth.text, 96);
      out.healthEvidence = cleanStatement(fallbackHealth.evidence || fallbackHealth.text, 60);
      out.healthImportance = clampImportance(fallbackHealth.importance, 0.95);
    }
  }
  if (!out.languageConstraint && Array.isArray(slots.language_constraints)) {
    const fallbackLang = slots.language_constraints.find((x) => LANGUAGE_CONSTRAINT_RE.test(String(x?.text || "")));
    if (fallbackLang?.text) {
      out.languageConstraint = cleanStatement(fallbackLang.text, 96);
      out.languageEvidence = cleanStatement(fallbackLang.evidence || fallbackLang.text, 60);
      out.languageImportance = clampImportance(fallbackLang.importance, 0.82);
    }
  }

  if (slots.scenic_preference?.text) {
    out.scenicPreference = cleanStatement(slots.scenic_preference.text, 64);
    out.scenicPreferenceEvidence = cleanStatement(
      slots.scenic_preference.evidence || slots.scenic_preference.text,
      60
    );
    out.scenicPreferenceHard = !!slots.scenic_preference.hard;
    out.scenicPreferenceImportance = clampImportance(
      slots.scenic_preference.importance,
      slots.scenic_preference.hard ? 0.8 : 0.66
    );
  }

  if (slots.lodging_preference?.text) {
    out.lodgingPreference = cleanStatement(slots.lodging_preference.text, 64);
    out.lodgingPreferenceEvidence = cleanStatement(
      slots.lodging_preference.evidence || slots.lodging_preference.text,
      60
    );
    out.lodgingPreferenceHard = !!slots.lodging_preference.hard;
    out.lodgingPreferenceImportance = clampImportance(
      slots.lodging_preference.importance,
      slots.lodging_preference.hard ? 0.82 : 0.66
    );
  }

  if (slots.intent_summary) {
    out.destinationEvidence = out.destinationEvidence || cleanStatement(slots.intent_summary, 60);
  }

  return out;
}

const SLOT_FUNCTION_NAME = "extract_structured_intent_slots";

const SLOT_SYSTEM_PROMPT = `你是结构化槽位抽取器。只调用给定函数并返回 JSON 参数。

要求：
1) 只从用户输入中抽取，不复述助手建议。
2) 后续消息出现更新时，以最新约束覆盖旧约束。
3) “留一天做事/发表论文/见人”归入 critical_days，不得覆盖 total_duration。
4) destinations 仅放地名；场馆/景点/街区尽量放入 sub_locations，并附 parent_city。
5) 约束可放 health_constraints / language_constraints / constraints（通用约束）。
6) 不确定就留空，不要编造。`;

const SLOT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent_summary: { type: "string" },
    intent_importance: { type: "number" },
    total_duration: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "number" },
        evidence: { type: "string" },
        importance: { type: "number" },
        confidence: { type: "number" },
      },
    },
    destinations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          evidence: { type: "string" },
          role: { type: "string", enum: ["travel", "meeting", "transit", "other"] },
          granularity: { type: "string", enum: ["country", "region", "city", "district", "venue", "poi", "other"] },
          parent_city: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    city_durations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          city: { type: "string" },
          days: { type: "number" },
          kind: { type: "string", enum: ["travel", "meeting"] },
          evidence: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    sub_locations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          parent_city: { type: "string" },
          kind: { type: "string", enum: ["district", "venue", "poi", "landmark", "area", "other"] },
          evidence: { type: "string" },
          hard: { type: "boolean" },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        cny: { type: "number" },
        evidence: { type: "string" },
        hard: { type: "boolean" },
        importance: { type: "number" },
        confidence: { type: "number" },
      },
    },
    people: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: { type: "number" },
        evidence: { type: "string" },
        importance: { type: "number" },
        confidence: { type: "number" },
      },
    },
    critical_days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          days: { type: "number" },
          reason: { type: "string" },
          city: { type: "string" },
          evidence: { type: "string" },
          hard: { type: "boolean" },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    health_constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidence: { type: "string" },
          severity: { type: "string", enum: ["medium", "high", "critical"] },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    language_constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidence: { type: "string" },
          severity: { type: "string", enum: ["medium", "high", "critical"] },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidence: { type: "string" },
          hard: { type: "boolean" },
          importance: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
    scenic_preference: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        evidence: { type: "string" },
        hard: { type: "boolean" },
        importance: { type: "number" },
        confidence: { type: "number" },
      },
    },
    lodging_preference: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        evidence: { type: "string" },
        hard: { type: "boolean" },
        importance: { type: "number" },
        confidence: { type: "number" },
      },
    },
    confidence: { type: "number" },
  },
} as const;

export async function extractIntentSignalsByFunctionCall(params: {
  model: string;
  latestUserText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  debug?: boolean;
}): Promise<{ signals: IntentSignals; raw: SlotExtractionResult } | null> {
  const userTurns = (params.recentTurns || [])
    .filter((t) => t.role === "user")
    .map((t) => cleanStatement(t.content || "", 900))
    .filter(Boolean)
    .slice(-8);

  const inputPayload = {
    latest_user_text: cleanStatement(params.latestUserText || "", 1200),
    recent_user_turns: userTurns,
    optional_system_prompt: params.systemPrompt ? cleanStatement(params.systemPrompt, 500) : undefined,
  };

  const resp = await openai.chat.completions.create({
    model: params.model,
    temperature: 0,
    max_tokens: 900,
    messages: [
      { role: "system", content: SLOT_SYSTEM_PROMPT },
      {
        role: "user",
        content: `请抽取结构化槽位。输入 JSON:\n${JSON.stringify(inputPayload)}`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: SLOT_FUNCTION_NAME,
          description:
            "Extract structured intent slots (destination, durations, budget, critical day, constraints, preferences) from user dialogue.",
          parameters: SLOT_PARAMETERS,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: SLOT_FUNCTION_NAME },
    },
  });

  const msg = resp.choices?.[0]?.message;
  const toolCall = (msg?.tool_calls || []).find(
    (x: any) => x?.type === "function" && x?.function?.name === SLOT_FUNCTION_NAME
  ) as any;

  let parsed: SlotExtractionResult | null = null;
  const toolArgs = toolCall?.function?.arguments;
  if (toolArgs) {
    parsed = parseJsonSafe(String(toolArgs)) as SlotExtractionResult | null;
  }

  if (!parsed && msg?.content) {
    parsed = parseJsonSafe(String(msg.content)) as SlotExtractionResult | null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const signals = slotsToSignals(parsed);
  const hasAnySignal =
    !!signals.destination ||
    !!signals.durationDays ||
    !!signals.budgetCny ||
    !!signals.peopleCount ||
    !!signals.healthConstraint ||
    !!signals.languageConstraint ||
    (signals.genericConstraints?.length || 0) > 0 ||
    !!signals.criticalPresentation ||
    !!signals.scenicPreference ||
    !!signals.lodgingPreference ||
    (signals.subLocations?.length || 0) > 0 ||
    (signals.cityDurations?.length || 0) > 0;

  if (!hasAnySignal) return null;

  if (params.debug) {
    // eslint-disable-next-line no-console
    console.log("[LLM][slots]", JSON.stringify(parsed));
  }

  return { signals, raw: parsed };
}
