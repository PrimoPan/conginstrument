import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

function cleanText(input: any, max = 160): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniq(arr: string[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr || []) {
    const value = cleanText(raw, 80).toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function hasAny(items: string[], expected: string[]): boolean {
  return items.some((item) => expected.includes(item));
}

function normalizeRelation(relation?: string): "enable" | "constraint" | "determine" | "conflicts_with" {
  const value = cleanText(relation, 40).toLowerCase();
  if (value === "constraint") return "constraint";
  if (value === "determine") return "determine";
  if (value === "conflicts_with") return "conflicts_with";
  return "enable";
}

export function genericMotifPatternTitle(params: {
  locale?: AppLocale;
  relation?: string;
}): string {
  const relation = normalizeRelation(params.relation);
  if (relation === "constraint") return t(params.locale, "先过滤不合适选项", "Filter out poor-fit options first");
  if (relation === "determine") return t(params.locale, "用关键条件锁定方案", "Lock the plan with core constraints");
  if (relation === "conflicts_with") return t(params.locale, "先澄清冲突条件", "Clarify conflicting conditions first");
  return t(params.locale, "按关键线索展开选择", "Expand the choice through key cues");
}

export function abstractMotifPatternTitle(params: {
  locale?: AppLocale;
  relation?: string;
  drivers?: string[];
  target?: string[];
}): string {
  const relation = normalizeRelation(params.relation);
  const drivers = uniq(params.drivers || [], 8);
  const target = uniq(params.target || [], 4);
  const hardConstraintDrivers = [
    "budget",
    "duration_total",
    "duration_city",
    "meeting_critical",
    "limiting_factor",
    "generic_constraint",
  ];
  const profileDrivers = ["people", "lodging"];
  const preferenceDrivers = ["activity_preference", "scenic_preference", "goal", "destination", "sub_location"];
  const planTargets = ["goal", "duration_total", "duration_city"];
  const placeTargets = ["destination", "sub_location", "lodging"];

  if (relation === "constraint") {
    if (hasAny(drivers, ["meeting_critical"])) {
      return t(params.locale, "围绕固定安排先收口", "Narrow the plan around fixed anchors first");
    }
    if (hasAny(drivers, hardConstraintDrivers) && hasAny(target, planTargets)) {
      return t(params.locale, "先按现实约束收紧范围", "Narrow the scope through real-world constraints first");
    }
    if (hasAny(drivers, hardConstraintDrivers) && hasAny(target, placeTargets)) {
      return t(params.locale, "先按现实约束过滤选项", "Filter options through real-world constraints first");
    }
    if (hasAny(drivers, [...profileDrivers, "limiting_factor"])) {
      return t(params.locale, "先做适配过滤", "Screen options for fit first");
    }
    return genericMotifPatternTitle(params);
  }

  if (relation === "determine") {
    if (hasAny(drivers, ["meeting_critical"])) {
      return t(params.locale, "围绕固定锚点锁定安排", "Lock the plan around fixed anchors");
    }
    if (hasAny(target, placeTargets)) {
      return t(params.locale, "用关键条件锁定落点", "Lock the choice with core constraints");
    }
    if (hasAny(target, planTargets)) {
      return t(params.locale, "用关键条件锁定方案", "Lock the plan with core constraints");
    }
    return t(params.locale, "用关键条件直接定方案", "Set the plan with core constraints");
  }

  if (relation === "conflicts_with") {
    return genericMotifPatternTitle(params);
  }

  if (
    hasAny(drivers, ["destination", "sub_location", "activity_preference", "scenic_preference"]) &&
    hasAny(target, [...placeTargets, "activity_preference"])
  ) {
    return t(params.locale, "先做情境匹配再选点", "Match the context before choosing places");
  }
  if (hasAny(drivers, profileDrivers)) {
    return t(params.locale, "让出行画像驱动筛选", "Let the traveler profile drive selection");
  }
  if (hasAny(drivers, preferenceDrivers)) {
    return t(params.locale, "让核心偏好驱动选择", "Let core preferences steer selection");
  }
  if (hasAny(drivers, hardConstraintDrivers)) {
    return t(params.locale, "按可行条件展开选择", "Expand options from feasible conditions");
  }
  return genericMotifPatternTitle(params);
}
