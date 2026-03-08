import type { MotifTransferRevisionRequest, MotifTransferState } from "./types.js";
import { emptyMotifTransferState, t } from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function revisionRequestId() {
  return `mtr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type RevisionChoice = "overwrite" | "new_version";

export function detectExplicitNegation(userText: string): { hit: boolean; reason: string } {
  const text = clean(userText, 420).toLowerCase();
  if (!text) return { hit: false, reason: "" };
  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /(这次|本次).{0,8}(不适用|不要沿用|别沿用|不同于上次)/i, reason: "explicit_cross_task_negation" },
    { re: /(不是这样|不是这个|不对|不成立)/i, reason: "explicit_belief_negation" },
    { re: /(do not apply|not applicable|different from last time|don't reuse)/i, reason: "explicit_cross_task_negation_en" },
    { re: /(that's not true|this is wrong|not this rule)/i, reason: "explicit_belief_negation_en" },
  ];
  for (const p of patterns) {
    if (p.re.test(text)) return { hit: true, reason: p.reason };
  }
  return { hit: false, reason: "" };
}

export function registerRevisionRequestFromUtterance(params: {
  locale?: "zh-CN" | "en-US";
  currentState?: MotifTransferState | null;
  userText: string;
}): { state: MotifTransferState; request?: MotifTransferRevisionRequest; followupQuestion?: string } {
  const state: MotifTransferState = params.currentState
    ? {
        ...params.currentState,
        recommendations: [...(params.currentState.recommendations || [])],
        decisions: [...(params.currentState.decisions || [])],
        activeInjections: [...(params.currentState.activeInjections || [])],
        feedbackEvents: [...(params.currentState.feedbackEvents || [])],
        revisionRequests: [...(params.currentState.revisionRequests || [])],
      }
    : emptyMotifTransferState();

  const detected = detectExplicitNegation(params.userText);
  if (!detected.hit) return { state };

  const candidate = state.activeInjections.find((x) => x.injection_state === "injected");
  if (!candidate) return { state };
  const existsPending = state.revisionRequests.some(
    (x) =>
      x.status === "pending_user_choice" &&
      x.motif_type_id === candidate.motif_type_id &&
      x.candidate_id === candidate.candidate_id
  );
  if (existsPending) return { state };

  const now = new Date().toISOString();
  const affectedInjections = state.activeInjections
    .filter((x) => x.motif_type_id === candidate.motif_type_id)
    .map((x) => ({
      candidate_id: x.candidate_id,
      motif_type_id: x.motif_type_id,
      motif_type_title: x.motif_type_title,
      injection_state: x.injection_state,
      application_scope: x.application_scope,
      constraint_text: clean(x.constraint_text, 220),
    }));
  const request: MotifTransferRevisionRequest = {
    request_id: revisionRequestId(),
    candidate_id: candidate.candidate_id,
    motif_type_id: candidate.motif_type_id,
    reason: detected.reason || "explicit_negation_detected",
    detected_text: clean(params.userText, 220),
    detected_at: now,
    status: "pending_user_choice",
    options: ["overwrite", "new_version"],
    suggested_action: "new_version",
    affected_injections: affectedInjections,
  };
  state.revisionRequests = [...state.revisionRequests, request].slice(-80);
  const followupQuestion = t(
    params.locale,
    "你刚才否定了之前的规则。请确认：要覆盖原有 motif，还是新建一个版本？",
    "You explicitly negated a prior rule. Should we overwrite the old motif or create a new version?"
  );
  return { state, request, followupQuestion };
}

export function appendFollowupQuestion(baseText: string, followupQuestion?: string): string {
  const current = String(baseText || "").trim();
  const followup = clean(followupQuestion, 320);
  if (!followup) return current;
  if (!current) return followup;
  const normalizedCurrent = current.replace(/\s+/g, " ").trim();
  const normalizedFollowup = followup.replace(/\s+/g, " ").trim();
  if (normalizedCurrent.includes(normalizedFollowup)) return current;
  return `${current}\n${followup}`.trim();
}

export function resolveRevisionRequest(params: {
  currentState?: MotifTransferState | null;
  requestId?: string;
  motifTypeId?: string;
  choice: RevisionChoice;
  targetCandidateIds?: string[];
  revisedTitle?: string;
  revisedDependency?: string;
  revisedText?: string;
  revisedVersionId?: string;
}): MotifTransferState {
  const now = new Date().toISOString();
  const state: MotifTransferState = params.currentState
    ? {
        ...params.currentState,
        recommendations: [...(params.currentState.recommendations || [])],
        decisions: [...(params.currentState.decisions || [])],
        activeInjections: [...(params.currentState.activeInjections || [])],
        feedbackEvents: [...(params.currentState.feedbackEvents || [])],
        revisionRequests: [...(params.currentState.revisionRequests || [])],
      }
    : emptyMotifTransferState();

  const requestId = clean(params.requestId, 80);
  const motifTypeId = clean(params.motifTypeId, 180);
  const targetCandidateIds = Array.from(
    new Set((params.targetCandidateIds || []).map((x) => clean(x, 220)).filter(Boolean))
  );
  const affectedCandidateIds =
    targetCandidateIds.length > 0
      ? targetCandidateIds
      : state.revisionRequests
          .flatMap((x) => {
            const matchById = requestId && x.request_id === requestId;
            const matchByType = motifTypeId && x.motif_type_id === motifTypeId;
            if (!matchById && !matchByType) return [];
            return (x.affected_injections || []).map((item) => clean(item.candidate_id, 220));
          })
          .filter(Boolean);

  state.revisionRequests = state.revisionRequests.map((x) => {
    const matchById = requestId && x.request_id === requestId;
    const matchByType = motifTypeId && x.motif_type_id === motifTypeId;
    if (!matchById && !matchByType) return x;
    return {
      ...x,
      status: "resolved",
      suggested_action: params.choice,
      detected_at: now,
      resolved_candidate_ids: affectedCandidateIds,
      resolution_choice: params.choice,
    };
  });
  if (affectedCandidateIds.length) {
    const chosen = new Set(affectedCandidateIds);
    state.activeInjections = state.activeInjections.map((x) =>
      chosen.has(clean(x.candidate_id, 220))
        ? {
            ...x,
            motif_type_title: clean(params.revisedTitle, 180) || x.motif_type_title,
            dependency: clean(params.revisedDependency, 40) || x.dependency,
            constraint_text: clean(params.revisedText, 320) || x.constraint_text,
            library_version_id: clean(params.revisedVersionId, 120) || x.library_version_id,
            injection_state: "injected",
            disabled_reason: undefined,
            transfer_confidence: Math.max(0.72, Math.min(1, Number(x.transfer_confidence || 0.7))),
            adopted_at: now,
          }
        : x
    );
    state.recommendations = state.recommendations.map((x) =>
      chosen.has(clean(x.candidate_id, 220))
        ? {
            ...x,
            decision_status: "revised",
            decision_at: now,
            motif_type_title: clean(params.revisedTitle, 180) || x.motif_type_title,
            dependency: clean(params.revisedDependency, 40) || x.dependency,
            reusable_description: clean(params.revisedText, 320) || x.reusable_description,
          }
        : x
    );
  }
  state.lastDecisionAt = now;
  return state;
}
