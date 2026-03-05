import type {
  MotifTransferActiveInjection,
  MotifTransferDecisionAction,
  MotifTransferDecisionRecord,
  MotifTransferRecommendation,
  MotifTransferState,
  TransferDecisionStatus,
  TransferRecommendedMode,
} from "./types.js";
import { emptyMotifTransferState, t } from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decisionId() {
  return `mtd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextDecisionStatus(action: MotifTransferDecisionAction): TransferDecisionStatus {
  if (action === "adopt") return "adopted";
  if (action === "modify") return "modified_pending_confirmation";
  return "ignored";
}

function nextMode(
  action: MotifTransferDecisionAction,
  recMode: TransferRecommendedMode,
  modeOverride?: TransferRecommendedMode
): TransferRecommendedMode {
  if (modeOverride === "A" || modeOverride === "B" || modeOverride === "C") return modeOverride;
  if (action === "adopt") return "A";
  if (action === "modify") return "B";
  return recMode || "C";
}

function upsertInjection(params: {
  current: MotifTransferActiveInjection[];
  recommendation: MotifTransferRecommendation;
  action: MotifTransferDecisionAction;
  modeOverride?: TransferRecommendedMode;
  revisedText?: string;
  at: string;
}): MotifTransferActiveInjection[] {
  const kept = (params.current || []).filter((x) => x.candidate_id !== params.recommendation.candidate_id);
  if (params.action === "ignore") return kept;

  const mode = nextMode(params.action, params.recommendation.recommended_mode, params.modeOverride);
  const injectionState = params.action === "modify" ? "pending_confirmation" : "injected";
  const baseConfidence = Math.max(0.45, Math.min(0.98, Number(params.recommendation.match_score || 0.72)));
  const constraintText =
    clean(params.revisedText, 320) ||
    clean(params.recommendation.reusable_description, 320) ||
    clean(params.recommendation.motif_type_title, 200);

  return [
    ...kept,
    {
      candidate_id: params.recommendation.candidate_id,
      motif_type_id: params.recommendation.motif_type_id,
      motif_type_title: params.recommendation.motif_type_title,
      mode,
      injection_state: injectionState,
      transfer_confidence: baseConfidence,
      constraint_text: constraintText,
      source_task_id: params.recommendation.source_task_id,
      source_conversation_id: params.recommendation.source_conversation_id,
      adopted_at: params.at,
    },
  ];
}

export function applyTransferDecision(params: {
  locale?: "zh-CN" | "en-US";
  currentState?: MotifTransferState | null;
  recommendation: MotifTransferRecommendation;
  action: MotifTransferDecisionAction;
  modeOverride?: TransferRecommendedMode;
  revisedText?: string;
  note?: string;
}): { state: MotifTransferState; decision: MotifTransferDecisionRecord; followupQuestion?: string } {
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

  const status = nextDecisionStatus(params.action);
  const decision: MotifTransferDecisionRecord = {
    id: decisionId(),
    candidate_id: params.recommendation.candidate_id,
    action: params.action,
    decision_status: status,
    decided_at: now,
    revised_text: clean(params.revisedText, 320) || undefined,
    note: clean(params.note, 220) || undefined,
  };
  state.decisions = [...state.decisions, decision].slice(-120);
  state.activeInjections = upsertInjection({
    current: state.activeInjections,
    recommendation: params.recommendation,
    action: params.action,
    modeOverride: params.modeOverride,
    revisedText: params.revisedText,
    at: now,
  });
  state.recommendations = (state.recommendations || []).map((x) =>
    x.candidate_id === params.recommendation.candidate_id
      ? {
          ...x,
          decision_status: status,
          decision_at: now,
        }
      : x
  );
  state.lastDecisionAt = now;

  const followupQuestion =
    params.action === "modify"
      ? t(
          params.locale,
          `已记录「修改后采用」。请确认：这次是否沿用这条规则？「${clean(params.revisedText || params.recommendation.motif_type_title, 120)}」`,
          `Recorded as "modify before adopt". Please confirm: should this rule apply now? "${clean(
            params.revisedText || params.recommendation.motif_type_title,
            120
          )}"`
        )
      : undefined;

  return { state, decision, followupQuestion };
}

export function confirmModifiedInjection(params: {
  currentState?: MotifTransferState | null;
  candidateId: string;
}): MotifTransferState {
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

  const now = new Date().toISOString();
  state.activeInjections = state.activeInjections.map((x) =>
    x.candidate_id === clean(params.candidateId, 220) && x.injection_state === "pending_confirmation"
      ? { ...x, injection_state: "injected", adopted_at: now, mode: "B" }
      : x
  );
  state.decisions = state.decisions.map((x) =>
    x.candidate_id === clean(params.candidateId, 220) && x.decision_status === "modified_pending_confirmation"
      ? { ...x, decision_status: "adopted", decided_at: now }
      : x
  );
  state.recommendations = state.recommendations.map((x) =>
    x.candidate_id === clean(params.candidateId, 220)
      ? { ...x, decision_status: "adopted", decision_at: now, recommended_mode: "B" }
      : x
  );
  state.lastDecisionAt = now;
  return state;
}
