import type { AppLocale } from "../../i18n/locale.js";

export type TransferRecommendedMode = "A" | "B" | "C";
export type TransferApplicationScope = "trip" | "local";
export type TransferDecisionAction = "adopt" | "modify" | "ignore" | "confirm";
export type TransferDecisionStatus =
  | "pending"
  | "pending_confirmation"
  | "adopted"
  | "ignored"
  | "revised";
export type TransferInjectionState = "injected" | "pending_confirmation" | "disabled";
export type TransferFeedbackSignal =
  | "thumbs_down"
  | "retry"
  | "manual_override"
  | "explicit_not_applicable";

export type MotifTransferRecommendation = {
  candidate_id: string;
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  reusable_description: string;
  source_task_id?: string;
  source_conversation_id?: string;
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  reason: string;
  match_score: number;
  recommended_mode: TransferRecommendedMode;
  decision_status: TransferDecisionStatus;
  decision_at?: string;
  created_at: string;
};

export type MotifTransferDecisionRecord = {
  id: string;
  candidate_id: string;
  action: TransferDecisionAction;
  decision_status: TransferDecisionStatus;
  decided_at: string;
  revised_text?: string;
  note?: string;
  application_scope?: TransferApplicationScope;
};

export type MotifTransferActiveInjection = {
  candidate_id: string;
  motif_type_id: string;
  motif_type_title: string;
  mode: TransferRecommendedMode;
  injection_state: TransferInjectionState;
  transfer_confidence: number;
  constraint_text: string;
  source_task_id?: string;
  source_conversation_id?: string;
  adopted_at: string;
  disabled_reason?: string;
  application_scope?: TransferApplicationScope;
};

export type MotifTransferFeedbackEvent = {
  event_id: string;
  candidate_id?: string;
  motif_type_id?: string;
  signal: TransferFeedbackSignal;
  signal_text?: string;
  delta: number;
  created_at: string;
};

export type MotifTransferRevisionImpact = {
  candidate_id: string;
  motif_type_id: string;
  motif_type_title: string;
  injection_state: TransferInjectionState;
  application_scope?: TransferApplicationScope;
  constraint_text: string;
};

export type MotifTransferRevisionRequest = {
  request_id: string;
  candidate_id?: string;
  motif_type_id: string;
  reason: string;
  detected_text: string;
  detected_at: string;
  status: "pending_user_choice" | "resolved";
  options: Array<"overwrite" | "new_version">;
  suggested_action?: "overwrite" | "new_version";
  affected_injections?: MotifTransferRevisionImpact[];
  resolved_candidate_ids?: string[];
  resolution_choice?: "overwrite" | "new_version";
};

export type MotifTransferState = {
  recommendations: MotifTransferRecommendation[];
  decisions: MotifTransferDecisionRecord[];
  activeInjections: MotifTransferActiveInjection[];
  feedbackEvents: MotifTransferFeedbackEvent[];
  revisionRequests: MotifTransferRevisionRequest[];
  lastEvaluatedAt?: string;
  lastDecisionAt?: string;
  lastFeedbackAt?: string;
};

export type MotifLibraryVersionPayload = {
  version_id: string;
  version: number;
  title: string;
  dependency: string;
  reusable_description: string;
  abstraction_levels: {
    L1?: string;
    L2?: string;
    L3?: string;
  };
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  source_task_id?: string;
  source_conversation_id?: string;
  created_at: string;
  updated_at: string;
};

export type MotifLibraryRevisionFieldDiff = {
  field: "title" | "dependency" | "reusable_description" | "L1" | "L2" | "L3" | "status";
  current_value?: string;
  next_value?: string;
};

export type MotifLibraryRevisionSummary = {
  choice: "overwrite" | "new_version";
  previous_version_id?: string;
  current_version_id?: string;
  overwritten_version_id?: string;
  version_created: boolean;
  changed_fields: MotifLibraryRevisionFieldDiff[];
};

export type MotifLibraryEntryPayload = {
  locale: AppLocale;
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  abstraction_levels: ("L1" | "L2" | "L3")[];
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  current_version_id: string;
  versions: MotifLibraryVersionPayload[];
  source_task_ids: string[];
  usage_stats: {
    adopted_count: number;
    ignored_count: number;
    feedback_negative_count: number;
    transfer_confidence: number;
    last_used_at?: string;
  };
};

export function emptyMotifTransferState(): MotifTransferState {
  return {
    recommendations: [],
    decisions: [],
    activeInjections: [],
    feedbackEvents: [],
    revisionRequests: [],
  };
}

export function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return locale === "en-US" ? en : zh;
}
