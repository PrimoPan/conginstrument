import type { CognitiveModel } from "./cognitiveModel.js";
import type { TravelPlanState, TravelPlanTaskHistorySegment } from "./travelPlan/state.js";
import { isEnglishLocale, type AppLocale } from "../i18n/locale.js";
import type { MotifLibraryEntryPayload, MotifTransferState } from "./motifTransfer/types.js";
import { extractIntentSignals } from "./graphUpdater/intentSignals.js";

export type TaskDetection = {
  current_task_id: string;
  is_task_switch: boolean;
  reason: string;
  signals: string[];
  mode: "single_conversation" | "new_task_detected";
  confidence: number;
  switch_reason_code:
    | "closed_task"
    | "new_conversation"
    | "explicit_restart"
    | "destination_switch"
    | "continuous";
};

export type PlanningTaskLifecycle = {
  status: "active" | "closed";
  endedAt?: string;
  endedTaskId?: string;
  reopenedAt?: string;
  updatedAt?: string;
  resumable?: boolean;
  resume_required?: boolean;
};

export type CognitiveStateConcept = {
  concept_id: string;
  kind: string;
  title: string;
  description: string;
  validation_status: string;
  source_msg_ids: string[];
  evidence_terms: string[];
};

export type CognitiveStateMotifInstance = {
  motif_id: string;
  motif_type: string;
  relation: string;
  title: string;
  status: string;
  confidence: number;
  concept_ids: string[];
  anchor_concept_id: string;
  rationale?: string;
};

export type MotifTransferCandidate = {
  candidate_id: string;
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  reusable_description: string;
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  match_score: number;
  recommended_mode: "A" | "B" | "C";
  decision_status: "pending" | "pending_confirmation" | "adopted" | "ignored" | "revised";
  decision_at?: string;
  reason: string;
};

export type CognitiveTaskState = {
  task_id: string;
  task_type: "travel_planning";
  task_context: {
    conversation_id: string;
    locale: AppLocale;
    destination_scope: string[];
    duration?: string;
    trip_goal_summary: string;
    updated_at: string;
  };
  concepts_from_user: CognitiveStateConcept[];
  motif_instances_current_task: CognitiveStateMotifInstance[];
  motif_transfer_candidates: MotifTransferCandidate[];
  clarification_questions: string[];
  history: Array<{
    at: string;
    action: string;
    summary: string;
    source: string;
  }>;
};

export type MotifLibraryPattern = {
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  abstraction_levels: ("L1" | "L2" | "L3")[];
  status: "active" | "uncertain" | "deprecated" | "cancelled";
  current_version_id: string;
  versions: Array<{
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
  }>;
  role_schema?: {
    drivers: string[];
    target: string[];
  };
  reusable_description: string;
  usage_count: number;
  source_task_ids: string[];
  usage_stats?: {
    adopted_count: number;
    ignored_count: number;
    feedback_negative_count: number;
    transfer_confidence: number;
    last_used_at?: string;
  };
};

export type CognitiveState = {
  current_task_id: string;
  tasks: CognitiveTaskState[];
  motif_library: MotifLibraryPattern[];
};

export type PortfolioTripSection = {
  task_id: string;
  trip_title: string;
  destination_scope: string[];
  travelers: string[];
  duration: string;
  plan_snapshot: {
    summary: string;
    constraints: string[];
    day_plan_count: number;
    budget_notes: string[];
  };
  export_ready_text: string;
  status: "draft" | "active" | "archived";
  last_updated: string;
};

export type PortfolioDocumentState = {
  portfolio_id: string;
  user_scope: string;
  trips: PortfolioTripSection[];
  export_order: string[];
  combined_outline: string[];
  combined_export_ready_text: string;
  pdf_metadata: {
    generated_at: string;
    trip_count: number;
    locale: AppLocale;
  };
  last_updated: string;
};

type ConversationTravelRecord = {
  conversationId: string;
  title?: string;
  travelPlanState?: TravelPlanState | null;
  updatedAt?: Date | string;
};

type TaskFragment = {
  taskId: string;
  conversationId: string;
  tripTitle: string;
  destinationScope: string[];
  travelers: string[];
  duration?: string;
  tripGoalSummary: string;
  exportReadyText: string;
  openQuestions: string[];
  rationaleRefs: string[];
  status: "draft" | "active" | "archived";
  updatedAt: string;
  changelog: Array<{ at: string; action: string; summary: string; source: string }>;
};

function clean(input: any, max = 220): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniq<T>(arr: T[], max = 48): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const raw of arr || []) {
    const key = JSON.stringify(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

function uniqStrings(arr: string[], max = 48): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr || []) {
    const x = clean(raw, 160);
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

function motifLibraryEntryMatchesTask(
  item: MotifLibraryEntryPayload,
  taskId: string,
  conversationId: string
): boolean {
  const safeTaskId = clean(taskId, 80);
  const safeConversationId = clean(conversationId, 80);
  const currentVersion =
    Array.isArray(item.versions) && item.versions.length
      ? item.versions.find((v) => clean(v.version_id, 120) === clean(item.current_version_id, 120)) ||
        item.versions[item.versions.length - 1]
      : null;
  if (safeTaskId) {
    const sourceTaskIds = Array.isArray(item.source_task_ids) ? item.source_task_ids : [];
    if (sourceTaskIds.some((x) => clean(x, 80) === safeTaskId)) return true;
    if (clean(currentVersion?.source_task_id, 80) === safeTaskId) return true;
  }
  if (safeConversationId && clean(currentVersion?.source_conversation_id, 80) === safeConversationId) return true;
  return false;
}

const LODGING_FOCUS_RE = /(多住一点|住久一点|多待一点|多留一点|重点住|优先住|主要住)/i;
const CONTINUATION_REFINEMENT_RE =
  /(整体还是|总时长还是|总时长还是按|还是按|不是必须|先不|先完全去掉|完全去掉|去掉|删掉|移除|保留|都保留|继续|也可以|也行|最后\s*[0-9一二三四五六七八九十两]{0,2}\s*晚|按.+(?:住|晚)|以.+为主住|就按|那就按|先按|先以|来想|不用单独算|最多半天|中转|过渡|先别塞满)/i;
const EXPLICIT_RESTART_RE = /(重新规划|新任务|下一趟|再规划一趟|another trip|new task|start over|plan a new trip)/i;
const SOFT_FRESH_TRIP_CUE_RE = /(?:我想|我们想|想|准备|打算).{0,8}(?:去|安排|规划|计划)/i;
const BROAD_DESTINATION_RE =
  /(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋|摩洛哥|冰岛|欧洲|亚洲|非洲|北美|南美|中东|关西|北海道|东南亚|北欧|南欧|西欧|东欧|japan|china|usa|united states|uk|united kingdom|france|germany|italy|spain|portugal|netherlands|belgium|switzerland|austria|singapore|thailand|malaysia|indonesia|australia|canada|new zealand|uae|morocco|iceland|europe|asia|africa|north america|south america|middle east|kansai|hokkaido|southeast asia|nordics?)/i;
const DESTINATION_BREAKDOWN_RE =
  /(优先|priority|prioriti(?:s|z)e|主要|mainly|重点|focus on|base in|中转|stopover|transit|过渡|not required|optional|不是必须|先不|去掉|删掉)/i;

function tr(locale: AppLocale, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function shouldCarryPreviousDestinationsForRefinement(params: {
  latestUserText?: string;
  currentDestinations: string[];
  previousDestinations: string[];
  destinationEvidences?: string[];
  removedDestinations?: string[];
  cityDurations?: Array<{ city?: string; days?: number }>;
}): boolean {
  const latestUserText = clean(params.latestUserText, 320);
  if (!latestUserText || !params.currentDestinations.length || !params.previousDestinations.length) return false;
  const destinationEvidenceText = uniqStrings(
    [...(params.destinationEvidences || []), latestUserText].map((x) => clean(x, 120)),
    8
  ).join(" ");
  const hasLodgingFocus = LODGING_FOCUS_RE.test(destinationEvidenceText);
  const hasCityAllocation = (params.cityDurations || []).some((seg) => !!clean(seg?.city, 60) && Number(seg?.days) > 0);
  const previousIsBroadAnchor =
    params.previousDestinations.length > 0 &&
    params.previousDestinations.every((dest) => BROAD_DESTINATION_RE.test(clean(dest, 80)));
  const currentHasBroadAnchor = params.currentDestinations.some((dest) => BROAD_DESTINATION_RE.test(clean(dest, 80)));
  const hasDestinationBreakdownCue = DESTINATION_BREAKDOWN_RE.test(latestUserText);
  const hierarchicalRefinement =
    previousIsBroadAnchor &&
    !currentHasBroadAnchor &&
    params.currentDestinations.length >= 2 &&
    hasDestinationBreakdownCue;
  if (EXPLICIT_RESTART_RE.test(latestUserText)) return false;
  if (SOFT_FRESH_TRIP_CUE_RE.test(latestUserText) && !hierarchicalRefinement) return false;
  const hasContinuationCue =
    CONTINUATION_REFINEMENT_RE.test(latestUserText) ||
    hasDestinationBreakdownCue ||
    (params.removedDestinations || []).length > 0;
  if (!hasContinuationCue) return false;
  return hasLodgingFocus || hasCityAllocation || hierarchicalRefinement;
}

function sourceTokens(raw: any): string[] {
  return uniqStrings((Array.isArray(raw) ? raw : []).map((x) => clean(x, 80).toLowerCase()), 30);
}

function isAssistantToken(token: string): boolean {
  const tkn = clean(token, 80).toLowerCase();
  if (!tkn) return false;
  return tkn.includes("assistant") || tkn === "latest_assistant" || tkn.startsWith("msg_a") || tkn.startsWith("a_");
}

function isUserToken(token: string): boolean {
  const tkn = clean(token, 80).toLowerCase();
  if (!tkn || isAssistantToken(tkn)) return false;
  return (
    tkn.includes("user") ||
    tkn === "latest_user" ||
    tkn.startsWith("msg_u") ||
    tkn.startsWith("u_") ||
    tkn.startsWith("turn_u") ||
    tkn.startsWith("turn_") ||
    tkn.startsWith("manual_")
  );
}

function conceptLooksUserGroundedStrict(concept: any): boolean {
  const src = sourceTokens(concept?.sourceMsgIds);
  if (!src.length) return false;
  const hasUser = src.some((s) => isUserToken(s));
  if (!hasUser) return false;
  const validation = clean(concept?.validationStatus, 24).toLowerCase();
  return validation === "resolved" || validation === "pending";
}

function motifPatternId(m: any): string {
  const explicit = clean(m?.motif_type_id, 140);
  if (explicit) return explicit;
  const dep = clean(m?.dependencyClass || m?.relation, 24) || "enable";
  const type = clean(m?.motifType, 24) || "pair";
  const roles =
    m?.motif_type_role_schema && typeof m.motif_type_role_schema === "object"
      ? `${(m.motif_type_role_schema.drivers || []).join("+")}=>${(m.motif_type_role_schema.target || []).join("+")}`
      : "generic";
  return `pattern:${dep}:${type}:${clean(roles, 120)}`;
}

function motifTypeTitle(m: any, locale: AppLocale): string {
  return clean(m?.motif_type_title, 160) || clean(m?.title, 160) || tr(locale, "通用依赖模式", "Generic dependency pattern");
}

function motifReusableDescription(m: any, locale: AppLocale): string {
  return (
    clean(m?.motif_type_reusable_description, 220) ||
    clean(m?.rationale, 220) ||
    tr(locale, "可迁移的推理结构", "Transferable reasoning structure")
  );
}

function mapClarificationQuestions(params: {
  motifs: any[];
  openQuestions: string[];
  locale: AppLocale;
}): string[] {
  const out: string[] = [];
  for (const m of params.motifs || []) {
    const status = clean(m?.status, 24).toLowerCase();
    if (status !== "uncertain" && status !== "deprecated") continue;
    const title = clean(m?.title, 120) || clean(m?.motif_type_title, 120) || clean(m?.id, 80);
    if (!title) continue;
    out.push(
      params.locale === "en-US"
        ? `Please confirm whether motif "${title}" should remain active.`
        : `请确认 motif「${title}」是否应保持 active。`
    );
    if (out.length >= 4) break;
  }
  for (const q of params.openQuestions || []) {
    const x = clean(q, 180);
    if (!x) continue;
    out.push(x);
    if (out.length >= 8) break;
  }
  return uniqStrings(out, 8);
}

function normalizeDuration(plan: TravelPlanState, locale: AppLocale): string | undefined {
  const explicit = clean(plan.travel_dates_or_duration, 80);
  if (explicit) return explicit;
  if (Number(plan.totalDays) > 0) {
    return locale === "en-US" ? `${plan.totalDays} days` : `${plan.totalDays}天`;
  }
  return undefined;
}

function planHistoryToEvents(plan: TravelPlanState, locale: AppLocale) {
  return (plan.changelog || []).map((c: any) => ({
    at: clean(c?.changed_at || c?.at, 40) || new Date().toISOString(),
    action: clean(c?.action, 40) || "plan_update",
    summary: clean(c?.summary, 220) || tr(locale, "计划状态更新", "Plan state updated"),
    source: clean(c?.source_label || c?.source, 40) || "assistant_proposed",
  }));
}

function currentFragmentFromPlan(params: {
  conversationId: string;
  title?: string;
  plan: TravelPlanState;
  locale: AppLocale;
  updatedAt?: Date | string;
}): TaskFragment {
  const destinationScope = uniqStrings(
    (params.plan.destination_scope || params.plan.destinations || []).map((x: any) => clean(x, 40)),
    12
  );
  const taskId = clean(params.plan.task_id, 80) || clean(params.conversationId, 80);
  return {
    taskId,
    conversationId: params.conversationId,
    tripTitle: clean(params.title, 120) || destinationScope[0] || tr(params.locale, "未命名行程", "Untitled trip"),
    destinationScope,
    travelers: uniqStrings((params.plan.travelers || []).map((x: any) => clean(x, 40)), 8),
    duration: normalizeDuration(params.plan, params.locale),
    tripGoalSummary: clean(params.plan.trip_goal_summary || params.plan.summary, 260),
    exportReadyText: clean(params.plan.export_ready_text || params.plan.exportNarrative || params.plan.summary, 12000),
    openQuestions: uniqStrings((params.plan.open_questions || []).map((x: any) => clean(x, 180)), 8),
    rationaleRefs: uniqStrings((params.plan.rationale_refs || []).map((x: any) => clean(x, 120)), 24),
    status: Number(params.plan?.source?.turnCount || 0) > 0 ? "active" : "draft",
    updatedAt:
      clean(params.plan.last_updated || params.plan.updatedAt, 40) ||
      (params.updatedAt ? new Date(params.updatedAt as any).toISOString() : new Date().toISOString()),
    changelog: planHistoryToEvents(params.plan, params.locale),
  };
}

function fragmentFromHistory(params: {
  conversationId: string;
  title?: string;
  segment: TravelPlanTaskHistorySegment;
  locale: AppLocale;
}): TaskFragment | null {
  const taskId = clean(params.segment.task_id, 80);
  if (!taskId) return null;
  return {
    taskId,
    conversationId: params.conversationId,
    tripTitle:
      clean(params.segment.trip_title, 120) ||
      clean(params.title, 120) ||
      tr(params.locale, "历史行程", "Archived trip"),
    destinationScope: uniqStrings((params.segment.destination_scope || []).map((x) => clean(x, 40)), 12),
    travelers: uniqStrings((params.segment.travelers || []).map((x) => clean(x, 40)), 8),
    duration: clean(params.segment.duration, 80) || undefined,
    tripGoalSummary: clean(params.segment.trip_goal_summary, 260),
    exportReadyText: clean(params.segment.export_ready_text, 12000),
    openQuestions: uniqStrings((params.segment.open_questions || []).map((x) => clean(x, 180)), 8),
    rationaleRefs: uniqStrings((params.segment.rationale_refs || []).map((x) => clean(x, 120)), 24),
    status: params.segment.status === "archived" ? "archived" : "active",
    updatedAt: clean(params.segment.closed_at, 40) || new Date().toISOString(),
    changelog: [
      {
        at: clean(params.segment.closed_at, 40) || new Date().toISOString(),
        action: "task_archived",
        summary: tr(params.locale, "旧任务段已归档。", "Previous task segment archived."),
        source: "system",
      },
    ],
  };
}

function collectTaskFragments(params: {
  locale: AppLocale;
  conversations: ConversationTravelRecord[];
}): TaskFragment[] {
  const out: TaskFragment[] = [];
  for (const conv of params.conversations || []) {
    const plan = conv.travelPlanState;
    if (!plan) continue;

    const historySegments = Array.isArray(plan.task_history) ? plan.task_history || [] : [];
    for (const segment of historySegments) {
      const fragment = fragmentFromHistory({
        conversationId: clean(conv.conversationId, 80),
        title: clean(conv.title, 120),
        segment,
        locale: params.locale,
      });
      if (fragment) out.push(fragment);
    }

    out.push(
      currentFragmentFromPlan({
        conversationId: clean(conv.conversationId, 80),
        title: clean(conv.title, 120),
        plan,
        locale: params.locale,
        updatedAt: conv.updatedAt,
      })
    );
  }

  const byTaskId = new Map<string, TaskFragment>();
  for (const item of out) {
    const prev = byTaskId.get(item.taskId);
    if (!prev || String(item.updatedAt) > String(prev.updatedAt)) {
      byTaskId.set(item.taskId, item);
    }
  }
  return Array.from(byTaskId.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function buildTaskDetection(params: {
  conversationId: string;
  locale: AppLocale;
  currentDestinations: string[];
  previousDestinations?: string[];
  isNewConversation?: boolean;
  taskLifecycle?: PlanningTaskLifecycle | null;
  latestUserText?: string;
  tripGoalSummary?: string;
  travelers?: string[];
  duration?: string;
}): TaskDetection {
  const current = uniqStrings(params.currentDestinations || [], 10);
  const previous = uniqStrings(params.previousDestinations || [], 10);
  const overlap = current.filter((d) => previous.includes(d));
  const latestUserText = clean(params.latestUserText, 220).toLowerCase();
  const restartText = [latestUserText, clean(params.tripGoalSummary, 220).toLowerCase()]
    .filter(Boolean)
    .join(" ");
  const explicitRestart = EXPLICIT_RESTART_RE.test(restartText);
  const switched = previous.length > 0 && current.length > 0 && overlap.length === 0;

  if (params.taskLifecycle?.status === "closed") {
    return {
      current_task_id: params.conversationId,
      is_task_switch: true,
      reason: tr(
        params.locale,
        "当前任务已结束，继续操作应显式恢复或创建新任务。",
        "The current task is closed. Continuing requires an explicit resume or a new task."
      ),
      signals: [tr(params.locale, "任务已结束", "Task is closed")],
      mode: "new_task_detected",
      confidence: 1,
      switch_reason_code: "closed_task",
    };
  }

  if (params.isNewConversation) {
    return {
      current_task_id: params.conversationId,
      is_task_switch: true,
      reason: tr(
        params.locale,
        "当前会话刚建立，视为一个新的任务起点。",
        "This conversation was just created and is treated as a new task entry point."
      ),
      signals: [tr(params.locale, "新建会话", "New conversation")],
      mode: "new_task_detected",
      confidence: 1,
      switch_reason_code: "new_conversation",
    };
  }

  if (explicitRestart) {
    return {
      current_task_id: params.conversationId,
      is_task_switch: true,
      reason: tr(
        params.locale,
        "用户表达了重新开始或规划下一任务的语义。",
        "The user explicitly indicated a restart or a next task."
      ),
      signals: [tr(params.locale, "显式重启语义", "Explicit restart intent")],
      mode: "new_task_detected",
      confidence: 0.95,
      switch_reason_code: "explicit_restart",
    };
  }

  if (switched) {
    return {
      current_task_id: params.conversationId,
      is_task_switch: true,
      reason: tr(
        params.locale,
        "目的地集合已切换，当前更像新的任务上下文。",
        "The destination set changed with no overlap, so this now looks like a new task context."
      ),
      signals: [tr(params.locale, "目的地无重叠", "No destination overlap")],
      mode: "new_task_detected",
      confidence: 0.82,
      switch_reason_code: "destination_switch",
    };
  }

  return {
    current_task_id: params.conversationId,
    is_task_switch: false,
    reason: tr(params.locale, "当前仍按单会话任务持续更新。", "Task continues within the same conversation."),
    signals: [tr(params.locale, "会话上下文连续", "Conversation context remains continuous")],
    mode: "single_conversation",
    confidence: 0.36,
    switch_reason_code: "continuous",
  };
}

export function detectTaskSwitchFromLatestUserTurn(params: {
  conversationId: string;
  locale: AppLocale;
  latestUserText?: string;
  previousTravelPlan?: TravelPlanState | null;
  taskLifecycle?: PlanningTaskLifecycle | null;
}): TaskDetection {
  const latestUserText = clean(params.latestUserText, 320);
  const signals = latestUserText ? extractIntentSignals(latestUserText, { locale: params.locale }) : {};
  const currentDestinations = uniqStrings(
    [
      ...((signals.destinations || []) as string[]),
      clean((signals as any).destination, 80),
      ...(!signals.destinations?.length && !(signals as any).destination
        ? ((signals.cityDurations || []) as Array<{ city?: string }>).map((x) => clean(x?.city, 80))
        : []),
    ].filter(Boolean),
    12
  );
  const previousDestinations = uniqStrings(
    [
      ...(((params.previousTravelPlan?.destination_scope || params.previousTravelPlan?.destinations || []) as string[])
        .map((x) => clean(x, 80))),
    ].filter(Boolean),
    12
  );
  const effectiveCurrentDestinations = shouldCarryPreviousDestinationsForRefinement({
    latestUserText,
    currentDestinations,
    previousDestinations,
    destinationEvidences: (signals.destinationEvidences || []) as string[],
    removedDestinations: (signals.removedDestinations || []) as string[],
    cityDurations: (signals.cityDurations || []) as Array<{ city?: string; days?: number }>,
  })
    ? uniqStrings([...previousDestinations, ...currentDestinations], 12)
    : currentDestinations;

  return buildTaskDetection({
    conversationId: clean(params.previousTravelPlan?.task_id, 80) || clean(params.conversationId, 80),
    locale: params.locale,
    currentDestinations: effectiveCurrentDestinations,
    previousDestinations,
    taskLifecycle: params.taskLifecycle || null,
    latestUserText,
    tripGoalSummary:
      latestUserText || clean(params.previousTravelPlan?.trip_goal_summary || params.previousTravelPlan?.summary, 220),
    travelers: Array.isArray(params.previousTravelPlan?.travelers) ? params.previousTravelPlan?.travelers : [],
    duration: clean(params.previousTravelPlan?.travel_dates_or_duration, 80) || undefined,
  });
}

export function buildCognitiveState(params: {
  conversationId: string;
  locale: AppLocale;
  model: CognitiveModel;
  travelPlanState: TravelPlanState;
  conversations?: ConversationTravelRecord[];
  persistentMotifLibrary?: MotifLibraryEntryPayload[];
  motifTransferState?: MotifTransferState | null;
  motifLibraryScope?: {
    sourceTaskId?: string;
    sourceConversationId?: string;
  } | null;
}): CognitiveState {
  const currentTaskId = clean(params.travelPlanState.task_id, 80) || clean(params.conversationId, 80);
  const scopedSourceTaskId = clean(params.motifLibraryScope?.sourceTaskId, 80);
  const scopedSourceConversationId = clean(params.motifLibraryScope?.sourceConversationId, 80);

  const conceptsFromUser: CognitiveStateConcept[] = (params.model.concepts || [])
    .filter((c: any) => conceptLooksUserGroundedStrict(c))
    .map((c: any) => ({
      concept_id: clean(c.id, 140),
      kind: clean(c.kind, 32),
      title: clean(c.title, 160),
      description: clean(c.description, 220),
      validation_status: clean(c.validationStatus, 24) || "unasked",
      source_msg_ids: uniqStrings((c.sourceMsgIds || []).map((x: any) => clean(x, 80)), 12),
      evidence_terms: uniqStrings((c.evidenceTerms || []).map((x: any) => clean(x, 60)), 8),
    }))
    .filter((x) => !!x.concept_id && !!x.title);

  const motifInstancesCurrentTask: CognitiveStateMotifInstance[] = (params.model.motifs || []).map((m: any) => ({
    motif_id: clean(m.id || m.motif_id, 140),
    motif_type: clean(m.motif_type || m.motifType, 40),
    relation: clean(m.relation || m.dependencyClass, 40),
    title: clean(m.title, 180),
    status: clean(m.status, 24),
    confidence: Number(m.confidence) || 0,
    concept_ids: uniqStrings((m.conceptIds || []).map((x: any) => clean(x, 140)), 12),
    anchor_concept_id: clean(m.anchorConceptId, 140),
    rationale: clean(m.rationale, 220) || undefined,
  }));

  const fragments = collectTaskFragments({
    locale: params.locale,
    conversations:
      params.conversations && params.conversations.length
        ? params.conversations
        : [
            {
              conversationId: params.conversationId,
              title: "",
              travelPlanState: params.travelPlanState,
              updatedAt: params.travelPlanState.last_updated || params.travelPlanState.updatedAt,
            },
          ],
  });

  const motifLibraryMap = new Map<string, MotifLibraryPattern>();
  for (const item of params.persistentMotifLibrary || []) {
    if (motifLibraryEntryMatchesTask(item, currentTaskId, params.conversationId)) continue;
    if (scopedSourceTaskId || scopedSourceConversationId) {
      if (!motifLibraryEntryMatchesTask(item, scopedSourceTaskId, scopedSourceConversationId)) continue;
    }
    motifLibraryMap.set(clean(item.motif_type_id, 180), {
      motif_type_id: clean(item.motif_type_id, 180),
      motif_type_title: clean(item.motif_type_title, 180),
      dependency: clean(item.dependency, 32) || "enable",
      abstraction_levels:
        Array.isArray(item.abstraction_levels) && item.abstraction_levels.length
          ? item.abstraction_levels.filter((x) => x === "L1" || x === "L2" || x === "L3")
          : ["L1", "L2"],
      status:
        clean(item.status, 24) === "uncertain" ||
        clean(item.status, 24) === "deprecated" ||
        clean(item.status, 24) === "cancelled"
          ? (clean(item.status, 24) as any)
          : "active",
      current_version_id: clean(item.current_version_id, 120),
      versions: Array.isArray(item.versions)
        ? item.versions.map((v) => ({
            version_id: clean(v.version_id, 120),
            version: Number(v.version || 1),
            title: clean(v.title, 180),
            dependency: clean(v.dependency, 32) || "enable",
            reusable_description: clean(v.reusable_description, 240),
            abstraction_levels: {
              L1: clean(v.abstraction_levels?.L1, 180) || undefined,
              L2: clean(v.abstraction_levels?.L2, 180) || undefined,
              L3: clean(v.abstraction_levels?.L3, 180) || undefined,
            },
            status:
              clean(v.status, 24) === "uncertain" ||
              clean(v.status, 24) === "deprecated" ||
              clean(v.status, 24) === "cancelled"
                ? (clean(v.status, 24) as any)
                : "active",
            source_task_id: clean(v.source_task_id, 80) || undefined,
            source_conversation_id: clean(v.source_conversation_id, 80) || undefined,
            created_at: clean(v.created_at, 40) || new Date().toISOString(),
            updated_at: clean(v.updated_at, 40) || new Date().toISOString(),
          }))
        : [],
      reusable_description:
        clean(item.versions?.find((v) => clean(v.version_id, 120) === clean(item.current_version_id, 120))?.reusable_description, 240) ||
        clean(item.versions?.[item.versions.length - 1]?.reusable_description, 240),
      usage_count: Number(item.usage_stats?.adopted_count || 0),
      source_task_ids: uniqStrings((item.source_task_ids || []).map((x) => clean(x, 80)), 20),
      usage_stats: {
        adopted_count: Number(item.usage_stats?.adopted_count || 0),
        ignored_count: Number(item.usage_stats?.ignored_count || 0),
        feedback_negative_count: Number(item.usage_stats?.feedback_negative_count || 0),
        transfer_confidence: Number(item.usage_stats?.transfer_confidence || 0.7),
        last_used_at: clean(item.usage_stats?.last_used_at, 40) || undefined,
      },
    });
  }
  const motifLibrary = Array.from(motifLibraryMap.values()).sort(
    (a, b) =>
      Number(b.usage_stats?.adopted_count || b.usage_count || 0) -
        Number(a.usage_stats?.adopted_count || a.usage_count || 0) ||
      String(a.motif_type_id).localeCompare(String(b.motif_type_id))
  );

  const motifTransferCandidates: MotifTransferCandidate[] = Array.isArray(params.motifTransferState?.recommendations)
    ? params.motifTransferState!.recommendations.map((r) => ({
        candidate_id: clean(r.candidate_id, 220),
        motif_type_id: clean(r.motif_type_id, 180),
        motif_type_title: clean(r.motif_type_title, 180),
        dependency: clean(r.dependency, 32) || "enable",
        reusable_description: clean(r.reusable_description, 240),
        status:
          clean(r.status, 24) === "active" ||
          clean(r.status, 24) === "deprecated" ||
          clean(r.status, 24) === "cancelled"
            ? (clean(r.status, 24) as any)
            : "uncertain",
        match_score: Number(r.match_score || 0),
        recommended_mode:
          clean(r.recommended_mode, 8) === "A" ||
          clean(r.recommended_mode, 8) === "C"
            ? (clean(r.recommended_mode, 8) as any)
            : "B",
        decision_status:
          clean(r.decision_status, 40) === "adopted" ||
          clean(r.decision_status, 40) === "pending_confirmation" ||
          clean(r.decision_status, 40) === "ignored" ||
          clean(r.decision_status, 40) === "revised"
            ? (clean(r.decision_status, 40) as any)
            : "pending",
        decision_at: clean(r.decision_at, 40) || undefined,
        reason: clean(r.reason, 220),
      }))
    : motifLibrary.slice(0, 6).map((p, idx) => ({
        candidate_id: clean(`${p.motif_type_id}::${p.current_version_id || `v${idx + 1}`}`, 220),
        motif_type_id: p.motif_type_id,
        motif_type_title: p.motif_type_title,
        dependency: p.dependency,
        reusable_description: p.reusable_description,
        status: p.status === "deprecated" || p.status === "cancelled" ? p.status : "uncertain",
        match_score: Number(p.usage_stats?.transfer_confidence || 0.7),
        recommended_mode:
          p.status === "deprecated" || p.status === "cancelled"
            ? "C"
            : Number(p.usage_stats?.transfer_confidence || 0.7) >= 0.75
            ? "A"
            : "B",
        decision_status: "pending",
        reason: tr(
          params.locale,
          "迁移候选需在当前任务中获得新证据确认。",
          "Transfer candidate requires fresh evidence in current task."
        ),
      }));

  const currentOpenQuestions = uniqStrings((params.travelPlanState.open_questions || []).map((x: any) => clean(x, 180)), 8);
  const currentClarificationQuestions = mapClarificationQuestions({
    motifs: params.model.motifs || [],
    openQuestions: currentOpenQuestions,
    locale: params.locale,
  });

  const taskMap = new Map<string, CognitiveTaskState>();
  for (const fragment of fragments) {
    taskMap.set(fragment.taskId, {
      task_id: fragment.taskId,
      task_type: "travel_planning",
      task_context: {
        conversation_id: fragment.conversationId,
        locale: params.locale,
        destination_scope: fragment.destinationScope,
        duration: fragment.duration,
        trip_goal_summary: fragment.tripGoalSummary,
        updated_at: fragment.updatedAt,
      },
      concepts_from_user: [],
      motif_instances_current_task: [],
      motif_transfer_candidates: [],
      clarification_questions: fragment.openQuestions,
      history: fragment.changelog.slice(-20),
    });
  }

  if (!taskMap.has(currentTaskId)) {
    taskMap.set(currentTaskId, {
      task_id: currentTaskId,
      task_type: "travel_planning",
      task_context: {
        conversation_id: params.conversationId,
        locale: params.locale,
        destination_scope: uniqStrings((params.travelPlanState.destination_scope || params.travelPlanState.destinations || []).map((x: any) => clean(x, 40)), 10),
        duration: clean(params.travelPlanState.travel_dates_or_duration, 80) || undefined,
        trip_goal_summary: clean(params.travelPlanState.trip_goal_summary || params.travelPlanState.summary, 220),
        updated_at: clean(params.travelPlanState.last_updated || params.travelPlanState.updatedAt, 40) || new Date().toISOString(),
      },
      concepts_from_user: [],
      motif_instances_current_task: [],
      motif_transfer_candidates: [],
      clarification_questions: [],
      history: [],
    });
  }

  const currentTask = taskMap.get(currentTaskId)!;
  currentTask.concepts_from_user = conceptsFromUser;
  currentTask.motif_instances_current_task = motifInstancesCurrentTask;
  currentTask.motif_transfer_candidates = motifTransferCandidates;
  currentTask.clarification_questions = currentClarificationQuestions;
  if (!currentTask.history.length) {
    currentTask.history = planHistoryToEvents(params.travelPlanState, params.locale).slice(-20);
  }

  const orderedTasks = Array.from(taskMap.values()).sort((a, b) => {
    if (a.task_id === currentTaskId) return -1;
    if (b.task_id === currentTaskId) return 1;
    return String(b.task_context.updated_at).localeCompare(String(a.task_context.updated_at));
  });

  return {
    current_task_id: currentTaskId,
    tasks: orderedTasks,
    motif_library: motifLibrary,
  };
}

function pushTripSection(params: {
  out: PortfolioTripSection[];
  locale: AppLocale;
  taskId: string;
  tripTitle: string;
  destinationScope: string[];
  travelers: string[];
  duration?: string;
  summary: string;
  constraints: string[];
  dayPlanCount: number;
  budgetNotes: string[];
  exportText: string;
  status: "draft" | "active" | "archived";
  lastUpdated: string;
}) {
  const taskId = clean(params.taskId, 80);
  if (!taskId) return;
  const destinationScope = uniqStrings(params.destinationScope.map((x) => clean(x, 40)), 12);
  params.out.push({
    task_id: taskId,
    trip_title: clean(params.tripTitle, 120) || destinationScope[0] || tr(params.locale, "未命名行程", "Untitled trip"),
    destination_scope: destinationScope,
    travelers: uniqStrings(params.travelers.map((x) => clean(x, 40)), 8),
    duration:
      clean(params.duration, 80) ||
      tr(params.locale, "待确认", "TBD"),
    plan_snapshot: {
      summary: clean(params.summary, 260),
      constraints: uniqStrings(params.constraints.map((x) => clean(x, 120)), 8),
      day_plan_count: Number(params.dayPlanCount) || 0,
      budget_notes: uniqStrings(params.budgetNotes.map((x) => clean(x, 120)), 8),
    },
    export_ready_text: clean(params.exportText, 12000),
    status: params.status,
    last_updated: clean(params.lastUpdated, 40) || new Date().toISOString(),
  });
}

export function buildPortfolioDocumentState(params: {
  userId: string;
  locale: AppLocale;
  conversations: ConversationTravelRecord[];
}): PortfolioDocumentState {
  const nowIso = new Date().toISOString();

  const trips: PortfolioTripSection[] = [];
  for (const conv of params.conversations || []) {
    const plan = conv.travelPlanState;
    if (!plan) continue;

    const historySegments = Array.isArray(plan.task_history) ? plan.task_history || [] : [];
    for (const seg of historySegments) {
      pushTripSection({
        out: trips,
        locale: params.locale,
        taskId: clean(seg.task_id, 80),
        tripTitle: clean(seg.trip_title, 120) || clean(conv.title, 120),
        destinationScope: (seg.destination_scope || []).map((x) => clean(x, 40)),
        travelers: (seg.travelers || []).map((x) => clean(x, 40)),
        duration: clean(seg.duration, 80),
        summary: clean(seg.trip_goal_summary, 260),
        constraints: [],
        dayPlanCount: 0,
        budgetNotes: [],
        exportText: clean(seg.export_ready_text, 12000),
        status: "archived",
        lastUpdated: clean(seg.closed_at, 40) || nowIso,
      });
    }

    pushTripSection({
      out: trips,
      locale: params.locale,
      taskId: clean(plan.task_id, 80) || clean(conv.conversationId, 80),
      tripTitle: clean(conv.title, 120),
      destinationScope: (plan.destination_scope || plan.destinations || []).map((x: any) => clean(x, 40)),
      travelers: (plan.travelers || []).map((x: any) => clean(x, 40)),
      duration: clean(plan.travel_dates_or_duration, 80),
      summary: clean(plan.trip_goal_summary || plan.summary, 260),
      constraints: (plan.constraints || []).map((x: any) => clean(x, 120)),
      dayPlanCount: Array.isArray(plan.day_by_day_plan) ? plan.day_by_day_plan.length : (plan.dayPlans || []).length,
      budgetNotes: (plan.budget_notes || []).map((x: any) => clean(x, 120)),
      exportText: clean(plan.export_ready_text || plan.exportNarrative || plan.summary || "", 12000),
      status: Number(plan?.source?.turnCount || 0) > 0 ? "active" : "draft",
      lastUpdated: clean(plan.last_updated || plan.updatedAt, 40) || (conv.updatedAt ? new Date(conv.updatedAt as any).toISOString() : nowIso),
    });
  }

  const byTaskId = new Map<string, PortfolioTripSection>();
  for (const trip of trips) {
    const prev = byTaskId.get(trip.task_id);
    if (!prev || String(trip.last_updated) > String(prev.last_updated)) {
      byTaskId.set(trip.task_id, trip);
    }
  }

  const dedupTrips = Array.from(byTaskId.values()).sort((a, b) => String(b.last_updated).localeCompare(String(a.last_updated)));
  const exportOrder = dedupTrips.map((t) => t.task_id);
  const combinedOutline = dedupTrips.map((t, idx) => {
    const destinationText = t.destination_scope.length
      ? t.destination_scope.join(" / ")
      : tr(params.locale, "目的地待补充", "Destination TBD");
    return `${idx + 1}. ${t.trip_title} · ${destinationText} · ${t.duration}`;
  });

  const combinedExportReadyText = dedupTrips
    .map((t, idx) => {
      const title = tr(params.locale, `行程 ${idx + 1}: ${t.trip_title}`, `Trip ${idx + 1}: ${t.trip_title}`);
      const destinationLine = t.destination_scope.length
        ? tr(params.locale, `目的地：${t.destination_scope.join("、")}`, `Destinations: ${t.destination_scope.join(" / ")}`)
        : tr(params.locale, "目的地：待补充", "Destinations: TBD");
      const statusLine =
        t.status === "archived"
          ? tr(params.locale, "状态：已归档", "Status: archived")
          : t.status === "draft"
          ? tr(params.locale, "状态：草稿", "Status: draft")
          : tr(params.locale, "状态：进行中", "Status: active");
      return [title, destinationLine, statusLine, t.export_ready_text || t.plan_snapshot.summary || ""].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return {
    portfolio_id: `portfolio:${clean(params.userId, 80)}`,
    user_scope: clean(params.userId, 80),
    trips: dedupTrips,
    export_order: exportOrder,
    combined_outline: combinedOutline,
    combined_export_ready_text: combinedExportReadyText,
    pdf_metadata: {
      generated_at: nowIso,
      trip_count: dedupTrips.length,
      locale: params.locale,
    },
    last_updated: nowIso,
  };
}
