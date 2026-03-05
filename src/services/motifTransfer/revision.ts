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
  };
  state.revisionRequests = [...state.revisionRequests, request].slice(-80);
  const followupQuestion = t(
    params.locale,
    "你刚才否定了之前的规则。请确认：要覆盖原有 motif，还是新建一个版本？",
    "You explicitly negated a prior rule. Should we overwrite the old motif or create a new version?"
  );
  return { state, request, followupQuestion };
}

export function resolveRevisionRequest(params: {
  currentState?: MotifTransferState | null;
  requestId?: string;
  motifTypeId?: string;
  choice: RevisionChoice;
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
  state.revisionRequests = state.revisionRequests.map((x) => {
    const matchById = requestId && x.request_id === requestId;
    const matchByType = motifTypeId && x.motif_type_id === motifTypeId;
    if (!matchById && !matchByType) return x;
    return {
      ...x,
      status: "resolved",
      suggested_action: params.choice,
      detected_at: now,
    };
  });
  state.lastDecisionAt = now;
  return state;
}
