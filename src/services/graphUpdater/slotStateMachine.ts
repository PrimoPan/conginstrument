import type { IntentSignals } from "./intentSignals.js";
import { buildTravelIntentStatement, isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";
import {
  HEALTH_STRATEGY_ACTIVITY_RE,
  HEALTH_STRATEGY_DIET_RE,
  LOW_HASSLE_TRAVEL_RE,
  SAFETY_STRATEGY_RE,
  TRANSPORT_CONVENIENCE_RE,
} from "./constants.js";
import { cleanStatement } from "./text.js";
import type { SlotEdgeSpec, SlotGraphState, SlotNodeSpec } from "./slotTypes.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

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

function tr(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function formatDays(locale: AppLocale | undefined, days: number): string {
  return isEnglishLocale(locale) ? `${days} days` : `${days}天`;
}

function statementGoal(locale: AppLocale | undefined, text: string): string {
  if (isEnglishLocale(locale)) {
    const body = cleanStatement(text || "", 96) || "Plan this task";
    return /^intent:/i.test(body) ? body : `Intent: ${body}`;
  }
  return cleanStatement(text || "", 96) || "意图：制定任务计划";
}

function statementWithPrefix(locale: AppLocale | undefined, zhPrefix: string, enPrefix: string, body: string): string {
  const prefix = isEnglishLocale(locale) ? enPrefix : zhPrefix;
  return `${prefix}${cleanStatement(body || "", 140)}`;
}

function moneyLabel(locale: AppLocale | undefined, amount: number): string {
  return isEnglishLocale(locale) ? `${amount} CNY` : `${amount}元`;
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
  return /第[一二三四五六七八九十0-9两]+天|首日|第一天|落地|抵达|转机|机场|当日|当天|晚上到|早上到|day\\s*[0-9]+|arrival|arrive|landing|transfer|layover|airport|same day/i.test(
    s
  );
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
      isDetailLikeDurationEvidence(x.evidence)
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

function buildDurationState(signals: IntentSignals, locale?: AppLocale): DurationState {
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
      evidence: cleanStatement(seg.evidence || `${city} ${formatDays(locale, days)}`, 64),
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
      evidence: cleanStatement(signals.durationEvidence || formatDays(locale, explicitTotal), 80),
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
      evidence: cityDurations.map((x) => `${x.city} ${formatDays(locale, x.days)}`).join(" + "),
      source: "city_sum",
    });
  }
  const maxSeg = cityDurations.slice().sort((a, b) => b.days - a.days)[0];
  if (maxSeg) {
    candidates.push({
      days: maxSeg.days,
      weight: clamp01(maxSeg.kind === "meeting" ? 0.62 : 0.68, 0.66),
      evidence: cleanStatement(`${maxSeg.city} ${formatDays(locale, maxSeg.days)}`, 64),
      source: "max_segment",
    });
  }

  const consensus = weightedMedian(candidates);
  let totalDays = consensus?.days;
  let totalEvidence = consensus?.evidence;

  if (signals.hasPartialDurationAllocation && explicitTotal) {
    totalDays = explicitTotal;
    totalEvidence = cleanStatement(signals.durationEvidence || formatDays(locale, explicitTotal), 80);
  }

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
    totalEvidence = cleanStatement(signals.durationEvidence || formatDays(locale, explicitTotal), 80);
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
    totalEvidence = cityDurations.map((x) => `${x.city} ${formatDays(locale, x.days)}`).join(" + ");
  }

  // 多城市且至少有一个“旅行段”时，优先满足分段总和，避免漏算“会议+旅行”这类组合行程。
  if (!signals.hasPartialDurationAllocation && cityDurations.length >= 2 && hasTravelSegment && citySum > 0) {
    const explicitStrong =
      !!explicitTotal &&
      (signals.hasExplicitTotalCue || clamp01(signals.durationStrength, 0.55) >= 0.88);
    const underEstimate = !totalDays || totalDays < citySum;
    const shouldUseSum = underEstimate || (signals.hasDurationUpdateCue && !explicitStrong);
    if (shouldUseSum) {
      totalDays = citySum;
      totalEvidence = cityDurations.map((x) => `${x.city} ${formatDays(locale, x.days)}`).join(" + ");
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

function hasActivePlanningSignals(signals: IntentSignals): boolean {
  if (signals.destination || signals.destinations?.length) return true;
  if (signals.durationDays || signals.cityDurations?.length) return true;
  if (signals.peopleCount) return true;
  if (signals.budgetCny != null || signals.budgetSpentCny != null || signals.budgetPendingCny != null) return true;
  if (signals.healthConstraint || signals.languageConstraint) return true;
  if (signals.genericConstraints?.length) return true;
  if (signals.scenicPreference || signals.lodgingPreference || signals.activityPreference) return true;
  if (signals.subLocations?.length) return true;
  if (signals.criticalPresentation) return true;
  return false;
}

function isRevocationOnlyTurn(signals: IntentSignals): boolean {
  const hasRevocation =
    (signals.revokedConstraintAxes?.length || 0) > 0 ||
    (signals.revokedPreferenceAxes?.length || 0) > 0;
  if (!hasRevocation) return false;
  return !hasActivePlanningSignals(signals);
}

function buildGoalNode(params: {
  userText: string;
  signals: IntentSignals;
  totalDays?: number;
  now: string;
  locale?: AppLocale;
  preserveExistingStatement?: boolean;
}): SlotNodeSpec {
  // 目标标题里的时长强制对齐状态机总时长，避免“意图6天 vs 总时长3天”这类显示分叉。
  const signalsForIntent: IntentSignals = {
    ...params.signals,
    durationDays: params.totalDays || params.signals.durationDays,
  };
  const generatedIntent = buildTravelIntentStatement(signalsForIntent, params.userText, params.locale);
  const rawIntent = params.preserveExistingStatement
    ? generatedIntent || tr(params.locale, "制定任务计划", "Plan this task")
    : generatedIntent || cleanStatement(params.userText, 88);
  const intent = compactIntentDuration(rawIntent, params.totalDays);
  const successCriteria: string[] = [];
  if (params.signals.destinations?.length) {
    successCriteria.push(
      tr(
        params.locale,
        `覆盖目的地：${params.signals.destinations.join("、")}`,
        `Cover destinations: ${params.signals.destinations.join(" / ")}`
      )
    );
  }
  if (params.totalDays) {
    successCriteria.push(
      tr(params.locale, `总时长满足：${params.totalDays}天`, `Total duration: ${params.totalDays} days`)
    );
  }
  if (params.signals.budgetCny) {
    successCriteria.push(
      tr(
        params.locale,
        `预算不超过：${params.signals.budgetCny}元`,
        `Budget cap: ${params.signals.budgetCny} CNY`
      )
    );
  }
  return {
    slotKey: "slot:goal",
    type: "belief",
    layer: "intent",
    statement: statementGoal(params.locale, intent || tr(params.locale, "制定任务计划", "Plan this task")),
    confidence: 0.86,
    importance: clamp01(params.signals.goalImportance, 0.84),
    strength: "hard",
    tags: ["intent", "cg"],
    evidenceIds: [cleanStatement(params.userText, 60)],
    sourceMsgIds: ["latest_user"],
    key: "slot:goal",
    motifType: "expectation",
    claim: intent || tr(params.locale, "制定任务计划", "Plan this task"),
    evidence: motifEvidence(params.userText, "latest_user"),
    linkedIntentIds: [],
    revisionHistory: [{ at: params.now, action: "updated", by: "system", reason: "slot_state_machine" }],
    priority: 0.9,
    successCriteria: successCriteria.length ? successCriteria : undefined,
    preserveExistingStatement: !!params.preserveExistingStatement,
  };
}

function pushEdge(edges: SlotEdgeSpec[], fromSlot: string, toSlot: string, type: SlotEdgeSpec["type"], confidence: number) {
  if (!fromSlot || !toSlot || fromSlot === toSlot) return;
  const key = `${fromSlot}|${toSlot}|${type}`;
  const exists = edges.some((e) => `${e.fromSlot}|${e.toSlot}|${e.type}` === key);
  if (exists) return;
  edges.push({ fromSlot, toSlot, type, confidence: clamp01(confidence, 0.78) });
}

function matchesHealthActivityStrategy(text: string): boolean {
  return HEALTH_STRATEGY_ACTIVITY_RE.test(cleanStatement(text || "", 160));
}

function matchesHealthDietStrategy(text: string): boolean {
  return HEALTH_STRATEGY_DIET_RE.test(cleanStatement(text || "", 160));
}

function matchesLowBurdenStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return LOW_HASSLE_TRAVEL_RE.test(s);
}

function matchesTransportConvenienceStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return TRANSPORT_CONVENIENCE_RE.test(s);
}

function matchesSafetyStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return SAFETY_STRATEGY_RE.test(s);
}

function matchesLanguageExecutionStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return /语言|英语|外语|沟通|翻译|language|english|communication|translate/i.test(s);
}

function matchesReligionStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return /宗教|礼拜|祷告|清真|斋月|安息日|religion|prayer|halal|kosher|ramadan|sabbath/i.test(s);
}

function matchesLegalStrategy(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return /签证|护照|入境|海关|居留|visa|passport|immigration|permit|legal/i.test(s);
}

function hasFamilyComfortCue(text: string): boolean {
  const s = cleanStatement(text || "", 180);
  return /父母|爸妈|家人|中老年|老人|老年|年纪|family|parents|senior/i.test(s);
}

type LimitingFactor = {
  text: string;
  evidence: string;
  hard: boolean;
  severity?: "medium" | "high" | "critical";
  importance: number;
  kind: string;
  canonicalKey: string;
  semanticTokens: string[];
};

function normalizeLimitingText(raw: string): string {
  return cleanStatement(raw || "", 140)
    .toLowerCase()
    .replace(/^限制因素[:：]?\s*/i, "")
    .replace(/^limiting factor[:：]?\s*/i, "")
    .replace(/[，。,；;！!？?\s]+/g, "")
    .replace(/^(我|我们|家人|父母|父亲|母亲)+/, "")
    .replace(/(所以|因此|然后|就是|一下|吧|呢|呀|啊|都要|都得|尽量|注意|请|希望|可以|需要|必须|务必|一定|不能|不要|避免)/g, "");
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function severityRank(x?: "medium" | "high" | "critical"): number {
  return x === "critical" ? 3 : x === "high" ? 2 : x === "medium" ? 1 : 0;
}

function inferLimitingKind(rawKind: string | undefined, text: string): string {
  const kind = cleanStatement(rawKind || "", 32).toLowerCase();
  const normalizedKind =
    kind === "security" || kind === "travel_safety" || kind === "safety_risk"
      ? "safety"
      : kind === "medical"
        ? "health"
        : kind === "lang"
          ? "language"
          : kind;
  const acceptedSemanticKinds = new Set([
    "health",
    "language",
    "diet",
    "religion",
    "legal",
    "mobility",
    "safety",
    "logistics",
    "other",
  ]);
  // Only trust kind when it is a semantic category. Ignore structural labels
  // such as "constraint/risk/requirement", then infer from text instead.
  if (acceptedSemanticKinds.has(normalizedKind) && normalizedKind !== "other") return normalizedKind;
  const s = cleanStatement(text || "", 160);
  if (/心脏|心肺|慢性病|过敏|糖尿病|哮喘|医疗|病史|health|medical|cardiac|allergy/i.test(s)) return "health";
  if (/英语|语言|翻译|沟通|外语|english|language|translate|communication/i.test(s)) return "language";
  if (/饮食|忌口|清真|素食|过敏原|halal|kosher|vegetarian|vegan|diet/i.test(s)) return "diet";
  if (/宗教|礼拜|祷告|斋月|安息日|religion|prayer|ramadan|sabbath/i.test(s)) return "religion";
  if (/签证|护照|入境|海关|法律|visa|passport|immigration|permit|legal/i.test(s)) return "legal";
  if (
    /轮椅|无障碍|体力|行动不便|不能久走|不想太累|不要太累|不太折腾|不要太折腾|少折腾|低强度|慢节奏|中老年|老人|老年|mobility|wheelchair|accessibility|low[-\s]?hassle|low[-\s]?intensity/i.test(
      s
    )
  ) {
    return "mobility";
  }
  if (
    /治安|安全|安全感|危险|夜间|夜里|夜晚|抢劫|诈骗|不想被坑|不被坑|防坑|防骗|宰客|security|safety|danger|risk|night|scam|fraud/i.test(
      s
    )
  ) {
    return "safety";
  }
  if (
    /转机|换乘|托运|航班|火车|机场|时差|交通方便|交通便利|离地铁近|靠近地铁|地铁站附近|步行可达|出行方便|logistics|layover|flight|train|near metro|easy transit|well[-\s]?connected/i.test(
      s
    )
  ) {
    return "logistics";
  }
  return "other";
}

function limitingPolarity(text: string): "pos" | "neg" {
  const s = cleanStatement(text || "", 160);
  return /(不要|不能|避免|别|禁止|must not|cannot|don't|avoid)/i.test(s) ? "neg" : "pos";
}

function semanticTokens(kind: string, text: string): string[] {
  const s = cleanStatement(text || "", 200);
  const out: string[] = [];
  const push = (x: string) => {
    if (!out.includes(x)) out.push(x);
  };
  if (kind === "safety") {
    if (/治安|安全|安全感|危险|风险|抢劫|诈骗|security|safety|safe|danger|risk/i.test(s)) push("security");
    if (/夜间|夜里|夜晚|晚间|night|late/i.test(s)) push("night");
    if (/出行|步行|打车|交通|transit|travel|walk|taxi/i.test(s)) push("transit");
    if (/酒店|住宿|民宿|住在|hotel|lodging|accommodation/i.test(s)) push("lodging");
    if (/区域|片区|地段|社区|neighborhood|district|area/i.test(s)) push("area");
  } else if (kind === "language") {
    if (/英语|语言|外语|english|language/i.test(s)) push("language");
    if (/翻译|翻译器|translate|translator/i.test(s)) push("translate");
    if (/沟通|communication|communicate/i.test(s)) push("communication");
  } else if (kind === "health") {
    if (/心脏|心肺|cardiac|heart/i.test(s)) push("cardiac");
    if (/慢性病|chronic|糖尿病|高血压|哮喘/i.test(s)) push("chronic");
    if (/过敏|allergy/i.test(s)) push("allergy");
    if (/体力|强度|不能久走|爬山|intensity|exertion/i.test(s)) push("intensity");
  } else if (kind === "mobility") {
    if (/不想太累|不要太累|低强度|慢节奏|少折腾|low[-\s]?intensity|low[-\s]?hassle/i.test(s)) push("pace");
    if (/少走路|少步行|不能久走|走不动|体力|exertion|walking/i.test(s)) push("walking");
    if (/老人|老年|中老年|父母|爸妈|senior|parents/i.test(s)) push("senior");
    if (/轮椅|无障碍|wheelchair|accessibility/i.test(s)) push("accessibility");
  } else if (kind === "logistics") {
    if (/交通方便|交通便利|离地铁近|靠近地铁|地铁站附近|near metro|easy transit|well[-\s]?connected/i.test(s)) push("transit");
    if (/少换乘|换乘少|直达|transfer|layover/i.test(s)) push("transfer");
    if (/机场|航班|火车|flight|train|airport/i.test(s)) push("airport");
  } else if (kind === "diet") {
    if (/低盐|low[-\s]?salt/i.test(s)) push("low_salt");
    if (/低脂|low[-\s]?fat/i.test(s)) push("low_fat");
    if (/高纤维|high[-\s]?fiber/i.test(s)) push("fiber");
    if (/清淡|少油|少糖|地中海|diet/i.test(s)) push("light_diet");
  } else if (kind === "religion") {
    if (/清真|halal/i.test(s)) push("halal");
    if (/kosher|犹太/i.test(s)) push("kosher");
    if (/礼拜|祷告|prayer/i.test(s)) push("prayer");
    if (/斋月|安息日|ramadan|sabbath/i.test(s)) push("calendar");
  } else if (kind === "legal") {
    if (/签证|visa/i.test(s)) push("visa");
    if (/护照|passport/i.test(s)) push("passport");
    if (/入境|immigration|海关|customs/i.test(s)) push("entry");
    if (/许可|permit|居留|residence/i.test(s)) push("permit");
  } else {
    const normalized = normalizeLimitingText(s);
    if (normalized) push(normalized.slice(0, 32));
  }
  return out.slice(0, 4);
}

function canonicalLimitingText(kind: string, tokens: string[], raw: string): string {
  const cjk = hasCjk(raw);
  if (kind === "safety") {
    const hasSecurity = tokens.includes("security");
    const hasNight = tokens.includes("night");
    const hasTransit = tokens.includes("transit");
    const hasLodgingOrArea = tokens.includes("lodging") || tokens.includes("area");
    if (hasSecurity && (hasNight || hasTransit)) {
      return cjk ? "治安、夜间出行要考虑" : "Prioritize security and night travel safety";
    }
    if (hasSecurity && hasLodgingOrArea) {
      return cjk ? "住宿区域需优先安全" : "Lodging area must prioritize safety";
    }
    if (hasSecurity) {
      return cjk ? "需优先考虑安全性" : "Safety needs to be prioritized";
    }
  }
  if (kind === "mobility") {
    const hasPace = tokens.includes("pace");
    const hasWalking = tokens.includes("walking");
    const hasSenior = tokens.includes("senior");
    if ((hasPace || hasWalking) && hasSenior) {
      return cjk ? "中老年同行，行程需低强度少折腾" : "Senior-friendly travel should keep low intensity and low hassle";
    }
    if (hasPace || hasWalking) {
      return cjk ? "行程需低强度、减少体力负担" : "Trip should be low-intensity with reduced physical burden";
    }
  }
  if (kind === "logistics") {
    if (tokens.includes("transit") || tokens.includes("transfer")) {
      return cjk ? "交通衔接需便利、少换乘" : "Transit should be convenient with minimal transfers";
    }
  }
  if (kind === "diet") {
    if (tokens.includes("low_salt") || tokens.includes("low_fat") || tokens.includes("fiber")) {
      return cjk ? "饮食需低盐低脂高纤维" : "Diet should be low-salt, low-fat, high-fiber";
    }
  }
  if (kind === "religion") {
    if (tokens.includes("halal")) return cjk ? "饮食需满足清真要求" : "Meals should satisfy halal requirements";
    if (tokens.includes("prayer")) return cjk ? "行程需预留礼拜时间" : "Itinerary should reserve prayer windows";
  }
  if (kind === "legal") {
    if (tokens.includes("visa") || tokens.includes("entry")) {
      return cjk ? "需满足签证与入境要求" : "Visa and entry requirements must be satisfied";
    }
  }
  return cleanStatement(raw || "", 120);
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = new Set([...setA, ...setB]).size;
  return union ? inter / union : 0;
}

function isSubsetTokens(a: string[], b: string[]): boolean {
  if (!a.length) return true;
  const setB = new Set(b);
  for (const x of a) {
    if (!setB.has(x)) return false;
  }
  return true;
}

function limitingQuality(x: LimitingFactor): number {
  return (
    severityRank(x.severity) * 100 +
    (x.hard ? 40 : 0) +
    x.importance * 10 +
    x.semanticTokens.length * 8 -
    cleanStatement(x.text, 120).length * 0.02
  );
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
    const rawText = cleanStatement(raw.text || "", 120);
    if (!rawText) return;
    const kind = inferLimitingKind(raw.kind, rawText);
    const tokens = semanticTokens(kind, rawText);
    const key = `${kind}:${limitingPolarity(rawText)}:${tokens.join("+") || normalizeLimitingText(rawText).slice(0, 48)}`;
    const text = canonicalLimitingText(kind, tokens, rawText);
    const next: LimitingFactor = {
      text,
      evidence: cleanStatement(raw.evidence || text, 80),
      hard: !!raw.hard,
      severity: raw.severity,
      importance: clamp01(raw.importance, raw.hard ? 0.84 : 0.74),
      kind,
      canonicalKey: key,
      semanticTokens: tokens,
    };
    const prev = map.get(key);
    if (!prev) {
      map.set(key, next);
      return;
    }
    const candidate: LimitingFactor = {
      text: limitingQuality(next) >= limitingQuality(prev) ? next.text : prev.text,
      evidence: next.evidence || prev.evidence,
      hard: prev.hard || next.hard,
      severity:
        prev.severity === "critical" || next.severity === "critical"
          ? "critical"
          : prev.severity === "high" || next.severity === "high"
            ? "high"
            : prev.severity || next.severity,
      importance: Math.max(prev.importance, next.importance),
      kind,
      canonicalKey: key,
      semanticTokens: Array.from(new Set([...prev.semanticTokens, ...next.semanticTokens])).slice(0, 4),
    };
    map.set(key, {
      ...candidate,
      kind: prev.kind === "other" ? kind : prev.kind,
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
      const sevDiff = severityRank(b.severity) - severityRank(a.severity);
      if (sevDiff !== 0) return sevDiff;
      const hardDiff = (b.hard ? 1 : 0) - (a.hard ? 1 : 0);
      if (hardDiff !== 0) return hardDiff;
      const tokenDiff = b.semanticTokens.length - a.semanticTokens.length;
      if (tokenDiff !== 0) return tokenDiff;
      return b.importance - a.importance;
    })
    .slice(0, 12);

  // near-duplicate suppression: same semantic family and overlapping token pattern keep the strongest one.
  const deduped: LimitingFactor[] = [];
  for (const cur of ranked) {
    const curNorm = normalizeLimitingText(cur.text);
    const dupIdx = deduped.findIndex((x) => {
      if (x.kind !== cur.kind) return false;
      const xNorm = normalizeLimitingText(x.text);
      if (!xNorm || !curNorm) return false;
      if (x.canonicalKey === cur.canonicalKey) return true;
      const overlap = overlapScore(x.semanticTokens, cur.semanticTokens);
      if (overlap >= 0.5) return true;
      if (
        x.kind === "safety" &&
        x.semanticTokens.includes("security") &&
        cur.semanticTokens.includes("security") &&
        (isSubsetTokens(x.semanticTokens, cur.semanticTokens) ||
          isSubsetTokens(cur.semanticTokens, x.semanticTokens))
      ) {
        return true;
      }
      return xNorm === curNorm || xNorm.includes(curNorm) || curNorm.includes(xNorm);
    });
    if (dupIdx < 0) {
      deduped.push(cur);
      continue;
    }
    const prev = deduped[dupIdx];
    const pickCur = limitingQuality(cur) >= limitingQuality(prev);
    if (pickCur) deduped[dupIdx] = cur;
  }

  // Final pass: semantic merge by kind + intent-equivalence to aggressively
  // suppress near-duplicate constraints (especially safety phrasing variants).
  const sameSemanticFactor = (a: LimitingFactor, b: LimitingFactor): boolean => {
    if (a.kind !== b.kind) return false;
    const aNorm = normalizeLimitingText(a.text);
    const bNorm = normalizeLimitingText(b.text);
    if (!aNorm || !bNorm) return false;
    if (aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true;
    const overlap = overlapScore(a.semanticTokens, b.semanticTokens);
    if (a.kind === "safety") {
      const aHasSecurity = a.semanticTokens.includes("security") || /治安|安全|安全感|security|safety|safe/i.test(a.text);
      const bHasSecurity = b.semanticTokens.includes("security") || /治安|安全|安全感|security|safety|safe/i.test(b.text);
      // For safety constraints we prefer a single canonical slot unless
      // semantics are clearly unrelated.
      if (aHasSecurity && bHasSecurity) return true;
      return overlap >= 0.5;
    }
    if (a.kind !== "other") return overlap >= 0.5;
    return overlap >= 0.66;
  };

  const mergeFactor = (a: LimitingFactor, b: LimitingFactor): LimitingFactor => {
    const preferred = limitingQuality(a) >= limitingQuality(b) ? a : b;
    const normalizedTokens = Array.from(new Set([...a.semanticTokens, ...b.semanticTokens])).slice(0, 4);
    const canonicalKey =
      preferred.kind === "other"
        ? `other:${normalizeLimitingText(preferred.text).slice(0, 32)}`
        : `${preferred.kind}:${normalizedTokens.join("+") || "generic"}`;
    return {
      text: preferred.text,
      evidence: cleanStatement(`${a.evidence}; ${b.evidence}`, 120),
      hard: a.hard || b.hard,
      severity:
        a.severity === "critical" || b.severity === "critical"
          ? "critical"
          : a.severity === "high" || b.severity === "high"
            ? "high"
            : a.severity || b.severity,
      importance: Math.max(a.importance, b.importance),
      kind: preferred.kind,
      canonicalKey,
      semanticTokens: normalizedTokens,
    };
  };

  const compactedBySemantic: LimitingFactor[] = [];
  for (const item of deduped) {
    const idx = compactedBySemantic.findIndex((x) => sameSemanticFactor(x, item));
    if (idx < 0) {
      compactedBySemantic.push(item);
      continue;
    }
    compactedBySemantic[idx] = mergeFactor(compactedBySemantic[idx], item);
  }

  const compacted = compactedBySemantic
    .sort((a, b) => limitingQuality(b) - limitingQuality(a))
    .slice(0, 8);

  return compacted;
}

export function buildSlotStateMachine(params: {
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  signals: IntentSignals;
  locale?: AppLocale;
}): SlotGraphState {
  const latestUserText = cleanStatement(params.userText, 1200);
  const nodes: SlotNodeSpec[] = [];
  const edges: SlotEdgeSpec[] = [];
  const now = nowISO();
  const preserveGoalStatement = isRevocationOnlyTurn(params.signals);

  const durationState = buildDurationState(params.signals, params.locale);
  const goal = buildGoalNode({
    userText: latestUserText,
    signals: params.signals,
    totalDays: durationState.totalDays,
    now,
    locale: params.locale,
    preserveExistingStatement: preserveGoalStatement,
  });
  nodes.push(goal);

  const destinationMap = new Map<string, string>();
  const removedDestinationSet = new Set(
    (params.signals.removedDestinations || [])
      .map((x) => normalizeDestination(x))
      .filter(Boolean)
  );
  const pushDestination = (raw?: string) => {
    const city = normalizeDestination(raw || "");
    if (!city || !isLikelyDestinationCandidate(city)) return;
    if (removedDestinationSet.has(city)) return;
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
  const limitingFactorSlotsByKind = new Map<string, string[]>();
  const limitingFactorBySlot = new Map<string, LimitingFactor>();
  const limitingFactorNodeIndexBySlot = new Map<string, number>();
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
      type: "factual_assertion",
      layer: "requirement",
      statement: statementWithPrefix(params.locale, "目的地: ", "Destination: ", city),
      confidence: 0.9,
      importance: imp,
      tags: ["destination"],
      evidenceIds: [params.signals.destinationEvidence || city].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "cognitive_step",
      claim: isEnglishLocale(params.locale) ? `Destination is ${city}` : `目的地是${city}`,
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
        statement: isEnglishLocale(params.locale)
          ? statementWithPrefix(
              params.locale,
              "活动偏好: ",
              "Activity preference: ",
              statement.replace(/^activity\\s*preference\\s*[:：]\\s*/i, "")
            )
          : statement.startsWith("活动偏好")
            ? statement
            : `活动偏好: ${statement}`,
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
      statement: statementWithPrefix(
        params.locale,
        "总行程时长: ",
        "Total duration: ",
        formatDays(params.locale, durationState.totalDays)
      ),
      confidence: clamp01(params.signals.durationStrength, 0.88),
      importance: clamp01(params.signals.durationImportance, 0.84),
      tags: ["duration", "total"],
      evidenceIds: [
        durationState.totalEvidence ||
          params.signals.durationEvidence ||
          `${durationState.totalDays}${isEnglishLocale(params.locale) ? " days" : "天"}`,
      ].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:duration_total",
      motifType: "cognitive_step",
      claim: isEnglishLocale(params.locale)
        ? `Total duration is about ${durationState.totalDays} days`
        : `总时长约${durationState.totalDays}天`,
      evidence: motifEvidence(durationState.totalEvidence || params.signals.durationEvidence),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: clamp01(params.signals.durationImportance, 0.84),
      successCriteria: [
        isEnglishLocale(params.locale)
          ? `Keep total trip duration within ${durationState.totalDays} days`
          : `行程总时长控制在${durationState.totalDays}天`,
      ],
    });
    pushEdge(edges, "slot:duration_total", "slot:goal", "constraint", 0.9);
  }

  for (const seg of durationState.cityDurations) {
    const cityKey = slug(seg.city);
    if (!durationState.emitCityDurationSlots.has(cityKey)) continue;
    const slotKey = `slot:duration_city:${cityKey}`;
    nodes.push({
      slotKey,
      type: "factual_assertion",
      layer: "requirement",
      statement: statementWithPrefix(
        params.locale,
        "城市时长: ",
        "City duration: ",
        `${seg.city} ${formatDays(params.locale, seg.days)}`
      ),
      confidence: seg.kind === "meeting" ? 0.88 : 0.84,
      importance: seg.importance,
      tags: ["duration_city", seg.kind],
      evidenceIds: [seg.evidence],
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: "cognitive_step",
      claim: isEnglishLocale(params.locale) ? `${seg.city} stay ${seg.days} days` : `${seg.city}停留${seg.days}天`,
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
      type: hard ? "constraint" : "factual_assertion",
      layer: "requirement",
      strength: hard ? "hard" : undefined,
      severity: undefined,
      statement: parentCity
        ? statementWithPrefix(
            params.locale,
            "子地点: ",
            "Sub-location: ",
            isEnglishLocale(params.locale) ? `${name} (${parentCity})` : `${name}（${parentCity}）`
          )
        : statementWithPrefix(params.locale, "子地点: ", "Sub-location: ", name),
      confidence: hard ? 0.9 : 0.74,
      importance,
      tags: ["sub_location", sub.kind || "other"],
      evidenceIds: [sub.evidence || name].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: slotKey,
      motifType: hard ? "hypothesis" : "cognitive_step",
      claim: parentCity
        ? isEnglishLocale(params.locale)
          ? `${name} belongs to ${parentCity}`
          : `${name}归属${parentCity}`
        : name,
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
        type: "factual_assertion",
        layer: "requirement",
        statement: statementWithPrefix(
          params.locale,
          "同行人数: ",
          "Travel party: ",
          isEnglishLocale(params.locale) ? `${count} people` : `${count}人`
        ),
        confidence: 0.9,
        importance,
        tags: ["people"],
        evidenceIds: [params.signals.peopleEvidence || (isEnglishLocale(params.locale) ? `${count} people` : `${count}人`)].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:people",
        motifType: "cognitive_step",
        claim: isEnglishLocale(params.locale) ? `Travel party size ${count}` : `同行人数${count}`,
        evidence: motifEvidence(
          params.signals.peopleEvidence || (isEnglishLocale(params.locale) ? `${count} people` : `${count}人`)
        ),
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
        statement: statementWithPrefix(params.locale, "预算上限: ", "Budget cap: ", moneyLabel(params.locale, budget)),
        confidence: 0.92,
        importance,
        tags: ["budget"],
        evidenceIds: [params.signals.budgetEvidence || moneyLabel(params.locale, budget)].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget",
        motifType: "hypothesis",
        claim: isEnglishLocale(params.locale) ? `Budget constraint ${budget} CNY` : `预算约束${budget}元`,
        evidence: motifEvidence(params.signals.budgetEvidence || moneyLabel(params.locale, budget)),
        linkedIntentIds: ["slot:goal"],
        revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
        priority: importance,
        successCriteria: [isEnglishLocale(params.locale) ? `Budget does not exceed ${budget} CNY` : `预算不超${budget}元`],
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
        type: "factual_assertion",
        layer: "requirement",
        statement: statementWithPrefix(
          params.locale,
          "已花预算: ",
          "Spent budget: ",
          moneyLabel(params.locale, normalizedSpent)
        ),
        confidence: 0.88,
        importance: spentImportance,
        tags: ["budget", "spent"],
        evidenceIds: [params.signals.budgetSpentEvidence || moneyLabel(params.locale, normalizedSpent)].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget_spent",
        motifType: "cognitive_step",
        claim: isEnglishLocale(params.locale)
          ? `Current spend is ${normalizedSpent} CNY`
          : `当前已花费${normalizedSpent}元`,
        evidence: motifEvidence(params.signals.budgetSpentEvidence || moneyLabel(params.locale, normalizedSpent)),
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
        statement: statementWithPrefix(
          params.locale,
          "待确认预算: ",
          "Pending budget: ",
          moneyLabel(params.locale, normalizedPending)
        ),
        confidence: 0.8,
        importance: pendingImportance,
        tags: ["budget", "pending"],
        evidenceIds: [params.signals.budgetPendingEvidence || moneyLabel(params.locale, normalizedPending)].filter(Boolean),
        sourceMsgIds: ["latest_user"],
        key: "slot:budget_pending",
        motifType: "hypothesis",
        claim: isEnglishLocale(params.locale)
          ? `Pending spending about ${normalizedPending} CNY`
          : `待确认支出约${normalizedPending}元`,
        evidence: motifEvidence(params.signals.budgetPendingEvidence || moneyLabel(params.locale, normalizedPending)),
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
            `${params.signals.budgetEvidence || moneyLabel(params.locale, totalBudgetForRemaining)}; ${
              params.signals.budgetSpentEvidence || moneyLabel(params.locale, spentBudgetForRemaining)
            }`,
            80
          )
        : cleanStatement(
            isEnglishLocale(params.locale)
              ? `${params.signals.budgetEvidence || moneyLabel(params.locale, totalBudgetForRemaining)}; no spent budget recorded`
              : `${params.signals.budgetEvidence || `${totalBudgetForRemaining}元`}；尚未记录已花预算`,
            80
          );
    nodes.push({
      slotKey: "slot:budget_remaining",
      type: "constraint",
      layer: "requirement",
      strength: "hard",
      statement: statementWithPrefix(
        params.locale,
        "剩余预算: ",
        "Remaining budget: ",
        moneyLabel(params.locale, remainingBudget)
      ),
      confidence: 0.9,
      importance: remainingImportance,
      tags: ["budget", "remaining"],
      evidenceIds: [remainingEvidence].filter(Boolean),
      sourceMsgIds: ["latest_user"],
      key: "slot:budget_remaining",
      motifType: "hypothesis",
      claim: isEnglishLocale(params.locale)
        ? `Remaining available budget ${remainingBudget} CNY`
        : `可用预算还剩${remainingBudget}元`,
      evidence: motifEvidence(
        isEnglishLocale(params.locale)
          ? `Total ${totalBudgetForRemaining} CNY, spent ${spentBudgetForRemaining} CNY, remaining ${remainingBudget} CNY`
          : `总预算${totalBudgetForRemaining}元，已花${spentBudgetForRemaining}元，剩余${remainingBudget}元`
      ),
      linkedIntentIds: ["slot:goal"],
      revisionHistory: [{ at: now, action: "updated", by: "system", reason: "slot_state_machine" }],
      priority: remainingImportance,
      successCriteria: [
        isEnglishLocale(params.locale)
          ? `Keep at least ${Math.round(remainingBudget * 0.2)} CNY as contingency budget`
          : `剩余预算不少于${Math.round(remainingBudget * 0.2)}元用于机动安排`,
      ],
    });
    pushEdge(edges, "slot:budget_remaining", "slot:goal", "constraint", 0.92);
    if (budgetSlotKey) pushEdge(edges, budgetSlotKey, "slot:budget_remaining", "determine", 0.9);
    if (budgetSpentSlotKey) pushEdge(edges, budgetSpentSlotKey, "slot:budget_remaining", "determine", 0.9);
    if (budgetPendingSlotKey) pushEdge(edges, budgetPendingSlotKey, "slot:budget_remaining", "determine", 0.72);
  }

  const limitingFactors = collectLimitingFactors(params.signals);
  for (const factor of limitingFactors) {
    const kind = factor.kind || "other";
    const semanticKind = slug(kind) || "other";
    // Keep one active slot per semantic limiting category to avoid repeated
    // near-duplicate safety/language/health concepts in graph.
    const slotKey =
      semanticKind === "other"
        ? `slot:constraint:limiting:${semanticKind}:${slug(factor.canonicalKey || factor.text)}`
        : `slot:constraint:limiting:${semanticKind}`;
    const severity = factor.severity || (factor.hard ? "high" : "medium");
    const riskKind = new Set(["health", "safety", "legal", "mobility"]);
    const imp = clamp01(factor.importance, factor.hard ? 0.84 : 0.74);
    const rebuttalPoints =
      kind === "health"
        ? [
            isEnglishLocale(params.locale)
              ? "Ignoring this constraint significantly increases travel safety risk"
              : "若忽略此限制，行程安全风险显著上升",
          ]
        : kind === "language"
          ? [
              isEnglishLocale(params.locale)
                ? "Ignoring this constraint significantly degrades communication and execution efficiency"
                : "若忽略此限制，沟通与执行效率会明显下降",
            ]
          : kind === "diet"
            ? [
                isEnglishLocale(params.locale)
                  ? "Ignoring this constraint reduces diet feasibility and comfort"
                  : "若忽略此限制，饮食可执行性与舒适度会下降",
              ]
            : kind === "religion"
              ? [
                  isEnglishLocale(params.locale)
                    ? "Ignoring this constraint may conflict with faith-related activities"
                    : "若忽略此限制，关键活动安排可能与信仰冲突",
                ]
              : undefined;

    const existingNodeIdx = limitingFactorNodeIndexBySlot.get(slotKey);
    if (existingNodeIdx == null) {
      nodes.push({
        slotKey,
        type: "constraint",
        layer: riskKind.has(kind) && (severity === "critical" || severity === "high") ? "risk" : "requirement",
        strength: factor.hard ? "hard" : "soft",
        severity,
        statement: statementWithPrefix(params.locale, "限制因素: ", "Limiting factor: ", factor.text),
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
      limitingFactorNodeIndexBySlot.set(slotKey, nodes.length - 1);
      limitingFactorSlotKeys.push(slotKey);
      if (!limitingFactorSlotsByKind.has(kind)) limitingFactorSlotsByKind.set(kind, []);
      limitingFactorSlotsByKind.get(kind)!.push(slotKey);
      limitingFactorBySlot.set(slotKey, factor);
      pushEdge(edges, slotKey, "slot:goal", factor.hard ? "constraint" : "determine", factor.hard ? 0.92 : 0.82);
      continue;
    }

    const existingNode = nodes[existingNodeIdx];
    existingNode.strength =
      existingNode.strength === "hard" || factor.hard ? "hard" : existingNode.strength || "soft";
    existingNode.severity =
      existingNode.severity === "critical" || severity === "critical"
        ? "critical"
        : existingNode.severity === "high" || severity === "high"
          ? "high"
          : existingNode.severity || severity;
    existingNode.layer =
      riskKind.has(kind) && (existingNode.severity === "critical" || existingNode.severity === "high")
        ? "risk"
        : existingNode.layer || "requirement";
    existingNode.confidence = Math.max(Number(existingNode.confidence) || 0, factor.hard ? 0.9 : 0.82);
    existingNode.importance = Math.max(Number(existingNode.importance) || 0, imp);
    existingNode.priority = Math.max(Number(existingNode.priority) || 0, imp);
    existingNode.evidenceIds = Array.from(
      new Set([...(existingNode.evidenceIds || []), factor.evidence || factor.text].filter(Boolean))
    ).slice(0, 4);
    existingNode.evidence = motifEvidence(
      cleanStatement(
        [
          ...(Array.isArray(existingNode.evidence)
            ? existingNode.evidence.map((item: any) => item?.quote).filter(Boolean)
            : []),
          factor.evidence || factor.text,
        ].join("; "),
        120
      )
    );

    const prevFactor = limitingFactorBySlot.get(slotKey);
    if ((Number(factor.importance) || 0) >= (Number(prevFactor?.importance) || 0)) {
      existingNode.statement = statementWithPrefix(params.locale, "限制因素: ", "Limiting factor: ", factor.text);
      existingNode.claim = factor.text;
      existingNode.rebuttalPoints = existingNode.rebuttalPoints || rebuttalPoints;
      limitingFactorBySlot.set(slotKey, {
        ...prevFactor,
        ...factor,
        evidence: cleanStatement(
          [prevFactor?.evidence, factor.evidence || factor.text].filter(Boolean).join("; "),
          120
        ),
        importance: Math.max(Number(prevFactor?.importance) || 0, Number(factor.importance) || 0),
      } as LimitingFactor);
    }
  }

  if (params.signals.criticalPresentation) {
    const p = params.signals.criticalPresentation;
    const city = normalizeDestination(p.city || "");
    const detail = city
      ? isEnglishLocale(params.locale)
        ? `${p.reason} (${city}, ${p.days} days)`
        : `${p.reason}（${city}，${p.days}天）`
      : isEnglishLocale(params.locale)
        ? `${p.reason} (${p.days} days)`
        : `${p.reason}（${p.days}天）`;
    const k = `slot:meeting_critical:${slug(city || p.reason || "critical")}`;
    const imp = clamp01(params.signals.criticalImportance, 0.95);
    nodes.push({
      slotKey: k,
      type: "constraint",
      layer: "risk",
      strength: "hard",
      severity: "critical",
      statement: statementWithPrefix(params.locale, "关键日: ", "Critical day: ", detail),
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
      successCriteria: [
        isEnglishLocale(params.locale)
          ? `Reserve ${p.days} day(s) for the critical task`
          : `保留${p.days}天用于关键任务`,
      ],
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
      statement: statementWithPrefix(
        params.locale,
        "景点偏好: ",
        "Scenic preference: ",
        params.signals.scenicPreference
      ),
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
      statement: statementWithPrefix(params.locale, "住宿偏好: ", "Lodging preference: ", params.signals.lodgingPreference),
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

  const nodeBySlot = new Map(nodes.map((x) => [x.slotKey, x]));
  const strategyTargetsByKind = new Map<string, Set<string>>();
  const addStrategyTarget = (kind: string, slotKey: string) => {
    const key = cleanStatement(kind, 24).toLowerCase();
    const slot = cleanStatement(slotKey, 120);
    if (!key || !slot) return;
    if (!strategyTargetsByKind.has(key)) strategyTargetsByKind.set(key, new Set<string>());
    strategyTargetsByKind.get(key)!.add(slot);
  };

  const activityStatement = cleanStatement(
    nodeBySlot.get(activitySlotKey || "")?.statement || nodeBySlot.get(activitySlotKey || "")?.claim || "",
    180
  );
  const lodgingStatement = cleanStatement(
    nodeBySlot.get(lodgingSlotKey || "")?.statement || nodeBySlot.get(lodgingSlotKey || "")?.claim || "",
    180
  );

  if (activitySlotKey && activityStatement) {
    if (matchesHealthActivityStrategy(activityStatement)) addStrategyTarget("health", activitySlotKey);
    if (matchesLowBurdenStrategy(activityStatement)) {
      addStrategyTarget("health", activitySlotKey);
      addStrategyTarget("mobility", activitySlotKey);
    }
  }
  if (lodgingSlotKey && lodgingStatement) {
    if (matchesSafetyStrategy(lodgingStatement)) addStrategyTarget("safety", lodgingSlotKey);
    if (matchesTransportConvenienceStrategy(lodgingStatement)) {
      addStrategyTarget("mobility", lodgingSlotKey);
      addStrategyTarget("logistics", lodgingSlotKey);
    }
    if (matchesLowBurdenStrategy(lodgingStatement)) addStrategyTarget("mobility", lodgingSlotKey);
  }

  for (const slotKey of limitingFactorSlotKeys) {
    const node = nodeBySlot.get(slotKey);
    const factor = limitingFactorBySlot.get(slotKey);
    if (!node || !factor) continue;
    const statement = cleanStatement(node.statement || node.claim || factor.text || "", 180);
    if (factor.kind === "diet" || matchesHealthDietStrategy(statement)) {
      addStrategyTarget("health", slotKey);
      addStrategyTarget("diet", slotKey);
    }
    if (factor.kind === "mobility" || matchesLowBurdenStrategy(statement)) {
      addStrategyTarget("mobility", slotKey);
      addStrategyTarget("health", slotKey);
    }
    if (factor.kind === "safety" || matchesSafetyStrategy(statement)) {
      addStrategyTarget("safety", slotKey);
    }
    if (factor.kind === "language" || matchesLanguageExecutionStrategy(statement)) {
      addStrategyTarget("language", slotKey);
      addStrategyTarget("logistics", slotKey);
    }
    if (factor.kind === "logistics" || matchesTransportConvenienceStrategy(statement)) {
      addStrategyTarget("logistics", slotKey);
      addStrategyTarget("mobility", slotKey);
      addStrategyTarget("language", slotKey);
    }
    if (factor.kind === "religion" || matchesReligionStrategy(statement)) {
      addStrategyTarget("religion", slotKey);
      addStrategyTarget("diet", slotKey);
    }
    if (factor.kind === "legal" || matchesLegalStrategy(statement)) {
      addStrategyTarget("legal", slotKey);
    }
  }

  const linkKindToStrategies = (kind: string, roots: string[]) => {
    if (!roots.length) return;
    const targets = Array.from(strategyTargetsByKind.get(kind) || []);
    for (const root of roots) {
      for (const target of targets) {
        if (!target || target === root) continue;
        const targetFactorKind = cleanStatement(limitingFactorBySlot.get(target)?.kind || "", 24).toLowerCase();
        if (kind === "logistics" && targetFactorKind === "language") continue;
        let edgeType: SlotEdgeSpec["type"] = "constraint";
        let confidence = 0.82;

        if (target === activitySlotKey) {
          edgeType = kind === "health" || kind === "mobility" ? "determine" : "constraint";
          confidence = kind === "health" ? 0.88 : kind === "mobility" ? 0.86 : 0.8;
        } else if (target === lodgingSlotKey) {
          edgeType =
            kind === "logistics" || kind === "language" ? "determine" : "constraint";
          confidence = kind === "safety" ? 0.9 : kind === "mobility" ? 0.84 : 0.82;
        } else if (/^slot:constraint:limiting:diet/.test(target)) {
          edgeType = "constraint";
          confidence = kind === "health" ? 0.9 : kind === "religion" ? 0.84 : 0.8;
        } else if (/^slot:constraint:limiting:logistics/.test(target)) {
          edgeType = kind === "language" ? "determine" : "constraint";
          confidence = kind === "language" ? 0.84 : 0.8;
        } else if (/^slot:constraint:limiting:safety/.test(target)) {
          edgeType = "constraint";
          confidence = 0.86;
        } else if (/^slot:constraint:limiting:mobility/.test(target)) {
          edgeType = kind === "health" ? "determine" : "constraint";
          confidence = kind === "health" ? 0.84 : 0.8;
        }

        pushEdge(edges, root, target, edgeType, confidence);
      }
    }
  };

  linkKindToStrategies("health", Array.from(new Set(limitingFactorSlotsByKind.get("health") || [])).slice(0, 12));
  linkKindToStrategies("safety", Array.from(new Set(limitingFactorSlotsByKind.get("safety") || [])).slice(0, 12));
  linkKindToStrategies("mobility", Array.from(new Set(limitingFactorSlotsByKind.get("mobility") || [])).slice(0, 12));
  linkKindToStrategies("language", Array.from(new Set(limitingFactorSlotsByKind.get("language") || [])).slice(0, 12));
  linkKindToStrategies("logistics", Array.from(new Set(limitingFactorSlotsByKind.get("logistics") || [])).slice(0, 12));
  linkKindToStrategies("diet", Array.from(new Set(limitingFactorSlotsByKind.get("diet") || [])).slice(0, 12));
  linkKindToStrategies("religion", Array.from(new Set(limitingFactorSlotsByKind.get("religion") || [])).slice(0, 12));
  linkKindToStrategies("legal", Array.from(new Set(limitingFactorSlotsByKind.get("legal") || [])).slice(0, 12));

  if (durationTotalSlotKey && activitySlotKey && matchesLowBurdenStrategy(activityStatement)) {
    pushEdge(edges, durationTotalSlotKey, activitySlotKey, "constraint", 0.82);
  }
  if (budgetSlotKey && lodgingSlotKey) {
    pushEdge(edges, budgetSlotKey, lodgingSlotKey, "constraint", 0.82);
  }
  const hasFamilyComfortFactor = limitingFactorSlotKeys.some((slotKey) => {
    const text = cleanStatement(
      nodeBySlot.get(slotKey)?.statement || nodeBySlot.get(slotKey)?.claim || limitingFactorBySlot.get(slotKey)?.text || "",
      180
    );
    return hasFamilyComfortCue(text) || matchesLowBurdenStrategy(text);
  });
  if (peopleSlotKey && lodgingSlotKey && hasFamilyComfortFactor) {
    pushEdge(edges, peopleSlotKey, lodgingSlotKey, "determine", 0.8);
  }
  if (peopleSlotKey && activitySlotKey && hasFamilyComfortFactor && matchesLowBurdenStrategy(activityStatement)) {
    pushEdge(edges, peopleSlotKey, activitySlotKey, "determine", 0.8);
  }

  return {
    nodes,
    edges,
    notes: [
      "slot_state_machine_v5_reasoning_subtree_families",
      "conflicts_are_derived_from_motif_only",
    ],
  };
}
