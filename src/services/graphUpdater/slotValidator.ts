import type { AppLocale } from "../../i18n/locale.js";
import { isEnglishLocale } from "../../i18n/locale.js";
import {
  LOW_HASSLE_TRAVEL_RE,
  STRUCTURED_PREFIX_RE,
} from "./constants.js";
import { dedupeClassifiedConstraints } from "./constraintClassifier.js";
import type { GenericConstraintKind } from "./constraintClassifier.js";
import {
  isLikelyDestinationCandidate,
  normalizeDestination,
  type IntentSignals,
} from "./intentSignals.js";
import { cleanStatement } from "./text.js";
import {
  looksLikeAbstractPlaceText,
  looksLikeAbstractTravelModeText,
  looksLikeDiscourseFragmentText,
  looksLikeFallbackPlanText,
  looksLikeLodgingSequenceFragmentText,
  looksLikeMovementFragmentText,
  looksLikeTaskRestart,
  looksLikeTripPhaseCueText,
} from "../../shared/travelSemantics.js";

export type SlotCandidateSource = "heuristic" | "function_call" | "history_merge" | "graph_context";

export type SemanticBucket =
  | "destination"
  | "sub_location"
  | "total_duration"
  | "city_duration"
  | "people"
  | "budget"
  | "pace_density";

export type SlotCandidate<T = unknown> = {
  slotFamily: string;
  semanticBucket: SemanticBucket;
  source: SlotCandidateSource;
  value: T;
  evidence?: string;
  confidence?: number;
  importance?: number;
  hard?: boolean;
};

export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
  source: SlotCandidateSource;
  semanticBucket?: SemanticBucket;
  value?: string;
};

export type SlotValidationResult = {
  signals: IntentSignals;
  issues: ValidationIssue[];
  candidates: SlotCandidate[];
};

const SUB_LOCATION_HINT_RE =
  /(纪念堂|博物馆|美术馆|图书馆|寺|庙|教堂|塔|桥|夜市|老街|步道|公园|广场|码头|车站|高铁站|机场|文创园区|文创园|创意园|商圈|景区|景点|场馆|stadium|arena|museum|park|temple|church|bridge|market|night market|old street|station|airport|square|pier|district|quarter|mall|venue|poi)/i;
const TEMPORAL_LEAD_IN_RE =
  /^(?:为期|历时|总共|一共|共计|合计|整体|全程|总时长|行程时长|停留时长|city duration|trip duration|total duration)\b/i;
const PACE_DENSITY_RE =
  /(?:行程|安排|节奏|路线|计划)?\s*(?:不能|不要|别|不想)?(?:安排)?太满|不想太累|不要太累|不太折腾|不要太折腾|少折腾|轻松一点|慢节奏|低强度|减少体力|少走路|少步行|不想太赶|不要太赶|别太赶|节奏别太赶|行程别太赶|不要爬坡|别爬坡|不能爬坡|no hills?|avoid slopes?|avoid uphill|not too packed|don'?t pack (?:the )?(?:trip|itinerary) too tightly|not too rushed|easy pace|gentle pace|low[-\s]?hassle|low[-\s]?intensity/i;
const LODGING_SPECIFIC_RE =
  /酒店|民宿|住宿|住在|入住|房型|星级|酒店标准|房费|少换酒店|换酒店|住同一家|hotel|lodging|accommodation|stay in|room|elevator|accessible|near metro|quiet area|walkable/i;
const ACTIVITY_SPECIFIC_RE =
  /划船|游船|看球|观赛|演唱会|音乐会|展览|看展|动物|野生动物|步道|boat(?:ing| ride)?|cruise|kayak|game|match|concert|exhibition|wildlife/i;

function cloneSignals(signals: IntentSignals): IntentSignals {
  return {
    ...signals,
    destinations: signals.destinations ? [...signals.destinations] : undefined,
    destinationEvidences: signals.destinationEvidences ? [...signals.destinationEvidences] : undefined,
    removedDestinations: signals.removedDestinations ? [...signals.removedDestinations] : undefined,
    cityDurations: signals.cityDurations ? signals.cityDurations.map((item) => ({ ...item })) : undefined,
    subLocations: signals.subLocations ? signals.subLocations.map((item) => ({ ...item })) : undefined,
    genericConstraints: signals.genericConstraints ? signals.genericConstraints.map((item) => ({ ...item })) : undefined,
    revokedConstraintAxes: signals.revokedConstraintAxes ? [...signals.revokedConstraintAxes] : undefined,
    revokedPreferenceAxes: signals.revokedPreferenceAxes ? [...signals.revokedPreferenceAxes] : undefined,
    destinationImportanceByCity: signals.destinationImportanceByCity
      ? { ...signals.destinationImportanceByCity }
      : undefined,
    cityDurationImportanceByCity: signals.cityDurationImportanceByCity
      ? { ...signals.cityDurationImportanceByCity }
      : undefined,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const text = cleanStatement(raw, 80);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function clampImportance(x: any, fallback = 0.78): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function looksLikeDestinationNoise(raw: string): boolean {
  const text = cleanStatement(raw, 80);
  if (!text) return true;
  if (TEMPORAL_LEAD_IN_RE.test(text)) return true;
  if (STRUCTURED_PREFIX_RE.test(text)) return true;
  if (looksLikeTaskRestart(text)) return true;
  if (looksLikeTripPhaseCueText(text)) return true;
  if (looksLikeAbstractTravelModeText(text)) return true;
  if (looksLikeAbstractPlaceText(text)) return true;
  if (looksLikeDiscourseFragmentText(text)) return true;
  if (looksLikeFallbackPlanText(text)) return true;
  if (looksLikeMovementFragmentText(text)) return true;
  if (looksLikeLodgingSequenceFragmentText(text)) return true;
  if (SUB_LOCATION_HINT_RE.test(text)) return true;
  return false;
}

function normalizeDestinationCandidate(raw: string): string {
  const city = normalizeDestination(raw || "");
  if (!city) return "";
  if (!isLikelyDestinationCandidate(city)) return "";
  if (looksLikeDestinationNoise(city)) return "";
  return city;
}

function normalizeSubLocationCandidate(raw: string): string {
  const text = cleanStatement(raw, 48);
  if (!text) return "";
  if (TEMPORAL_LEAD_IN_RE.test(text)) return "";
  if (looksLikeTaskRestart(text)) return "";
  if (looksLikeTripPhaseCueText(text)) return "";
  return text;
}

function isPaceDensityText(raw: string): boolean {
  const text = cleanStatement(raw, 120);
  if (!text) return false;
  return PACE_DENSITY_RE.test(text) || LOW_HASSLE_TRAVEL_RE.test(text);
}

function hasExplicitLodgingCue(raw: string): boolean {
  return LODGING_SPECIFIC_RE.test(cleanStatement(raw, 120));
}

function hasExplicitActivityCue(raw: string): boolean {
  return ACTIVITY_SPECIFIC_RE.test(cleanStatement(raw, 120));
}

function normalizePaceText(raw: string): string {
  return cleanStatement(raw, 96);
}

function prefersSource(source: SlotCandidateSource): number {
  if (source === "heuristic") return 4;
  if (source === "function_call") return 3;
  if (source === "history_merge") return 2;
  return 1;
}

function pushCandidate<T>(
  out: SlotCandidate[],
  slotFamily: string,
  semanticBucket: SemanticBucket,
  source: SlotCandidateSource,
  value: T,
  extras?: Partial<Omit<SlotCandidate<T>, "slotFamily" | "semanticBucket" | "source" | "value">>
) {
  if (value == null) return;
  out.push({
    slotFamily,
    semanticBucket,
    source,
    value,
    ...extras,
  });
}

function collectCandidates(params: {
  signals: IntentSignals;
  latestSignals?: IntentSignals;
  functionSignals?: IntentSignals;
  historySignals?: IntentSignals;
}): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const sources: Array<[SlotCandidateSource, IntentSignals | undefined]> = [
    ["history_merge", params.historySignals],
    ["heuristic", params.latestSignals],
    ["function_call", params.functionSignals],
    ["graph_context", params.signals],
  ];

  for (const [source, signals] of sources) {
    if (!signals) continue;
    for (const destination of signals.destinations || []) {
      pushCandidate(out, "destination", "destination", source, destination, {
        evidence: signals.destinationEvidence,
        importance: signals.destinationImportance,
      });
    }
    if (signals.destination) {
      pushCandidate(out, "destination", "destination", source, signals.destination, {
        evidence: signals.destinationEvidence,
        importance: signals.destinationImportance,
      });
    }
    for (const item of signals.subLocations || []) {
      pushCandidate(out, "sub_location", "sub_location", source, item.name, {
        evidence: item.evidence,
        importance: item.importance,
        hard: item.hard,
      });
    }
    if (signals.durationDays != null) {
      pushCandidate(out, "duration", "total_duration", source, signals.durationDays, {
        evidence: signals.durationEvidence,
        importance: signals.durationImportance,
      });
    }
    for (const item of signals.cityDurations || []) {
      pushCandidate(out, "city_duration", "city_duration", source, `${item.city}:${item.days}`, {
        evidence: item.evidence,
      });
    }
    if (signals.peopleCount != null) {
      pushCandidate(out, "people", "people", source, signals.peopleCount, {
        evidence: signals.peopleEvidence,
        importance: signals.peopleImportance,
      });
    }
    if (signals.budgetCny != null) {
      pushCandidate(out, "budget", "budget", source, signals.budgetCny, {
        evidence: signals.budgetEvidence,
        importance: signals.budgetImportance,
      });
    }
    for (const item of signals.genericConstraints || []) {
      if (!isPaceDensityText(item.text) && !isPaceDensityText(item.evidence || "")) continue;
      pushCandidate(out, "generic_constraint", "pace_density", source, item.text, {
        evidence: item.evidence,
        importance: item.importance,
        hard: item.hard,
      });
    }
    if (signals.activityPreference && isPaceDensityText(signals.activityPreference)) {
      pushCandidate(out, "activity_preference", "pace_density", source, signals.activityPreference, {
        evidence: signals.activityPreferenceEvidence,
        importance: signals.activityPreferenceImportance,
        hard: signals.activityPreferenceHard,
      });
    }
    if (signals.lodgingPreference && isPaceDensityText(signals.lodgingPreference)) {
      pushCandidate(out, "lodging_preference", "pace_density", source, signals.lodgingPreference, {
        evidence: signals.lodgingPreferenceEvidence,
        importance: signals.lodgingPreferenceImportance,
        hard: signals.lodgingPreferenceHard,
      });
    }
  }
  return out;
}

function pickPrimaryPaceCandidate(candidates: SlotCandidate[]): SlotCandidate | null {
  const ranked = candidates
    .filter((item) => item.semanticBucket === "pace_density")
    .slice()
    .sort((a, b) => {
      const familyRank = (candidate: SlotCandidate) => {
        if (candidate.slotFamily === "generic_constraint") return 3;
        if (candidate.slotFamily === "activity_preference") return 2;
        return 1;
      };
      const familyDiff = familyRank(b) - familyRank(a);
      if (familyDiff !== 0) return familyDiff;
      const sourceDiff = prefersSource(b.source) - prefersSource(a.source);
      if (sourceDiff !== 0) return sourceDiff;
      return clampImportance(b.importance, 0.78) - clampImportance(a.importance, 0.78);
    });
  return ranked[0] || null;
}

function localizeIssue(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function validateDestinations(
  next: IntentSignals,
  issues: ValidationIssue[],
  stableDestinationHints: string[],
  locale?: AppLocale
) {
  const promotedSubLocations: NonNullable<IntentSignals["subLocations"]> = [];
  const validDestinations = dedupeStrings(
    (next.destinations || []).flatMap((item) => {
      const normalized = normalizeDestinationCandidate(item);
      if (normalized) return [normalized];
      const subLocation = normalizeSubLocationCandidate(item);
      const parentCity = stableDestinationHints.find((city) => city && city !== normalizeDestination(item || ""));
      if (subLocation && parentCity && SUB_LOCATION_HINT_RE.test(subLocation)) {
        promotedSubLocations.push({
          name: subLocation,
          parentCity,
          evidence: cleanStatement(item || subLocation, 60),
          kind: "poi",
          hard: false,
          importance: 0.72,
        });
      }
      return [];
    })
  );
  for (const raw of next.destinations || []) {
    const normalized = normalizeDestinationCandidate(raw);
    if (raw && !normalized && !promotedSubLocations.some((item) => item.name === cleanStatement(raw, 48))) {
      issues.push({
        field: "destinations",
        code: "filtered_destination_noise",
        message: localizeIssue(locale, "已过滤非目的地噪声候选", "Filtered a non-destination candidate"),
        source: "graph_context",
        semanticBucket: "destination",
        value: cleanStatement(raw, 60),
      });
    }
  }
  next.destinations = validDestinations.length ? validDestinations.slice(0, 8) : undefined;
  const primary = normalizeDestinationCandidate(next.destination || "");
  next.destination = primary || next.destinations?.[0];
  if (!next.destination) {
    next.destinationEvidence = undefined;
  }

  next.cityDurations = (next.cityDurations || [])
    .map((item) => ({
      ...item,
      city: normalizeDestinationCandidate(item.city || ""),
      evidence: cleanStatement(item.evidence || "", 80),
    }))
    .filter((item) => {
      if (!item.city) {
        issues.push({
          field: "cityDurations",
          code: "filtered_city_duration_noise",
          message: localizeIssue(locale, "已过滤无效城市时长候选", "Filtered an invalid city-duration candidate"),
          source: "graph_context",
          semanticBucket: "city_duration",
          value: cleanStatement(item.evidence || "", 60),
        });
        return false;
      }
      const days = Number(item.days) || 0;
      return days > 0 && days <= 365;
    });
  if (!next.cityDurations?.length) next.cityDurations = undefined;

  next.subLocations = (next.subLocations || [])
    .map((item) => {
      const name = normalizeSubLocationCandidate(item.name || "");
      const parentCity = normalizeDestinationCandidate(item.parentCity || "");
      return {
        ...item,
        name,
        parentCity: parentCity || undefined,
        evidence: cleanStatement(item.evidence || item.name || "", 60),
      };
    })
    .filter((item) => !!item.name);
  for (const promoted of promotedSubLocations) {
    const exists = (next.subLocations || []).some(
      (item) =>
        cleanStatement(item.name || "", 48).toLowerCase() === cleanStatement(promoted.name || "", 48).toLowerCase() &&
        normalizeDestination(item.parentCity || "") === normalizeDestination(promoted.parentCity || "")
    );
    if (!exists) {
      issues.push({
        field: "destinations",
        code: "destination_reclassified_as_sub_location",
        message: localizeIssue(locale, "已将子地点候选归并到子地点槽位", "Reclassified a venue-like destination as a sub-location"),
        source: "graph_context",
        semanticBucket: "sub_location",
        value: promoted.name,
      });
      next.subLocations = [...(next.subLocations || []), promoted];
    }
  }
  if (!next.subLocations?.length) next.subLocations = undefined;
}

function validateScalarSlots(next: IntentSignals, issues: ValidationIssue[], locale?: AppLocale) {
  const days = Number(next.durationDays) || 0;
  if (next.durationDays != null && (days <= 0 || days > 365)) {
    issues.push({
      field: "durationDays",
      code: "invalid_total_duration",
      message: localizeIssue(locale, "已过滤异常总时长", "Filtered an invalid total duration"),
      source: "graph_context",
      semanticBucket: "total_duration",
      value: String(next.durationDays),
    });
    next.durationDays = undefined;
    next.durationEvidence = undefined;
  }

  const people = Number(next.peopleCount) || 0;
  if (next.peopleCount != null && (people <= 0 || people > 200)) {
    issues.push({
      field: "peopleCount",
      code: "invalid_people_count",
      message: localizeIssue(locale, "已过滤异常人数", "Filtered an invalid people count"),
      source: "graph_context",
      semanticBucket: "people",
      value: String(next.peopleCount),
    });
    next.peopleCount = undefined;
    next.peopleEvidence = undefined;
  }

  const budget = Number(next.budgetCny);
  if (next.budgetCny != null && (!Number.isFinite(budget) || budget <= 0 || budget > 100000000)) {
    issues.push({
      field: "budgetCny",
      code: "invalid_budget",
      message: localizeIssue(locale, "已过滤异常预算", "Filtered an invalid budget"),
      source: "graph_context",
      semanticBucket: "budget",
      value: String(next.budgetCny),
    });
    next.budgetCny = undefined;
    next.budgetEvidence = undefined;
  }
}

function arbitratePaceDensity(
  next: IntentSignals,
  candidates: SlotCandidate[],
  issues: ValidationIssue[],
  locale?: AppLocale
) {
  const paceCandidates = candidates.filter((item) => item.semanticBucket === "pace_density");
  if (!paceCandidates.length) return;

  const primary = pickPrimaryPaceCandidate(paceCandidates);
  if (!primary) return;
  const bestText = normalizePaceText(String(primary.value || primary.evidence || ""));
  const bestEvidence = normalizePaceText(primary.evidence || String(primary.value || ""));
  if (!bestText) return;

  const remainingGenerics = (next.genericConstraints || []).filter(
    (item) => !isPaceDensityText(item.text || "") && !isPaceDensityText(item.evidence || "")
  );
  const paceConstraint = {
    text: bestText,
    evidence: bestEvidence || bestText,
    kind: "mobility" as GenericConstraintKind,
    hard: primary.hard !== false,
    severity: "high" as const,
    importance: clampImportance(primary.importance, primary.hard !== false ? 0.84 : 0.76),
  };
  next.genericConstraints = dedupeClassifiedConstraints([paceConstraint, ...remainingGenerics]);

  if (next.activityPreference && isPaceDensityText(next.activityPreference) && !hasExplicitActivityCue(next.activityPreferenceEvidence || next.activityPreference)) {
    issues.push({
      field: "activityPreference",
      code: "pace_density_promoted_to_generic_constraint",
      message: localizeIssue(
        locale,
        "已将节奏/强度语义收敛为单一约束节点",
        "Collapsed pace-density language into a single constraint node"
      ),
      source: "graph_context",
      semanticBucket: "pace_density",
      value: cleanStatement(next.activityPreference, 60),
    });
    next.activityPreference = undefined;
    next.activityPreferenceEvidence = undefined;
    next.activityPreferenceHard = undefined;
    next.activityPreferenceImportance = undefined;
  }

  if (next.lodgingPreference && isPaceDensityText(next.lodgingPreference) && !hasExplicitLodgingCue(next.lodgingPreferenceEvidence || next.lodgingPreference)) {
    issues.push({
      field: "lodgingPreference",
      code: "pace_density_removed_from_lodging",
      message: localizeIssue(
        locale,
        "已移除误归类到住宿偏好的节奏语义",
        "Removed pace-density language from lodging preference"
      ),
      source: "graph_context",
      semanticBucket: "pace_density",
      value: cleanStatement(next.lodgingPreference, 60),
    });
    next.lodgingPreference = undefined;
    next.lodgingPreferenceEvidence = undefined;
    next.lodgingPreferenceHard = undefined;
    next.lodgingPreferenceImportance = undefined;
  }
}

export function validateTravelCoreSlots(params: {
  signals: IntentSignals;
  latestSignals?: IntentSignals;
  functionSignals?: IntentSignals;
  historySignals?: IntentSignals;
  locale?: AppLocale;
}): SlotValidationResult {
  const next = cloneSignals(params.signals || {});
  const candidates = collectCandidates(params);
  const issues: ValidationIssue[] = [];
  const stableDestinationHints = dedupeStrings(
    [
      ...(next.destinations || []),
      next.destination || "",
      ...(params.historySignals?.destinations || []),
      params.historySignals?.destination || "",
    ]
      .map((item) => normalizeDestinationCandidate(item))
      .filter(Boolean)
  ).slice(0, 4);

  validateDestinations(next, issues, stableDestinationHints, params.locale);
  validateScalarSlots(next, issues, params.locale);
  arbitratePaceDensity(next, candidates, issues, params.locale);

  return {
    signals: next,
    issues,
    candidates,
  };
}
