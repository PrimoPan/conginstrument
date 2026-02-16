import { openai } from "../llmClient.js";
import { cleanStatement } from "./text.js";
import {
  type IntentSignals,
  isLikelyDestinationCandidate,
  normalizeDestination,
} from "./intentSignals.js";

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
  }>;
  city_durations?: Array<{
    city?: string;
    days?: number;
    kind?: "travel" | "meeting";
    evidence?: string;
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

  const cityDurationImportanceByCity: Record<string, number> = {};
  if (Array.isArray(slots.city_durations)) {
    const map = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting" }>();
    for (const seg of slots.city_durations) {
      const city = normalizeDestination(seg?.city || "");
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

  if (Array.isArray(slots.health_constraints) && slots.health_constraints.length) {
    const best = slots.health_constraints
      .map((x) => ({
        text: cleanStatement(x?.text || "", 96),
        evidence: cleanStatement(x?.evidence || x?.text || "", 60),
        imp: clampImportance(x?.importance, x?.severity === "critical" ? 0.97 : 0.9),
        score:
          (x?.severity === "critical" ? 0.25 : x?.severity === "high" ? 0.16 : 0) +
          clampImportance(x?.importance, 0.88) * 0.55 +
          clamp01(x?.confidence, 0.86) * 0.2,
      }))
      .filter((x) => !!x.text)
      .sort((a, b) => b.score - a.score)[0];
    if (best) {
      out.healthConstraint = best.text;
      out.healthEvidence = best.evidence;
      out.healthImportance = best.imp;
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
2) 如用户在后续消息更新预算/时长/目的地，使用最新约束。
3) “留一天做事/发表论文/见亲戚”归入 critical_days，不得覆盖 total_duration。
4) destinations 只能是地名，禁止“顺带/其他时间/这座城之外”等描述词。
5) 不确定就留空，不要编造。`;

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
    !!signals.criticalPresentation ||
    !!signals.scenicPreference ||
    !!signals.lodgingPreference ||
    (signals.cityDurations?.length || 0) > 0;

  if (!hasAnySignal) return null;

  if (params.debug) {
    // eslint-disable-next-line no-console
    console.log("[LLM][slots]", JSON.stringify(parsed));
  }

  return { signals, raw: parsed };
}
