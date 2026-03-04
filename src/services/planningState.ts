import type { CognitiveModel } from "./cognitiveModel.js";
import type { TravelPlanState, TravelPlanTaskHistorySegment } from "./travelPlan/state.js";
import { isEnglishLocale, type AppLocale } from "../i18n/locale.js";

export type TaskDetection = {
  current_task_id: string;
  is_task_switch: boolean;
  reason: string;
  signals: string[];
  mode: "single_conversation" | "new_task_detected";
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
  motif_type_id: string;
  motif_type_title: string;
  dependency: string;
  reusable_description: string;
  status: "uncertain";
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
  role_schema?: {
    drivers: string[];
    target: string[];
  };
  reusable_description: string;
  usage_count: number;
  source_task_ids: string[];
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

function tr(locale: AppLocale, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
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
}): TaskDetection {
  const current = uniqStrings(params.currentDestinations || [], 10);
  const previous = uniqStrings(params.previousDestinations || [], 10);
  const overlap = current.filter((d) => previous.includes(d));
  const switched = previous.length > 0 && current.length > 0 && overlap.length === 0;

  return {
    current_task_id: params.conversationId,
    is_task_switch: switched,
    reason: switched
      ? tr(params.locale, "目的地集合已切换，可能进入新任务。", "Destination set changed with no overlap, likely a new task.")
      : tr(params.locale, "当前仍按单会话任务持续更新。", "Task continues within the same conversation."),
    signals: switched
      ? [tr(params.locale, "目的地无重叠", "No destination overlap")]
      : [tr(params.locale, "会话上下文连续", "Conversation context remains continuous")],
    mode: switched ? "new_task_detected" : "single_conversation",
  };
}

export function buildCognitiveState(params: {
  conversationId: string;
  locale: AppLocale;
  model: CognitiveModel;
  travelPlanState: TravelPlanState;
  conversations?: ConversationTravelRecord[];
}): CognitiveState {
  const currentTaskId = clean(params.travelPlanState.task_id, 80) || clean(params.conversationId, 80);

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

  const motifPatternGroups = new Map<string, { motif: any; count: number; sourceTaskIds: Set<string> }>();
  for (const m of params.model.motifs || []) {
    const patternId = motifPatternId(m);
    if (!motifPatternGroups.has(patternId)) {
      motifPatternGroups.set(patternId, { motif: m, count: 0, sourceTaskIds: new Set<string>() });
    }
    const bucket = motifPatternGroups.get(patternId)!;
    bucket.count += 1;
    bucket.sourceTaskIds.add(currentTaskId);
  }

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

  for (const fragment of fragments) {
    for (const ref of fragment.rationaleRefs || []) {
      const match = clean(ref, 160).match(/^motif_type:(.+)$/i);
      if (!match?.[1]) continue;
      const pid = clean(match[1], 140);
      if (!pid || !motifPatternGroups.has(pid)) continue;
      motifPatternGroups.get(pid)!.sourceTaskIds.add(fragment.taskId);
    }
  }

  const motifLibrary: MotifLibraryPattern[] = Array.from(motifPatternGroups.entries()).map(([patternId, g]) => ({
    motif_type_id: patternId,
    motif_type_title: motifTypeTitle(g.motif, params.locale),
    dependency: clean(g.motif?.dependencyClass || g.motif?.relation, 32) || "enable",
    role_schema:
      g.motif?.motif_type_role_schema && typeof g.motif.motif_type_role_schema === "object"
        ? {
            drivers: uniqStrings((g.motif.motif_type_role_schema.drivers || []).map((x: any) => clean(x, 80)), 8),
            target: uniqStrings((g.motif.motif_type_role_schema.target || []).map((x: any) => clean(x, 80)), 8),
          }
        : undefined,
    reusable_description: motifReusableDescription(g.motif, params.locale),
    usage_count: g.count,
    source_task_ids: Array.from(g.sourceTaskIds).slice(0, 20),
  }));

  const motifTransferCandidates: MotifTransferCandidate[] = motifLibrary.slice(0, 6).map((p) => ({
    motif_type_id: p.motif_type_id,
    motif_type_title: p.motif_type_title,
    dependency: p.dependency,
    reusable_description: p.reusable_description,
    status: "uncertain",
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
