import type { TravelPlanState } from "../travelPlan/state.js";
import type {
  MotifLibraryEntryPayload,
  MotifTransferRecommendation,
  MotifTransferState,
  TransferDecisionStatus,
  TransferRecommendedMode,
} from "./types.js";
import { t } from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isAlgoV3Enabled(): boolean {
  const raw = String(process.env.CI_ALGO_V3 || "").trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function toTokens(input: string): Set<string> {
  const text = clean(input, 1200).toLowerCase();
  const parts = text.match(/[\u4e00-\u9fff]{1,16}|[a-z0-9]{2,24}/g) || [];
  const out = new Set<string>();
  for (const part of parts) {
    if (/^[a-z0-9]{2,24}$/i.test(part)) {
      out.add(part);
      continue;
    }
    const chunk = clean(part, 16);
    if (!chunk) continue;
    if (chunk.length <= 4) out.add(chunk);
    const maxGram = Math.min(4, chunk.length);
    for (let size = 2; size <= maxGram; size += 1) {
      for (let i = 0; i + size <= chunk.length; i += 1) {
        out.add(chunk.slice(i, i + size));
      }
    }
  }
  return out;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) {
    if (b.has(token)) hit += 1;
  }
  const denom = Math.max(a.size, b.size, 1);
  return hit / denom;
}

function overlapScoreArray(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a.map((x) => clean(x, 32).toLowerCase()).filter(Boolean));
  const sb = new Set(b.map((x) => clean(x, 32).toLowerCase()).filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let hit = 0;
  for (const token of sa) if (sb.has(token)) hit += 1;
  const denom = sa.size + sb.size - hit;
  return denom > 0 ? hit / denom : 0;
}

function activeTaskText(plan: TravelPlanState | null | undefined): string {
  if (!plan) return "";
  const parts = [
    Array.isArray(plan.destination_scope) ? plan.destination_scope.join(" ") : "",
    Array.isArray(plan.destinations) ? plan.destinations.join(" ") : "",
    clean((plan as any)?.travel_dates_or_duration, 120),
    clean((plan as any)?.trip_goal_summary || (plan as any)?.summary, 220),
    Array.isArray((plan as any)?.constraints) ? (plan as any).constraints.slice(0, 8).join(" ") : "",
    Array.isArray((plan as any)?.travelers) ? (plan as any).travelers.slice(0, 6).join(" ") : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function hintText(input: any): string {
  return clean(input, 220);
}

function taskStructureSignals(plan: TravelPlanState | null | undefined): string[] {
  const text = activeTaskText(plan);
  const out: string[] = [];
  if (/预算|budget|cost|花费|cny|usd|eur|hkd/i.test(text)) out.push("budget");
  if (/天|day|days|时长|duration|行程长度/i.test(text)) out.push("duration");
  if (/住宿|hotel|airbnb|lodging/i.test(text)) out.push("lodging");
  if (/活动|activity|节奏|pace|强度|intensity/i.test(text)) out.push("activity");
  if (/安全|safety|治安|risk|危险/i.test(text)) out.push("safety");
  if (/交通|metro|subway|logistics|换乘|transfer/i.test(text)) out.push("logistics");
  if (/饮食|diet|halal|kosher|vegan|vegetarian/i.test(text)) out.push("diet");
  if (/健康|health|身体|无障碍|mobility|行动|轮椅/i.test(text)) out.push("health");
  if (/宗教|religion|礼拜|church|mosque|temple/i.test(text)) out.push("religion");
  if (/语言|language|英文|中文|translation|翻译/i.test(text)) out.push("language");
  if (/行动不便|mobility|stairs|步行距离|wheelchair/i.test(text)) out.push("mobility");
  return Array.from(new Set(out));
}

function entryStructureSignals(params: {
  entry: MotifLibraryEntryPayload;
  entryText: string;
  versionUpdatedAt?: string;
}): string[] {
  const out: string[] = [];
  const dep = clean(params.entry.dependency, 40).toLowerCase();
  if (dep) out.push(`dep:${dep}`);
  for (const lv of params.entry.abstraction_levels || []) out.push(`lv:${clean(lv, 8).toLowerCase()}`);
  const text = clean(params.entryText, 360);
  if (/预算|budget|cost|花费|cny|usd|eur|hkd/i.test(text)) out.push("budget");
  if (/天|day|days|时长|duration/i.test(text)) out.push("duration");
  if (/住宿|hotel|airbnb|lodging/i.test(text)) out.push("lodging");
  if (/活动|activity|节奏|pace|强度|intensity/i.test(text)) out.push("activity");
  if (/安全|safety|治安|risk|危险/i.test(text)) out.push("safety");
  if (/交通|metro|subway|logistics|换乘|transfer/i.test(text)) out.push("logistics");
  if (/饮食|diet|halal|kosher|vegan|vegetarian/i.test(text)) out.push("diet");
  if (/健康|health|身体|无障碍|行动不便|mobility|轮椅/i.test(text)) out.push("health");
  if (/宗教|religion|礼拜|church|mosque|temple/i.test(text)) out.push("religion");
  if (/语言|language|英文|中文|translation|翻译/i.test(text)) out.push("language");
  if (/行动不便|mobility|stairs|步行距离|wheelchair/i.test(text)) out.push("mobility");
  if (clean(params.versionUpdatedAt, 40)) out.push("has_recent_version");
  return Array.from(new Set(out));
}

function daysSince(iso?: string): number {
  const ts = Date.parse(String(iso || ""));
  if (!Number.isFinite(ts)) return 365;
  const delta = Date.now() - ts;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return delta / (1000 * 60 * 60 * 24);
}

function entryBelongsToTask(params: {
  entry: MotifLibraryEntryPayload;
  taskId?: string;
  conversationId?: string;
}): boolean {
  const taskId = clean(params.taskId, 80);
  const conversationId = clean(params.conversationId, 80);
  if (!taskId && !conversationId) return false;
  const currentVersion =
    params.entry.versions.find((v) => clean(v.version_id, 120) === clean(params.entry.current_version_id, 120)) ||
    params.entry.versions[params.entry.versions.length - 1];
  if (taskId) {
    const sourceTaskIds = Array.isArray(params.entry.source_task_ids) ? params.entry.source_task_ids : [];
    if (sourceTaskIds.some((x) => clean(x, 80) === taskId)) return true;
    if (clean(currentVersion?.source_task_id, 80) === taskId) return true;
  }
  if (conversationId && clean(currentVersion?.source_conversation_id, 80) === conversationId) return true;
  return false;
}

const MIN_TRANSFER_RECOMMENDATION_SCORE = 0.35;

function mmrSelect<T>(items: T[], limit: number, lambda: number, score: (x: T) => number, sim: (a: T, b: T) => number): T[] {
  const selected: T[] = [];
  const pool = items.slice();
  while (pool.length && selected.length < limit) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const relevance = score(candidate);
      const maxSim = selected.length ? Math.max(...selected.map((s) => sim(candidate, s))) : 0;
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}

function modeFromEntry(entry: MotifLibraryEntryPayload): TransferRecommendedMode {
  const confidence = Number(entry?.usage_stats?.transfer_confidence || 0.7);
  if (entry.status === "cancelled" || entry.status === "deprecated") return "C";
  if (entry.status === "uncertain" || confidence < 0.75) return "B";
  return "A";
}

function decisionStatusForCandidate(
  state: MotifTransferState | undefined,
  candidateId: string
): TransferDecisionStatus {
  if (!state?.decisions?.length) return "pending";
  const decision = [...state.decisions]
    .reverse()
    .find((x) => clean(x.candidate_id, 220) === candidateId);
  return decision?.decision_status || "pending";
}

export function buildTransferRecommendations(params: {
  locale?: "zh-CN" | "en-US";
  conversationId: string;
  currentTaskId: string;
  travelPlanState?: TravelPlanState | null;
  retrievalHints?: {
    sourceTaskId?: string;
    sourceConversationId?: string;
    keepConsistentText?: string;
    carryHealthReligion?: boolean;
    carryStableProfile?: boolean;
  };
  motifLibrary: MotifLibraryEntryPayload[];
  existingState?: MotifTransferState;
  maxCount?: number;
}): MotifTransferRecommendation[] {
  const now = new Date().toISOString();
  const algoV3 = isAlgoV3Enabled();
  const activeText = [activeTaskText(params.travelPlanState || null), hintText(params.retrievalHints?.keepConsistentText)]
    .filter(Boolean)
    .join(" ");
  const activeTokens = toTokens(activeText);
  const taskSignals = taskStructureSignals(params.travelPlanState || null);
  const carryStableProfile = params.retrievalHints?.carryStableProfile !== false;
  const carryHealthReligion = params.retrievalHints?.carryHealthReligion !== false;
  const sourceTaskId = clean(params.retrievalHints?.sourceTaskId, 80);
  const sourceConversationId = clean(params.retrievalHints?.sourceConversationId, 80);
  const maxCount = Math.max(1, Math.min(Number(params.maxCount || 4), 6));
  const scoredCandidates = (params.motifLibrary || [])
    .filter((entry) => {
      if (entryBelongsToTask({ entry, taskId: params.currentTaskId, conversationId: params.conversationId })) return false;
      if (sourceTaskId || sourceConversationId) {
        return entryBelongsToTask({ entry, taskId: sourceTaskId, conversationId: sourceConversationId });
      }
      return true;
    })
    .map((entry) => {
      const version = entry.versions.find((v) => v.version_id === entry.current_version_id) || entry.versions[entry.versions.length - 1];
      const scopedMatch =
        (sourceTaskId || sourceConversationId) &&
        entryBelongsToTask({ entry, taskId: sourceTaskId, conversationId: sourceConversationId });
      const entryText = [
        clean(entry.motif_type_title, 160),
        clean(version?.title, 160),
        clean(version?.reusable_description, 220),
        clean(version?.abstraction_levels?.L1, 160),
        clean(version?.abstraction_levels?.L2, 160),
        clean(version?.abstraction_levels?.L3, 160),
      ]
        .filter(Boolean)
        .join(" ");
      const entryTokens = toTokens(entryText);
      const semanticMatch = overlapScore(activeTokens, entryTokens);
      const structureSignals = entryStructureSignals({
        entry,
        entryText,
        versionUpdatedAt: version?.updated_at,
      });
      const stableProfilePenalty =
        !carryStableProfile &&
        structureSignals.some((signal) =>
          ["health", "religion", "language", "mobility", "diet", "safety"].includes(signal)
        )
          ? 0.18
          : 0;
      const healthReligionPenalty =
        !carryHealthReligion &&
        structureSignals.some((signal) => signal === "health" || signal === "religion")
          ? 0.18
          : 0;
      const structuralMatch = overlapScoreArray(taskSignals, structureSignals);
      const adopted = Number(entry.usage_stats?.adopted_count || 0);
      const ignored = Number(entry.usage_stats?.ignored_count || 0);
      const prior = adopted / Math.max(1, adopted + ignored + 1);
      const usagePrior = Math.max(
        0,
        Math.min(1, prior * 0.62 + Number(entry?.usage_stats?.transfer_confidence || 0.7) * 0.38)
      );
      const stalenessPenalty = Math.max(0, Math.min(0.45, daysSince(version?.updated_at || version?.created_at) / 900));
      const statusPenalty = entry.status === "deprecated" || entry.status === "cancelled" ? 0.22 : 0;
      const scopeBoost = scopedMatch ? 0.18 : 0;
      const score = algoV3
        ? Math.max(
            0,
            Math.min(
              1,
              semanticMatch * 0.52 +
                structuralMatch * 0.2 +
                usagePrior * 0.18 -
                stalenessPenalty * 0.1 +
                scopeBoost -
                stableProfilePenalty -
                healthReligionPenalty -
                statusPenalty
            )
          )
        : Math.max(
            0,
            Math.min(
              1,
                semanticMatch * 0.62 +
                Number(entry?.usage_stats?.transfer_confidence || 0.7) * 0.32 +
                (entry.usage_stats?.adopted_count || 0) * 0.01 +
                scopeBoost -
                stableProfilePenalty -
                healthReligionPenalty -
                statusPenalty
            )
          );
      const mode = modeFromEntry(entry);
      const candidateId = clean(`${entry.motif_type_id}::${entry.current_version_id}`, 220);
      const decisionStatus = decisionStatusForCandidate(params.existingState, candidateId);
      const decisionAt =
        params.existingState?.decisions
          ?.slice()
          .reverse()
          .find((x) => clean(x.candidate_id, 220) === candidateId)?.decided_at || undefined;

      return {
        candidate_id: candidateId,
        motif_type_id: clean(entry.motif_type_id, 180),
        motif_type_title: clean(entry.motif_type_title, 180) || clean(version?.title, 180),
        dependency: clean(entry.dependency, 40) || clean(version?.dependency, 40) || "enable",
        reusable_description:
          clean(version?.reusable_description, 240) ||
          clean(version?.abstraction_levels?.L2, 220) ||
          clean(version?.abstraction_levels?.L1, 220),
        source_task_id: clean(version?.source_task_id, 80) || clean(entry.source_task_ids?.[0], 80) || undefined,
        source_conversation_id: clean(version?.source_conversation_id, 80) || undefined,
        status: entry.status,
        reason:
          score >= 0.72
            ? t(
                params.locale,
                "与当前任务语境高度匹配，可优先评估是否沿用。",
                "High task-context match. Evaluate it first."
              )
            : t(
                params.locale,
                "与当前任务存在中等匹配，建议确认后再应用。",
                "Moderate match. Confirm before applying."
              ),
        match_score: Number(score.toFixed(4)),
        recommended_mode: mode,
        decision_status: decisionStatus,
        decision_at: decisionAt,
        created_at: now,
        _semantic_match: semanticMatch,
        _structural_match: structuralMatch,
        _tokens: Array.from(entryTokens).slice(0, 28),
      } as MotifTransferRecommendation;
    })
    .sort((a, b) => b.match_score - a.match_score || a.motif_type_id.localeCompare(b.motif_type_id));

  const eligibleCandidates = scoredCandidates.filter((x: any) => Number(x.match_score || 0) >= MIN_TRANSFER_RECOMMENDATION_SCORE);
  if (!eligibleCandidates.length) return [];
  const desiredCount = Math.min(maxCount, eligibleCandidates.length);
  const minCount = eligibleCandidates.length >= 2 ? Math.min(2, desiredCount) : 1;
  const selected = (algoV3
    ? mmrSelect(
        eligibleCandidates,
        Math.max(minCount, desiredCount),
        0.72,
        (x: any) => Number(x.match_score || 0),
        (a: any, b: any) => overlapScoreArray(a?._tokens || [], b?._tokens || [])
      )
    : eligibleCandidates.slice(0, Math.max(minCount, desiredCount))
  ).sort((a, b) => b.match_score - a.match_score || a.motif_type_id.localeCompare(b.motif_type_id));

  return selected.map((x: any) => {
    const { _semantic_match, _structural_match, _tokens, ...rest } = x || {};
    return rest as MotifTransferRecommendation;
  });
}
