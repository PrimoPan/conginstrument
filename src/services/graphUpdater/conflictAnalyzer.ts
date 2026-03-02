import { cleanStatement } from "./text.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

export type LimitingFactorInput = {
  text: string;
  kind: string;
  hard: boolean;
  severity?: "medium" | "high" | "critical";
  importance: number;
};

export type ConflictInsight = {
  key: string;
  statement: string;
  severity: "medium" | "high" | "critical";
  importance: number;
  relatedTypes: Array<
    "budget" | "lodging" | "duration_total" | "destination" | "scenic_preference" | "limiting_factor" | "people"
  >;
  evidence: string[];
};

export type ConflictAnalyzeInput = {
  budgetCny?: number;
  lodgingPreference?: string;
  scenicPreference?: string;
  peopleCount?: number;
  totalDays?: number;
  destinations?: string[];
  limitingFactors?: LimitingFactorInput[];
  locale?: AppLocale;
};

const LUXURY_LODGING_RE = /五星|豪华|高档|奢华|五星级|luxury|five\s*star/i;
const HIGH_INTENSITY_SCENIC_RE = /徒步|爬山|登山|高强度|长距离|暴走|越野|探险|hiking|trekking/i;
const DESTINATION_NOISE_RE =
  /(一个人|独自|自己|我们|我和|父母|家人|全家|去|前往|抵达|飞到|旅游|旅行|游玩|玩|现场观看|看球|比赛|球赛|预算|人民币|安全一点|地方吧|当地|本地|本市|本城|这边|那边|只含当地|仅含当地|含当地|比较好|更好|好一点|安全感)/i;

function clamp01(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function dedupeConflicts(items: ConflictInsight[]): ConflictInsight[] {
  const out = new Map<string, ConflictInsight>();
  for (const it of items) {
    const key = cleanStatement(it.key || "", 80).toLowerCase();
    if (!key) continue;
    const prev = out.get(key);
    if (!prev || (it.importance || 0) > (prev.importance || 0)) out.set(key, it);
  }
  return Array.from(out.values());
}

function normalizeDestinationForConflict(raw: string): string {
  let s = normalizeDestination(raw || "");
  if (!s) return "";
  s = s
    .replace(/^(?:我(?:和[^，。；\s]{0,8})?|我们(?:一家[三四五六七八九十]口)?|一个人|独自|自己|和父母|跟父母|带父母|陪父母|与父母|父母|家人|全家)\s*(?:去|到|前往|飞到|抵达)\s*/i, "")
    .replace(/^(?:去|到|前往|飞到|抵达)\s*/i, "")
    .replace(/(?:旅游|旅行|游玩|玩|出行)$/i, "")
    .trim();
  s = normalizeDestination(s);
  if (!s || DESTINATION_NOISE_RE.test(s)) return "";
  if (/^(?:只|仅)?含当地$|^(?:比较|更|稍微)?好(?:一点)?$/i.test(s)) return "";
  if (/^(?:安全|安静|方便|便宜|舒适|舒服|热闹|清净)(?:一点)?$/i.test(s)) return "";
  if (!isLikelyDestinationCandidate(s)) return "";
  return s;
}

function compactDestinationsForConflict(list: string[]): string[] {
  const sorted = list
    .slice()
    .map((x) => normalizeDestinationForConflict(x))
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  if (!sorted.length) return [];

  const out: string[] = [];
  for (const cur of sorted) {
    const isNearDuplicate = out.some((k) => {
      if (k === cur) return true;
      const short = k.length <= cur.length ? k : cur;
      const long = k.length > cur.length ? k : cur;
      return short.length >= 2 && long.includes(short);
    });
    if (!isNearDuplicate) out.push(cur);
  }
  return Array.from(new Set(out)).slice(0, 8);
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

export function analyzeConstraintConflicts(input: ConflictAnalyzeInput): ConflictInsight[] {
  const locale = input.locale;
  const out: ConflictInsight[] = [];
  const destinations = compactDestinationsForConflict(input.destinations || []);
  const limiting = input.limitingFactors || [];
  const hardLimiting = limiting.filter((x) => x.hard);

  if (input.budgetCny && input.lodgingPreference && LUXURY_LODGING_RE.test(input.lodgingPreference)) {
    const days = Math.max(1, Number(input.totalDays) || 1);
    const people = Math.max(1, Number(input.peopleCount) || 1);
    const perPersonPerDay = input.budgetCny / days / people;
    if (perPersonPerDay < 1400) {
      const high = perPersonPerDay < 900;
      out.push({
        key: "budget_lodging",
        statement: t(
          locale,
          `预算与住宿偏好可能冲突（估算人均日预算约${Math.round(perPersonPerDay)}元）`,
          `Budget may conflict with lodging preference (estimated per-person daily budget: ${Math.round(perPersonPerDay)} CNY)`
        ),
        severity: high ? "high" : "medium",
        importance: high ? 0.86 : 0.78,
        relatedTypes: ["budget", "lodging"],
        evidence: [
          cleanStatement(t(locale, `预算${input.budgetCny}元`, `Budget ${input.budgetCny} CNY`), 40),
          cleanStatement(input.lodgingPreference, 40),
        ],
      });
    }
  }

  if (destinations.length >= 2 && input.totalDays && input.totalDays < destinations.length * 2) {
    out.push({
      key: "duration_destination_density",
      statement: t(
        locale,
        `目的地数量与总时长可能冲突（${destinations.length}个目的地仅${input.totalDays}天）`,
        `Destination count may conflict with total duration (${destinations.length} destinations in ${input.totalDays} days)`
      ),
      severity: "high",
      importance: 0.84,
      relatedTypes: ["duration_total", "destination"],
      evidence: [
        cleanStatement(destinations.join(isEnglishLocale(locale) ? " / " : "、"), 60),
        t(locale, `${input.totalDays}天`, `${input.totalDays} days`),
      ],
    });
  }

  if (input.scenicPreference && HIGH_INTENSITY_SCENIC_RE.test(input.scenicPreference)) {
    const hasMobilityRisk = limiting.some((x) =>
      /(health|mobility)/i.test(x.kind) || /不能久走|不能爬|行动不便|高强度/.test(x.text)
    );
    if (hasMobilityRisk) {
      out.push({
        key: "mobility_scenic_conflict",
        statement: t(
          locale,
          "活动强度偏好与限制因素可能冲突（需降低强度或调整节奏）",
          "Activity intensity preference may conflict with constraints (reduce intensity or adjust pace)"
        ),
        severity: "high",
        importance: 0.88,
        relatedTypes: ["scenic_preference", "limiting_factor"],
        evidence: [
          cleanStatement(input.scenicPreference, 48),
          cleanStatement(limiting.find((x) => /(health|mobility)/i.test(x.kind))?.text || "", 48),
        ].filter(Boolean),
      });
    }
  }

  if (hardLimiting.length >= 3 && (input.totalDays || 0) > 0 && (input.totalDays || 0) <= 5) {
    out.push({
      key: "too_many_hard_constraints",
      statement: t(
        locale,
        "硬限制较多且时长较短，行程可执行性风险较高",
        "Many hard constraints with short duration may reduce plan feasibility"
      ),
      severity: "medium",
      importance: 0.8,
      relatedTypes: ["limiting_factor", "duration_total"],
      evidence: [
        t(locale, `硬限制数量: ${hardLimiting.length}`, `Hard constraints: ${hardLimiting.length}`),
        t(locale, `${input.totalDays}天`, `${input.totalDays} days`),
      ],
    });
  }

  return dedupeConflicts(out).sort((a, b) => (b.importance || 0) - (a.importance || 0));
}
