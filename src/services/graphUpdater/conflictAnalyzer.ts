import { cleanStatement } from "./text.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";

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
};

const LUXURY_LODGING_RE = /五星|豪华|高档|奢华|五星级|luxury|five\s*star/i;
const HIGH_INTENSITY_SCENIC_RE = /徒步|爬山|登山|高强度|长距离|暴走|越野|探险|hiking|trekking/i;

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

export function analyzeConstraintConflicts(input: ConflictAnalyzeInput): ConflictInsight[] {
  const out: ConflictInsight[] = [];
  const destinations = Array.from(
    new Set(
      (input.destinations || [])
        .map((x) => normalizeDestination(x || ""))
        .filter((x) => x && isLikelyDestinationCandidate(x))
    )
  ).slice(0, 8);
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
        statement: `预算与住宿偏好可能冲突（估算人均日预算约${Math.round(perPersonPerDay)}元）`,
        severity: high ? "high" : "medium",
        importance: high ? 0.86 : 0.78,
        relatedTypes: ["budget", "lodging"],
        evidence: [
          cleanStatement(`预算${input.budgetCny}元`, 40),
          cleanStatement(input.lodgingPreference, 40),
        ],
      });
    }
  }

  if (destinations.length >= 2 && input.totalDays && input.totalDays < destinations.length * 2) {
    out.push({
      key: "duration_destination_density",
      statement: `目的地数量与总时长可能冲突（${destinations.length}个目的地仅${input.totalDays}天）`,
      severity: "high",
      importance: 0.84,
      relatedTypes: ["duration_total", "destination"],
      evidence: [cleanStatement(destinations.join("、"), 60), `${input.totalDays}天`],
    });
  }

  if (input.scenicPreference && HIGH_INTENSITY_SCENIC_RE.test(input.scenicPreference)) {
    const hasMobilityRisk = limiting.some((x) =>
      /(health|mobility)/i.test(x.kind) || /不能久走|不能爬|行动不便|高强度/.test(x.text)
    );
    if (hasMobilityRisk) {
      out.push({
        key: "mobility_scenic_conflict",
        statement: "活动强度偏好与限制因素可能冲突（需降低强度或调整节奏）",
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
      statement: "硬限制较多且时长较短，行程可执行性风险较高",
      severity: "medium",
      importance: 0.8,
      relatedTypes: ["limiting_factor", "duration_total"],
      evidence: [`硬限制数量: ${hardLimiting.length}`, `${input.totalDays}天`],
    });
  }

  return dedupeConflicts(out).sort((a, b) => (b.importance || 0) - (a.importance || 0));
}
