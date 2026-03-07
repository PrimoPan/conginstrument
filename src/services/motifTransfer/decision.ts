import type {
  MotifTransferActiveInjection,
  TransferApplicationScope,
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
  if (action === "adopt" || action === "modify") return "pending_confirmation";
  if (action === "confirm") return "adopted";
  return "ignored";
}

function normalizeApplicationScope(raw: any): TransferApplicationScope {
  return clean(raw, 24) === "local" ? "local" : "trip";
}

function nextMode(
  action: MotifTransferDecisionAction,
  recMode: TransferRecommendedMode,
  modeOverride?: TransferRecommendedMode
): TransferRecommendedMode {
  if (action === "confirm") return modeOverride || recMode || "A";
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
  applicationScope?: TransferApplicationScope;
}): MotifTransferActiveInjection[] {
  const kept = (params.current || []).filter((x) => x.candidate_id !== params.recommendation.candidate_id);
  if (params.action === "ignore" || params.action === "confirm") return kept;

  const mode = nextMode(params.action, params.recommendation.recommended_mode, params.modeOverride);
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
      injection_state: "pending_confirmation",
      transfer_confidence: baseConfidence,
      constraint_text: constraintText,
      source_task_id: params.recommendation.source_task_id,
      source_conversation_id: params.recommendation.source_conversation_id,
      adopted_at: params.at,
      application_scope: normalizeApplicationScope(params.applicationScope),
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
  applicationScope?: TransferApplicationScope;
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
    application_scope: normalizeApplicationScope(params.applicationScope),
  };
  state.decisions = [...state.decisions, decision].slice(-120);
  state.activeInjections = upsertInjection({
    current: state.activeInjections,
    recommendation: params.recommendation,
    action: params.action,
    modeOverride: params.modeOverride,
    revisedText: params.revisedText,
    at: now,
    applicationScope: params.applicationScope,
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

  const confirmText = clean(
    params.revisedText || params.recommendation.reusable_description || params.recommendation.motif_type_title,
    120
  );
  const scopeTextZh = normalizeApplicationScope(params.applicationScope) === "local" ? "只在当前问题里参考" : "整趟都沿用";
  const scopeTextEn =
    normalizeApplicationScope(params.applicationScope) === "local"
      ? "use it only for the current sub-problem"
      : "carry it through the trip";
  const followupQuestion =
    params.action === "adopt" || params.action === "modify"
      ? t(
          params.locale,
          `我先把这条历史思路放进待确认区了。确认一下：这次要${scopeTextZh}「${confirmText}」吗？`,
          `I put this past motif into pending confirmation. Confirm: should this trip ${scopeTextEn}: "${confirmText}"?`
        )
      : undefined;

  return { state, decision, followupQuestion };
}

export function confirmTransferInjection(params: {
  currentState?: MotifTransferState | null;
  candidateId: string;
}): { state: MotifTransferState; decision?: MotifTransferDecisionRecord } {
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
  const candidateId = clean(params.candidateId, 220);
  const pendingInjection = state.activeInjections.find(
    (x) => x.candidate_id === candidateId && x.injection_state === "pending_confirmation"
  );
  if (!pendingInjection) return { state };

  state.activeInjections = state.activeInjections.map((x) =>
    x.candidate_id === candidateId && x.injection_state === "pending_confirmation"
      ? { ...x, injection_state: "injected", adopted_at: now }
      : x
  );
  state.decisions = state.decisions.map((x) =>
    x.candidate_id === candidateId && x.decision_status === "pending_confirmation"
      ? { ...x, decision_status: "adopted", decided_at: now }
      : x
  );
  state.recommendations = state.recommendations.map((x) =>
    x.candidate_id === candidateId
      ? { ...x, decision_status: "adopted", decision_at: now, recommended_mode: pendingInjection.mode || "A" }
      : x
  );
  const decision: MotifTransferDecisionRecord = {
    id: decisionId(),
    candidate_id: candidateId,
    action: "confirm",
    decision_status: "adopted",
    decided_at: now,
    application_scope: pendingInjection.application_scope,
  };
  state.decisions = [...state.decisions, decision].slice(-120);
  state.lastDecisionAt = now;
  return { state, decision };
}

export function confirmTransferInjections(params: {
  currentState?: MotifTransferState | null;
  candidateIds: string[];
}): { state: MotifTransferState; decisions: MotifTransferDecisionRecord[] } {
  let state = params.currentState || emptyMotifTransferState();
  const decisions: MotifTransferDecisionRecord[] = [];
  for (const rawId of params.candidateIds || []) {
    const out = confirmTransferInjection({ currentState: state, candidateId: rawId });
    state = out.state;
    if (out.decision) decisions.push(out.decision);
  }
  return { state, decisions };
}

export function applyTransferDecisionBatch(params: {
  locale?: "zh-CN" | "en-US";
  currentState?: MotifTransferState | null;
  items: Array<{
    recommendation: MotifTransferRecommendation;
    action: Exclude<MotifTransferDecisionAction, "confirm">;
    modeOverride?: TransferRecommendedMode;
    revisedText?: string;
    note?: string;
    applicationScope?: TransferApplicationScope;
  }>;
}): {
  state: MotifTransferState;
  decisions: MotifTransferDecisionRecord[];
  followupQuestions: string[];
} {
  let state = params.currentState || emptyMotifTransferState();
  const decisions: MotifTransferDecisionRecord[] = [];
  const followupQuestions: string[] = [];
  for (const item of params.items || []) {
    const out = applyTransferDecision({
      locale: params.locale,
      currentState: state,
      recommendation: item.recommendation,
      action: item.action,
      modeOverride: item.modeOverride,
      revisedText: item.revisedText,
      note: item.note,
      applicationScope: item.applicationScope,
    });
    state = out.state;
    decisions.push(out.decision);
    if (out.followupQuestion) followupQuestions.push(out.followupQuestion);
  }
  return { state, decisions, followupQuestions };
}

// Backward-compatible alias for older call sites and tests that still expect the
// pre-confirmation helper to return only the updated state.
export function confirmModifiedInjection(params: {
  currentState?: MotifTransferState | null;
  candidateId: string;
}): MotifTransferState {
  return confirmTransferInjection(params).state;
}
