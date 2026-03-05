import type {
  MotifTransferFeedbackEvent,
  MotifTransferFeedbackSignal,
  MotifTransferRevisionRequest,
  MotifTransferState,
} from "./types.js";
import { emptyMotifTransferState, t } from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function feedbackDelta(signal: MotifTransferFeedbackSignal): number {
  if (signal === "explicit_not_applicable") return -0.22;
  if (signal === "manual_override") return -0.18;
  if (signal === "retry") return -0.12;
  return -0.1;
}

function feedbackId() {
  return `mtf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function revisionId() {
  return `mtr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRevisionRequest(params: {
  motifTypeId: string;
  candidateId?: string;
  signalText?: string;
  reason: string;
  at: string;
}): MotifTransferRevisionRequest {
  return {
    request_id: revisionId(),
    candidate_id: clean(params.candidateId, 220) || undefined,
    motif_type_id: clean(params.motifTypeId, 180),
    reason: clean(params.reason, 180) || "transfer_failure_detected",
    detected_text: clean(params.signalText, 220),
    detected_at: params.at,
    status: "pending_user_choice",
    options: ["overwrite", "new_version"],
    suggested_action: "new_version",
  };
}

export function applyTransferFeedback(params: {
  locale?: "zh-CN" | "en-US";
  currentState?: MotifTransferState | null;
  signal: MotifTransferFeedbackSignal;
  signalText?: string;
  candidateId?: string;
  motifTypeId?: string;
}): {
  state: MotifTransferState;
  event: MotifTransferFeedbackEvent;
  followupQuestion?: string;
} {
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

  const candidateId = clean(params.candidateId, 220);
  const motifTypeId = clean(params.motifTypeId, 180);
  const event: MotifTransferFeedbackEvent = {
    event_id: feedbackId(),
    candidate_id: candidateId || undefined,
    motif_type_id: motifTypeId || undefined,
    signal: params.signal,
    signal_text: clean(params.signalText, 220) || undefined,
    delta: feedbackDelta(params.signal),
    created_at: now,
  };
  state.feedbackEvents = [...state.feedbackEvents, event].slice(-120);

  let effectiveMotifTypeId = motifTypeId;
  state.activeInjections = state.activeInjections.map((x) => {
    const byCandidate = candidateId && x.candidate_id === candidateId;
    const byMotifType = motifTypeId && x.motif_type_id === motifTypeId;
    if (!byCandidate && !byMotifType) return x;
    effectiveMotifTypeId = x.motif_type_id;
    const nextConfidence = Math.max(0, Math.min(1, Number(x.transfer_confidence || 0.7) + event.delta));
    const degraded = nextConfidence < 0.52;
    return {
      ...x,
      transfer_confidence: nextConfidence,
      injection_state: degraded ? "disabled" : x.injection_state,
      disabled_reason: degraded ? `transfer_failure:${params.signal}` : x.disabled_reason,
    };
  });

  state.recommendations = state.recommendations.map((x) => {
    const byCandidate = candidateId && x.candidate_id === candidateId;
    const byMotifType = motifTypeId && x.motif_type_id === motifTypeId;
    if (!byCandidate && !byMotifType) return x;
    const linked = state.activeInjections.find((inj) => inj.candidate_id === x.candidate_id);
    return {
      ...x,
      match_score: linked ? Number(Math.max(0, Math.min(1, linked.transfer_confidence)).toFixed(4)) : x.match_score,
      decision_status: linked?.injection_state === "disabled" ? "revised" : x.decision_status,
    };
  });

  const disabledTarget = state.activeInjections.find((x) => {
    const byCandidate = candidateId && x.candidate_id === candidateId;
    const byMotifType = motifTypeId && x.motif_type_id === motifTypeId;
    return (byCandidate || byMotifType) && x.injection_state === "disabled";
  });

  if (disabledTarget) {
    const existsPending = state.revisionRequests.some(
      (x) =>
        x.status === "pending_user_choice" &&
        x.motif_type_id === disabledTarget.motif_type_id &&
        (!disabledTarget.candidate_id || x.candidate_id === disabledTarget.candidate_id)
    );
    if (!existsPending) {
      state.revisionRequests = [
        ...state.revisionRequests,
        createRevisionRequest({
          motifTypeId: disabledTarget.motif_type_id,
          candidateId: disabledTarget.candidate_id,
          signalText: params.signalText,
          reason: "transfer_failure_detected",
          at: now,
        }),
      ].slice(-80);
    }
  }
  state.lastFeedbackAt = now;

  const followupQuestion = disabledTarget
    ? t(
        params.locale,
        "检测到迁移可能失效：上次这条认知规则在这次任务里是否不再适用？请选择“覆盖原规则”或“新建版本”。",
        "Transfer may have failed: does this prior cognitive rule no longer apply here? Choose overwrite or create a new version."
      )
    : t(
        params.locale,
        "已记录反馈，我会降低该规则权重并继续观察是否仍适用。",
        "Feedback recorded. I lowered this rule's weight and will continue monitoring."
      );

  if (!event.motif_type_id && effectiveMotifTypeId) {
    event.motif_type_id = effectiveMotifTypeId;
  }
  return { state, event, followupQuestion };
}
