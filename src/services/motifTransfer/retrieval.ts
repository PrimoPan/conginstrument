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

function toTokens(input: string): Set<string> {
  const text = clean(input, 1200).toLowerCase();
  const parts = text.match(/[\u4e00-\u9fff]{1,4}|[a-z0-9]{2,24}/g) || [];
  return new Set(parts);
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
  motifLibrary: MotifLibraryEntryPayload[];
  existingState?: MotifTransferState;
  maxCount?: number;
}): MotifTransferRecommendation[] {
  const now = new Date().toISOString();
  const activeText = activeTaskText(params.travelPlanState || null);
  const activeTokens = toTokens(activeText);
  const maxCount = Math.max(1, Math.min(Number(params.maxCount || 4), 6));
  const candidates = (params.motifLibrary || [])
    .map((entry) => {
      const version = entry.versions.find((v) => v.version_id === entry.current_version_id) || entry.versions[entry.versions.length - 1];
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
      const lexicalScore = overlapScore(activeTokens, entryTokens);
      const confidence = Number(entry?.usage_stats?.transfer_confidence || 0.7);
      const statusPenalty = entry.status === "deprecated" || entry.status === "cancelled" ? 0.18 : 0;
      const score = Math.max(
        0,
        Math.min(1, lexicalScore * 0.62 + confidence * 0.32 + (entry.usage_stats?.adopted_count || 0) * 0.01 - statusPenalty)
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
      } as MotifTransferRecommendation;
    })
    .sort((a, b) => b.match_score - a.match_score || a.motif_type_id.localeCompare(b.motif_type_id));

  if (!candidates.length) return [];
  const desiredCount = Math.min(maxCount, candidates.length);
  const minCount = candidates.length >= 2 ? Math.min(2, desiredCount) : 1;
  return candidates.slice(0, Math.max(minCount, desiredCount));
}
