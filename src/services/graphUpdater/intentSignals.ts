import {
  COUNTRY_PREFIX_RE,
  CRITICAL_PRESENTATION_RE,
  CULTURE_PREF_RE,
  DESTINATION_NOISE_RE,
  HARD_CONSTRAINT_RE,
  HARD_DAY_ACTION_RE,
  HARD_DAY_FORCE_RE,
  HARD_REQUIRE_RE,
  HEALTH_STRATEGY_ACTIVITY_RE,
  HEALTH_STRATEGY_DIET_RE,
  LANGUAGE_CONSTRAINT_RE,
  LOW_HASSLE_TRAVEL_RE,
  MEDICAL_HEALTH_RE,
  NATURE_TOPIC_RE,
  NON_PLACE_TOKEN_RE,
  PLACE_STOPWORD_RE,
  PREFERENCE_MARKER_RE,
  SAFETY_STRATEGY_RE,
  TRANSPORT_CONVENIENCE_RE,
} from "./constants.js";
import {
  classifyConstraintText,
  dedupeClassifiedConstraints,
  type GenericConstraintKind,
} from "./constraintClassifier.js";
import { cleanStatement, sentenceParts } from "./text.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

type BudgetMatch = { value: number; evidence: string; index: number };
type BudgetDeltaMatch = { delta: number; evidence: string; index: number };

type DurationCandidate = {
  days: number;
  evidence: string;
  index: number;
  kind: "total" | "meeting" | "segment" | "critical_event" | "unknown";
  strength: number;
};

type DateMention = {
  month: number;
  day: number;
  ordinal: number;
  index: number;
  evidence: string;
};

type DateRangeCandidate = {
  days: number;
  evidence: string;
  index: number;
  isMeetingLike: boolean;
};

type DateRangeBoundaryMode = "auto" | "inclusive" | "exclusive";

type StableCityDurationSnapshot = {
  cities: string[];
  sumDays: number;
  evidenceByCity: Map<string, string>;
};

export type IntentSignals = {
  peopleCount?: number;
  peopleEvidence?: string;
  peopleImportance?: number;
  destination?: string;
  destinationEvidence?: string;
  destinations?: string[];
  destinationEvidences?: string[];
  removedDestinations?: string[];
  destinationImportance?: number;
  destinationImportanceByCity?: Record<string, number>;
  durationDays?: number;
  durationEvidence?: string;
  durationStrength?: number;
  durationImportance?: number;
  durationBoundaryAmbiguous?: boolean;
  durationBoundaryQuestion?: string;
  hasTemporalAnchor?: boolean;
  hasDurationUpdateCue?: boolean;
  hasExplicitTotalCue?: boolean;
  hasPartialDurationAllocation?: boolean;
  cityDurations?: Array<{
    city: string;
    days: number;
    evidence: string;
    kind: "travel" | "meeting";
  }>;
  cityDurationImportanceByCity?: Record<string, number>;
  subLocations?: Array<{
    name: string;
    parentCity?: string;
    evidence: string;
    kind?: "poi" | "venue" | "district" | "landmark" | "area" | "other";
    hard?: boolean;
    importance?: number;
  }>;
  criticalPresentation?: {
    days: number;
    reason: string;
    evidence: string;
    city?: string;
  };
  criticalImportance?: number;
  durationUnknown?: boolean;
  durationUnknownEvidence?: string;
  budgetCny?: number;
  budgetDeltaCny?: number;
  budgetSpentCny?: number;
  budgetSpentDeltaCny?: number;
  budgetRemainingCny?: number;
  budgetPendingCny?: number;
  budgetEvidence?: string;
  budgetSpentEvidence?: string;
  budgetPendingEvidence?: string;
  budgetImportance?: number;
  healthConstraint?: string;
  healthEvidence?: string;
  healthImportance?: number;
  languageConstraint?: string;
  languageEvidence?: string;
  languageImportance?: number;
  genericConstraints?: Array<{
    text: string;
    evidence: string;
    kind?: GenericConstraintKind;
    hard?: boolean;
    severity?: "medium" | "high" | "critical";
    importance?: number;
  }>;
  scenicPreference?: string;
  scenicPreferenceEvidence?: string;
  scenicPreferenceHard?: boolean;
  scenicPreferenceImportance?: number;
  lodgingPreference?: string;
  lodgingPreferenceEvidence?: string;
  lodgingPreferenceHard?: boolean;
  lodgingPreferenceImportance?: number;
  activityPreference?: string;
  activityPreferenceEvidence?: string;
  activityPreferenceHard?: boolean;
  activityPreferenceImportance?: number;
  revokedConstraintAxes?: string[];
  revokedPreferenceAxes?: string[];
  goalImportance?: number;
};

export function parseCnInt(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);

  const map: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }

  if (map[s] != null) return map[s];
  return null;
}

function formatDayCount(locale: AppLocale | undefined, days: number): string {
  return isEnglishLocale(locale) ? `${days} days` : `${days}天`;
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function formatBudgetCny(locale: AppLocale | undefined, amount: number): string {
  return isEnglishLocale(locale) ? `${amount} CNY` : `${amount}元`;
}

function formatApproxBudgetCny(locale: AppLocale | undefined, amount: number): string {
  return isEnglishLocale(locale) ? `(~${amount} CNY)` : `（约${amount}元）`;
}

function formatDateLabel(locale: AppLocale | undefined, month: number, day: number): string {
  return isEnglishLocale(locale) ? `${month}/${day}` : `${month}月${day}日`;
}

function formatDateRangeLabel(
  locale: AppLocale | undefined,
  monthA: number,
  dayA: number,
  monthB: number,
  dayB: number
): string {
  if (monthA === monthB) {
    return isEnglishLocale(locale) ? `${monthA}/${dayA}-${dayB}` : `${monthA}月${dayA}日-${dayB}日`;
  }
  return isEnglishLocale(locale)
    ? `${monthA}/${dayA}-${monthB}/${dayB}`
    : `${monthA}月${dayA}日-${monthB}月${dayB}日`;
}

function formatCriticalEvidence(locale: AppLocale | undefined, reason: string, days: number): string {
  return isEnglishLocale(locale) ? `${reason} for ${days} days (hard constraint)` : `${reason} ${days}天（硬约束）`;
}

function hasExplicitDurationTotalCue(text: string): boolean {
  const s = cleanStatement(text, 180);
  if (!s) return false;
  if (
    /(总行程|行程时长|总时长|总天数|整体行程|整个行程|全程|trip length|trip duration|overall duration|overall trip|total duration)/i.test(
      s
    )
  ) {
    return true;
  }
  return /(?:总共|一共|总计|整体|overall|total|in total)[^，。,；;！!?\n]{0,10}([0-9一二三四五六七八九十两]{1,3})\s*(天|晚|夜)/i.test(
    s
  );
}

function hasPartialDurationAllocationCue(text: string): boolean {
  const s = cleanStatement(text, 180);
  if (!s) return false;
  if (!/([0-9一二三四五六七八九十两半]{1,3})\s*(天|晚|夜)/.test(s)) return false;
  return /(剩下|其余|余下|机动|留白|留一点|留出|过渡|缓冲|先别塞满|别塞满|先不排满|空着|待定|最后再看|最多半天|半天过渡)/i.test(
    s
  );
}

function hasCompleteTravelDurationAllocation(
  signals?: Pick<IntentSignals, "cityDurations" | "durationDays">
): boolean {
  const travelSegments = (signals?.cityDurations || []).filter((seg) => {
    const city = normalizeDestination(seg?.city || "");
    const days = Number(seg?.days) || 0;
    return !!city && isLikelyDestinationCandidate(city) && days > 0 && seg?.kind !== "meeting";
  });
  if (travelSegments.length < 2) return false;
  const sumDays = travelSegments.reduce((acc, seg) => acc + (Number(seg.days) || 0), 0);
  if (sumDays <= 0) return false;
  const statedDays = Number(signals?.durationDays) || 0;
  return statedDays > 0 && Math.abs(statedDays - sumDays) <= 1;
}

function summarizeStableCityDurationSnapshot(
  signals?: Pick<IntentSignals, "cityDurations" | "durationDays" | "hasPartialDurationAllocation">
): StableCityDurationSnapshot | null {
  const completeAllocation = hasCompleteTravelDurationAllocation(signals);
  if (signals?.hasPartialDurationAllocation && !completeAllocation) return null;
  const orderedCities: string[] = [];
  const seen = new Set<string>();
  const evidenceByCity = new Map<string, string>();
  let sumDays = 0;
  let hasTravelSegment = false;

  for (const seg of signals?.cityDurations || []) {
    const city = normalizeDestination(seg?.city || "");
    const days = Number(seg?.days) || 0;
    if (!city || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    if (!seen.has(city)) {
      seen.add(city);
      orderedCities.push(city);
    }
    if (!evidenceByCity.has(city)) {
      evidenceByCity.set(city, cleanStatement(seg?.evidence || city, 48) || city);
    }
    sumDays += days;
    if (seg?.kind !== "meeting") hasTravelSegment = true;
  }

  if (orderedCities.length < 2 || !hasTravelSegment || sumDays <= 0) return null;
  const statedDays = Number(signals?.durationDays) || 0;
  if (statedDays > 0 && Math.abs(statedDays - sumDays) > 1) return null;

  return {
    cities: orderedCities,
    sumDays,
    evidenceByCity,
  };
}

function parseCnCompositeInt(raw: string): number | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(s)) return null;

  const map: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
  };

  let total = 0;
  let section = 0;
  let number = 0;

  for (const ch of s) {
    if (ch in map) {
      number = map[ch];
      continue;
    }
    const unit = unitMap[ch];
    if (!unit) return null;
    if (unit === 10000) {
      section = (section + (number || 1)) * unit;
      total += section;
      section = 0;
      number = 0;
      continue;
    }
    section += (number || 1) * unit;
    number = 0;
  }

  const out = total + section + number;
  return Number.isFinite(out) && out > 0 ? out : null;
}

function parseBudgetAmountToken(raw: string): number | null {
  const s = String(raw || "")
    .replace(/[,，\s]/g, "")
    .replace(/(人民币|rmb|cny|元|块)$/i, "");
  if (!s) return null;

  const wanLike = s.match(
    /^([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十百千万]+)万([0-9]+|[零一二两三四五六七八九十百千]+)?$/i
  );
  if (wanLike?.[1]) {
    const headRaw = wanLike[1];
    const tailRaw = wanLike[2] || "";
    const head =
      /^\d+(?:\.\d+)?$/.test(headRaw) ? Number(headRaw) : Number(parseCnCompositeInt(headRaw) || 0);
    if (!Number.isFinite(head) || head <= 0) return null;
    let value = Math.round(head * 10000);
    if (tailRaw) {
      if (/[十百千]/.test(tailRaw)) {
        const tail = parseCnCompositeInt(tailRaw);
        if (tail && tail > 0) value = Math.round(head * 10000 + tail);
      } else {
        const tail =
          /^\d+$/.test(tailRaw) ? Number(tailRaw) : Number(parseCnInt(tailRaw) || parseCnCompositeInt(tailRaw) || 0);
        if (Number.isFinite(tail) && tail > 0) {
          const tailDigits = String(Math.trunc(tail)).length;
          const scale = Math.max(0, 4 - tailDigits);
          value = Math.round(head * 10000 + tail * Math.pow(10, scale));
        }
      }
    }
    return value > 0 ? value : null;
  }

  const qianLike = s.match(
    /^([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十百千万]+)千([0-9]+|[零一二两三四五六七八九十百]+)?$/i
  );
  if (qianLike?.[1]) {
    const headRaw = qianLike[1];
    const tailRaw = qianLike[2] || "";
    const head =
      /^\d+(?:\.\d+)?$/.test(headRaw) ? Number(headRaw) : Number(parseCnCompositeInt(headRaw) || 0);
    if (!Number.isFinite(head) || head <= 0) return null;
    let value = Math.round(head * 1000);
    if (tailRaw) {
      if (/[十百]/.test(tailRaw)) {
        const tail = parseCnCompositeInt(tailRaw);
        if (tail && tail > 0) value = Math.round(head * 1000 + tail);
      } else {
        const tail =
          /^\d+$/.test(tailRaw) ? Number(tailRaw) : Number(parseCnInt(tailRaw) || parseCnCompositeInt(tailRaw) || 0);
        if (Number.isFinite(tail) && tail > 0) {
          const tailDigits = String(Math.trunc(tail)).length;
          const scale = Math.max(0, 3 - tailDigits);
          value = Math.round(head * 1000 + tail * Math.pow(10, scale));
        }
      }
    }
    return value > 0 ? value : null;
  }

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const cn = parseCnCompositeInt(s);
  return cn && cn > 0 ? cn : null;
}

const FX_TO_CNY_DEFAULT: Record<string, number> = {
  EUR: 7.9,
  USD: 7.2,
  GBP: 9.2,
  HKD: 0.92,
  JPY: 0.048,
};

function normalizeForeignCurrency(raw: string): keyof typeof FX_TO_CNY_DEFAULT | "" {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "eur" || s === "€" || s === "欧元") return "EUR";
  if (s === "usd" || s === "$" || s === "美元") return "USD";
  if (s === "gbp" || s === "£" || s === "英镑") return "GBP";
  if (s === "hkd" || s === "港币" || s === "港元") return "HKD";
  if (s === "jpy" || s === "yen" || s === "円" || s === "日元") return "JPY";
  return "";
}

function fxToCny(amount: number, currency: string): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const code = normalizeForeignCurrency(currency);
  if (!code) return null;
  const envKey = `CI_FX_${code}_TO_CNY`;
  const envRate = Number(process.env[envKey]);
  const rate = Number.isFinite(envRate) && envRate > 0 ? envRate : FX_TO_CNY_DEFAULT[code];
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(1, Math.round(amount * rate));
}

function parseBoundaryMode(raw: string): DateRangeBoundaryMode {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "inclusive" || v === "exclusive" || v === "auto") return v;
  return "auto";
}

function getDateRangeBoundaryMode(): DateRangeBoundaryMode {
  return parseBoundaryMode(String(process.env.CI_DATE_RANGE_BOUNDARY_MODE || "auto"));
}

const RANGE_MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayOfYear(month: number, day: number, year = 2026): number {
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return 0;
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return 0;
  const start = new Date(year, 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / RANGE_MS_PER_DAY) + 1;
}

function daysInYear(year = 2026): number {
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  return Math.round((end - start) / RANGE_MS_PER_DAY);
}

function extractExplicitDurationHints(snippet: string): number[] {
  const out: number[] = [];
  const text = String(snippet || "");
  const re = /([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)/g;
  for (const m of text.matchAll(re)) {
    const idx = Number(m.index) || 0;
    const prev = text[Math.max(0, idx - 1)] || "";
    if (prev === "第") continue;
    const base = parseCnInt(m[1] || "");
    if (!base || base <= 0) continue;
    const days = m[2] === "天" ? base : base * 7;
    if (days > 0 && days <= 120) out.push(days);
  }
  return out;
}

function escapeRegExp(input: string): string {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSubLocationName(raw: string): string {
  let s = cleanStatement(raw, 40);
  s = s.replace(/^(在|于|到|去|前往|飞到|抵达)\s*/i, "");
  s = s.replace(
    /(看(?:一场|一场次|一场比赛)?球|观赛|比赛|参观|游览|打卡|逛|散步|汇报|演讲|发表|讲论文|参加|参会|开会)$/i,
    ""
  );
  return s.trim();
}

function mergeSubLocations(
  a?: IntentSignals["subLocations"],
  b?: IntentSignals["subLocations"]
): IntentSignals["subLocations"] | undefined {
  const map = new Map<string, NonNullable<IntentSignals["subLocations"]>[number]>();
  for (const x of [...(a || []), ...(b || [])]) {
    const name = normalizeSubLocationName(x?.name || "");
    if (!name) continue;
    const parentCity = x?.parentCity ? normalizeDestination(x.parentCity) : undefined;
    const key = `${name.toLowerCase()}|${(parentCity || "").toLowerCase()}`;
    const cur = map.get(key);
    const cand = {
      name,
      parentCity: parentCity && isLikelyDestinationCandidate(parentCity) ? parentCity : undefined,
      evidence: cleanStatement(x?.evidence || name, 60),
      kind: x?.kind,
      hard: !!x?.hard,
      importance: x?.importance,
    };
    if (!cur) {
      map.set(key, cand);
      continue;
    }
    map.set(key, {
      ...cur,
      evidence: cleanStatement(`${cur.evidence}; ${cand.evidence}`, 60),
      hard: cur.hard || cand.hard,
      importance: Math.max(Number(cur.importance) || 0, Number(cand.importance) || 0) || undefined,
      kind: cur.kind || cand.kind,
      parentCity: cur.parentCity || cand.parentCity,
    });
  }
  return map.size ? Array.from(map.values()).slice(0, 12) : undefined;
}

function remapBySubLocationParent(
  city: string,
  subLocations?: IntentSignals["subLocations"]
): string {
  const c = normalizeDestination(city || "");
  if (!c) return c;
  if (!subLocations?.length) return c;
  const hit = subLocations.find(
    (x) =>
      normalizeDestination(x.name || "") === c &&
      x.parentCity &&
      isLikelyDestinationCandidate(x.parentCity)
  );
  return hit?.parentCity ? normalizeDestination(hit.parentCity) : c;
}

function filterDestinationsBySubLocations(
  destinations?: string[],
  subLocations?: IntentSignals["subLocations"]
): string[] | undefined {
  if (!destinations?.length) return undefined;
  if (!subLocations?.length) return destinations;
  const childWithParent = new Set(
    subLocations
      .filter((x) => x.parentCity)
      .map((x) => normalizeDestination(x.name || ""))
      .filter(Boolean)
  );
  const parentCities = subLocations
    .map((x) => (x.parentCity ? normalizeDestination(x.parentCity) : ""))
    .filter((x) => x && isLikelyDestinationCandidate(x));

  const out = destinations
    .map((x) => normalizeDestination(x))
    .filter((x) => {
      if (!x || !isLikelyDestinationCandidate(x)) return false;
      if (childWithParent.has(x)) return false;
      for (const child of childWithParent) {
        if (!child || child.length < 2) continue;
        if (x.includes(child)) return false;
      }
      return true;
    });
  for (const p of parentCities) {
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out.slice(0, 8) : undefined;
}

function extractSubLocationsFromText(
  text: string,
  destinationHints?: string[]
): IntentSignals["subLocations"] {
  const out: NonNullable<IntentSignals["subLocations"]> = [];
  const t = String(text || "");
  if (!t) return undefined;

  const knownCities = (destinationHints || [])
    .map((x) => normalizeDestination(x))
    .filter((x) => x && isLikelyDestinationCandidate(x));

  const cityMentions: Array<{ city: string; index: number }> = [];
  if (knownCities.length) {
    for (const city of knownCities) {
      const cityEsc = escapeRegExp(city);
      const re = new RegExp(cityEsc, "gi");
      for (const m of t.matchAll(re)) {
        cityMentions.push({ city, index: Number(m.index) || 0 });
      }
    }
    cityMentions.sort((a, b) => a.index - b.index);
  }

  const activityPoiRe =
    /(?:到|去|在|于|抵达)\s*([A-Za-z\u4e00-\u9fff]{2,24}?)(?=看(?:一场|场|一下|一场比赛)?球|看(?:一场|场|一下)?比赛|观赛|比赛|参观|游览|看展|打卡|拍照|购物|吃饭|就餐|汇报|演讲|发表|讲论文|参加|参会|开会)/gi;
  for (const m of t.matchAll(activityPoiRe)) {
    const rawName = String(m[1] || "");
    const name = normalizeSubLocationName(rawName);
    if (!name) continue;

    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(t.slice(Math.max(0, idx - 24), Math.min(t.length, idx + 44)), 120);
    const hard = HARD_REQUIRE_RE.test(ctx) || HARD_CONSTRAINT_RE.test(ctx);
    const venueCtx =
      /看(?:一场|场|一下|一场比赛)?球|看(?:一场|场|一下)?比赛|观赛|比赛|看展|演唱会|演出|打卡|拍照|购物|吃饭|就餐/i.test(
        ctx
      );
    const nameAsCity = normalizeDestination(name);
    if (knownCities.includes(nameAsCity) && !venueCtx) continue;
    let parentCity: string | undefined;
    for (let i = cityMentions.length - 1; i >= 0; i -= 1) {
      const c = cityMentions[i];
      if (normalizeDestination(c.city) === nameAsCity) continue;
      if (c.index <= idx && idx - c.index <= 64) {
        parentCity = c.city;
        break;
      }
    }
    out.push({
      name,
      parentCity,
      evidence: cleanStatement(m[0] || name, 60),
      kind: "venue",
      hard,
      importance: hard ? 0.88 : 0.62,
    });
  }

  return mergeSubLocations(undefined, out);
}

function pickLatestBudgetMatch(
  text: string,
  pattern: RegExp,
  parseValue: (raw: string) => number
): BudgetMatch | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let best: BudgetMatch | null = null;

  for (const m of text.matchAll(re)) {
    if (!m?.[1]) continue;
    const value = parseValue(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const index = Number(m.index) || 0;
    const candidate: BudgetMatch = {
      value,
      index,
      evidence: cleanStatement(m[0] || m[1], 40),
    };
    if (
      !best ||
      candidate.index > best.index ||
      (candidate.index === best.index && candidate.value > best.value)
    ) {
      best = candidate;
    }
  }

  return best;
}

function pickBudgetFromText(text: string): { value: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;
  const GLOBAL_BUDGET_CUE_RE =
    /(预算上限|总预算|预算(?:为|是|在)?|经费|费用|控制在|不超过|上限|可用预算|剩余预算)/i;
  const hasGlobalBudgetCue = GLOBAL_BUDGET_CUE_RE.test(t);
  const isLikelyBudgetContext = (idx: number, hitLen: number) => {
    const left = t.slice(Math.max(0, idx - 10), idx);
    const right = t.slice(idx, Math.min(t.length, idx + hitLen + 14));
    const near = `${left}${right}`;
    const leftBoundary = Math.max(
      t.lastIndexOf("，", idx - 1),
      t.lastIndexOf("。", idx - 1),
      t.lastIndexOf("；", idx - 1),
      t.lastIndexOf(",", idx - 1),
      t.lastIndexOf(";", idx - 1),
      t.lastIndexOf("!", idx - 1),
      t.lastIndexOf("！", idx - 1),
      t.lastIndexOf("?", idx - 1),
      t.lastIndexOf("？", idx - 1)
    );
    let rightBoundary = t.length;
    for (const ch of ["，", "。", "；", ",", ";", "!", "！", "?", "？"]) {
      const next = t.indexOf(ch, idx + hitLen);
      if (next >= 0) rightBoundary = Math.min(rightBoundary, next);
    }
    const clause = t.slice(leftBoundary + 1, rightBoundary);
    const hasSpendCue =
      /(花了|花费了|用了|消费了|支出|支付|付了|已花|开销|打车花了|酒店花了|机票花了)/i.test(near);
    const clauseHasBudgetCue = GLOBAL_BUDGET_CUE_RE.test(clause);
    const clauseHasRemainingCue = /(剩余预算|可用预算|余额|还剩)/i.test(clause);
    const immediateSpendLeft = /(?:花了?|花费了?|用了?|消费了?|支出了?|支付了?|付了?|已花|已用)\s*$/i.test(left);
    const budgetCueClose =
      /(?:总预算|预算(?:上限)?|经费|费用|上限|可用预算|剩余预算)\s*[:：]?\s*$/i.test(left) ||
      /^\s*(?:元|块|人民币)?\s*(?:预算|总预算|经费|费用|上限)/i.test(right);

    if ((immediateSpendLeft || hasSpendCue) && !budgetCueClose && !clauseHasRemainingCue) return false;
    if (budgetCueClose) return true;
    if (clauseHasBudgetCue || clauseHasRemainingCue) return true;
    return false;
  };

  const pickRangeBudget = (): BudgetMatch | null => {
    const defs: Array<{
      re: RegExp;
      parser: (left: string, right: string) => number;
    }> = [
      {
        re: /(?:总预算|预算(?:上限)?|经费|花费|费用)?\s*([0-9]+(?:\.[0-9]+)?)\s*万\s*[-~到至]\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?/gi,
        parser: (left, right) => Math.round(Math.max(Number(left), Number(right)) * 10000),
      },
      {
        re: /(?:总预算|预算(?:上限)?|经费|花费|费用)?\s*([0-9]{3,9})\s*[-~到至]\s*([0-9]{3,9})\s*(?:元|块|人民币)?/gi,
        parser: (left, right) => Math.max(Number(left), Number(right)),
      },
      {
        re: /(?:总预算|预算(?:上限)?|经费|花费|费用)?\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6})\s*[-~到至]\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6})\s*(?:元|块|人民币)?/gi,
        parser: (left, right) =>
          Math.max(Number(parseBudgetAmountToken(left) || 0), Number(parseBudgetAmountToken(right) || 0)),
      },
    ];
    let best: BudgetMatch | null = null;
    for (const def of defs) {
      for (const m of t.matchAll(def.re)) {
        if (!m?.[1] || !m?.[2]) continue;
        const idx = Number(m.index) || 0;
        if (!isLikelyBudgetContext(idx, String(m[0] || "").length)) continue;
        const value = def.parser(m[1], m[2]);
        if (!Number.isFinite(value) || value <= 0) continue;
        const cand: BudgetMatch = {
          value: Math.round(value),
          evidence: cleanStatement(m[0] || `${m[1]}-${m[2]}`, 40),
          index: idx,
        };
        if (
          !best ||
          cand.index > best.index ||
          (cand.index === best.index && cand.value > best.value)
        ) {
          best = cand;
        }
      }
    }
    return best;
  };

  const wanPatterns = [
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|增加到|降到|降低到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]+(?:\.[0-9]+)?)\s*万/i,
    /([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?\s*(?:预算|经费|花费|费用)?/i,
  ];
  let best: BudgetMatch | null = null;
  const range = pickRangeBudget();
  if (range) best = range;

  const colloquialPatterns = [
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|增加到|降到|降低到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4})\s*(?:元|块|人民币)?/gi,
    /([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4})\s*(?:元|块|人民币)\s*(?:预算|总预算|经费|花费|费用)?/gi,
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|增加到|降到|降低到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([零一二两三四五六七八九十百千万]{2,12})\s*(?:元|块|人民币)?/gi,
    /([零一二两三四五六七八九十百千万]{2,12})\s*(?:元|块|人民币)\s*(?:预算|总预算|经费|花费|费用)?/gi,
  ];
  for (const re of colloquialPatterns) {
    for (const m of t.matchAll(re)) {
      if (!m?.[1]) continue;
      const value = parseBudgetAmountToken(m[1]);
      if (!value || value <= 0) continue;
      const idx = Number(m.index) || 0;
      if (!isLikelyBudgetContext(idx, String(m[0] || m[1]).length)) continue;
      const cand: BudgetMatch = {
        value,
        index: idx,
        evidence: cleanStatement(m[0] || m[1], 40),
      };
      if (
        !best ||
        cand.index > best.index ||
        (cand.index === best.index && cand.value > best.value)
      ) {
        best = cand;
      }
    }
  }
  if (!best) {
    for (const re of wanPatterns) {
      const match = pickLatestBudgetMatch(t, re, (raw) => Math.round(Number(raw) * 10000));
      if (!match) continue;
      if (!isLikelyBudgetContext(match.index, match.evidence.length)) continue;
      if (
        !best ||
        match.index > best.index ||
        (match.index === best.index && match.value > best.value)
      ) {
        best = match;
      }
    }
  }

  const yuanPatterns = [
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|增加到|降到|降低到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]{3,9})(?:\s*[-~到至]\s*[0-9]{3,9})?\s*(?:元|块|人民币)?/i,
    /([0-9]{3,9})\s*(?:元|块|人民币)\s*(?:预算|总预算|经费|花费|费用)?/i,
  ];
  for (const re of yuanPatterns) {
    const match = pickLatestBudgetMatch(t, re, (raw) => Number(raw));
    if (!match) continue;
    if (!isLikelyBudgetContext(match.index, match.evidence.length)) continue;
    if (
      !best ||
      match.index > best.index ||
      (match.index === best.index && match.value > best.value)
    ) {
      best = match;
    }
  }

  if (!best) return null;
  return { value: best.value, evidence: best.evidence };
}

function pickBudgetDeltaFromText(text: string, locale?: AppLocale): { delta: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;
  const foreignUnitRe =
    /^\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円)/i;

  const defs: Array<{
    re: RegExp;
    sign: 1 | -1;
    parser?: (raw: string) => number;
  }> = [
    {
      re: /(?:又|再|另外|额外|追加|补充)?\s*(?:父亲|母亲|家人|朋友|老板|公司)?\s*(?:又)?\s*(?:给了?|给到|给|跟我)\s*(?:我|我们)?\s*(?:增添了?|新增了?|增加了?|加了?)\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?(?:的)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
      parser: (raw) => Math.round(Number(raw) * 10000),
    },
    {
      re: /(?:又|再|另外|额外|追加|补充)?\s*(?:父亲|母亲|家人|朋友|老板|公司)?\s*(?:又)?\s*(?:给了?|给到|给|跟我)\s*(?:我|我们)?\s*(?:增添了?|新增了?|增加了?|加了?)\s*([0-9]{2,9})\s*(?:元|块|人民币)?(?:的)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
    },
    {
      re: /(?:又|再|另外|额外|追加|补充)\s*(?:给了?|给到|给)\s*(?:我|我们)?\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?(?:的)?(?:预算|经费|花费|费用)/gi,
      sign: 1,
      parser: (raw) => Math.round(Number(raw) * 10000),
    },
    {
      re: /(?:又|再|另外|额外|追加|补充)\s*(?:给了?|给到|给)\s*(?:我|我们)?\s*([0-9]{2,9})\s*(?:元|块|人民币)?(?:的)?(?:预算|经费|花费|费用)/gi,
      sign: 1,
    },
    {
      re: /(?:又|再|另外|额外|追加|补充)\s*(?:给了?|给到|给)\s*(?:我|我们)?\s*([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4}|[零一二两三四五六七八九十百千]{2,8})\s*(?:元|块|人民币)?(?:的)?(?:预算|经费|花费|费用)/gi,
      sign: 1,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:又|再|另外|额外|追加|补充|增添了?|新增了?)\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
      parser: (raw) => Math.round(Number(raw) * 10000),
    },
    {
      re: /(?:又|再|另外|额外|追加|补充|增添了?|新增了?)\s*([0-9]{2,9})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
    },
    {
      re: /(?:又|再|另外|额外|追加|补充|增添了?|新增了?)\s*([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4}|[零一二两三四五六七八九十百千]{2,8})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:再|又|额外|另外|追加|多给|增加了?|加了?|上调了?|提高了?|提升了?)\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
      parser: (raw) => Math.round(Number(raw) * 10000),
    },
    {
      re: /(?:再|又|额外|另外|追加|多给|增加了?|加了?|上调了?|提高了?|提升了?)\s*([0-9]{2,9})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
    },
    {
      re: /(?:再|又|额外|另外|追加|多给|增加了?|加了?|上调了?|提高了?|提升了?)\s*([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4}|[零一二两三四五六七八九十百千]{2,8})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: 1,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:减少了?|减了?|减去|下调了?|砍掉|扣减|省下了?)\s*([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: -1,
      parser: (raw) => Math.round(Number(raw) * 10000),
    },
    {
      re: /(?:减少了?|减了?|减去|下调了?|砍掉|扣减|省下了?)\s*([0-9]{2,9})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: -1,
    },
    {
      re: /(?:减少了?|减了?|减去|下调了?|砍掉|扣减|省下了?)\s*([0-9一二两三四五六七八九十百千万\.]{1,12}(?:万|千)[0-9一二两三四五六七八九十百千]{0,4}|[零一二两三四五六七八九十百千]{2,8})\s*(?:元|块|人民币)?(?:预算|经费|花费|费用)?/gi,
      sign: -1,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
  ];

  let best: BudgetDeltaMatch | null = null;
  for (const def of defs) {
    for (const m of t.matchAll(def.re)) {
      if (!m?.[1]) continue;
      const raw = m[1];
      let value = def.parser ? def.parser(raw) : Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      const index = Number(m.index) || 0;
      const matched = String(m[0] || raw);
      let evidence = cleanStatement(matched || raw, 40);
      const tail = t.slice(index + matched.length, Math.min(t.length, index + matched.length + 16));
      const foreignUnit = tail.match(foreignUnitRe)?.[1] || "";
      if (foreignUnit) {
        const converted = fxToCny(value, foreignUnit);
        if (!converted || converted <= 0) continue;
        value = converted;
        evidence = cleanStatement(`${matched}${foreignUnit} ${formatApproxBudgetCny(locale, Math.round(value))}`, 64);
      }
      const cand: BudgetDeltaMatch = {
        delta: Math.round(value) * def.sign,
        evidence,
        index,
      };
      if (!best || cand.index >= best.index) best = cand;
    }
  }
  if (!best) return null;

  // 诸如“提高到15000/增加到15000”是绝对预算，不应当作增量。
  const near = t.slice(Math.max(0, best.index - 12), Math.min(t.length, best.index + 36));
  if (/(增加到|提高到|提升到|上调到|下调到|调到|改到|改成|调整为|变成|变为|达到|总预算为|预算上限为)/i.test(near)) {
    return null;
  }
  return { delta: best.delta, evidence: best.evidence };
}

function pickBudgetSpentDeltaFromText(text: string, locale?: AppLocale): { delta: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;
  const looksLikeQuestion = (ctx: string) => {
    const s = cleanStatement(ctx, 140);
    if (!s) return false;
    const q = /[？?]|多少钱|多少欧|多少元|票价|价格|预算多少|贵吗|合适吗/.test(s);
    const commit = /(那|就|确定|锁定|下单|付款|支付|买了?|订了?|定了?|我选|就选|就买|就定)/.test(s);
    return q && !commit;
  };

  const defs: Array<{ re: RegExp; parser?: (raw: string) => number }> = [
    {
      re: /(?:又|再|另外|额外|追加|新增|多)\s*(?:花了?|花费了?|用了?|消费了?|支出了?|支付了?|付了?)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:元|块|人民币|rmb|cny)?/gi,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:新增|追加|额外)\s*(?:开销|支出|消费|花费|费用)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:元|块|人民币|rmb|cny)?/gi,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
  ];

  let best: BudgetDeltaMatch | null = null;
  for (const def of defs) {
    for (const m of t.matchAll(def.re)) {
      if (!m?.[1]) continue;
      const value = def.parser ? def.parser(m[1]) : Number(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const index = Number(m.index) || 0;
      const near = t.slice(Math.max(0, index - 10), Math.min(t.length, index + 44));
      if (looksLikeQuestion(near)) continue;
      const cand: BudgetDeltaMatch = {
        delta: Math.round(value),
        evidence: cleanStatement(m[0] || m[1], 48),
        index,
      };
      if (!best || cand.index >= best.index) best = cand;
    }
  }
  const foreignSpendRe =
    /(?:买|买了|购买|购入|下单|订|订了|订票|买票|购票|支付|付款|付了?|刷卡|出票)[^\n，。,；;]{0,14}?([0-9]+(?:\.[0-9]+)?)\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円)(?:\s*(?:的|左右|约|大概))?/gi;
  for (const m of t.matchAll(foreignSpendRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const amount = Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cny = fxToCny(amount, m[2]);
    if (!cny || cny <= 0) continue;
    const index = Number(m.index) || 0;
    const near = t.slice(Math.max(0, index - 10), Math.min(t.length, index + 46));
    if (looksLikeQuestion(near)) continue;
    const cand: BudgetDeltaMatch = {
      delta: Math.round(cny),
      evidence: cleanStatement(`${m[0]} ${formatApproxBudgetCny(locale, Math.round(cny))}`, 64),
      index,
    };
    if (!best || cand.index >= best.index) best = cand;
  }

  const commitmentSpendRe =
    /(?:那|就|我|我们|先|决定|确定|最终|直接)?\s*(?:买|买了|购买|订|订了|定了|下单|支付|付款|付了?|选|就选|就买|就定|锁定)(?:了)?[^\n，。,；;]{0,16}?([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円|元|块|人民币|rmb|cny)/gi;
  for (const m of t.matchAll(commitmentSpendRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    const near = t.slice(Math.max(0, idx - 12), Math.min(t.length, idx + 52));
    if (looksLikeQuestion(near)) continue;
    const token = m[1];
    const unit = m[2];
    let cny = Number(parseBudgetAmountToken(token) || 0);
    if (!cny || cny <= 0) continue;
    if (!/(元|块|人民币|rmb|cny)/i.test(unit)) {
      const fxCny = fxToCny(cny, unit);
      if (!fxCny || fxCny <= 0) continue;
      cny = fxCny;
    }
    const cand: BudgetDeltaMatch = {
      delta: Math.round(cny),
      evidence: cleanStatement(
        /(元|块|人民币|rmb|cny)/i.test(unit)
          ? `${m[0]}`
          : `${m[0]} ${formatApproxBudgetCny(locale, Math.round(cny))}`,
        64
      ),
      index: idx,
    };
    if (!best || cand.index >= best.index) best = cand;
  }
  const categoryCommittedBudgetRe =
    /(?:酒店|住宿|球票|门票|比赛|看球|观赛|购物|买包|买鞋|餐饮|吃饭|交通|打车|地铁|火车|演出|活动|导游)[^\n，。,；;]{0,10}?(?:预算|费用|花费|开销|成本)?[^\n，。,；;]{0,6}?(?:定在|控制在|锁定|确定|就按|按|定为)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円|元|块|人民币|rmb|cny)/gi;
  for (const m of t.matchAll(categoryCommittedBudgetRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    const near = t.slice(Math.max(0, idx - 12), Math.min(t.length, idx + 56));
    if (looksLikeQuestion(near)) continue;
    const token = m[1];
    const unit = m[2];
    let cny = Number(parseBudgetAmountToken(token) || 0);
    if (!cny || cny <= 0) continue;
    if (!/(元|块|人民币|rmb|cny)/i.test(unit)) {
      const fxCny = fxToCny(cny, unit);
      if (!fxCny || fxCny <= 0) continue;
      cny = fxCny;
    }
    const cand: BudgetDeltaMatch = {
      delta: Math.round(cny),
      evidence: cleanStatement(
        /(元|块|人民币|rmb|cny)/i.test(unit)
          ? `${m[0]}`
          : `${m[0]} ${formatApproxBudgetCny(locale, Math.round(cny))}`,
        64
      ),
      index: idx,
    };
    if (!best || cand.index >= best.index) best = cand;
  }
  return best ? { delta: best.delta, evidence: best.evidence } : null;
}

function pickBudgetSpentAbsoluteFromText(text: string, locale?: AppLocale): { spent: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;

  const defs: Array<{ re: RegExp; parser?: (raw: string) => number }> = [
    {
      re: /(?:已经|已|目前|当前|到现在|截至目前|这次|本次)?\s*(?:花了?|花费了?|用了?|消费了?|支出了?|支付了?|付了?|已花)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:元|块|人民币|rmb|cny)?/gi,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:酒店|住宿|机票|餐饮|交通|门票|购物|打车|火车|航班|活动|演出|比赛|球票|签证)[^\n，。,；;]{0,10}?(?:花了?|花费了?|用了?|消费了?|支出了?|支付了?|付了?)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:元|块|人民币|rmb|cny)?/gi,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
    {
      re: /(?:已花|已用|累计花费|累计消费|已支出|已付款)\s*([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:元|块|人民币|rmb|cny)?/gi,
      parser: (raw) => Number(parseBudgetAmountToken(raw) || 0),
    },
  ];

  let best: BudgetMatch | null = null;
  for (const def of defs) {
    for (const m of t.matchAll(def.re)) {
      if (!m?.[1]) continue;
      const value = def.parser ? def.parser(m[1]) : Number(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const index = Number(m.index) || 0;
      const near = t.slice(Math.max(0, index - 10), Math.min(t.length, index + 50));
      if (/(预算|预算上限|总预算|预算总额)/i.test(near) && !/(花|用|消费|支出|支付|付)/i.test(near)) {
        continue;
      }
      const cand: BudgetMatch = {
        value: Math.round(value),
        evidence: cleanStatement(m[0] || m[1], 48),
        index,
      };
      if (!best || cand.index >= best.index) best = cand;
    }
  }
  if (!best) return null;
  const near = t.slice(Math.max(0, best.index - 12), Math.min(t.length, best.index + 42));
  if (/(又|再|另外|额外|追加|新增|多)\s*(花|用|消费|支出|支付|付)/i.test(near)) {
    return null;
  }
  return { spent: best.value, evidence: best.evidence };
}

function parseDateMentions(text: string, locale?: AppLocale): DateMention[] {
  const out: DateMention[] = [];
  const re = /([0-9]{1,2})月([0-9]{1,2})日/g;
  for (const m of text.matchAll(re)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const ordinal = dayOfYear(month, day);
    if (ordinal <= 0) continue;
    const index = Number(m.index) || 0;
    out.push({
      month,
      day,
      ordinal,
      index,
      evidence: cleanStatement(m[0] || "", 24),
    });
  }

  const rangeRe = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/g;
  for (const m of text.matchAll(rangeRe)) {
    const month = Number(m[1]);
    const day1 = Number(m[2]);
    const day2 = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day1) || !Number.isFinite(day2)) continue;
    if (month < 1 || month > 12 || day1 < 1 || day1 > 31 || day2 < 1 || day2 > 31) continue;
    const ordinalA = dayOfYear(month, day1);
    const ordinalB = dayOfYear(month, day2);
    if (ordinalA <= 0 || ordinalB <= 0) continue;
    const index = Number(m.index) || 0;
    out.push({
      month,
      day: day1,
      ordinal: ordinalA,
      index,
      evidence: cleanStatement(formatDateLabel(locale, month, day1), 24),
    });
    out.push({
      month,
      day: day2,
      ordinal: ordinalB,
      index: index + String(m[0] || "").length - 1,
      evidence: cleanStatement(formatDateLabel(locale, month, day2), 24),
    });
  }

  const shortRe = /(^|[^\d])([0-9]{1,2})[-/]([0-9]{1,2})(?=[^\d]|$)/g;
  for (const m of text.matchAll(shortRe)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const ordinal = dayOfYear(month, day);
    if (ordinal <= 0) continue;
    const index = (Number(m.index) || 0) + String(m[1] || "").length;
    out.push({
      month,
      day,
      ordinal,
      index,
      evidence: cleanStatement(`${month}-${day}`, 24),
    });
  }

  return out;
}

function computeDateMentionSpanDays(mentions: DateMention[]): number {
  if (!mentions.length) return 0;
  const ordinals = mentions.map((x) => Number(x.ordinal) || 0).filter((x) => x > 0);
  if (!ordinals.length) return 0;
  const minOrdinal = Math.min(...ordinals);
  const maxOrdinal = Math.max(...ordinals);
  let span = maxOrdinal - minOrdinal + 1;
  const months = mentions.map((x) => Number(x.month) || 0);
  const likelyCrossYear =
    months.some((m) => m >= 11) && months.some((m) => m <= 2) && span > 120;
  if (likelyCrossYear) {
    const yearDays = daysInYear(2026);
    const lateOrdinals = mentions
      .filter((x) => (Number(x.month) || 0) >= 11)
      .map((x) => Number(x.ordinal) || 0)
      .filter((x) => x > 0);
    const earlyOrdinals = mentions
      .filter((x) => (Number(x.month) || 0) <= 2)
      .map((x) => Number(x.ordinal) || 0)
      .filter((x) => x > 0);
    if (lateOrdinals.length && earlyOrdinals.length) {
      const wrapSpan = yearDays - Math.min(...lateOrdinals) + 1 + Math.max(...earlyOrdinals);
      if (Number.isFinite(wrapSpan) && wrapSpan > 0) span = Math.min(span, wrapSpan);
    }
  }
  return span;
}

function calcRangeDays(
  monthA: number,
  dayA: number,
  monthB: number,
  dayB: number,
  opts?: {
    mode?: DateRangeBoundaryMode;
    context?: string;
    isMeetingLike?: boolean;
    hintedDays?: number[];
  }
): number {
  const year = 2026;
  const start = new Date(year, monthA - 1, dayA);
  let end = new Date(year, monthB - 1, dayB);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (start.getMonth() !== monthA - 1 || start.getDate() !== dayA) return 0;
  if (end.getMonth() !== monthB - 1 || end.getDate() !== dayB) return 0;
  if (end.getTime() < start.getTime()) {
    end = new Date(year + 1, monthB - 1, dayB);
    if (end.getMonth() !== monthB - 1 || end.getDate() !== dayB) return 0;
  }
  const raw = Math.floor((end.getTime() - start.getTime()) / RANGE_MS_PER_DAY);
  if (!Number.isFinite(raw)) return 0;
  const inclusiveDays = raw + 1;
  const exclusiveDays = Math.max(1, raw);

  const mode = opts?.mode || getDateRangeBoundaryMode();
  if (mode === "inclusive") return inclusiveDays;
  if (mode === "exclusive") return exclusiveDays;

  const ctx = cleanStatement(opts?.context || "", 160);
  if (/(不含首尾|不算首尾|exclusive|净天数)/i.test(ctx)) return exclusiveDays;
  if (/(含首尾|算上首尾|inclusive|含出发和返程|包含首末日)/i.test(ctx)) return inclusiveDays;

  const hinted = (opts?.hintedDays || []).filter((x) => Number.isFinite(x) && x > 0 && x <= 120);
  if (hinted.length) {
    const incLoss = hinted.reduce((acc, x) => acc + Math.abs(x - inclusiveDays), 0);
    const excLoss = hinted.reduce((acc, x) => acc + Math.abs(x - exclusiveDays), 0);
    if (incLoss + 0.25 < excLoss) return inclusiveDays;
    if (excLoss + 0.25 < incLoss) return exclusiveDays;
  }

  if (opts?.isMeetingLike) return exclusiveDays;
  return inclusiveDays;
}

function extractDateRangeDurations(text: string, locale?: AppLocale): DateRangeCandidate[] {
  const out: DateRangeCandidate[] = [];

  const sameMonthRe = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/g;
  for (const m of text.matchAll(sameMonthRe)) {
    const month = Number(m[1]);
    const dayA = Number(m[2]);
    const dayB = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(dayA) || !Number.isFinite(dayB)) continue;
    if (month < 1 || month > 12 || dayA < 1 || dayA > 31 || dayB < 1 || dayB > 31) continue;
    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(
      text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + String(m[0] || "").length + 44)),
      120
    );
    const isMeetingLike = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会|发表|汇报|报告|讲论文)/i.test(ctx);
    const days = calcRangeDays(month, dayA, month, dayB, {
      mode: getDateRangeBoundaryMode(),
      context: ctx,
      isMeetingLike,
      hintedDays: extractExplicitDurationHints(ctx),
    });
    if (days <= 0 || days > 62) continue;
    out.push({
      days,
      evidence: cleanStatement(m[0] || formatDateRangeLabel(locale, month, dayA, month, dayB), 36),
      index: idx,
      isMeetingLike,
    });
  }

  const crossMonthRe =
    /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})月([0-9]{1,2})日?/g;
  for (const m of text.matchAll(crossMonthRe)) {
    const monthA = Number(m[1]);
    const dayA = Number(m[2]);
    const monthB = Number(m[3]);
    const dayB = Number(m[4]);
    if (!Number.isFinite(monthA) || !Number.isFinite(dayA) || !Number.isFinite(monthB) || !Number.isFinite(dayB)) continue;
    if (monthA < 1 || monthA > 12 || monthB < 1 || monthB > 12 || dayA < 1 || dayA > 31 || dayB < 1 || dayB > 31) continue;
    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(
      text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + String(m[0] || "").length + 44)),
      120
    );
    const isMeetingLike = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会|发表|汇报|报告|讲论文)/i.test(ctx);
    const days = calcRangeDays(monthA, dayA, monthB, dayB, {
      mode: getDateRangeBoundaryMode(),
      context: ctx,
      isMeetingLike,
      hintedDays: extractExplicitDurationHints(ctx),
    });
    if (days <= 0 || days > 62) continue;
    out.push({
      days,
      evidence: cleanStatement(m[0] || formatDateRangeLabel(locale, monthA, dayA, monthB, dayB), 42),
      index: idx,
      isMeetingLike,
    });
  }

  return out
    .sort((a, b) => a.index - b.index)
    .filter((x, i, arr) => i === arr.findIndex((y) => y.index === x.index && y.days === x.days));
}

function extractDurationCandidates(text: string): DurationCandidate[] {
  const out: DurationCandidate[] = [];
  const re = /([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)(?!上)/g;
  for (const m of text.matchAll(re)) {
    if (!m?.[1] || !m?.[2]) continue;
    const index = Number(m.index) || 0;
    const prevChar = text[Math.max(0, index - 1)] || "";
    if (prevChar === "第") continue;
    const base = parseCnInt(m[1]);
    if (!base || base <= 0) continue;
    const unit = m[2];
    const days = unit === "天" ? base : base * 7;
    if (days <= 0 || days > 120) continue;

    const left = Math.max(0, index - 20);
    const right = Math.min(text.length, index + String(m[0] || "").length + 28);
    const ctx = cleanStatement(text.slice(left, right), 120);
    if ((prevChar === "前" || prevChar === "后") && !/(玩|待|停留|旅行|旅游|出行|行程|参会|开会|会议)/i.test(ctx)) {
      continue;
    }

    const isTotal = /(总共|一共|总计|全程|整个(?:行程|旅行)?|整体|行程时长|trip length|overall|total|in total)/i.test(ctx);
    const isMeeting = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会)/i.test(ctx);
    const isCriticalEvent = hasHardDayReservationSignal(ctx);
    const isSegment =
      /(停留|经过|先去|再去|之后去|前往|飞到|抵达|转机|行程段|安排|规划|计划|逛|游|玩|旅行|旅游|度假|city|stay|flight|arrive|depart|before|after)/i.test(
        ctx
      );

    let kind: DurationCandidate["kind"] = "unknown";
    let strength = 0.55;
    if (isTotal) {
      kind = "total";
      strength = 0.95;
    } else if (isCriticalEvent) {
      kind = "critical_event";
      strength = 0.96;
    } else if (isMeeting) {
      kind = "meeting";
      strength = 0.64;
    } else if (isSegment) {
      kind = "segment";
      strength = 0.68;
    }

    out.push({
      days,
      evidence: cleanStatement(m[0] || m[1], 30),
      index,
      kind,
      strength,
    });
  }
  return out;
}

function inferDurationFromText(
  text: string,
  opts?: { historyMode?: boolean; locale?: AppLocale }
): {
  days: number;
  evidence: string;
  strength: number;
  boundaryAmbiguous?: boolean;
  boundaryQuestion?: string;
} | null {
  const historyMode = !!opts?.historyMode;
  const durationCandidates = extractDurationCandidates(text);
  const dateRangeCandidates = extractDateRangeDurations(text, opts?.locale);
  const dateMentions = parseDateMentions(text, opts?.locale);
  const uniqueDateMentions = dateMentions.filter(
    (d, i, arr) => i === arr.findIndex((x) => x.month === d.month && x.day === d.day)
  );

  const explicitTotal = durationCandidates
    .filter((x) => x.kind === "total")
    .sort((a, b) => b.index - a.index)[0];
  if (explicitTotal) {
    return {
      days: explicitTotal.days,
      evidence: explicitTotal.evidence,
      strength: explicitTotal.strength,
    };
  }

  let best: { days: number; evidence: string; strength: number } | null = null;
  const consider = (days: number, evidence: string, strength: number) => {
    if (!Number.isFinite(days) || days <= 0 || days > 120) return;
    const e = cleanStatement(evidence, 80);
    if (!best) {
      best = { days, evidence: e, strength };
      return;
    }
    if (strength > best.strength + 0.06) {
      best = { days, evidence: e, strength };
      return;
    }
    if (days > best.days) {
      // 更大的天数不应无条件覆盖：需要置信度接近当前最优，避免被噪声跨度抬高。
      if (strength + 0.04 >= best.strength) {
        best = { days, evidence: e, strength };
      }
      return;
    }
    if (days === best.days && strength > best.strength) {
      best = { days, evidence: e, strength };
    }
  };

  const rangeLatest = dateRangeCandidates.slice().sort((a, b) => b.index - a.index)[0];
  const boundaryMode = getDateRangeBoundaryMode();
  const hasBoundaryCue =
    /(不含首尾|不算首尾|exclusive|净天数|含首尾|算上首尾|inclusive|含出发和返程|包含首末日)/i.test(
      text
    );
  let boundaryAmbiguous = false;
  let boundaryQuestion = "";
  if (!historyMode && rangeLatest) {
    const nearbyExplicit = durationCandidates
      .filter(
        (x) =>
          (x.kind === "meeting" ||
            x.kind === "segment" ||
            x.kind === "total" ||
            (x.kind === "unknown" && x.days >= 3)) &&
          Math.abs(x.index - rangeLatest.index) <= 48
      )
      .sort((a, b) => b.strength - a.strength || b.index - a.index)[0];
    if (nearbyExplicit && Math.abs(nearbyExplicit.days - rangeLatest.days) <= 2) {
      consider(
        nearbyExplicit.days,
        nearbyExplicit.evidence,
        Math.max(0.97, nearbyExplicit.strength)
      );
    }
    const rangeStrength = rangeLatest.isMeetingLike ? 0.92 : 0.88;
    consider(rangeLatest.days, rangeLatest.evidence, rangeStrength);

    const hasExplicitDayCue = /(总共|一共|总计|共|净停留|停留)\s*[0-9一二三四五六七八九十两]{1,3}\s*(天|周|星期)/i.test(
      text
    );
    const hasHintedDuration = extractExplicitDurationHints(text).length > 0;
    if (
      boundaryMode === "auto" &&
      !rangeLatest.isMeetingLike &&
      !hasExplicitDayCue &&
      !hasBoundaryCue &&
      !hasHintedDuration
    ) {
      const inclusive = rangeLatest.days;
      const exclusive = Math.max(1, inclusive - 1);
      if (inclusive !== exclusive) {
        boundaryAmbiguous = true;
        boundaryQuestion = isEnglishLocale(opts?.locale)
          ? `For "${rangeLatest.evidence}", do you mean ${inclusive} days inclusive or ${exclusive} net stay days?`
          : `你说的“${rangeLatest.evidence}”是按含首尾（${inclusive}天）还是净停留（${exclusive}天）？`;
      }
    }
  }

  const eligibleForTotal = durationCandidates.filter(
    (x) =>
      x.kind === "total" ||
      x.kind === "segment" ||
      (x.kind === "meeting" && x.days >= 3) ||
      (x.kind === "unknown" && x.days >= 3)
  );
  const maxSingle = eligibleForTotal.slice().sort((a, b) => b.days - a.days || b.strength - a.strength)[0];
  if (maxSingle) consider(maxSingle.days, maxSingle.evidence, maxSingle.strength);

  const meetingMax = durationCandidates
    .filter((x) => x.kind === "meeting" && x.days >= 2)
    .sort((a, b) => b.days - a.days || b.index - a.index)[0];
  const segmentMax = durationCandidates
    .filter((x) => x.kind === "segment")
    .sort((a, b) => b.days - a.days || b.index - a.index)[0];

  if (!historyMode && meetingMax && segmentMax) {
    consider(
      meetingMax.days + segmentMax.days,
      `${segmentMax.evidence} + ${meetingMax.evidence}`,
      Math.max(meetingMax.strength, segmentMax.strength) + 0.06
    );
  }

  if (!historyMode && uniqueDateMentions.length >= 2) {
    const span = computeDateMentionSpanDays(uniqueDateMentions);
    if (span >= 2 && span <= 60) {
      const first = uniqueDateMentions.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
      const last = uniqueDateMentions.slice().sort((a, b) => b.ordinal - a.ordinal)[0];
      consider(span, `${first.evidence}-${last.evidence}`, 0.74);
    }
  }

  // 仅在没有明确日期区间时，用“会议起始日+会议时长”估计总时长下界，避免把 5 天误抬高成 14 天。
  if (!historyMode && dateRangeCandidates.length === 0 && uniqueDateMentions.length >= 1) {
    const earliest = uniqueDateMentions.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
    const hasBeforeCue = /之前|此前|先|然后|再|之后|再从|before|then/i.test(text);
    const confRe =
      /([0-9]{1,2})月([0-9]{1,2})日[\s\S]{0,40}?([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)[\s\S]{0,20}?(学术会议|会议|开会|chi|conference|workshop)/gi;
    for (const m of text.matchAll(confRe)) {
      const month = Number(m[1]);
      const day = Number(m[2]);
      const rawDuration = m[3];
      const unit = m[4];
      const d = parseCnInt(rawDuration || "");
      if (!Number.isFinite(month) || !Number.isFinite(day) || !d || d <= 0) continue;
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      const confDays = unit === "天" ? d : d * 7;
      const startOrdinal = month * 31 + day;
      const offset = startOrdinal - earliest.ordinal;
      if (offset < 0 || offset > 60) continue;
      if (!hasBeforeCue && offset > 0) continue;
      const totalLowerBound = offset + confDays;
      consider(
        totalLowerBound,
        cleanStatement(
          m[0] || `${formatDateLabel(opts?.locale, Number(m[1]), Number(m[2]))} ${isEnglishLocale(opts?.locale) ? `${confDays}-day conference` : `${confDays}天会议`}`,
          60
        ),
        0.9
      );
    }
  }

  if (!best) return null;

  const onlyCriticalOrTiny =
    durationCandidates.length > 0 &&
    durationCandidates.every((x) => x.kind === "critical_event" || x.days <= 2 || x.kind === "meeting");
  if (onlyCriticalOrTiny && best.days <= 2 && best.strength < 0.9) return null;

  const hasExplicitTotalCue = hasExplicitDurationTotalCue(text);
  const trustedUpper = Math.max(
    ...dateRangeCandidates.map((x) => x.days),
    ...durationCandidates.filter((x) => x.kind === "meeting" && x.days >= 3).map((x) => x.days),
    0
  );
  if (!hasExplicitTotalCue && trustedUpper > 0 && best.days > trustedUpper + 3) {
    best = {
      days: trustedUpper,
      evidence: dateRangeCandidates[0]?.evidence || durationCandidates.find((x) => x.days === trustedUpper)?.evidence || best.evidence,
      strength: Math.max(best.strength, 0.9),
    };
  }

  return {
    ...best,
    boundaryAmbiguous,
    boundaryQuestion: boundaryQuestion || undefined,
  };
}

export function normalizeDestination(raw: string): string {
  let s = cleanStatement(raw, 24);
  s = s.replace(/^(那就先以|那就先按|那就按|就先以|先以|以|就按|先按|按|改成|改为|改到)\s*/i, "");
  s = s.replace(/^(和|与|及|加)\s*/i, "");
  s = s.replace(/^(在|于|到|去|从|飞到|前往|抵达)\s*/i, "");
  s = s.replace(/^(我想|想|想去|想到|想逛|想安排|安排|规划|计划|逛一逛|逛逛|逛|游览|游玩|探索|体验|顺带|顺便|顺路|顺道)\s*/i, "");
  s = s.replace(
    /^(?:我|我们)?\s*(?:一个人|两个人|三个人|[0-9一二三四五六七八九十两]{1,2}\s*个?人|独自|单人|solo|一家[三四五六七八九十0-9]*口|全家)(?:一起)?\s*去\s*/i,
    ""
  );
  s = s.replace(
    /^(?:一个人|两个人|三个人|[0-9一二三四五六七八九十两]{1,2}\s*个?人|独自|单人|solo|一家[三四五六七八九十0-9]*口|全家)\s*/i,
    ""
  );
  s = s.replace(/^(?:我|我们)\s*去\s*/i, "");
  s = s.replace(/^(的|在|于)\s*/i, "");
  s = s.replace(
    /(?:为主(?:住|待|停留|安排)?|主要(?:住|待|停留|安排)?|住为主|停留为主|安排为主|落脚(?:在|点)?|主要落脚(?:在|点)?|首住|先住)$/i,
    ""
  );
  s = s.replace(/(?:最后(?:一晚|一夜|一天|一日)?|最后住|收尾(?:住|待)?|临走前)$/i, "");
  s = s.replace(/(?:首晚|首夜|第一晚|第一夜|落地(?:先)?住?)$/i, "");
  s = s.replace(/(这座城市|这座城|这座|城市|城区|城)$/i, "");
  s = s.replace(/(之外|之内|以内|以内地区)$/i, "");
  s = s.replace(/(?:前|后)$/i, "");
  s = s.replace(
    /(?:看|观)(?:一场|一下|一次|场)?(?:球|比赛|演唱会|演出|展览|赛事)$/i,
    ""
  );
  s = s.replace(
    /(?:参加|观看|去看|打卡)(?:一场|一下|一次|场)?(?:比赛|演唱会|演出|展览|赛事)$/i,
    ""
  );
  // 迭代剥离尾部噪声，避免“巴塞罗那参加CHI”“米兰玩”这类污染目的地槽位。
  const tailNoiseRe =
    /(参加|参会|开会|会议|chi|conference|workshop|summit|论坛|峰会|玩|逛|旅游|旅行|游玩|出行|度假|计划|安排|放空|休整|休息|放松|躺平|慢游)$/i;
  let changed = true;
  while (changed && s) {
    const next = s.replace(tailNoiseRe, "");
    changed = next !== s;
    s = next.trim();
  }
  s = s.replace(/^的+/g, "").replace(/的+$/g, "");
  s = s.replace(/省/g, "").replace(/市/g, "");
  const strippedCountryPrefix = s.replace(COUNTRY_PREFIX_RE, "");
  if (strippedCountryPrefix && strippedCountryPrefix !== s) s = strippedCountryPrefix;
  s = s.replace(/^的+/g, "");
  s = s.replace(/(放空|休整|休息|放松|躺平|慢游)$/i, "");
  s = s.replace(/(旅游|旅行|游玩|出行|度假|参会|开会|会议|行程|计划|玩|逛)$/i, "");
  s = s.replace(/(不确定要不要去|不确定要不要|不确定是否去|不确定|不是必须|先完全|完全|了)$/i, "");
  s = s.replace(/(地方|区域|位置|片区)(吧|呢|呀|啊)?$/i, "");
  s = s.replace(/(的地方|的区域)$/i, "");
  s = s.replace(/[吧啊呀呢嘛]+$/g, "");
  const routeScoped = s.match(/^(.{2,16}?)(?:自驾)?(?:小)?(?:环岛|环线|环游|环路|一圈)$/i);
  if (routeScoped?.[1]) s = routeScoped[1];
  s = s.trim();
  return s;
}

export function isLikelyDestinationCandidate(x: string): boolean {
  const s = normalizeDestination(x);
  if (!s) return false;
  if (/^(?:剩下|其余|余下|机动|过渡|中转)$/.test(s)) return false;
  if (/去/.test(s)) return false;
  if (/^(?:整体|整体还是|总时长|总时长还是|总时长还是按|总行程|总行程还是|全程|整个行程|一共|总共|总计|但总时长还是)/.test(s)) {
    return false;
  }
  if (/^(?:只|仅)?含当地$|^当地(?:游|玩)?$|^本地(?:游|玩)?$/i.test(s)) return false;
  if (/(^|.*)(只含当地|仅含当地|当地|本地|本市|本城|这边|那边)(.*|$)/i.test(s)) return false;
  if (s.length < 2 || s.length > 16) return false;
  if (/^的/.test(s)) return false;
  if (NON_PLACE_TOKEN_RE.test(s)) return false;
  if (/^(?:[0-9]+|[一二三四五六七八九十两百千]+)$/.test(s)) return false;
  if (/(很高的建筑|高空建筑|高层建筑|摩天楼|高楼|楼顶|屋顶观景|高空观景)/i.test(s)) return false;
  if (/^(所以|因此|然后|另外|此外|这|那|此次|本次)/.test(s)) return false;
  if (!/^[A-Za-z\u4e00-\u9fff]+$/.test(s)) return false;
  if (/[\u4e00-\u9fffA-Za-z]{1,12}(和|与|及|、|,|，)[\u4e00-\u9fffA-Za-z]{1,12}/.test(s)) return false;
  if (DESTINATION_NOISE_RE.test(s)) return false;
  if (PLACE_STOPWORD_RE.test(s)) return false;
  if (/(人民币|预算|经费|花费|费用|准备|打算|计划|安排|行程)/i.test(s)) return false;
  if (/[A-Za-z]/.test(s) && /[\u4e00-\u9fff]/.test(s)) return false;
  if (/^[A-Za-z]+$/.test(s) && s.length <= 2) return false;
  if (/^(?:更|比较|稍微|尽量|优先|最好)?\s*(?:慢|快|轻松|悠闲|休闲|紧凑|宽松|松弛|舒服|舒适|放松|赶)\s*(?:一点|一些)?(?:也可以|也行)?$/i.test(s)) {
    return false;
  }
  if (/(妈妈|爸爸|父母|家人|老人|孩子|娃|可以)/.test(s)) return false;
  if (/(多住一点|少住一点|多待一点|少待一点|压缩一些|都保留|不用单独算|还是问题|先别塞满|别塞满)/.test(s)) return false;
  if (/(一个人|两个人|三个人|[0-9一二三四五六七八九十两]{1,2}个?人|独自|单人|全家|一家)/i.test(s)) return false;
  if (/^(?:我|我们)(?:去)?/.test(s)) return false;
  if (/(其中|其中有|其余|其他时候|海地区|该地区)/.test(s)) return false;
  if (/(作为.*(?:中转|过渡)|(?:都|也)?不会|语言|法语|阿拉伯语|西语|葡语|英语)/i.test(s)) return false;
  if (/基地$/.test(s)) return false;
  if (s.endsWith("地区") && s.length <= 4) return false;
  if (/^(现场|现场观看|现场观赛|观看|观赏)$/.test(s)) return false;
  if (/(现场观看|现场观赛|现场看|去现场|到现场|去.*观看|看.*现场)$/.test(s)) return false;
  if (/(参加|参会|开会|会议|玩|旅游|旅行|度假|计划|安排)$/i.test(s)) return false;
  if (/(看|观).{0,4}(球|赛|比赛|演出|展)|球迷|演唱会|音乐会|球票|门票/i.test(s)) return false;
  if (/(西班牙语地区|英语地区|法语地区|德语地区|语地区)/i.test(s)) return false;
  if (/^(更|比较|尽量|优先|最好|稍微)?\s*(安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安|人少|离中心近|靠近中心)$/i.test(s)) {
    return false;
  }
  if (/^(安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安|人少|近一点|远一点)/i.test(s) && s.length <= 8) {
    return false;
  }
  if (
    /(安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安|人少|离.*近|靠近|附近).{0,10}(地方|位置|区域)/i.test(s)
  ) {
    return false;
  }
  if (/(不出事|稳妥|安全感|别出事|不冒险|低风险|风险低|保险一点|保守一点)/i.test(s)) return false;
  if (/^(更|比较|稍微|尽量|优先|最好)?\s*(安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安).*/i.test(s)) {
    return false;
  }
  if (/地方(吧|呢|呀|啊)?$/i.test(s) && s.length <= 10) return false;
  if (
    /心脏|母亲|父亲|父母|家人|我们一家|一起|预算|人数|行程|计划|注意|高强度|旅行时|旅游时|需要|限制|不能|安排|在此之前|此前|之前|之后|然后|再从|我会|我要|参会|参加|开会|会议|飞到|出发|机场|航班|汇报|论文|报告|顺带|顺便|顺路|顺道/i.test(
      s
    )
  ) {
    return false;
  }
  if (/^(?:比较|更|稍微|尽量|优先|最好)?\s*(?:好|安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安)(?:一点)?$/i.test(s)) {
    return false;
  }
  if (/(比较好|更好|好一点|安全一点|安静一点|方便一点|便宜一点|舒适一点|清净一点|稳妥一点)/i.test(s)) {
    return false;
  }
  return true;
}

function expandCompoundDestinations(raw: string): string[] {
  const text = cleanStatement(raw, 80);
  if (!text) return [];
  const parts = text
    .split(/(?:和|与|及|加|、|,|，)/)
    .map((x) => normalizeDestination(x))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part || seen.has(part) || !isLikelyDestinationCandidate(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

export function extractRemovedDestinations(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    for (const city of expandCompoundDestinations(raw)) {
      if (!out.includes(city)) out.push(city);
    }
    const single = normalizeDestination(raw);
    if (single && isLikelyDestinationCandidate(single) && !out.includes(single)) out.push(single);
  };

  const patterns = [
    /([A-Za-z\u4e00-\u9fff]{2,16}?)(?=\s*(?:先)?(?:完全)?(?:去掉|删掉|移除|去除|先不要|不要去|不去|不考虑|排除))/gi,
    /(?:先)?(?:完全)?(?:去掉|删掉|移除|去除|不要去|不去|不考虑|排除)\s*([A-Za-z\u4e00-\u9fff]{2,16})/gi,
    /别把\s*([A-Za-z\u4e00-\u9fff]{2,16})\s*(?:再)?加回来/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const raw = String(m[1] || "").trim();
      if (!raw) continue;
      add(raw);
    }
  }
  return out.slice(0, 6);
}

function extractDestinationList(text: string): Array<{ city: string; evidence: string; index: number }> {
  const out: Array<{ city: string; evidence: string; index: number }> = [];
  const scanText = text.replace(
    /在此之前|在此之后|此前|此后|之前|之后|然后|再从|再去|再到|(前|后)\s*[0-9一二三四五六七八九十两]{1,2}\s*天/g,
    (m) => "，".repeat(m.length)
  );
  const push = (raw: string, evidence: string, index: number) => {
    const expanded = expandCompoundDestinations(raw);
    if (expanded.length >= 2) {
      for (const city of expanded) {
        out.push({
          city,
          evidence: cleanStatement(evidence || raw, 30),
          index,
        });
      }
      return;
    }
    const city = normalizeDestination(raw);
    if (!isLikelyDestinationCandidate(city)) return;
    out.push({
      city,
      evidence: cleanStatement(evidence || raw, 30),
      index,
    });
  };

  const routeRe =
    /从\s*([A-Za-z\u4e00-\u9fff]{2,20})[^\n。；;，,]{0,10}?(?:飞|出发|前往|去|到)?[^\n。；;，,]{0,3}?到\s*([A-Za-z\u4e00-\u9fff]{2,20})/gi;
  for (const m of scanText.matchAll(routeRe)) {
    if (!m?.[2]) continue;
    push(m[2], m[0] || m[2], Number(m.index) || 0);
  }

  const goRe =
    /(?:去|到|前往|飞到|抵达|经过|途经|经停|经由)\s*([A-Za-z\u4e00-\u9fff]{2,14}?)(?=[0-9一二三四五六七八九十两]{1,3}\s*天|之前|之后|参加|参会|开会|会议|玩|旅游|旅行|度假|逛|游|[，。,；;！!？?\s]|$)/gi;
  for (const m of scanText.matchAll(goRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const viaRe =
    /(?:经过|途经|经停|经由)\s*([A-Za-z\u4e00-\u9fff]{2,14})(?=[，。,；;！!？?\s]|$)/gi;
  for (const m of scanText.matchAll(viaRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const visitRe = /(?:逛|游览|游玩|探索|体验)\s*(?:一逛|一下|一圈|一遍)?\s*([A-Za-z\u4e00-\u9fff]{2,14})(?:这座城市|这座城|城市|城)?/gi;
  for (const m of scanText.matchAll(visitRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const atMeetingRe = /(?:在|于)\s*([A-Za-z\u4e00-\u9fff]{2,20})\s*(?:参加|参会|开会|办会|召开)/gi;
  for (const m of scanText.matchAll(atMeetingRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const transitRe =
    /([A-Za-z\u4e00-\u9fff]{2,16}?)(?=\s*(?:可以|可)?作为(?:落地)?(?:中转|过渡|转机))\s*(?:可以|可)?作为(?:落地)?(?:中转|过渡|转机)/gi;
  for (const m of scanText.matchAll(transitRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[0] || m[1], Number(m.index) || 0);
  }

  const pairRe =
    /(?:去|到|在|前往|飞到|抵达|安排|规划|计划)\s*([^\s，。,；;！!？?\d]{2,16})\s*(?:和|与|及|、|,|，)\s*([^\s，。,；;！!？?\d]{2,16})(?:旅游|旅行|出行|玩|度假|开会|会议|chi|conference|$)/gi;
  for (const m of scanText.matchAll(pairRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    push(m[1], m[1], idx);
    push(m[2], m[2], idx + String(m[1]).length + 1);
  }

  const preferencePairRe =
    /(?:想去|想安排|安排|规划|计划|优先|先以|以|先按|按)\s*([^\s，。,；;！!？?\d]{2,16})\s*(?:和|与|及|加|、|,|，)\s*([^\s，。,；;！!？?\d]{2,16})(?=[0-9一二三四五六七八九十两]{0,3}\s*(?:天|晚|夜)?|[，。,；;！!？?\s]|$)/gi;
  for (const m of scanText.matchAll(preferencePairRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    push(m[1], m[0] || m[1], idx);
    push(m[2], m[0] || m[2], idx + String(m[1]).length + 1);
  }

  const trailingPreferencePairRe =
    /([^\s，。,；;！!？?\d]{2,16})\s*(?:和|与|及|加|、|,|，)\s*([^\s，。,；;！!？?\d]{2,16})\s*(?:优先|为主|重点|首选)(?=[，。,；;！!？?\s]|$)/gi;
  for (const m of scanText.matchAll(trailingPreferencePairRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    push(m[1], m[0] || m[1], idx);
    push(m[2], m[0] || m[2], idx + String(m[1]).length + 1);
  }

  const lodgingFocusRe =
    /([A-Za-z\u4e00-\u9fff]{2,14})\s*(?:多住一点|住久一点|多待一点|多留一点|重点住|优先住|主要住)(?:也可以|也行)?(?=[，。,；;！!？?\s]|$)/gi;
  for (const m of scanText.matchAll(lodgingFocusRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[0] || m[1], Number(m.index) || 0);
  }

  const seen = new Set<string>();
  const dedup = out
    .sort((a, b) => a.index - b.index)
    .filter((x) => {
      const key = normalizeDestination(x.city);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return dedup.slice(0, 4);
}

function isCompoundTripEnvelopeDuration(snippet: string, city: string): boolean {
  const s = cleanStatement(snippet, 120);
  const normalizedCity = normalizeDestination(city);
  if (!s || !normalizedCity) return false;
  const pair = s.match(
    /([A-Za-z\u4e00-\u9fff]{2,16})\s*(?:和|与|及|加|、|,|，)\s*([A-Za-z\u4e00-\u9fff]{2,16})\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:天|晚|夜)(?!上)/i
  );
  if (!pair?.[1] || !pair?.[2]) return false;
  const left = normalizeDestination(pair[1]);
  const right = normalizeDestination(pair[2]);
  if (!left || !right) return false;
  if (!isLikelyDestinationCandidate(left) || !isLikelyDestinationCandidate(right)) return false;
  if (normalizedCity !== left && normalizedCity !== right) return false;
  return /(?:想去|想安排|安排|规划|计划|旅行|旅游|出行|行程|玩|度假|整体|全程|总共|一共)/i.test(s);
}

function extractCityDurationSegments(
  text: string,
  locale?: AppLocale
): Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }> {
  const out: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }> = [];
  const scanText = text.replace(
    /在此之前|在此之后|此前|此后|之前|之后|然后|再从|再去|再到|(前|后)\s*[0-9一二三四五六七八九十两]{1,2}\s*天/g,
    (m) => "，".repeat(m.length)
  )
    .replace(
      /(^|[，。,；;！!？?\s])(?:那就先按|那就按|就按|按)\s*(?=[A-Za-z\u4e00-\u9fff]{2,14}\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:天|晚|夜)(?!上))/g,
      "$1"
    )
    .replace(
      /(天|晚|夜)(?!上)\s*(?:再加|外加|另加|加|和|与|及|再)\s*(?=[A-Za-z\u4e00-\u9fff]{2,14}\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:天|晚|夜)(?!上))/g,
      "$1，"
    );
  const hasRelativeDayOffset = (snippet: string, city: string) => {
    const s = cleanStatement(snippet, 120);
    if (!s || !city) return false;
    const cityEsc = escapeRegExp(city);
    const directRel = new RegExp(
      `(?:在|于|到|去|飞到|抵达)?\\s*${cityEsc}\\s*(?:前|后)\\s*[0-9一二三四五六七八九十两]{1,2}\\s*天`,
      "i"
    );
    if (directRel.test(s)) return true;
    if (
      /(在去|去|到|飞到|抵达).{0,16}(之前|之前会|之前先|之前再|前面|此前)/.test(s) &&
      /(前|后)\s*[0-9一二三四五六七八九十两]{1,2}\s*天/.test(s)
    ) {
      return true;
    }
    return false;
  };

  const travelHintRe =
    /(?:在|于|到|去|飞到|抵达|经过|途经|经停|经由)\s*([A-Za-z\u4e00-\u9fff]{2,16}?)(?=(?:玩|逛|停留|待|旅行|旅游|参会|开会|参加|住|[，。,；;！!？?\s]))\s*(?:玩|逛|停留|待|旅行|旅游|参会|开会|参加|住)?\s*([0-9一二三四五六七八九十两]{1,3})\s*(天|晚|夜)(?!上)/gi;
  for (const m of scanText.matchAll(travelHintRe)) {
    const city = normalizeDestination(m?.[1] || "");
    const days = parseCnInt(m?.[2] || "");
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    if (/^(所以|因此|然后|另外|此外|这|那|此次|本次)/.test(city)) continue;
    const idx = Number(m.index) || 0;
    const snippet = cleanStatement(m[0] || `${city} ${formatDayCount(locale, days)}`, 80);
    if (hasRelativeDayOffset(snippet, city)) continue;
    if (hasHardDayReservationSignal(snippet) && days <= 2) continue;
    if (isCompoundTripEnvelopeDuration(snippet, city)) continue;
    const kind: "travel" | "meeting" =
      /(会议|开会|chi|conference|workshop|论坛|参会)/i.test(snippet) ? "meeting" : "travel";
    out.push({
      city,
      days,
      evidence: cleanStatement(snippet, 50),
      kind,
      index: idx,
    });
  }

  const re =
    /(?:^|[，。、；;！!？?\s])(?:在|于|到|去|飞到|抵达|前往|经过|途经|经停|经由)?\s*([^\s，。、；;！!？?\d]{2,14})(?:\s*(?:停留|待|玩|逛|旅行|旅游|参会|开会|参加|住))?[^\n。；;，,]{0,6}?([0-9一二三四五六七八九十两]{1,3})\s*(天|晚|夜)(?!上)/g;
  for (const m of scanText.matchAll(re)) {
    const rawCity = m?.[1] || "";
    const rawDays = m?.[2] || "";
    const city = normalizeDestination(rawCity);
    const days = parseCnInt(rawDays);
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    if (/^(所以|因此|然后|另外|此外|这|那|此次|本次)/.test(city)) continue;
    if (DESTINATION_NOISE_RE.test(city) || PLACE_STOPWORD_RE.test(city)) continue;

    const idx = Number(m.index) || 0;
    const right = Math.min(scanText.length, idx + String(m[0] || "").length + 26);
    const ctx = cleanStatement(scanText.slice(idx, right), 80);
    if (hasRelativeDayOffset(ctx, city)) continue;
    if (hasHardDayReservationSignal(ctx) && days <= 2) continue;
    if (isCompoundTripEnvelopeDuration(ctx, city)) continue;
    const kind: "travel" | "meeting" =
      /(会议|开会|chi|conference|workshop|论坛)/i.test(ctx) ? "meeting" : "travel";

    out.push({
      city,
      days,
      evidence: cleanStatement(m[0] || `${city} ${formatDayCount(locale, days)}`, 50),
      kind,
      index: idx,
    });
  }

  const bareListRe =
    /(?:^|[，。、；;！!？?\s])(?:那就先以|那就先按|那就按|先以|以|先按|按)?\s*([A-Za-z\u4e00-\u9fff]{2,16})\s*([0-9一二三四五六七八九十两]{1,3})\s*(天|晚|夜)(?!上)/gi;
  for (const m of scanText.matchAll(bareListRe)) {
    const city = normalizeDestination(m?.[1] || "");
    const days = parseCnInt(m?.[2] || "");
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(m[0] || `${city} ${formatDayCount(locale, days)}`, 60);
    out.push({
      city,
      days,
      evidence: ctx,
      kind: "travel",
      index: idx,
    });
  }

  const rangeRe =
    /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*(?:([0-9]{1,2})月)?([0-9]{1,2})日?[^\n。；;]{0,28}?(?:去|到|在|飞到)\s*([A-Za-z\u4e00-\u9fff]{2,20}?)(?=参加|参会|开会|会议|玩|旅游|旅行|度假|[，。,；;！!？?\s]|$)[^\n。；;]{0,20}?(参加|参会|开会|会议|chi|conference|workshop|玩|旅游|旅行|度假)?/gi;
  for (const m of scanText.matchAll(rangeRe)) {
    const monthA = Number(m[1]);
    const startDay = Number(m[2]);
    const monthB = Number(m[3]) || monthA;
    const endDay = Number(m[4]);
    const city = normalizeDestination(m[5] || "");
    if (!Number.isFinite(monthA) || !Number.isFinite(startDay) || !Number.isFinite(monthB) || !Number.isFinite(endDay)) continue;
    if (!city || !isLikelyDestinationCandidate(city)) continue;
    const action = String(m[6] || "");
    const ctx = cleanStatement(
      scanText.slice(
        Math.max(0, (Number(m.index) || 0) - 12),
        Math.min(scanText.length, (Number(m.index) || 0) + String(m[0] || "").length + 44)
      ),
      120
    );
    const kind: "travel" | "meeting" =
      /(参加|参会|开会|会议|chi|conference|workshop)/i.test(action) ? "meeting" : "travel";
    const days = calcRangeDays(monthA, startDay, monthB, endDay, {
      mode: getDateRangeBoundaryMode(),
      context: ctx,
      isMeetingLike: kind === "meeting",
      hintedDays: extractExplicitDurationHints(ctx),
    });
    if (days <= 0 || days > 31) continue;
    out.push({
      city,
      days,
      evidence: cleanStatement(m[0] || `${city} ${formatDayCount(locale, days)}`, 52),
      kind,
      index: Number(m.index) || 0,
    });
  }

  const cityMentions = Array.from(
    scanText.matchAll(
      /(?:在|于|去|到|飞到|抵达|经过|途经|经停|经由)\s*([A-Za-z\u4e00-\u9fff]{2,14}?)(?=玩|逛|停留|待|旅行|旅游|参会|开会|参加|[，。,；;！!？?\s（(]|$)/gi
    )
  )
    .map((m) => {
      const city = normalizeDestination(m?.[1] || "");
      const idx = Number(m.index) || 0;
      if (!city || !isLikelyDestinationCandidate(city)) return null;
      return { city, index: idx };
    })
    .filter((x): x is { city: string; index: number } => !!x);
  if (cityMentions.length) {
    const fallbackDuration = extractDurationCandidates(scanText)
      .filter((x) => x.days > 0 && x.days <= 30 && (x.kind === "segment" || x.kind === "meeting" || x.kind === "unknown"))
      .sort((a, b) => a.index - b.index);
    for (const d of fallbackDuration) {
      const ctx = cleanStatement(
        scanText.slice(Math.max(0, d.index - 28), Math.min(scanText.length, d.index + 34)),
        100
      );
      if (hasHardDayReservationSignal(ctx) && d.days <= 2) continue;
      let nearest: { city: string; index: number } | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of cityMentions) {
        const dist = d.index - c.index;
        if (dist < 0 || dist > 42) continue;
        if (dist < bestDist) {
          bestDist = dist;
          nearest = c;
        }
      }
      if (!nearest) continue;
      if (hasRelativeDayOffset(ctx, nearest.city)) continue;
      out.push({
        city: nearest.city,
        days: d.days,
        evidence: cleanStatement(`${nearest.city} ${formatDayCount(locale, d.days)}`, 50),
        kind: d.kind === "meeting" ? "meeting" : "travel",
        index: d.index,
      });
    }
  }

  const bestByCity = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }>();
  for (const x of out) {
    const cur = bestByCity.get(x.city);
    const shouldReplace =
      !cur ||
      x.days > cur.days ||
      (x.days === cur.days && x.kind === "meeting" && cur.kind !== "meeting");
    if (shouldReplace) bestByCity.set(x.city, x);
  }
  return Array.from(bestByCity.values()).sort((a, b) => a.index - b.index).slice(0, 6);
}

function dedupeCityDurationSegments(
  list: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index?: number }>,
  locale?: AppLocale
): Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }> {
  const map = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }>();
  for (const seg of list || []) {
    const city = normalizeDestination(seg?.city || "");
    const days = Number(seg?.days) || 0;
    if (!city || !isLikelyDestinationCandidate(city) || days <= 0 || days > 60) continue;
    const key = city.toLowerCase();
    const cand = {
      city,
      days,
      evidence: cleanStatement(seg?.evidence || `${city} ${formatDayCount(locale, days)}`, 60),
      kind: seg?.kind === "meeting" ? "meeting" : "travel",
      index: Number(seg?.index) || 0,
    };
    const cur = map.get(key);
    const shouldReplace =
      !cur ||
      cand.days > cur.days ||
      (cand.days === cur.days && cand.kind === "meeting" && cur.kind !== "meeting") ||
      (cand.days === cur.days && cand.kind === cur.kind && cand.index < cur.index);
    if (shouldReplace) map.set(key, cand);
  }
  return Array.from(map.values())
    .sort((a, b) => a.index - b.index || a.city.localeCompare(b.city))
    .slice(0, 6);
}

export function isTravelIntentText(text: string, signals: IntentSignals) {
  if (signals.destination || signals.durationDays || signals.budgetCny || signals.peopleCount) return true;
  return /旅游|旅行|出行|行程|景点|酒店|攻略|目的地|去|玩/i.test(String(text || ""));
}

export function buildTravelIntentStatement(
  signals: IntentSignals,
  userText: string,
  locale?: AppLocale
): string | null {
  if (!isTravelIntentText(userText, signals)) return null;

  const subLocationNames = new Set(
    (signals.subLocations || [])
      .map((x) => normalizeDestination(x.name || ""))
      .filter(Boolean)
  );
  const alignedDestinations = (signals.destinations || [])
    .map((x, index) => ({
      city: normalizeDestination(x),
      evidence: cleanStatement(signals.destinationEvidences?.[index] || "", 60),
    }))
    .filter(({ city }) => {
      const x = city;
      if (!x || !isLikelyDestinationCandidate(x)) return false;
      if (subLocationNames.has(x)) return false;
      for (const sub of subLocationNames) {
        if (!sub || sub.length < 2) continue;
        if (x.includes(sub)) return false;
      }
      return true;
    });
  const destinations = alignedDestinations.map((x) => x.city);
  const normalizedPrimary = normalizeDestination(signals.destination || "");
  const primaryDestination =
    normalizedPrimary &&
    isLikelyDestinationCandidate(normalizedPrimary) &&
    !subLocationNames.has(normalizedPrimary) &&
    !Array.from(subLocationNames).some((sub) => sub && sub.length >= 2 && normalizedPrimary.includes(sub))
      ? normalizedPrimary
      : "";
  const en = isEnglishLocale(locale);
  const goalDestinations =
    destinations.length >= 2
      ? (() => {
          const firstEvidence = alignedDestinations[0]?.evidence;
          if (firstEvidence) {
            const primaryCluster = alignedDestinations
              .filter((x) => x.evidence === firstEvidence)
              .map((x) => x.city);
            if (primaryCluster.length >= 2) return primaryCluster.slice(0, 3);
          }
          if (primaryDestination && destinations.includes(primaryDestination)) {
            return [primaryDestination, ...destinations.filter((x) => x !== primaryDestination)].slice(0, 3);
          }
          return destinations.slice(0, 3);
        })()
      : [primaryDestination || destinations[0] || ""].filter(Boolean);
  const destinationPhrase =
    goalDestinations.length >= 2
      ? en
        ? goalDestinations.join(" and ")
        : goalDestinations.join("和")
      : primaryDestination || destinations[0] || "";

  if (destinationPhrase && signals.durationDays) {
    return en
      ? `Intent: travel to ${destinationPhrase} for ${signals.durationDays} days`
      : `意图：去${destinationPhrase}旅游${signals.durationDays}天`;
  }
  if (destinationPhrase) {
    return en ? `Intent: travel to ${destinationPhrase}` : `意图：去${destinationPhrase}旅游`;
  }
  if (signals.durationDays) {
    return en
      ? `Intent: create a ${signals.durationDays}-day travel plan`
      : `意图：制定${signals.durationDays}天旅行计划`;
  }
  return en ? "Intent: create a travel plan" : "意图：制定旅行计划";
}

export function hasHardDayReservationSignal(text: string): boolean {
  const s = cleanStatement(text, 160);
  if (!s) return false;
  const hasDay = /(一天|1天|一日|1日|[0-9一二三四五六七八九十两]{1,2}\s*天)/.test(s);
  const hasForce = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s) || HARD_DAY_FORCE_RE.test(s);
  const hasAction = HARD_DAY_ACTION_RE.test(s) || CRITICAL_PRESENTATION_RE.test(s);
  return hasDay && hasForce && hasAction;
}

export function normalizePreferenceStatement(raw: string, locale?: AppLocale) {
  const s = cleanStatement(raw, 160);
  if (!s) return null;

  const hasCulture = CULTURE_PREF_RE.test(s);
  const hasNature = NATURE_TOPIC_RE.test(s);
  const dislikeNature = hasNature && /不感兴趣|不喜欢|避免|不要|不能|厌恶/.test(s);
  if (!hasCulture && !dislikeNature) return null;
  if (!PREFERENCE_MARKER_RE.test(s) && !HARD_REQUIRE_RE.test(s) && !HARD_CONSTRAINT_RE.test(s)) return null;

  const hard = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s);
  const en = isEnglishLocale(locale);
  const statement =
    hasCulture && dislikeNature
      ? en
        ? "Scenic preference: prioritize cultural/human attractions and reduce pure nature-only spots"
        : "景点偏好：优先人文景观，减少纯自然景观"
      : hasCulture
        ? en
          ? "Scenic preference: cultural attractions first"
          : "景点偏好：人文景观优先"
        : en
          ? "Scenic preference: avoid pure nature-only attractions when possible"
          : "景点偏好：尽量避免纯自然景观";
  return {
    statement,
    hard,
    evidence: s,
  };
}

export function normalizeLodgingPreferenceStatement(raw: string, locale?: AppLocale) {
  const s = cleanStatement(raw, 160);
  if (!s) return null;
  const hasLodging =
    /酒店|民宿|住宿|房型|星级|房费|住在|入住|住全程|全程住|酒店标准/i.test(s);
  const hasPreferenceCue =
    /想住|住在|入住|选择|优先|偏好|希望|住全程|全程住|酒店标准|星级|房型|靠近|附近|离.*近|步行可达|交通方便/i.test(
      s
    );
  const isExpenseOnly =
    /(花了|花费|用了|消费|支出|支付|付了|预算|价格|多少钱|费用|开销|花销)/i.test(s) &&
    !hasPreferenceCue;
  if (!hasLodging) return null;
  if (isExpenseOnly) return null;
  const hard = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s);
  const en = isEnglishLocale(locale);
  const safetyOrArea =
    SAFETY_STRATEGY_RE.test(s) ||
    /住市中心|市中心|中心区域|核心区|区域安全|安全区域|治安更好|更安全/i.test(s);
  const transportConvenience =
    TRANSPORT_CONVENIENCE_RE.test(s) ||
    /交通方便|交通便利|离地铁近|靠近地铁|地铁站附近|步行可达|少换乘|换乘少|出行方便/i.test(s);
  const quietBalance =
    /安静|清净|不吵|宁静/i.test(s) && /不要太封闭|别太封闭|不要封闭|不封闭|别太偏|不要太偏/i.test(s);

  if (/(五星|5星|豪华|高端)/i.test(s)) {
    return {
      statement: en ? "Lodging preference: prioritize high-star hotels for the whole trip" : "住宿偏好：全程高星级酒店优先",
      hard,
      evidence: s,
    };
  }
  if (/(经济型|省钱|便宜|青年旅舍|青旅)/i.test(s)) {
    return {
      statement: en ? "Lodging preference: prioritize budget accommodation" : "住宿偏好：优先经济型住宿",
      hard,
      evidence: s,
    };
  }
  if (safetyOrArea && transportConvenience) {
    return {
      statement: en
        ? "Lodging preference: prioritize safer central areas with convenient transit access"
        : "住宿偏好：优先安全且交通便利的市中心区域",
      hard,
      evidence: s,
    };
  }
  if (safetyOrArea) {
    return {
      statement: en
        ? "Lodging preference: prioritize safer areas"
        : "住宿偏好：优先治安更好的区域",
      hard,
      evidence: s,
    };
  }
  if (transportConvenience) {
    return {
      statement: en
        ? "Lodging preference: prioritize transport-convenient locations near metro/walkable hubs"
        : "住宿偏好：优先交通便利、靠近地铁或步行可达",
      hard,
      evidence: s,
    };
  }
  if (quietBalance) {
    return {
      statement: en
        ? "Lodging preference: quiet environment without being too isolated"
        : "住宿偏好：安静但不要太封闭",
      hard,
      evidence: s,
    };
  }
  return {
    statement: en ? "Lodging preference: must satisfy specified lodging standards" : "住宿偏好：需满足指定住宿标准",
    hard,
    evidence: s,
  };
}

function normalizeActivityPreferenceStatement(raw: string, locale?: AppLocale) {
  const s = cleanStatement(raw, 180);
  if (!s) return null;
  const hasSports = /球迷|看球|观赛|比赛|球赛|主场|客场|德比|门票|球票|足球|篮球|赛事/i.test(s);
  const hasEvent = /演唱会|音乐会|演出|展览|看展|live\s*show|concert|match|game/i.test(s);
  const hasLowIntensity = HEALTH_STRATEGY_ACTIVITY_RE.test(s);
  if (!hasSports && !hasEvent && !hasLowIntensity) return null;
  if (
    !HARD_REQUIRE_RE.test(s) &&
    !HARD_CONSTRAINT_RE.test(s) &&
    !/喜欢|偏好|热爱|粉丝|球迷|想看|一定要|必须|务必|绝对|希望|尽量|减少|选择|采用|低强度|轻松|避免|不要|不能|不宜/i.test(
      s
    )
  ) {
    return null;
  }
  const hard =
    HARD_REQUIRE_RE.test(s) ||
    HARD_CONSTRAINT_RE.test(s) ||
    (hasLowIntensity && /必须|务必|避免|不要|不能|不宜|只/i.test(s));
  const normalizeTeamName = (x: string) =>
    cleanStatement(x || "", 24)
      .replace(/^(?:我是|我|一个|一名|个|位)+\s*/i, "")
      .replace(/^(的|最喜欢|最爱|支持的)\s*/i, "")
      .replace(/(球队|俱乐部)$/i, "")
      .trim();
  const teamRaw =
    s.match(/([A-Za-z][A-Za-z0-9\s._-]{1,24})\s*(?:球迷|粉丝)/i)?.[1] ||
    s.match(/([\u4e00-\u9fffA-Za-z]{2,16})\s*(?:球迷|粉丝|主队)/i)?.[1] ||
    "";
  const team = normalizeTeamName(teamRaw);
  const en = isEnglishLocale(locale);
  const statement = hasLowIntensity
    ? en
      ? "Activity preference: low-intensity itinerary with reduced exertion"
      : "活动偏好：低强度行程，减少体力负担"
    : hasSports
    ? team
      ? en
        ? `Activity preference: prioritize ${cleanStatement(team, 20)} related matches`
        : `活动偏好：${cleanStatement(team, 20)}相关赛事优先`
      : en
        ? "Activity preference: prioritize sports events"
        : "活动偏好：体育赛事优先"
    : en
      ? "Activity preference: prioritize live performances and exhibitions"
      : "活动偏好：演出展览优先";
  return {
    statement,
    hard,
    evidence: s,
  };
}

function clampImportance(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function mergeImportanceMap(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (!k) continue;
      out[k] = Math.max(out[k] || 0, clampImportance(v, 0.72));
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function constraintClauses(userText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of sentenceParts(userText)) {
    for (const raw of String(part || "").split(/[，,、]/)) {
      const clause = cleanStatement(raw, 120);
      if (!clause || seen.has(clause)) continue;
      seen.add(clause);
      out.push(clause);
    }
  }
  return out.length ? out : sentenceParts(userText);
}

export function pickHealthClause(userText: string): string | undefined {
  const parts = constraintClauses(userText);
  const hit = parts.find((x) => MEDICAL_HEALTH_RE.test(x));
  return hit || undefined;
}

export function pickLanguageConstraintClause(userText: string): string | undefined {
  const parts = constraintClauses(userText);
  const patterns = [
    /((?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文|当地语言)(?:和|与|及|、|,|，)?(?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文|当地语言)?(?:都不会|都不懂|不会|不懂|不太会|不太懂|不好))/i,
    /((?:不会|不懂|不太会|不太懂)[^，。；;\n]{0,18}(?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文|当地语言))/i,
    /((?:语言不通|语言障碍|沟通困难)[^，。；;\n]{0,18})/i,
  ];
  for (const part of parts) {
    if (!LANGUAGE_CONSTRAINT_RE.test(part)) continue;
    let snippet = part;
    for (const re of patterns) {
      const m = part.match(re);
      if (m?.[1]) {
        snippet = m[1];
        break;
      }
    }
    snippet = cleanStatement(snippet, 60)
      .replace(/^(?:另外|再就是|还有|而且|并且|同时|希望|最好|尽量)\s*/i, "")
      .trim();
    if (snippet) return snippet;
  }
  return undefined;
}

function isLanguageOnlyConstraint(text: string | undefined): boolean {
  const s = cleanStatement(text || "", 120);
  if (!s) return false;
  return LANGUAGE_CONSTRAINT_RE.test(s) && !MEDICAL_HEALTH_RE.test(s);
}

function isVenueOrExperienceRequirement(text: string): boolean {
  const s = cleanStatement(text || "", 120);
  if (!s) return false;
  const hasExperienceCue =
    /球迷|看球|观赛|比赛|球赛|主场|客场|门票|球票|圣西罗|stadium|arena|演唱会|音乐会|演出|展览|看展|concert|match|game/i.test(
      s
    );
  const hasRiskCue =
    MEDICAL_HEALTH_RE.test(s) ||
    LANGUAGE_CONSTRAINT_RE.test(s) ||
    /签证|护照|入境|法律|治安|安全|危险|急救|宗教|礼拜|清真|过敏|忌口|饮食/i.test(s);
  return hasExperienceCue && !hasRiskCue;
}

function hasConstraintDeclarationCue(text: string): boolean {
  const s = cleanStatement(text || "", 160);
  if (!s) return false;
  return /^(?:限制因素|limiting factor|constraint)[:：]/i.test(s);
}

function hasExplicitConstraintNegationCue(text: string): boolean {
  const s = cleanStatement(text || "", 160);
  if (!s) return false;
  if (/请确认|是否|是不是|不确定|不知道|吗[？?]?$/i.test(s)) return false;
  if (/(?:不要|不能|不可|不得|别再?|勿|避免|禁止|取消|去掉|不用|无需|不再|不必|不想)\s*[^\s，。,；;！!？?]{1,20}/i.test(s)) {
    return true;
  }
  if (
    hasStandaloneChineseNegation(s) &&
    /(?:坐|住|去|乘|搭|选|用|安排|计划|考虑|包含|参加|看|玩|带|吃|喝|买|订|book|take|go|stay|use|choose|include)/i.test(
      s
    )
  ) {
    return true;
  }
  return /\b(?:don't|do not|must not|cannot|can't|avoid|without|exclude|never|no)\b/i.test(s);
}

type PreferenceAxis = "preference:scenic" | "preference:lodging" | "preference:activity";
type GenericConstraintPolarity = "positive" | "negative" | "neutral";

type NormalizedGenericConstraint = {
  text: string;
  evidence: string;
  kind: GenericConstraintKind;
  hard: boolean;
  severity?: "medium" | "high" | "critical";
  importance: number;
  polarity: GenericConstraintPolarity;
  axisKey: string;
};

const NEGATIVE_PREFIX_RE =
  /(?:不要|不能|不可|不得|别再?|勿|避免|禁止|禁用|排除|取消|去掉|不用|无需|不再|不必|不想|must not|do not|don't|cannot|can't|avoid|without|exclude|never|no)/gi;
const POSITIVE_PREFIX_RE =
  /(?:必须|务必|一定|需要|要|应当|应该|优先|尽量|最好|must|need|should|prefer|required|include|with)/gi;
const NON_NEGATION_IDIOM_RE = /(?:不但|不光|不仅|不止|不得不|不少|不错|不一定|不太|不够)/i;
const LEADING_NOISE_RE =
  /^(?:我|我们|希望|想|要|需要|必须|务必|一定|请|尽量|最好|优先|一般|通常|可能|也许|先|再|然后|另外|顺便|好的?|好吧|行吧|行|那就|嗯|哦|收到|ok(?:ay)?|alright|限制因素|limiting|factor|constraint)+/i;
const AXIS_STOPWORDS = new Set([
  "限制因素",
  "limiting",
  "factor",
  "constraint",
  "constraints",
  "requirement",
  "requirements",
  "trip",
  "travel",
  "plan",
  "itinerary",
  "please",
  "want",
  "need",
  "must",
  "should",
  "prefer",
  "and",
  "or",
  "the",
  "a",
  "to",
  "好",
  "好的",
  "好吧",
  "行",
  "行吧",
  "那就",
  "嗯",
  "哦",
  "收到",
  "ok",
  "okay",
  "alright",
  "喜欢",
  "喜歡",
  "prefer",
  "like",
]);

const SCENIC_PREF_NEGATION_RE =
  /(?:不喜欢|不想|不要|不再|不考虑|取消|去掉|避免|stop|don't|do not|avoid|no longer)[^，。；;\n]{0,12}(?:人文|文化|景点|自然|徒步|博物馆|展览|scenic|attraction|culture|nature)/i;
const LODGING_PREF_NEGATION_RE =
  /(?:不住|不要|不要住|不想|不想住|不再|不再住|不考虑|不考虑住|不选|取消|去掉|avoid|don't|do not|no longer)[^，。；;\n]{0,14}(?:酒店|民宿|住宿|房型|星级|高星|青旅|hotel|lodging|accommodation)/i;
const ACTIVITY_PREF_NEGATION_RE =
  /(?:不看|不要看|不想看|不再看|不安排|不参加|取消|去掉|avoid|don't|do not|no longer)[^，。；;\n]{0,14}(?:球|比赛|球赛|演出|演唱会|展览|赛事|match|game|concert|show|event)/i;

function normalizeAxis(raw: string): string {
  return cleanStatement(raw || "", 80).toLowerCase();
}

function mergeAxisList(a?: string[], b?: string[]): string[] | undefined {
  const out = new Set<string>();
  for (const axis of [...(a || []), ...(b || [])]) {
    const normalized = normalizeAxis(axis);
    if (!normalized) continue;
    out.add(normalized);
  }
  return out.size ? Array.from(out).slice(0, 12) : undefined;
}

function normalizePreferenceAxis(raw: string): PreferenceAxis | null {
  const s = normalizeAxis(raw);
  if (s === "preference:scenic") return "preference:scenic";
  if (s === "preference:lodging") return "preference:lodging";
  if (s === "preference:activity") return "preference:activity";
  return null;
}

function detectPreferenceRevocationAxesFromText(raw: string): PreferenceAxis[] {
  const s = cleanStatement(raw || "", 160);
  if (!s) return [];
  const hasNegation =
    /(不喜欢|不想|不要|不能|不再|取消|去掉|避免|stop|don't|do not|must not|cannot|can't|avoid|no longer|without)/i.test(s) ||
    hasStandaloneChineseNegation(s);
  if (!hasNegation) return [];

  const out: PreferenceAxis[] = [];
  if (SCENIC_PREF_NEGATION_RE.test(s)) out.push("preference:scenic");
  if (LODGING_PREF_NEGATION_RE.test(s)) out.push("preference:lodging");
  if (ACTIVITY_PREF_NEGATION_RE.test(s)) out.push("preference:activity");
  return out;
}

function normalizeGenericConstraintKind(kind: any, text: string): GenericConstraintKind {
  const raw = cleanStatement(kind || "", 40).toLowerCase();
  const mapped =
    raw === "security" || raw === "travel_safety" || raw === "safety_risk"
      ? "safety"
      : raw === "medical"
        ? "health"
        : raw === "lang"
          ? "language"
          : raw;
  if (["legal", "safety", "mobility", "logistics", "diet", "religion", "other"].includes(mapped)) {
    return mapped as GenericConstraintKind;
  }
  const classified = classifyConstraintText({ text, evidence: text });
  if (classified?.family === "generic" && classified.kind) return classified.kind;
  return "other";
}

function hasStandaloneChineseNegation(text: string): boolean {
  if (!text.includes("不")) return false;
  if (NON_NEGATION_IDIOM_RE.test(text)) return false;
  if (/(^|[，。,；;、\s])不(?=[\u4e00-\u9fa5a-z])/i.test(text)) return true;
  return /不(?:再|坐|住|去|看|玩|选|用|买|吃|喝|带|做|安排|计划|走|乘)/i.test(text);
}

function genericConstraintPolarity(text: string): GenericConstraintPolarity {
  const s = cleanStatement(text || "", 180).toLowerCase();
  if (!s) return "neutral";
  const hasNeg =
    NEGATIVE_PREFIX_RE.test(s) ||
    hasStandaloneChineseNegation(s);
  NEGATIVE_PREFIX_RE.lastIndex = 0;
  if (hasNeg) return "negative";
  const hasPos = POSITIVE_PREFIX_RE.test(s);
  POSITIVE_PREFIX_RE.lastIndex = 0;
  if (hasPos) return "positive";
  return "neutral";
}

function normalizeConstraintAxisText(text: string): string {
  let s = cleanStatement(text || "", 200).toLowerCase();
  if (!s) return "";
  s = s.replace(/^限制因素[:：]?\s*/i, "").replace(/^limiting factor[:：]?\s*/i, "").trim();

  const transportAxis = (() => {
    if (/(?:船|渡轮|轮渡|ferry|boat)/i.test(s)) return "boat";
    if (/(?:地铁|捷运|metro|subway)/i.test(s)) return "metro";
    if (/(?:火车|高铁|train|rail)/i.test(s)) return "train";
    if (/(?:飞机|航班|flight|plane|air)/i.test(s)) return "flight";
    if (/(?:打车|出租车|网约车|taxi|cab)/i.test(s)) return "taxi";
    if (/(?:坐车|乘车|开车|驾车|car|drive|driving|vehicle)/i.test(s)) return "car";
    return "";
  })();
  if (transportAxis) return transportAxis;

  const normalizedChunks = s
    .split(/[。！？!?；;，,\n]/)
    .map((part) => cleanStatement(part, 120))
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/^(?:好的?|好吧|行吧|行|那就|嗯|哦|收到|ok(?:ay)?|alright)\s*/i, " ")
        .replace(NEGATIVE_PREFIX_RE, " ")
        .replace(POSITIVE_PREFIX_RE, " ")
        .replace(LEADING_NOISE_RE, " ")
        .replace(/(^|[，。,；;、\s])不(?=[\u4e00-\u9fa5a-z])/gi, "$1")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
  NEGATIVE_PREFIX_RE.lastIndex = 0;
  POSITIVE_PREFIX_RE.lastIndex = 0;

  if (!normalizedChunks.length) return "";

  const tokens = normalizedChunks
    .flatMap((part) => part.match(/[\u4e00-\u9fa5]{1,8}|[a-z0-9]{2,24}/g) || [])
    .map((token) =>
      token
        .replace(/^(?:不再|不要|不能|不可|不得|别|勿|避免|禁止|取消|去掉|不用|无需|不必|不想|不)/, "")
        .replace(/^(?:喜欢|喜歡|prefer|like)/i, "")
        .replace(/^(?:坐|乘|搭|开|驾)(?=船|车|地铁|火车|飞机)/, "")
        .replace(/(?:了|吧|呢|呀|啊)$/g, "")
        .trim()
    )
    .filter((token) => token && !AXIS_STOPWORDS.has(token));

  const uniq = Array.from(new Set(tokens)).slice(0, 5);
  return uniq.join("_");
}

function normalizeGenericConstraintItem(
  raw: NonNullable<IntentSignals["genericConstraints"]>[number]
): NormalizedGenericConstraint | null {
  const text = cleanStatement(raw?.text || "", 120);
  if (!text) return null;
  const kind = normalizeGenericConstraintKind(raw?.kind, text);
  const polarity = genericConstraintPolarity(text);
  const axisCore = normalizeConstraintAxisText(text);
  const fallbackAxis = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 36) || "factor";
  const axisKey = `${kind}:${axisCore || fallbackAxis}`;
  return {
    text,
    evidence: cleanStatement(raw?.evidence || text, 80),
    kind,
    hard: !!raw?.hard,
    severity: raw?.severity,
    importance: clampImportance(raw?.importance, raw?.hard ? 0.84 : 0.72),
    polarity,
    axisKey,
  };
}

function mergeGenericConstraints(
  a?: IntentSignals["genericConstraints"],
  b?: IntentSignals["genericConstraints"]
): IntentSignals["genericConstraints"] | undefined {
  const history = (a || [])
    .map((item) => normalizeGenericConstraintItem(item as any))
    .filter((item): item is NormalizedGenericConstraint => !!item);
  const latest = (b || [])
    .map((item) => normalizeGenericConstraintItem(item as any))
    .filter((item): item is NormalizedGenericConstraint => !!item);

  const merged: NormalizedGenericConstraint[] = [...history];

  // latest-wins on the same semantic axis:
  // when users revise or negate a previous constraint, we keep only the newest one.
  for (const cur of latest) {
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i].axisKey === cur.axisKey) merged.splice(i, 1);
    }
    merged.push(cur);
  }

  const pool = dedupeClassifiedConstraints(
    merged
      .slice()
      .reverse()
      .map((item) => ({
        text: item.text,
        evidence: item.evidence,
        kind: item.kind,
        hard: item.hard,
        severity: item.severity,
        importance: item.importance,
      }))
  ).reverse();

  const out = pool
    .filter((x) => !!x.text)
    .sort((x, y) => (Number(y.importance) || 0) - (Number(x.importance) || 0))
    .slice(0, 6);
  return out.length ? out : undefined;
}

function mergeGenericConstraintsWithRevocation(params: {
  history?: IntentSignals["genericConstraints"];
  latest?: IntentSignals["genericConstraints"];
  latestRevokedAxes?: string[];
}): { constraints?: IntentSignals["genericConstraints"]; revokedAxes?: string[] } {
  const history = (params.history || [])
    .map((item) => normalizeGenericConstraintItem(item as any))
    .filter((item): item is NormalizedGenericConstraint => !!item);
  const latest = (params.latest || [])
    .map((item) => normalizeGenericConstraintItem(item as any))
    .filter((item): item is NormalizedGenericConstraint => !!item);

  const historyAxes = new Set(history.map((item) => item.axisKey));
  const requestedRevoked = new Set((params.latestRevokedAxes || []).map((x) => normalizeAxis(x)).filter(Boolean));
  const appliedRevoked = new Set<string>();

  const merged: NormalizedGenericConstraint[] = [...history];
  for (const axis of requestedRevoked) {
    if (!historyAxes.has(axis)) continue;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i].axisKey === axis) merged.splice(i, 1);
    }
    appliedRevoked.add(axis);
  }

  for (const cur of latest) {
    const shouldRevoke =
      requestedRevoked.has(cur.axisKey) &&
      historyAxes.has(cur.axisKey) &&
      cur.polarity === "negative";
    if (shouldRevoke) {
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        if (merged[i].axisKey === cur.axisKey) merged.splice(i, 1);
      }
      appliedRevoked.add(cur.axisKey);
      continue;
    }

    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i].axisKey === cur.axisKey) merged.splice(i, 1);
    }
    merged.push(cur);
  }

  const pool = dedupeClassifiedConstraints(
    merged.map((item) => ({
      text: item.text,
      evidence: item.evidence,
      kind: item.kind,
      hard: item.hard,
      severity: item.severity,
      importance: item.importance,
    }))
  );

  const constraints = pool
    .filter((x) => !!x.text)
    .sort((x, y) => (Number(y.importance) || 0) - (Number(x.importance) || 0))
    .slice(0, 6);

  return {
    constraints: constraints.length ? constraints : undefined,
    revokedAxes: appliedRevoked.size ? Array.from(appliedRevoked).slice(0, 12) : undefined,
  };
}

export function extractCriticalPresentationRequirement(
  text: string,
  locale?: AppLocale
): { days: number; reason: string; evidence: string; city?: string } | null {
  const s = String(text || "");
  if (!s) return null;
  const candidates = sentenceParts(s).filter((x) => hasHardDayReservationSignal(x));
  if (!candidates.length) return null;

  const target =
    candidates
      .slice()
      .sort((a, b) => {
        const score = (y: string) => {
          let v = 0;
          if (CRITICAL_PRESENTATION_RE.test(y)) v += 3;
          if (HARD_DAY_FORCE_RE.test(y) || HARD_REQUIRE_RE.test(y) || HARD_CONSTRAINT_RE.test(y)) v += 2;
          if (/用于|留给|安排|见|拜访|会见|参加|汇报|报告|发表|办理/.test(y)) v += 1;
          return v;
        };
        return score(b) - score(a);
      })[0] || "";

  const dm = target.match(/([0-9一二三四五六七八九十两]{1,2})\s*天/);
  const days = dm?.[1] ? parseCnInt(dm[1]) || 1 : /(一天|一日|1天|1日)/.test(target) ? 1 : 0;
  if (!days || days <= 0 || days > 7) return null;

  let reason = "";
  const p1 = target.match(/(?:用于|留给|安排给|用来)([^，。；;]{2,28})/);
  if (p1?.[1]) reason = cleanStatement(p1[1], 24);
  if (!reason) {
    const p2 = target.match(/(见[^，。；;]{1,20}|拜访[^，。；;]{1,20}|会见[^，。；;]{1,20}|参加[^，。；;]{1,20}|办理[^，。；;]{1,20}|处理[^，。；;]{1,20}|汇报[^，。；;]{1,20}|发表[^，。；;]{1,20})/);
    if (p2?.[1]) reason = cleanStatement(p2[1], 24);
  }
  if (!reason && CRITICAL_PRESENTATION_RE.test(target)) {
    reason = isEnglishLocale(locale) ? "paper/report presentation" : "论文/报告汇报";
  }
  if (!reason && HARD_DAY_ACTION_RE.test(target)) {
    reason = isEnglishLocale(locale) ? "critical task handling" : "关键事项处理";
  }
  if (!reason) return null;

  let city: string | undefined;
  const cm = target.match(/(?:在|于|到|去)\s*([A-Za-z\u4e00-\u9fff]{2,20})/);
  const cityNorm = normalizeDestination(cm?.[1] || "");
  if (cityNorm && isLikelyDestinationCandidate(cityNorm)) city = cityNorm;

  return {
    days,
    reason,
    evidence: cleanStatement(formatCriticalEvidence(locale, reason, days), 60),
    city,
  };
}

function detectDurationUpdateCue(text: string): boolean {
  const s = cleanStatement(text || "", 240);
  if (!s) return false;
  if (/(多|少|再)\s*(玩|待|停留|旅行|旅游|出行)\s*[0-9一二三四五六七八九十两]{1,3}\s*天/i.test(s)) {
    return true;
  }
  if (/(延长|缩短)\s*(行程|时长|天数|旅行|旅游|出行)?/i.test(s)) return true;

  const updateVerb = /(改成|改为|改到|调整为|调整到|更新为|更新到|变为|变成|上调|下调|放宽|加到|减到|增加|减少)/i;
  const durationToken = /(天数|时长|总共|一共|全程|总行程|行程|旅行|旅游|出行|停留|待|玩|周|星期|天)/i;

  if (new RegExp(`${updateVerb.source}[\\s\\S]{0,10}${durationToken.source}`, "i").test(s)) return true;
  if (new RegExp(`${durationToken.source}[\\s\\S]{0,10}${updateVerb.source}`, "i").test(s)) return true;
  if (/(改成|改为|改到|调整为|调整到|更新为|更新到|变为|变成)[^，。；;\n]{0,12}[0-9一二三四五六七八九十两]{1,3}\s*(天|周|星期)/i.test(s)) {
    return true;
  }
  return false;
}

export function extractIntentSignals(userText: string, opts?: { historyMode?: boolean; locale?: AppLocale }): IntentSignals {
  const text = String(userText || "");
  const out: IntentSignals = {};
  out.hasTemporalAnchor =
    /([0-9]{1,2})月([0-9]{1,2})日?(?:\s*[-~到至]\s*([0-9]{1,2})日?)?/.test(text) ||
    /(^|[^\d])([0-9]{1,2})[-/]([0-9]{1,2})(?=[^\d]|$)/.test(text);
  out.hasDurationUpdateCue = detectDurationUpdateCue(text);
  out.hasExplicitTotalCue = hasExplicitDurationTotalCue(text);
  out.hasPartialDurationAllocation = hasPartialDurationAllocationCue(text);

  const peopleM =
    text.match(/(?:一家|全家|我们|同行)[^\d一二三四五六七八九十两]{0,4}([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)/) ||
    text.match(/([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)(?:同行|一起|出游|旅游|出行)?/);
  if (peopleM?.[1]) {
    const n = parseCnInt(peopleM[1]);
    if (n && n > 0 && n < 30) {
      out.peopleCount = n;
      out.peopleEvidence = cleanStatement(peopleM[0] || peopleM[1], 40);
    }
  }

  const destinationList = extractDestinationList(text);
  const removedDestinations = extractRemovedDestinations(text);
  if (destinationList.length) {
    const keptDestinations = destinationList
      .map((x) => x.city)
      .filter((city) => !removedDestinations.includes(city));
    const keptDestinationEvidences = destinationList
      .filter((x) => !removedDestinations.includes(x.city))
      .map((x) => x.evidence);
    out.destinations = keptDestinations;
    out.destinationEvidences = keptDestinationEvidences;
    out.destination = keptDestinations[0];
    out.destinationEvidence = keptDestinationEvidences[0];
  } else {
    const destM =
      text.match(
        /(?:去|到|在)\s*([^\s，。,；;！!？?\d]{2,16}?)(?:玩|旅游|旅行|度假|出行|住|待|逛|[0-9一二三四五六七八九十两]{1,3}\s*天|，|。|,|$)/
      ) ||
      text.match(/目的地(?:是|为)?\s*([^\s，。,；;！!？?\d]{2,16})/);
    if (destM?.[1]) {
      const d = normalizeDestination(destM[1]);
      if (d && isLikelyDestinationCandidate(d)) {
        out.destination = d;
        out.destinationEvidence = cleanStatement(destM[1], 32);
        if (!removedDestinations.includes(d)) {
          out.destinations = [d];
          out.destinationEvidences = [out.destinationEvidence];
        }
      }
    }
  }
  const destinationLooksLikeLodgingFocus =
    /(多住一点|住久一点|多待一点|多留一点|重点住|优先住|主要住)/.test(out.destinationEvidence || "");
  if (destinationLooksLikeLodgingFocus) {
    out.destination = undefined;
    out.destinationEvidence = undefined;
  }
  if (removedDestinations.length) {
    out.removedDestinations = removedDestinations;
    out.destinations = (out.destinations || []).filter((city) => !removedDestinations.includes(city));
    out.destinationEvidences = (out.destinationEvidences || []).slice(0, out.destinations.length);
    if (removedDestinations.includes(normalizeDestination(out.destination || ""))) {
      out.destination = out.destinations?.[0];
      out.destinationEvidence = out.destinationEvidences?.[0];
    }
  }

  const textSubLocations = extractSubLocationsFromText(text, out.destinations || []);
  if (textSubLocations?.length) {
    out.subLocations = textSubLocations;
    out.destinations = filterDestinationsBySubLocations(out.destinations, out.subLocations);
    if (out.destinations?.length) {
      out.destination = out.destinations[0];
      if (!out.destinationEvidence) out.destinationEvidence = out.destinationEvidences?.[0] || out.destinations[0];
    }
  }

  const duration = inferDurationFromText(text, { historyMode: !!opts?.historyMode, locale: opts?.locale });
  if (duration?.days) {
    out.durationDays = duration.days;
    out.durationEvidence = duration.evidence;
    out.durationStrength = duration.strength;
    out.durationBoundaryAmbiguous = !!duration.boundaryAmbiguous;
    out.durationBoundaryQuestion = duration.boundaryQuestion;
  }

  const rawCitySegments = dedupeCityDurationSegments(extractCityDurationSegments(text, opts?.locale), opts?.locale);
  const pairEnvelopeSegment = rawCitySegments.find((seg) => {
    if ((out.destinations || []).length < 2) return false;
    return isCompoundTripEnvelopeDuration(seg.evidence || "", seg.city);
  });
  if (!out.durationDays && pairEnvelopeSegment) {
    out.durationDays = pairEnvelopeSegment.days;
    out.durationEvidence = pairEnvelopeSegment.evidence;
    out.durationStrength = Math.max(out.durationStrength || 0, 0.76);
  }
  const citySegments = rawCitySegments.filter((seg) => {
    if ((out.destinations || []).length < 2) return true;
    if (!isCompoundTripEnvelopeDuration(seg.evidence || "", seg.city)) return true;
    if (out.durationDays != null && seg.days !== out.durationDays) return true;
    return false;
  });
  if (citySegments.length) {
    out.cityDurations = citySegments.map((x) => ({
      city: remapBySubLocationParent(x.city, out.subLocations),
      days: x.days,
      evidence: x.evidence,
      kind: x.kind,
    }));
    for (const seg of citySegments) {
      if (!out.destinations) out.destinations = [];
      if (!out.destinationEvidences) out.destinationEvidences = [];
      const mappedCity = remapBySubLocationParent(seg.city, out.subLocations);
      if (removedDestinations.includes(mappedCity)) continue;
      if (!out.destinations.includes(mappedCity)) {
        out.destinations.push(mappedCity);
        out.destinationEvidences.push(seg.evidence);
      }
    }

    const sumDays = citySegments.reduce((acc, x) => acc + x.days, 0);
    const distinctCities = new Set(citySegments.map((x) => x.city)).size;
    const hasTravelSegment = citySegments.some((x) => x.kind === "travel");
    const shouldPromoteAsTotal =
      !out.hasPartialDurationAllocation &&
      (!!out.hasExplicitTotalCue || (distinctCities >= 2 && hasTravelSegment));
    if (sumDays > 0 && shouldPromoteAsTotal) {
      const segmentStrength = citySegments.some((x) => x.kind === "meeting") ? 0.9 : 0.8;
      const shouldTakeSegments =
        !out.durationDays ||
        sumDays > out.durationDays ||
        segmentStrength >= (out.durationStrength || 0) + 0.08 ||
        ((out.durationStrength || 0) <= 0.78 && Math.abs(sumDays - (out.durationDays || 0)) <= 2);
      if (shouldTakeSegments) {
        out.durationDays = sumDays;
        out.durationEvidence = citySegments
          .map((x) =>
            isEnglishLocale(opts?.locale) ? `${x.city} ${x.days} days` : `${x.city}${x.days}天`
          )
          .join(" + ");
        out.durationStrength = Math.max(out.durationStrength || 0, segmentStrength);
      }
    }

    const looksLikeCompoundTripEnvelope =
      citySegments.length === 1 &&
      (out.destinations || []).length >= 2 &&
      /(?:和|与|及|、|,|，)/.test(String(citySegments[0]?.evidence || "")) &&
      /(?:安排|规划|计划|旅行|旅游|出行|行程|玩)/i.test(text);
    if (!out.durationDays && sumDays > 0 && looksLikeCompoundTripEnvelope) {
      out.durationDays = sumDays;
      out.durationEvidence = citySegments[0]?.evidence || out.durationEvidence;
      out.durationStrength = Math.max(out.durationStrength || 0, 0.76);
    }
  }

  const criticalPresentation = extractCriticalPresentationRequirement(text, opts?.locale);
  if (criticalPresentation) {
    out.criticalPresentation = criticalPresentation;
  }

  if (
    (!out.cityDurations || out.cityDurations.length === 0) &&
    out.durationDays &&
    out.destination &&
    isLikelyDestinationCandidate(out.destination) &&
    !out.criticalPresentation &&
    !hasHardDayReservationSignal(text)
  ) {
    const destinations = (out.destinations || []).filter((x) => isLikelyDestinationCandidate(x));
    const hasSingleDestination = destinations.length <= 1;
    const destinationLooksLikeLodgingFocus =
      /(多住一点|住久一点|多待一点|多留一点|重点住|优先住|主要住)/.test(out.destinationEvidence || "");
    if (hasSingleDestination && !destinationLooksLikeLodgingFocus) {
      out.cityDurations = [
        {
          city: remapBySubLocationParent(out.destination, out.subLocations),
          days: out.durationDays,
          evidence:
            out.durationEvidence ||
            (isEnglishLocale(opts?.locale)
              ? `${out.destination} ${out.durationDays} days`
              : `${out.destination}${out.durationDays}天`),
          kind: /(会议|开会|chi|conference|workshop|论坛|参会)/i.test(text) ? "meeting" : "travel",
        },
      ];
      if (!out.destinations?.includes(out.destination)) {
        out.destinations = [...(out.destinations || []), out.destination];
      }
      if (!out.destinationEvidences?.length) {
        out.destinationEvidences = [out.destinationEvidence || out.durationEvidence || out.destination];
      }
    }
  }

  if (out.subLocations?.length) {
    out.destinations = filterDestinationsBySubLocations(out.destinations, out.subLocations);
    if (out.cityDurations?.length) {
      out.cityDurations = out.cityDurations
        .map((x) => ({ ...x, city: remapBySubLocationParent(x.city, out.subLocations) }))
        .filter((x) => !!x.city && isLikelyDestinationCandidate(x.city));
    }
    if (out.destinations?.length) out.destination = out.destinations[0];
  }

  if (!out.durationDays && /几天|多少天|天数待定|时长待定/i.test(text)) {
    out.durationUnknown = true;
    const du = text.match(/几天|多少天|天数待定|时长待定/i);
    out.durationUnknownEvidence = du?.[0] || (isEnglishLocale(opts?.locale) ? "duration pending confirmation" : "时长待确认");
  }

  const budgetDelta = pickBudgetDeltaFromText(text, opts?.locale);
  if (budgetDelta) {
    out.budgetDeltaCny = budgetDelta.delta;
    out.budgetEvidence = budgetDelta.evidence;
    out.budgetImportance = clampImportance(0.9, out.budgetImportance || 0.86);
  }

  const budgetSpentDelta = pickBudgetSpentDeltaFromText(text, opts?.locale);
  if (budgetSpentDelta) {
    out.budgetSpentDeltaCny = budgetSpentDelta.delta;
    out.budgetSpentEvidence = budgetSpentDelta.evidence;
    out.budgetImportance = clampImportance(0.9, out.budgetImportance || 0.86);
  }

  const budgetSpent = pickBudgetSpentAbsoluteFromText(text, opts?.locale);
  if (budgetSpent) {
    out.budgetSpentCny = budgetSpent.spent;
    out.budgetSpentEvidence = budgetSpent.evidence;
    out.budgetImportance = clampImportance(0.88, out.budgetImportance || 0.84);
  }

  const budget = pickBudgetFromText(text);
  if (budget) {
    const hasAbsoluteBudgetCue = /(?:总预算|预算上限|预算总额|一共|总共|合计|总计|现在预算|预算变成|预算为|预算是|调整为|改成|改到|调到|提高到|增加到|提升到|上调到|下调到|达到|控制在|不超过|上限为|上限是)/i.test(
      text
    );
    const hasOnlyDeltaCue =
      !!budgetDelta &&
      !hasAbsoluteBudgetCue;
    const hasSpentCommitmentOnlyCue =
      !!budgetSpentDelta &&
      !hasAbsoluteBudgetCue;
    if (!hasOnlyDeltaCue && !hasSpentCommitmentOnlyCue) {
      out.budgetCny = budget.value;
      out.budgetEvidence = budget.evidence;
    }
  }
  if (out.budgetCny != null && out.budgetSpentCny != null) {
    out.budgetRemainingCny = Math.max(0, Math.round(out.budgetCny - out.budgetSpentCny));
  }

  const healthClause = pickHealthClause(text);
  if (healthClause) {
    out.healthConstraint = healthClause;
    out.healthEvidence = healthClause;
  }
  const languageClause = pickLanguageConstraintClause(text);
  if (languageClause) {
    out.languageConstraint = languageClause;
    out.languageEvidence = languageClause;
  }

  const revokedConstraintAxes = new Set<string>();
  const revokedPreferenceAxes = new Set<PreferenceAxis>();
  for (const part of sentenceParts(text)) {
    for (const axis of detectPreferenceRevocationAxesFromText(part)) {
      revokedPreferenceAxes.add(axis);
    }
  }

  const genericConstraints: NonNullable<IntentSignals["genericConstraints"]> = [];
  const pushDerivedGenericConstraint = (params: {
    text: string;
    kind: GenericConstraintKind;
    evidence?: string;
    hard?: boolean;
    importance?: number;
  }) => {
    const text = cleanStatement(params.text, 120);
    if (!text) return;
    genericConstraints.push({
      text,
      evidence: cleanStatement(params.evidence || params.text, 80),
      kind: params.kind,
      hard: !!params.hard,
      severity:
        params.kind === "safety" || params.kind === "mobility" || params.kind === "diet" || params.kind === "religion" || params.kind === "legal"
          ? "high"
          : "medium",
      importance: clampImportance(params.importance, params.hard ? 0.84 : 0.76),
    });
  };
  for (const part of constraintClauses(text)) {
    const s = cleanStatement(part, 120);
    if (!s) continue;
    if (/^(预算(?:上限)?|总行程时长|行程时长|城市时长|停留时长|同行人数|目的地)[:：]/.test(s)) continue;
    if (isVenueOrExperienceRequirement(s)) continue;
    const likelyConstraintCue =
      HARD_CONSTRAINT_RE.test(s) ||
      HARD_REQUIRE_RE.test(s) ||
      hasConstraintDeclarationCue(s) ||
      hasExplicitConstraintNegationCue(s) ||
      LOW_HASSLE_TRAVEL_RE.test(s) ||
      SAFETY_STRATEGY_RE.test(s) ||
      TRANSPORT_CONVENIENCE_RE.test(s) ||
      HEALTH_STRATEGY_DIET_RE.test(s) ||
      /签证|护照|入境|治安|安全|被坑|防骗|轮椅|无障碍|转机|换乘|托运|语言障碍|不会英语|不会英文|法语|阿拉伯语|西语|葡语|英语|英文|不懂|翻译|饮食|忌口|素食|清真|宗教|礼拜|祷告|斋月|安息日|低盐|低脂|高纤维|清淡|少油|少糖|不想太累|不太折腾|中老年|老人|地铁近|交通方便|halal|kosher|vegetarian|vegan|religion|prayer|visa|passport|safety|logistics|low[-\s]?salt|low[-\s]?fat|high[-\s]?fiber|diet/i.test(
        s
      );
    if (!likelyConstraintCue) continue;
    const c = classifyConstraintText({
      text: s,
      evidence: s,
    });
    if (!c) continue;
    if (c.family === "health") {
      if (!out.healthConstraint) {
        out.healthConstraint = c.text;
        out.healthEvidence = c.evidence;
        out.healthImportance = c.importance;
      }
      continue;
    }
    if (c.family === "language") {
      if (!out.languageConstraint) {
        out.languageConstraint = c.text;
        out.languageEvidence = c.evidence;
        out.languageImportance = c.importance;
      }
      if (TRANSPORT_CONVENIENCE_RE.test(s) || /换乘|转机|地铁|公交|交通|出行方便|transfer|transit|metro/i.test(s)) {
        pushDerivedGenericConstraint({
          text: t(opts?.locale, "交通衔接需便利、少换乘", "Transit should be convenient with minimal transfers"),
          kind: "logistics",
          evidence: c.evidence,
          hard: c.hard,
          importance: c.importance,
        });
      }
      if (LOW_HASSLE_TRAVEL_RE.test(s)) {
        pushDerivedGenericConstraint({
          text: t(opts?.locale, "行程需低强度、减少体力负担", "Trip should be low-intensity with reduced physical burden"),
          kind: "mobility",
          evidence: c.evidence,
          hard: c.hard,
          importance: c.importance,
        });
      }
      continue;
    }
    if (c.family === "generic") {
      const normalized = normalizeGenericConstraintItem({
        text: c.text,
        evidence: c.evidence,
        kind: c.kind,
        hard: c.hard,
        severity: c.severity,
        importance: c.importance,
      } as any);
      if (normalized && normalized.polarity === "negative" && hasExplicitConstraintNegationCue(s)) {
        revokedConstraintAxes.add(normalized.axisKey);
      }
      genericConstraints.push({
        text: c.text,
        evidence: c.evidence,
        kind: c.kind,
        hard: c.hard,
        severity: c.severity,
        importance: c.importance,
      });
      if (c.kind === "logistics" && LOW_HASSLE_TRAVEL_RE.test(s)) {
        pushDerivedGenericConstraint({
          text: t(opts?.locale, "行程需低强度、减少体力负担", "Trip should be low-intensity with reduced physical burden"),
          kind: "mobility",
          evidence: c.evidence,
          hard: c.hard,
          importance: c.importance,
        });
      }
      if (c.kind === "mobility" && TRANSPORT_CONVENIENCE_RE.test(s)) {
        pushDerivedGenericConstraint({
          text: t(opts?.locale, "交通衔接需便利、少换乘", "Transit should be convenient with minimal transfers"),
          kind: "logistics",
          evidence: c.evidence,
          hard: c.hard,
          importance: c.importance,
        });
      }
    }
  }
  out.genericConstraints = mergeGenericConstraints(undefined, genericConstraints);

  const prefClause = sentenceParts(text).map((x) => normalizePreferenceStatement(x, opts?.locale)).find(Boolean);
  if (prefClause && !revokedPreferenceAxes.has("preference:scenic")) {
    out.scenicPreference = prefClause.statement;
    out.scenicPreferenceHard = prefClause.hard;
    out.scenicPreferenceEvidence = prefClause.evidence;
    out.scenicPreferenceImportance = prefClause.hard ? 0.8 : 0.68;
  }

  const lodgingClause = sentenceParts(text).map((x) => normalizeLodgingPreferenceStatement(x, opts?.locale)).find(Boolean);
  if (lodgingClause && !revokedPreferenceAxes.has("preference:lodging")) {
    out.lodgingPreference = lodgingClause.statement;
    out.lodgingPreferenceHard = lodgingClause.hard;
    out.lodgingPreferenceEvidence = lodgingClause.evidence;
    out.lodgingPreferenceImportance = lodgingClause.hard ? 0.82 : 0.66;
  }

  const activityClause = sentenceParts(text).map((x) => normalizeActivityPreferenceStatement(x, opts?.locale)).find(Boolean);
  if (activityClause && !revokedPreferenceAxes.has("preference:activity")) {
    out.activityPreference = activityClause.statement;
    out.activityPreferenceEvidence = activityClause.evidence;
    out.activityPreferenceHard = activityClause.hard;
    out.activityPreferenceImportance = activityClause.hard ? 0.84 : 0.7;
  }

  if (revokedConstraintAxes.size) {
    out.revokedConstraintAxes = Array.from(revokedConstraintAxes).slice(0, 12);
  }
  if (revokedPreferenceAxes.size) {
    out.revokedPreferenceAxes = Array.from(revokedPreferenceAxes).slice(0, 8);
  }

  return out;
}

function hasPreferenceStateForAxis(signals: IntentSignals, axis: PreferenceAxis): boolean {
  if (axis === "preference:scenic") return !!cleanStatement(signals.scenicPreference || "", 120);
  if (axis === "preference:lodging") return !!cleanStatement(signals.lodgingPreference || "", 120);
  return !!cleanStatement(signals.activityPreference || "", 120);
}

function clearPreferenceStateForAxis(signals: IntentSignals, axis: PreferenceAxis): void {
  if (axis === "preference:scenic") {
    signals.scenicPreference = undefined;
    signals.scenicPreferenceEvidence = undefined;
    signals.scenicPreferenceHard = undefined;
    signals.scenicPreferenceImportance = undefined;
    return;
  }
  if (axis === "preference:lodging") {
    signals.lodgingPreference = undefined;
    signals.lodgingPreferenceEvidence = undefined;
    signals.lodgingPreferenceHard = undefined;
    signals.lodgingPreferenceImportance = undefined;
    return;
  }
  signals.activityPreference = undefined;
  signals.activityPreferenceEvidence = undefined;
  signals.activityPreferenceHard = undefined;
  signals.activityPreferenceImportance = undefined;
}

function mergeSignalsWithLatest(history: IntentSignals, latest: IntentSignals, locale?: AppLocale): IntentSignals {
  const out: IntentSignals = { ...history };
  const destinationEvidenceByCity = new Map<string, string>();
  const rememberDestinationEvidence = (rawCity: string | undefined, rawEvidence: string | undefined) => {
    const city = normalizeDestination(rawCity || "");
    const evidence = cleanStatement(rawEvidence || rawCity || "", 60);
    const key = city.toLowerCase();
    if (!city || !evidence || !key || !isLikelyDestinationCandidate(city) || destinationEvidenceByCity.has(key)) return;
    destinationEvidenceByCity.set(key, evidence);
  };
  (history.destinations || []).forEach((city, index) => {
    rememberDestinationEvidence(city, history.destinationEvidences?.[index] || history.destinationEvidence || city);
  });
  rememberDestinationEvidence(history.destination, history.destinationEvidence || history.destination);
  (latest.destinations || []).forEach((city, index) => {
    rememberDestinationEvidence(city, latest.destinationEvidences?.[index] || latest.destinationEvidence || city);
  });
  rememberDestinationEvidence(latest.destination, latest.destinationEvidence || latest.destination);
  // delta 是“事件”，不是“状态”：避免历史增量在后续轮次被重复叠加。
  out.budgetDeltaCny = undefined;
  out.budgetSpentDeltaCny = undefined;
  out.revokedConstraintAxes = undefined;
  out.revokedPreferenceAxes = undefined;
  out.hasTemporalAnchor = !!history.hasTemporalAnchor;
  out.hasDurationUpdateCue = !!history.hasDurationUpdateCue;
  out.hasExplicitTotalCue = !!history.hasExplicitTotalCue;
  out.hasPartialDurationAllocation = !!history.hasPartialDurationAllocation;
  out.durationBoundaryAmbiguous = !!history.durationBoundaryAmbiguous;
  out.durationBoundaryQuestion = history.durationBoundaryQuestion;

  const mergeDestinations = (a?: string[], b?: string[]) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const x of [...(a || []), ...(b || [])]) {
      const city = normalizeDestination(String(x || ""));
      if (!city || !isLikelyDestinationCandidate(city) || seen.has(city)) continue;
      seen.add(city);
      result.push(city);
    }
    return result.length ? result.slice(0, 4) : undefined;
  };
  const removedDestinations = mergeDestinations(undefined, latest.removedDestinations);
  const removeCities = (list?: string[]) =>
    list?.filter((x) => !removedDestinations?.includes(normalizeDestination(x))) || undefined;

  const mergeCityDurations = (
    a?: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting" }>,
    b?: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting" }>
  ) => {
    const map = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting" }>();
    for (const seg of [...(a || []), ...(b || [])]) {
      const rawCity = normalizeDestination(seg?.city || "");
      const city = remapBySubLocationParent(rawCity, mergeSubLocations(out.subLocations, latest.subLocations));
      const days = Number(seg?.days) || 0;
      if (!city || days <= 0 || days > 60) continue;
      if (!isLikelyDestinationCandidate(city)) continue;
      if (removedDestinations?.includes(city)) continue;
      const cur = map.get(city);
      const kind: "travel" | "meeting" = seg?.kind === "meeting" ? "meeting" : "travel";
      const cand = {
        city,
        days,
        evidence: cleanStatement(seg?.evidence || `${city} ${formatDayCount(locale, days)}`, 40),
        kind,
      };
      rememberDestinationEvidence(city, cand.evidence);
      const shouldReplace =
        !cur ||
        cand.days > cur.days ||
        (cand.days === cur.days && cand.kind === "meeting" && cur.kind !== "meeting");
      if (shouldReplace) map.set(city, cand);
    }
    return map.size ? Array.from(map.values()).slice(0, 6) : undefined;
  };

  const latestStableCitySnapshot = summarizeStableCityDurationSnapshot(latest);
  const latestStableCities = latestStableCitySnapshot?.cities || [];
  const latestShouldReplaceCoarseDestinations =
    latestStableCities.length >= 2 &&
    (mergeDestinations(out.destinations, latest.destinations) || []).some(
      (city) => !latestStableCities.includes(city)
    );

  out.destinations = mergeDestinations(out.destinations, undefined);
  out.removedDestinations = removedDestinations;
  if (out.destination) {
    const d = normalizeDestination(out.destination);
    out.destination = d && isLikelyDestinationCandidate(d) ? d : undefined;
  }
  out.cityDurations = mergeCityDurations(undefined, out.cityDurations);
  if (!out.destination && out.destinations?.length) out.destination = out.destinations[0];
  out.subLocations = mergeSubLocations(out.subLocations, undefined);

  if (latest.peopleCount != null) {
    out.peopleCount = latest.peopleCount;
    out.peopleEvidence = latest.peopleEvidence || out.peopleEvidence;
  }
  if (latest.peopleImportance != null) {
    out.peopleImportance = clampImportance(latest.peopleImportance, out.peopleImportance || 0.72);
  }

  const historyDestSnapshot = (out.destinations || [])
    .map((x) => normalizeDestination(x))
    .filter((x) => x && isLikelyDestinationCandidate(x));
  out.destinations = removeCities(mergeDestinations(out.destinations, latest.destinations));
  if (out.destinations?.length) {
    out.destination = out.destinations[0];
  }
  out.destinationImportanceByCity = mergeImportanceMap(
    out.destinationImportanceByCity,
    latest.destinationImportanceByCity
  );
  if (latest.destinationImportance != null) {
    out.destinationImportance = clampImportance(
      latest.destinationImportance,
      out.destinationImportance || 0.8
    );
  }
  if (latest.destination) {
    const normalizedLatestDestination = normalizeDestination(latest.destination);
    const latestSubNames = new Set(
      (latest.subLocations || [])
        .map((x) => normalizeDestination(x.name || ""))
        .filter(Boolean)
    );
    const latestLooksLikeSubLocation =
      latestSubNames.has(normalizedLatestDestination) ||
      Array.from(latestSubNames).some(
        (sub) => sub && sub.length >= 2 && normalizedLatestDestination.includes(sub)
      );
    if (normalizedLatestDestination && isLikelyDestinationCandidate(normalizedLatestDestination)) {
      if (!latestLooksLikeSubLocation) {
        out.destination = normalizedLatestDestination;
        out.destinationEvidence = latest.destinationEvidence || out.destinationEvidence;
        out.destinations = removeCities(mergeDestinations(out.destinations, [normalizedLatestDestination]));
      }
    }
  }
  const latestSubs = (latest.subLocations || []).map((x) => ({ ...x }));
  if (latestSubs.length) {
    const historyDests = historyDestSnapshot;
    const uniqueHistory = Array.from(new Set(historyDests));
    const fallbackParent = uniqueHistory.length === 1 ? uniqueHistory[0] : "";
    if (fallbackParent) {
      for (const sub of latestSubs) {
        if (!sub.parentCity) {
          sub.parentCity = fallbackParent;
        }
      }
    }
  }
  out.subLocations = mergeSubLocations(out.subLocations, latestSubs);
  out.hasTemporalAnchor = !!latest.hasTemporalAnchor || !!out.hasTemporalAnchor;
  out.hasDurationUpdateCue = !!latest.hasDurationUpdateCue || !!out.hasDurationUpdateCue;
  out.hasExplicitTotalCue = !!latest.hasExplicitTotalCue || !!out.hasExplicitTotalCue;
  out.hasPartialDurationAllocation = !!latest.hasPartialDurationAllocation || !!out.hasPartialDurationAllocation;
  if (latest.durationBoundaryAmbiguous) {
    out.durationBoundaryAmbiguous = true;
    out.durationBoundaryQuestion = latest.durationBoundaryQuestion || out.durationBoundaryQuestion;
  } else if (
    latest.durationDays != null ||
    latest.hasDurationUpdateCue ||
    latest.hasExplicitTotalCue
  ) {
    out.durationBoundaryAmbiguous = false;
    out.durationBoundaryQuestion = undefined;
  }
  const latestHasSnapshotDuration =
    latest.durationDays != null &&
    (!!latest.hasDurationUpdateCue || (!!latest.hasTemporalAnchor && !!latest.hasExplicitTotalCue));

  if (latest.cityDurations?.length) {
    out.cityDurations = latestHasSnapshotDuration || !!latestStableCitySnapshot
      ? mergeCityDurations(undefined, latest.cityDurations)
      : mergeCityDurations(out.cityDurations, latest.cityDurations);
  } else {
    out.cityDurations = mergeCityDurations(out.cityDurations, latest.cityDurations);
  }
  if (out.cityDurations?.length) {
    out.cityDurations = out.cityDurations
      .map((x) => ({ ...x, city: remapBySubLocationParent(x.city, out.subLocations) }))
      .filter((x) => !!x.city && isLikelyDestinationCandidate(x.city));
  }
  out.destinations = filterDestinationsBySubLocations(
    removeCities(mergeDestinations(out.destinations, undefined)),
    out.subLocations
  );
  if (latestShouldReplaceCoarseDestinations && latestStableCities.length) {
    out.destinations = latestStableCities.slice(0, 8);
    out.destinationEvidences = out.destinations.map(
      (city) => latestStableCitySnapshot?.evidenceByCity.get(city) || city
    );
  }
  if (out.destinations?.length) out.destination = out.destinations[0];
  if (removedDestinations?.includes(normalizeDestination(out.destination || ""))) {
    out.destination = out.destinations?.[0];
    out.destinationEvidence = out.destination ? latestStableCitySnapshot?.evidenceByCity.get(out.destination) || out.destination : undefined;
  }
  if (latestShouldReplaceCoarseDestinations && out.destination) {
    out.destinationEvidence =
      latestStableCitySnapshot?.evidenceByCity.get(out.destination) ||
      latest.destinationEvidence ||
      out.destinationEvidence;
  }
  if (out.destinations?.length) {
    out.destinationEvidences = out.destinations.map(
      (city) =>
        latestStableCitySnapshot?.evidenceByCity.get(city) ||
        destinationEvidenceByCity.get(normalizeDestination(city).toLowerCase()) ||
        city
    );
    out.destinationEvidence = out.destinationEvidences[0] || out.destinationEvidence || out.destination;
  } else {
    out.destinationEvidences = undefined;
  }
  out.cityDurationImportanceByCity = mergeImportanceMap(
    out.cityDurationImportanceByCity,
    latest.cityDurationImportanceByCity
  );

  if (latest.criticalPresentation) {
    out.criticalPresentation = latest.criticalPresentation;
  }
  if (latest.criticalImportance != null) {
    out.criticalImportance = clampImportance(
      latest.criticalImportance,
      out.criticalImportance || 0.96
    );
  }

  if (latest.durationDays != null) {
    const latestStrength = Number(latest.durationStrength) || 0.55;
    const historyStrength = Number(out.durationStrength) || 0;
    const mergedSegSum = (out.cityDurations || []).reduce((acc, x) => acc + (Number(x.days) || 0), 0);
    const mergedSegDistinct = new Set((out.cityDurations || []).map((x) => normalizeDestination(x.city))).size;
    const shouldProtectSegmentTotal =
      !latest.hasDurationUpdateCue &&
      mergedSegDistinct >= 2 &&
      mergedSegSum > 0 &&
      latest.durationDays < mergedSegSum;
    const tinyCriticalOnly =
      !!latest.criticalPresentation &&
      latest.durationDays <= 2 &&
      !latest.hasTemporalAnchor &&
      !latest.hasDurationUpdateCue;
    const shouldUseLatest =
      !shouldProtectSegmentTotal &&
      !tinyCriticalOnly &&
      (out.durationDays == null ||
        latestHasSnapshotDuration ||
        (!!latestStableCitySnapshot &&
          latest.durationDays > 0 &&
          latest.durationDays < (out.durationDays || 0)) ||
        latestStrength >= 0.9 ||
        latest.durationDays > (out.durationDays || 0) ||
        latestStrength + 0.06 >= historyStrength);

    if (shouldUseLatest) {
      out.durationDays = latest.durationDays;
      out.durationEvidence = latest.durationEvidence || out.durationEvidence;
      out.durationStrength = latestStrength;
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
      if (latest.durationImportance != null) {
        out.durationImportance = clampImportance(
          latest.durationImportance,
          out.durationImportance || 0.78
        );
      }
    }
  } else if (latest.durationUnknown) {
    out.durationUnknown = true;
    out.durationUnknownEvidence = latest.durationUnknownEvidence || out.durationUnknownEvidence;
  }

  if (out.cityDurations?.length) {
    const segSum = out.cityDurations.reduce((acc, x) => acc + (Number(x.days) || 0), 0);
    const distinctCities = new Set(out.cityDurations.map((x) => x.city)).size;
    const hasTravelSegment = out.cityDurations.some((x) => x.kind === "travel");
    const canPromoteBySegments = distinctCities >= 2 && hasTravelSegment;
    const segStrength = out.cityDurations.some((x) => x.kind === "meeting") ? 0.9 : 0.84;
    const latestTouchedCityDurations = !!latest.cityDurations?.length;
    const protectStableTotalFromSegmentLeak =
      out.durationDays != null &&
      !latest.hasDurationUpdateCue &&
      !latest.hasExplicitTotalCue &&
      !!latest.cityDurations?.length &&
      (!latestStableCitySnapshot || !!latest.hasPartialDurationAllocation);

    const shouldTakeSeg =
      canPromoteBySegments &&
      segSum > 0 &&
      !protectStableTotalFromSegmentLeak &&
      (!out.durationDays ||
        latestHasSnapshotDuration ||
        (latestTouchedCityDurations &&
          (segSum > out.durationDays ||
            segStrength >= (Number(out.durationStrength) || 0) + 0.08 ||
            ((Number(out.durationStrength) || 0) <= 0.78 &&
              Math.abs(segSum - (out.durationDays || 0)) <= 2))));
    if (shouldTakeSeg) {
      out.durationDays = segSum;
      out.durationEvidence = out.cityDurations.map((x) => `${x.city} ${formatDayCount(locale, x.days)}`).join(" + ");
      out.durationStrength = Math.max(Number(out.durationStrength) || 0.55, segStrength);
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
    }
  }

  if (out.criticalPresentation && out.cityDurations?.length && !out.criticalPresentation.city) {
    const meetingCity = out.cityDurations.find((x) => x.kind === "meeting")?.city;
    if (meetingCity) out.criticalPresentation.city = meetingCity;
  }

  if (latest.budgetDeltaCny != null) {
    const baseBudget = Number(out.budgetCny);
    if (Number.isFinite(baseBudget) && baseBudget > 0) {
      const merged = Math.max(100, Math.round(baseBudget + Number(latest.budgetDeltaCny)));
      out.budgetCny = merged;
      const deltaText = `${latest.budgetDeltaCny > 0 ? "+" : "-"}${formatBudgetCny(locale, Math.abs(latest.budgetDeltaCny))}`;
      out.budgetEvidence =
        latest.budgetEvidence ||
        cleanStatement(`${formatBudgetCny(locale, baseBudget)} ${deltaText}`, 48);
    } else if (latest.budgetCny != null) {
      out.budgetCny = latest.budgetCny;
      out.budgetEvidence = latest.budgetEvidence || out.budgetEvidence;
    }
  }
  if (latest.budgetCny != null) {
    out.budgetCny = latest.budgetCny;
    out.budgetEvidence = latest.budgetEvidence || out.budgetEvidence;
  }
  if (latest.budgetSpentDeltaCny != null) {
    const prevSpent = Number(out.budgetSpentCny);
    if (Number.isFinite(prevSpent) && prevSpent >= 0) {
      out.budgetSpentCny = Math.max(0, Math.round(prevSpent + Number(latest.budgetSpentDeltaCny)));
    } else {
      out.budgetSpentCny = Math.max(0, Math.round(Number(latest.budgetSpentDeltaCny)));
    }
    out.budgetSpentEvidence =
      latest.budgetSpentEvidence ||
      cleanStatement(
        `${out.budgetSpentEvidence || t(locale, "已花", "Spent")} + ${formatBudgetCny(locale, latest.budgetSpentDeltaCny)}`,
        80
      );
  }
  if (latest.budgetSpentCny != null) {
    out.budgetSpentCny = Math.max(0, Math.round(Number(latest.budgetSpentCny)));
    out.budgetSpentEvidence = latest.budgetSpentEvidence || out.budgetSpentEvidence;
  }
  if (out.budgetCny != null && out.budgetSpentCny != null) {
    out.budgetRemainingCny = Math.max(0, Math.round(Number(out.budgetCny) - Number(out.budgetSpentCny)));
  } else if (latest.budgetRemainingCny != null) {
    out.budgetRemainingCny = Math.max(0, Math.round(Number(latest.budgetRemainingCny)));
  }
  if (latest.budgetPendingCny != null) {
    out.budgetPendingCny = Math.max(0, Math.round(Number(latest.budgetPendingCny)));
  }
  if (latest.budgetPendingEvidence) {
    out.budgetPendingEvidence = latest.budgetPendingEvidence;
  }
  if (latest.budgetImportance != null) {
    out.budgetImportance = clampImportance(
      latest.budgetImportance,
      out.budgetImportance || 0.86
    );
  }
  if (latest.healthConstraint) {
    const latestHealth = cleanStatement(latest.healthConstraint, 120);
    if (isLanguageOnlyConstraint(latestHealth)) {
      out.languageConstraint = latestHealth;
      out.languageEvidence = latest.healthEvidence || latest.healthConstraint || out.languageEvidence;
      out.languageImportance = clampImportance(
        latest.healthImportance,
        latest.languageImportance || out.languageImportance || 0.82
      );
    } else {
      out.healthConstraint = latestHealth;
      out.healthEvidence = latest.healthEvidence || out.healthEvidence;
    }
  }
  if (latest.healthImportance != null && !isLanguageOnlyConstraint(latest.healthConstraint)) {
    out.healthImportance = clampImportance(
      latest.healthImportance,
      out.healthImportance || 0.96
    );
  }
  if (latest.languageConstraint) {
    out.languageConstraint = cleanStatement(latest.languageConstraint, 120);
    out.languageEvidence = latest.languageEvidence || out.languageEvidence;
  }
  if (latest.languageImportance != null) {
    out.languageImportance = clampImportance(
      latest.languageImportance,
      out.languageImportance || 0.82
    );
  }
  if (out.healthConstraint && isLanguageOnlyConstraint(out.healthConstraint)) {
    out.languageConstraint = out.languageConstraint || out.healthConstraint;
    out.languageEvidence = out.languageEvidence || out.healthEvidence || out.healthConstraint;
    out.languageImportance = clampImportance(
      out.languageImportance,
      out.healthImportance || 0.82
    );
    out.healthConstraint = undefined;
    out.healthEvidence = undefined;
    out.healthImportance = undefined;
  }
  const mergedConstraints = mergeGenericConstraintsWithRevocation({
    history: out.genericConstraints,
    latest: latest.genericConstraints,
    latestRevokedAxes: latest.revokedConstraintAxes,
  });
  out.genericConstraints = mergedConstraints.constraints;
  if (mergedConstraints.revokedAxes?.length) {
    out.revokedConstraintAxes = mergeAxisList(out.revokedConstraintAxes, mergedConstraints.revokedAxes);
  }

  const requestedPreferenceRevokes = new Set<PreferenceAxis>();
  for (const axisRaw of latest.revokedPreferenceAxes || []) {
    const axis = normalizePreferenceAxis(axisRaw);
    if (axis) requestedPreferenceRevokes.add(axis);
  }
  const appliedPreferenceRevokes = new Set<string>();
  for (const axis of requestedPreferenceRevokes) {
    if (!hasPreferenceStateForAxis(out, axis)) continue;
    clearPreferenceStateForAxis(out, axis);
    appliedPreferenceRevokes.add(axis);
  }

  if (latest.scenicPreference && !requestedPreferenceRevokes.has("preference:scenic")) {
    out.scenicPreference = latest.scenicPreference;
    out.scenicPreferenceEvidence = latest.scenicPreferenceEvidence || out.scenicPreferenceEvidence;
    out.scenicPreferenceHard = latest.scenicPreferenceHard;
  }
  if (latest.scenicPreferenceImportance != null && !requestedPreferenceRevokes.has("preference:scenic")) {
    out.scenicPreferenceImportance = clampImportance(
      latest.scenicPreferenceImportance,
      out.scenicPreferenceImportance || 0.68
    );
  }
  if (latest.lodgingPreference && !requestedPreferenceRevokes.has("preference:lodging")) {
    out.lodgingPreference = latest.lodgingPreference;
    out.lodgingPreferenceEvidence =
      latest.lodgingPreferenceEvidence || out.lodgingPreferenceEvidence;
    out.lodgingPreferenceHard = latest.lodgingPreferenceHard;
  }
  if (latest.lodgingPreferenceImportance != null && !requestedPreferenceRevokes.has("preference:lodging")) {
    out.lodgingPreferenceImportance = clampImportance(
      latest.lodgingPreferenceImportance,
      out.lodgingPreferenceImportance || 0.66
    );
  }
  if (latest.activityPreference && !requestedPreferenceRevokes.has("preference:activity")) {
    out.activityPreference = latest.activityPreference;
    out.activityPreferenceEvidence =
      latest.activityPreferenceEvidence || out.activityPreferenceEvidence;
    out.activityPreferenceHard = latest.activityPreferenceHard;
  }
  if (latest.activityPreferenceImportance != null && !requestedPreferenceRevokes.has("preference:activity")) {
    out.activityPreferenceImportance = clampImportance(
      latest.activityPreferenceImportance,
      out.activityPreferenceImportance || 0.7
    );
  }
  if (appliedPreferenceRevokes.size) {
    out.revokedPreferenceAxes = mergeAxisList(out.revokedPreferenceAxes, Array.from(appliedPreferenceRevokes));
  }
  if (latest.goalImportance != null) {
    out.goalImportance = clampImportance(latest.goalImportance, out.goalImportance || 0.82);
  }

  return out;
}

export function extractIntentSignalsWithRecency(
  historyText: string,
  latestUserText: string,
  opts?: { locale?: AppLocale }
): IntentSignals {
  const chunks = String(historyText || "")
    .split(/\n+/)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  let fromHistory: IntentSignals = {};
  if (chunks.length) {
    for (const chunk of chunks) {
      const turnSignals = extractIntentSignals(chunk, { historyMode: true, locale: opts?.locale });
      fromHistory = mergeSignalsWithLatest(fromHistory, turnSignals, opts?.locale);
    }
  } else {
    fromHistory = extractIntentSignals(historyText, { historyMode: true, locale: opts?.locale });
  }
  const fromLatest = extractIntentSignals(latestUserText, { locale: opts?.locale });
  return mergeSignalsWithLatest(fromHistory, fromLatest, opts?.locale);
}

export function mergeIntentSignals(base: IntentSignals, incoming: IntentSignals, locale?: AppLocale): IntentSignals {
  return mergeSignalsWithLatest(base, incoming, locale);
}
