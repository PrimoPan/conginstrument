import { Router } from "express";
import { ObjectId } from "mongodb";
import { authMiddleware, AuthedRequest } from "../middleware/auth.js";
import { collections } from "../db/mongo.js";
import { generateTurn, generateTurnStreaming } from "../services/llm.js";
import { applyPatchWithGuards, normalizeGraphSnapshot } from "../core/graph.js";
import type { CDG } from "../core/graph.js";
import { config } from "../server/config.js";
import { generateAssistantTextNonStreaming } from "../services/chatResponder.js";
import { buildCognitiveModel } from "../services/cognitiveModel.js";
import { buildConflictGatePayload } from "../services/motif/conflictGate.js";
import {
  buildTravelPlanState,
  buildTravelPlanSourceMapKey,
  type TravelPlanSourceMap,
  type TravelPlanState,
} from "../services/travelPlan/state.js";
import {
  defaultTravelPlanFileName,
  renderPortfolioTravelPlanPdf,
  renderTravelPlanPdf,
} from "../services/travelPlan/pdf.js";
import {
  buildTaskDetection,
  buildCognitiveState,
  buildPortfolioDocumentState,
  detectTaskSwitchFromLatestUserTurn,
  type TaskDetection,
  type CognitiveState,
  type PortfolioDocumentState,
} from "../services/planningState.js";
import { normalizeLocale, isEnglishLocale, type AppLocale } from "../i18n/locale.js";
import type { ConceptItem } from "../services/concepts.js";
import {
  applyTransferDecision,
  confirmModifiedInjection,
} from "../services/motifTransfer/decision.js";
import { buildTransferRecommendations } from "../services/motifTransfer/retrieval.js";
import {
  confirmMotifLibraryEntries,
  listUserMotifLibrary,
  recordTransferUsage,
  reviseMotifLibraryEntry,
} from "../services/motifTransfer/storage.js";
import type {
  MotifTransferState,
  TransferDecisionAction,
  TransferFeedbackSignal,
} from "../services/motifTransfer/types.js";
import { applyTransferFeedback } from "../services/motifTransfer/feedback.js";
import {
  registerRevisionRequestFromUtterance,
  resolveRevisionRequest,
  type RevisionChoice,
} from "../services/motifTransfer/revision.js";
import { buildTransferredConstraintPrompt, applyTransferStateToMotifs } from "../services/motifTransfer/application.js";
import {
  annotateMotifExtractionMeta,
  normalizeMotifTransferState,
} from "../services/motifTransfer/state.js";
import { asyncRoute } from "./asyncRoute.js";

export const convRouter = Router();
convRouter.use(authMiddleware);

function defaultSystemPrompt(locale: AppLocale) {
  if (isEnglishLocale(locale)) {
    return `You are CogInstrument's assistant. Help the user complete the current task and ask focused clarification questions about goals, constraints, and preferences. Each conversation is isolated by default; only use cross-task motifs when the user has explicitly adopted them.`;
  }
  return `你是CogInstrument的助手，目标是帮助用户完成当前任务，并通过提问澄清用户的目标/约束/偏好。默认每个conversation独立；仅当用户明确采用迁移规则时，才可引用跨任务信息。`;
}

function emptyGraph(conversationId: string): CDG {
  return { id: conversationId, version: 0, nodes: [], edges: [] };
}

function parseObjectId(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function graphComparablePayload(g: CDG) {
  const nodes = (g.nodes || [])
    .map((n) => ({
      id: n.id,
      type: n.type,
      layer: n.layer,
      strength: n.strength,
      statement: n.statement,
      status: n.status,
      confidence: n.confidence,
      locked: !!n.locked,
      severity: n.severity,
      importance: n.importance,
      tags: n.tags || [],
      key: n.key,
      value: n.value,
      evidenceIds: n.evidenceIds || [],
      sourceMsgIds: n.sourceMsgIds || [],
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edges = (g.edges || [])
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      type: e.type,
      confidence: e.confidence,
      phi: e.phi,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { nodes, edges };
}

function graphChanged(a: CDG, b: CDG): boolean {
  return JSON.stringify(graphComparablePayload(a)) !== JSON.stringify(graphComparablePayload(b));
}

function parseBoolFlag(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

type TaskLifecycleState = {
  status: "active" | "closed";
  endedAt?: string;
  endedTaskId?: string;
  reopenedAt?: string;
  updatedAt?: string;
  resumable?: boolean;
  resume_required?: boolean;
};

type PlanningBootstrapHints = {
  sourceConversationId?: string;
  destination?: string;
  keepConsistentText?: string;
  carryHealthReligion?: boolean;
  carryStableProfile?: boolean;
};

type ManualReferenceInput = {
  motif_type_id: string;
  title: string;
  text: string;
};

function readTaskLifecycle(raw: any): TaskLifecycleState {
  const statusRaw = cleanInput(raw?.status, 24).toLowerCase();
  const status: "active" | "closed" = statusRaw === "closed" ? "closed" : "active";
  const resumable = status === "closed";
  return {
    status,
    endedAt: cleanInput(raw?.endedAt, 40) || undefined,
    endedTaskId: cleanInput(raw?.endedTaskId, 120) || undefined,
    reopenedAt: cleanInput(raw?.reopenedAt, 40) || undefined,
    updatedAt: cleanInput(raw?.updatedAt, 40) || undefined,
    resumable,
    resume_required: status === "closed",
  };
}

function closeTaskLifecycle(currentTaskId: string): TaskLifecycleState {
  const now = new Date().toISOString();
  return {
    status: "closed",
    endedAt: now,
    endedTaskId: cleanInput(currentTaskId, 120) || undefined,
    updatedAt: now,
    resumable: true,
    resume_required: true,
  };
}

function reopenTaskLifecycle(previous: TaskLifecycleState): TaskLifecycleState {
  const now = new Date().toISOString();
  return {
    status: "active",
    endedAt: previous.endedAt,
    endedTaskId: previous.endedTaskId,
    reopenedAt: now,
    updatedAt: now,
    resumable: false,
    resume_required: false,
  };
}

function readPlanningBootstrapHints(raw: any): PlanningBootstrapHints | null {
  if (!raw || typeof raw !== "object") return null;
  const sourceConversationId = cleanInput(raw?.sourceConversationId, 80);
  const destination = cleanInput(raw?.destination, 80);
  const keepConsistentText = cleanInput(raw?.keepConsistentText, 400);
  const hasHealthReligion =
    raw?.carryHealthReligion == null ? true : parseBoolFlag(raw?.carryHealthReligion);
  const hasStableProfile =
    raw?.carryStableProfile == null ? hasHealthReligion : parseBoolFlag(raw?.carryStableProfile);
  if (!sourceConversationId && !destination && !keepConsistentText && hasHealthReligion && hasStableProfile) {
    return null;
  }
  return {
    sourceConversationId: sourceConversationId || undefined,
    destination: destination || undefined,
    keepConsistentText: keepConsistentText || undefined,
    carryHealthReligion: hasHealthReligion,
    carryStableProfile: hasStableProfile,
  };
}

function taskClosedErrorPayload(taskLifecycle: TaskLifecycleState) {
  return {
    error: "task_closed",
    message: "task_closed",
    ended_at: taskLifecycle.endedAt,
    ended_task_id: taskLifecycle.endedTaskId,
    suggested_actions: ["start_new_task", "resume_task"],
    resumable: taskLifecycle.resumable !== false,
    resume_required: true,
  };
}

function readMotifTransferState(raw: any): MotifTransferState {
  return normalizeMotifTransferState(raw);
}

function currentTaskId(plan: TravelPlanState | null | undefined, fallback: string): string {
  return cleanInput((plan as any)?.task_id, 80) || cleanInput(fallback, 80);
}

function withTransferSystemPrompt(params: {
  locale: AppLocale;
  baseSystemPrompt: string;
  motifTransferState?: MotifTransferState | null;
  manualReferences?: ManualReferenceInput[];
}): string {
  const transferPrompt = buildTransferredConstraintPrompt({
    locale: params.locale,
    state: params.motifTransferState || null,
  });
  const manualRefs = Array.isArray(params.manualReferences) ? params.manualReferences : [];
  const manualRefPrompt =
    manualRefs.length > 0
      ? [
          isEnglishLocale(params.locale)
            ? "User-selected Manual References (Mode C, reference-first):"
            : "用户选择的手动参考（Mode C，优先作为参考）：",
          ...manualRefs.slice(0, 6).map((r, idx) => `${idx + 1}. ${cleanInput(r.text || r.title, 220)}`),
        ].join("\n")
      : "";
  if (!transferPrompt && !manualRefPrompt) return params.baseSystemPrompt;
  return [params.baseSystemPrompt, transferPrompt, manualRefPrompt].filter(Boolean).join("\n\n").trim();
}

function parseManualReferences(raw: any): ManualReferenceInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ManualReferenceInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const motifTypeId = cleanInput((item as any).motif_type_id, 180);
    const title = cleanInput((item as any).title, 120);
    const text = cleanInput((item as any).text, 260);
    if (!text) continue;
    const key = `${motifTypeId}::${text}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      motif_type_id: motifTypeId || `manual_ref_${seen.size}`,
      title: title || motifTypeId || `Manual Ref ${seen.size}`,
      text,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function shouldEvaluateTransferRecommendations(params: {
  priorTurnCount: number;
  motifTransferState: MotifTransferState;
}): boolean {
  if (Number(params.priorTurnCount || 0) > 0) return false;
  const existing = params.motifTransferState.recommendations || [];
  return existing.length === 0;
}

function isAffirmativeForTransfer(userText: string): boolean {
  const text = cleanInput(userText, 280).toLowerCase();
  if (!text) return false;
  return /(是的|可以沿用|继续沿用|仍适用|同样适用|确认采用|yes|still applies|apply it|keep it)/i.test(text);
}

function isNegativeForTransfer(userText: string): boolean {
  const text = cleanInput(userText, 280).toLowerCase();
  if (!text) return false;
  return /(不适用|不要沿用|这次不用|不继续|no|not apply|don't apply|skip it)/i.test(text);
}

type ConversationPlanningBootstrap = {
  sourceConversationId?: string;
  destination?: string;
  keepConsistentText?: string;
  carryHealthReligion?: boolean;
  carryStableProfile?: boolean;
};

function slugToken(input: string, max = 48): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function cleanInput(input: any, max = 220): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniqValues(arr: any[], max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr || []) {
    const value = cleanInput(raw, 120);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function stableGraphItemId(prefix: string, raw: string): string {
  const safe = slugToken(raw, 80) || "item";
  return `${prefix}_${safe}`;
}

function defaultTravelPlanState(params: {
  locale: AppLocale;
  taskId: string;
  nowIso: string;
  destinationScope?: string[];
  constraints?: string[];
  openQuestions?: string[];
  summary?: string;
}): TravelPlanState {
  const en = isEnglishLocale(params.locale);
  const destinationScope = Array.isArray(params.destinationScope)
    ? params.destinationScope.map((x) => cleanInput(x, 80)).filter(Boolean)
    : [];
  const constraints = Array.isArray(params.constraints)
    ? params.constraints.map((x) => cleanInput(x, 180)).filter(Boolean)
    : [];
  const openQuestions = Array.isArray(params.openQuestions)
    ? params.openQuestions.map((x) => cleanInput(x, 180)).filter(Boolean)
    : [];
  const defaultSummary = en
    ? "No travel plan yet. Start chatting to build one."
    : "暂无旅行计划，请先开始对话。";
  const summary = cleanInput(params.summary, 220) || defaultSummary;
  const sourceMap: TravelPlanSourceMap = {};
  constraints.forEach((_, idx) => {
    sourceMap[buildTravelPlanSourceMapKey("constraints", idx + 1)] = {
      source_label: "transferred_pattern_based",
    };
  });
  openQuestions.forEach((_, idx) => {
    sourceMap[buildTravelPlanSourceMapKey("open_questions", idx + 1)] = {
      source_label: "transferred_pattern_based",
    };
  });

  return {
    version: 1,
    task_id: params.taskId,
    plan_version: 1,
    updatedAt: params.nowIso,
    last_updated: params.nowIso,
    summary,
    trip_goal_summary: summary,
    destinations: destinationScope,
    destination_scope: destinationScope,
    constraints,
    travelers: [en ? "TBD" : "待确认"],
    candidate_options: [],
    itinerary_outline: [],
    day_by_day_plan: [],
    transport_plan: [],
    stay_plan: [],
    food_plan: [],
    risk_notes: [],
    budget_notes: [],
    open_questions: openQuestions,
    rationale_refs: [],
    source_map: sourceMap,
    export_ready_text: "",
    changelog: [],
    dayPlans: [],
    source: { turnCount: 0 },
  } as any;
}

function parsePlanningBootstrap(raw: any): ConversationPlanningBootstrap | null {
  if (!raw || typeof raw !== "object") return null;
  const sourceConversationId = cleanInput((raw as any).sourceConversationId, 80);
  const destination = cleanInput((raw as any).destination, 80);
  const keepConsistentText = cleanInput((raw as any).keepConsistentText, 400);
  const carryHealthReligionRaw = (raw as any).carryHealthReligion;
  const carryStableProfileRaw = (raw as any).carryStableProfile;
  const carryHealthReligion =
    carryHealthReligionRaw == null ? true : parseBoolFlag(carryHealthReligionRaw);
  const carryStableProfile =
    carryStableProfileRaw == null ? carryHealthReligion : parseBoolFlag(carryStableProfileRaw);

  if (!sourceConversationId && !destination && !keepConsistentText) return null;
  return {
    sourceConversationId: sourceConversationId || undefined,
    destination: destination || undefined,
    keepConsistentText: keepConsistentText || undefined,
    carryHealthReligion,
    carryStableProfile,
  };
}

function conceptFamily(raw: any): string {
  return cleanInput(raw?.family, 40).toLowerCase();
}

function conceptSemanticKey(raw: any): string {
  return cleanInput(raw?.semanticKey, 180).toLowerCase();
}

function conceptText(raw: any): string {
  const bits = [
    cleanInput(raw?.title, 160),
    cleanInput(raw?.description, 180),
    cleanInput(raw?.semanticKey, 180),
    Array.isArray(raw?.evidenceTerms) ? raw.evidenceTerms.join(" ") : "",
  ]
    .map((x) => cleanInput(x, 220))
    .filter(Boolean);
  return bits.join(" ").toLowerCase();
}

function tokenize(input: string): Set<string> {
  const text = cleanInput(input, 420).toLowerCase();
  const parts = text.match(/[\u4e00-\u9fff]{1,4}|[a-z0-9]{2,24}/g) || [];
  return new Set(parts);
}

function hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

function limitingKindFromSemantic(semanticKey: string): string {
  if (!semanticKey.startsWith("slot:constraint:limiting:")) return "";
  return semanticKey.slice("slot:constraint:limiting:".length).split(":")[0] || "";
}

function conceptKind(raw: any): string {
  return cleanInput(raw?.kind, 40).toLowerCase();
}

function isHealthOrReligionKind(kind: string): boolean {
  return kind === "health" || kind === "religion";
}

function isHardStableLimitingKind(kind: string): boolean {
  return (
    kind === "health" ||
    kind === "religion" ||
    kind === "language" ||
    kind === "mobility" ||
    kind === "diet" ||
    kind === "safety"
  );
}

function isCarryHealthReligionConcept(concept: any): boolean {
  const semantic = conceptSemanticKey(concept);
  const family = conceptFamily(concept);
  const text = conceptText(concept);
  const kind = limitingKindFromSemantic(semantic);
  if (kind === "health" || kind === "religion") return true;
  if (family !== "limiting_factor") return false;
  return /冠心病|心脏|心肺|慢性病|健康|医疗|health|cardiac|medical|宗教|信仰|礼拜|祷告|religion|faith|prayer|halal|kosher/i.test(
    text
  );
}

type CarryPolicy = {
  level: "hard_auto" | "soft_confirm";
  reason: string;
};

function inferStableCarryPolicy(concept: any): CarryPolicy | null {
  const semantic = conceptSemanticKey(concept);
  const family = conceptFamily(concept);
  const text = conceptText(concept);
  const kind = limitingKindFromSemantic(semantic);
  const kindLabel = conceptKind(concept);

  if (isHardStableLimitingKind(kind)) {
    return { level: "hard_auto", reason: `stable_limiting:${kind}` };
  }

  // Soft carry buckets: ask user to confirm for new trip.
  if (kind === "logistics") return { level: "soft_confirm", reason: "soft_transport_baseline" };
  if (family === "people" || semantic === "slot:people") {
    return { level: "soft_confirm", reason: "soft_traveler_profile" };
  }
  if (family === "lodging" || semantic === "slot:lodging") {
    return { level: "soft_confirm", reason: "soft_lodging_baseline" };
  }
  if (
    family === "activity_preference" ||
    family === "scenic_preference" ||
    /低强度|节奏|轻松|慢一点|pace|low intensity|easy|slow/i.test(text)
  ) {
    return { level: "soft_confirm", reason: "soft_pace_style" };
  }
  if (
    /保险|医院|急救|药物|应急|insurance|hospital|emergency|medication|risk protocol/i.test(text) &&
    (family === "generic_constraint" || family === "limiting_factor" || kindLabel === "constraint")
  ) {
    return { level: "soft_confirm", reason: "soft_risk_protocol" };
  }

  return null;
}

function shouldExcludeCrossTripCarry(concept: any): boolean {
  const family = conceptFamily(concept);
  const semantic = conceptSemanticKey(concept);
  if (family === "destination" || family === "duration_city" || family === "meeting_critical") return true;
  if (semantic.startsWith("slot:destination:")) return true;
  if (semantic.startsWith("slot:duration_city:")) return true;
  if (semantic.startsWith("slot:meeting_critical:")) return true;
  if (semantic.startsWith("slot:sub_location:")) return true;
  if (semantic.startsWith("slot:budget")) return true;
  const text = conceptText(concept);
  if (/米兰|milan|京都|kyoto|东京|tokyo|巴黎|paris|罗马|rome/i.test(text) && family === "other") {
    return true;
  }
  return false;
}

function softCarryQuestionTitle(concept: any): string {
  return cleanInput(concept?.title, 120) || cleanInput(concept?.description, 120) || "偏好信息";
}

function buildSoftCarryQuestion(params: { locale: AppLocale; concept: any }): string {
  const title = softCarryQuestionTitle(params.concept);
  if (isEnglishLocale(params.locale)) {
    return `Should we keep this from your previous trip as well: "${title}"?`;
  }
  return `是否在新行程中继续沿用「${title}」？`;
}

function carriesByKeepText(concept: any, keepTokens: Set<string>, keepTextRaw: string): boolean {
  if (!keepTextRaw || !keepTokens.size) return false;
  const family = conceptFamily(concept);
  const semantic = conceptSemanticKey(concept);
  const text = conceptText(concept);
  if (/保留全部|延续全部|沿用全部|keep all|keep everything|same as last trip/i.test(keepTextRaw)) {
    return [
      "limiting_factor",
      "people",
      "budget",
      "lodging",
      "activity_preference",
      "scenic_preference",
      "generic_constraint",
      "duration_total",
    ].includes(family);
  }
  const conceptTokens = tokenize(text);
  if (hasTokenOverlap(keepTokens, conceptTokens)) return true;

  if (
    /饮食|低盐|低脂|高纤维|diet|low salt|low fat|fiber/i.test(keepTextRaw) &&
    (limitingKindFromSemantic(semantic) === "diet" || /饮食|diet/i.test(text))
  ) {
    return true;
  }
  if (
    /预算|budget/i.test(keepTextRaw) &&
    (family === "budget" || semantic.startsWith("slot:budget"))
  ) {
    return true;
  }
  if (
    /节奏|低强度|轻松|慢一点|pace|low intensity|easy/i.test(keepTextRaw) &&
    (family === "activity_preference" || /低强度|轻松|节奏|slow|low intensity/i.test(text))
  ) {
    return true;
  }
  if (
    /人数|同行|家人|父亲|母亲|parents|family|travelers|party size/i.test(keepTextRaw) &&
    (family === "people" || semantic === "slot:people")
  ) {
    return true;
  }
  return false;
}

function mapConceptKind(rawKind: any): "belief" | "constraint" | "preference" | "factual_assertion" {
  const kind = cleanInput(rawKind, 32).toLowerCase();
  if (kind === "belief" || kind === "constraint" || kind === "preference") return kind;
  return "factual_assertion";
}

function defaultLayerForType(type: "belief" | "constraint" | "preference" | "factual_assertion") {
  if (type === "belief") return "intent";
  if (type === "preference") return "preference";
  return "requirement";
}

function defaultStrengthForType(type: "belief" | "constraint" | "preference" | "factual_assertion") {
  return type === "constraint" ? "hard" : "soft";
}

async function buildBootstrapGraphAndPlan(params: {
  userId: ObjectId;
  locale: AppLocale;
  conversationId: string;
  bootstrap: ConversationPlanningBootstrap | null;
}): Promise<{ graph: CDG; travelPlanState: TravelPlanState; autoTitle?: string }> {
  const nowIso = new Date().toISOString();
  const fallbackPlan = defaultTravelPlanState({
    locale: params.locale,
    taskId: params.conversationId,
    nowIso,
  });
  if (!params.bootstrap) {
    return {
      graph: emptyGraph(params.conversationId),
      travelPlanState: fallbackPlan,
    };
  }

  const destination = cleanInput(params.bootstrap.destination, 80);
  const nodes: CDG["nodes"] = [];
  let destinationNodeId = "";
  if (destination) {
    destinationNodeId = stableGraphItemId("n_dest", destination);
    nodes.push({
      id: destinationNodeId,
      type: "factual_assertion",
      layer: "requirement",
      strength: "hard",
      statement: isEnglishLocale(params.locale) ? `Destination: ${destination}` : `目的地:${destination}`,
      status: "confirmed",
      confidence: 0.92,
      importance: 0.9,
      key: `slot:destination:${slugToken(destination, 56) || "unknown"}`,
      sourceMsgIds: ["manual_user_bootstrap", "planning_bootstrap"],
      validation_status: "resolved",
      value: {
        provenance: "planning_bootstrap",
        conceptState: {
          validation_status: "resolved",
        },
      },
    } as any);
  }

  const graph: CDG = {
    id: params.conversationId,
    version: 0,
    nodes: nodes.slice(0, 8),
    edges: [],
  };

  const summary = destination
    ? isEnglishLocale(params.locale)
      ? `New trip to ${destination}. Start the first turn to establish current-task rules before reviewing past motifs.`
      : `已创建前往${destination}的新旅行规划。请先开始第一轮对话，再评审历史规则建议。`
    : isEnglishLocale(params.locale)
    ? "A new trip planning session is created. Start chatting to establish the current task."
    : "已创建新的旅行规划会话，请先开始对话以建立当前任务语义。";
  const autoTitle = destination
    ? isEnglishLocale(params.locale)
      ? `Trip Plan · ${destination}`
      : `旅行规划·${destination}`
    : undefined;
  const travelPlanState = defaultTravelPlanState({
    locale: params.locale,
    taskId: params.conversationId,
    nowIso,
    destinationScope: destination ? [destination] : [],
    summary,
  });

  return {
    graph,
    travelPlanState,
    autoTitle,
  };
}

async function loadRecentTurnsForPlan(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
}) {
  return collections.turns
    .find({ conversationId: params.conversationId, userId: params.userId })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Math.min(params.limit || 120, 320)))
    .toArray();
}

async function loadRecentUserTextsForState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
}) {
  const docs = await collections.turns
    .find({ conversationId: params.conversationId, userId: params.userId })
    .sort({ createdAt: -1 })
    .limit(Math.max(8, Math.min(params.limit || 120, 320)))
    .toArray();
  return docs
    .reverse()
    .map((t) => String(t.userText || "").trim())
    .filter(Boolean);
}

async function computeTravelPlanState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  graph: CDG;
  concepts?: any[];
  motifs?: any[];
  previous?: TravelPlanState | null;
  locale: AppLocale;
  forceTaskSwitch?: boolean;
}): Promise<TravelPlanState> {
  const turns = await loadRecentTurnsForPlan({
    conversationId: params.conversationId,
    userId: params.userId,
    limit: 160,
  });
  return buildTravelPlanState({
    locale: params.locale,
    graph: params.graph,
    concepts: Array.isArray(params.concepts) ? params.concepts : [],
    motifs: Array.isArray(params.motifs) ? params.motifs : [],
    taskId: String(params.conversationId),
    turns: turns.map((t) => ({
      createdAt: t.createdAt,
      userText: t.userText,
      assistantText: t.assistantText,
    })),
    previous: params.previous || null,
    forceTaskSwitch: !!params.forceTaskSwitch,
  });
}

function buildTransferEvaluationTravelPlan(params: {
  locale: AppLocale;
  conversationId: string;
  graph: CDG;
  concepts?: any[];
  motifs?: any[];
  previous?: TravelPlanState | null;
  recentTurns: Array<{ createdAt?: Date | string; userText: string; assistantText: string }>;
  currentUserText: string;
  currentAssistantText: string;
  forceTaskSwitch?: boolean;
}): TravelPlanState {
  return buildTravelPlanState({
    locale: params.locale,
    graph: params.graph,
    concepts: Array.isArray(params.concepts) ? params.concepts : [],
    motifs: Array.isArray(params.motifs) ? params.motifs : [],
    taskId: params.conversationId,
    turns: [
      ...(params.recentTurns || []),
      {
        createdAt: new Date().toISOString(),
        userText: params.currentUserText,
        assistantText: params.currentAssistantText,
      },
    ],
    previous: params.previous || null,
    forceTaskSwitch: !!params.forceTaskSwitch,
  });
}

type PlanningStateBundle = {
  taskDetection: TaskDetection;
  cognitiveState: CognitiveState;
  portfolioDocumentState: PortfolioDocumentState;
};

type TurnRuntimeBase = {
  graph: CDG;
  concepts: any[];
  motifs: any[];
  motifLinks: any[];
  contexts: any[];
  recentDocs: any[];
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  stateContextUserTurns: string[];
  forceTaskSwitch: boolean;
};

function shouldResetTurnBaseline(taskDetection: TaskDetection): boolean {
  return (
    !!taskDetection?.is_task_switch &&
    (taskDetection.switch_reason_code === "explicit_restart" ||
      taskDetection.switch_reason_code === "destination_switch")
  );
}

async function buildTurnRuntimeBase(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  conv: any;
  locale: AppLocale;
  userText: string;
  taskLifecycle?: TaskLifecycleState | null;
}): Promise<TurnRuntimeBase> {
  const taskDetection = detectTaskSwitchFromLatestUserTurn({
    conversationId: String(params.conversationId),
    locale: params.locale,
    latestUserText: params.userText,
    previousTravelPlan: (params.conv as any).travelPlanState || null,
    taskLifecycle: params.taskLifecycle || null,
  });
  const forceTaskSwitch = shouldResetTurnBaseline(taskDetection);
  const recent = forceTaskSwitch
    ? []
    : await collections.turns
        .find({ conversationId: params.conversationId, userId: params.userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();
  const recentTurns = recent
    .slice()
    .reverse()
    .flatMap((t) => [
      { role: "user" as const, content: t.userText },
      { role: "assistant" as const, content: t.assistantText },
    ]);
  const stateContextUserTurns = forceTaskSwitch
    ? []
    : await loadRecentUserTextsForState({
        conversationId: params.conversationId,
        userId: params.userId,
        limit: 140,
      });

  return {
    graph: forceTaskSwitch ? emptyGraph(String(params.conversationId)) : params.conv.graph,
    concepts: forceTaskSwitch ? [] : params.conv.concepts || [],
    motifs: forceTaskSwitch ? [] : (params.conv as any).motifs || [],
    motifLinks: forceTaskSwitch ? [] : (params.conv as any).motifLinks || [],
    contexts: forceTaskSwitch ? [] : (params.conv as any).contexts || [],
    recentDocs: recent,
    recentTurns,
    stateContextUserTurns,
    forceTaskSwitch,
  };
}

type PersistedConversationSnapshot = PlanningStateBundle & {
  travelPlanState: TravelPlanState;
};

type PlanningStateBundleParams = {
  conversationId: ObjectId;
  userId: ObjectId;
  locale: AppLocale;
  model: ReturnType<typeof buildCognitiveModel>;
  travelPlanState: TravelPlanState;
  previousTravelPlan?: TravelPlanState | null;
  motifTransferState?: MotifTransferState | null;
  persistentMotifLibrary?: Awaited<ReturnType<typeof listUserMotifLibrary>>;
  taskLifecycle?: TaskLifecycleState | null;
  latestUserText?: string;
  isNewConversation?: boolean;
};

async function buildPlanningStateBundle(params: PlanningStateBundleParams): Promise<PlanningStateBundle> {
  const convs = await collections.conversations
    .find({ userId: params.userId, locale: params.locale })
    .project({ title: 1, travelPlanState: 1, updatedAt: 1, locale: 1 })
    .sort({ updatedAt: -1 })
    .limit(80)
    .toArray();
  const conversationRecords = convs.map((c) => ({
    conversationId: String(c._id),
    title: String((c as any)?.title || ""),
    travelPlanState: (c as any)?.travelPlanState || null,
    updatedAt: (c as any)?.updatedAt,
    locale: normalizeLocale((c as any)?.locale),
  }));
  const currentId = String(params.conversationId);
  const idx = conversationRecords.findIndex((x) => x.conversationId === currentId);
  if (idx >= 0) {
    conversationRecords[idx] = {
      ...conversationRecords[idx],
      travelPlanState: params.travelPlanState,
      updatedAt: new Date(),
    };
  } else {
    conversationRecords.unshift({
      conversationId: currentId,
      title: "",
      travelPlanState: params.travelPlanState,
      updatedAt: new Date(),
      locale: params.locale,
    });
  }

  const currentDestinationScope =
    (params.travelPlanState as any)?.destination_scope ||
    params.travelPlanState.destinations ||
    [];
  const previousDestinationScope =
    (params.previousTravelPlan as any)?.destination_scope ||
    params.previousTravelPlan?.destinations ||
    [];

  const taskDetection = buildTaskDetection({
    conversationId: String(params.travelPlanState.task_id || params.conversationId),
    locale: params.locale,
    currentDestinations: currentDestinationScope,
    previousDestinations: previousDestinationScope,
    isNewConversation: !!params.isNewConversation,
    taskLifecycle: params.taskLifecycle || null,
    latestUserText: params.latestUserText,
    tripGoalSummary: cleanInput(params.travelPlanState.trip_goal_summary || params.travelPlanState.summary, 220),
    travelers: Array.isArray(params.travelPlanState.travelers) ? params.travelPlanState.travelers : [],
    duration: cleanInput(params.travelPlanState.travel_dates_or_duration, 80) || undefined,
  });

  const cognitiveState = buildCognitiveState({
    conversationId: String(params.conversationId),
    locale: params.locale,
    model: params.model,
    travelPlanState: params.travelPlanState,
    conversations: conversationRecords,
    motifTransferState: params.motifTransferState || null,
    persistentMotifLibrary: params.persistentMotifLibrary || [],
  });

  const portfolioDocumentState = buildPortfolioDocumentState({
    userId: String(params.userId),
    locale: params.locale,
    conversations: conversationRecords,
  });

  return {
    taskDetection,
    cognitiveState,
    portfolioDocumentState,
  };
}

function buildPlanningStateBundleFallback(params: PlanningStateBundleParams): PlanningStateBundle {
  const conversationRecords = [
    {
      conversationId: String(params.conversationId),
      title: "",
      travelPlanState: params.travelPlanState,
      updatedAt: new Date(),
      locale: params.locale,
    },
  ];
  const currentDestinationScope =
    (params.travelPlanState as any)?.destination_scope ||
    params.travelPlanState.destinations ||
    [];
  const previousDestinationScope =
    (params.previousTravelPlan as any)?.destination_scope ||
    params.previousTravelPlan?.destinations ||
    [];

  return {
    taskDetection: buildTaskDetection({
      conversationId: String(params.travelPlanState.task_id || params.conversationId),
      locale: params.locale,
      currentDestinations: currentDestinationScope,
      previousDestinations: previousDestinationScope,
      isNewConversation: !!params.isNewConversation,
      taskLifecycle: params.taskLifecycle || null,
      latestUserText: params.latestUserText,
      tripGoalSummary: cleanInput(params.travelPlanState.trip_goal_summary || params.travelPlanState.summary, 220),
      travelers: Array.isArray(params.travelPlanState.travelers) ? params.travelPlanState.travelers : [],
      duration: cleanInput(params.travelPlanState.travel_dates_or_duration, 80) || undefined,
    }),
    cognitiveState: buildCognitiveState({
      conversationId: String(params.conversationId),
      locale: params.locale,
      model: params.model,
      travelPlanState: params.travelPlanState,
      conversations: conversationRecords,
      motifTransferState: params.motifTransferState || null,
      persistentMotifLibrary: params.persistentMotifLibrary || [],
    }),
    portfolioDocumentState: buildPortfolioDocumentState({
      userId: String(params.userId),
      locale: params.locale,
      conversations: conversationRecords,
    }),
  };
}

async function safeBuildPlanningStateBundle(params: PlanningStateBundleParams): Promise<PlanningStateBundle> {
  try {
    return await buildPlanningStateBundle(params);
  } catch (error) {
    console.error("Failed to build planning state bundle; falling back to current conversation only.", {
      conversationId: String(params.conversationId),
      userId: String(params.userId),
      error,
    });
    return buildPlanningStateBundleFallback(params);
  }
}

async function persistConversationModel(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  model: ReturnType<typeof buildCognitiveModel>;
  updatedAt: Date;
  previousTravelPlan?: TravelPlanState | null;
  locale: AppLocale;
  motifTransferState?: MotifTransferState | null;
  taskLifecycle?: TaskLifecycleState;
  forceTaskSwitch?: boolean;
  previousMotifs?: any[];
  turnNumber?: number;
  latestUserText?: string;
}): Promise<PersistedConversationSnapshot> {
  const motifsWithTransfer = applyTransferStateToMotifs({
    motifs: annotateMotifExtractionMeta({
      motifs: params.model.motifs || [],
      previousMotifs: Array.isArray(params.previousMotifs) ? (params.previousMotifs as any) : [],
      turnNumber: Number(params.turnNumber || 0) > 0 ? Number(params.turnNumber) : 1,
    }),
    state: params.motifTransferState || null,
  });
  const modelWithTransfer = {
    ...params.model,
    motifs: motifsWithTransfer,
    motifGraph: {
      ...(params.model.motifGraph || { motifs: [], motifLinks: [] }),
      motifs: motifsWithTransfer,
    },
  };
  const travelPlanState = await computeTravelPlanState({
    conversationId: params.conversationId,
    userId: params.userId,
    graph: modelWithTransfer.graph,
    concepts: modelWithTransfer.concepts,
    motifs: modelWithTransfer.motifs,
    previous: params.previousTravelPlan || null,
    locale: params.locale,
    forceTaskSwitch: !!params.forceTaskSwitch,
  });
  const persistentMotifLibrary = await listUserMotifLibrary(params.userId, params.locale);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: params.conversationId,
    userId: params.userId,
    locale: params.locale,
    model: modelWithTransfer,
    travelPlanState,
    previousTravelPlan: params.previousTravelPlan || null,
    motifTransferState: params.motifTransferState || null,
    persistentMotifLibrary,
    taskLifecycle: params.taskLifecycle || null,
    latestUserText: params.latestUserText,
  });
  await collections.conversations.updateOne(
    { _id: params.conversationId, userId: params.userId },
    {
      $set: {
        graph: modelWithTransfer.graph,
        concepts: modelWithTransfer.concepts,
        motifs: modelWithTransfer.motifs,
        motifLinks: modelWithTransfer.motifLinks,
        motifReasoningView: modelWithTransfer.motifReasoningView,
        contexts: modelWithTransfer.contexts,
        validationStatus: modelWithTransfer.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState: params.motifTransferState || readMotifTransferState(null),
        taskLifecycle: params.taskLifecycle || readTaskLifecycle(null),
        updatedAt: params.updatedAt,
      },
    }
  );
  return {
    travelPlanState,
    ...planning,
  };
}

function normalizeReasoningSteps(model: ReturnType<typeof buildCognitiveModel>) {
  const steps = Array.isArray(model?.motifReasoningView?.steps) ? model.motifReasoningView.steps : [];
  return steps.map((step: any, idx: number) => ({
    step_id: String(step?.step_id || step?.id || `S${idx + 1}`),
    summary: String(step?.summary || step?.explanation || "").trim().slice(0, 240),
    motif_ids: Array.isArray(step?.motif_ids)
      ? step.motif_ids
      : [String(step?.motifId || "")].filter(Boolean),
    concept_ids: Array.isArray(step?.concept_ids)
      ? step.concept_ids
      : Array.isArray(step?.usedConceptIds)
      ? step.usedConceptIds
      : [],
    depends_on: Array.isArray(step?.depends_on)
      ? step.depends_on
      : Array.isArray(step?.dependsOnMotifIds)
      ? step.dependsOnMotifIds
      : [],
  }));
}

function modelPayload(model: ReturnType<typeof buildCognitiveModel>) {
  const reasoning_steps = normalizeReasoningSteps(model);
  return {
    algorithm_version: model.algorithmVersion || "v3",
    algorithm_pipeline: model.algorithmPipeline,
    graph: model.graph,
    concept_graph: model.conceptGraph,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    motif_graph: {
      motifs: model.motifGraph.motifs,
      motif_links: model.motifGraph.motifLinks,
    },
    motifReasoningView: model.motifReasoningView,
    motifInvariantReport: model.motifInvariantReport,
    reasoning_steps,
    concepts: model.concepts,
    contexts: model.contexts,
    validation_status: model.validationStatus,
  };
}

/**
 * SSE 发送（event + data）
 * data 必须是 JSON 可序列化对象（或 string），我们统一 JSON.stringify。
 */
function sseSend(res: any, event: string, data: any) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // 某些环境/中间件会提供 flush，用它能更及时把 chunk 推给客户端
    res.flush?.();
  } catch {
    // 忽略写入异常（通常是客户端断开）
  }
}

async function refreshConversationTransferProjection(params: {
  oid: ObjectId;
  userId: ObjectId;
  locale: AppLocale;
  conv: any;
  motifTransferState: MotifTransferState;
  taskLifecycle?: TaskLifecycleState;
  latestUserText?: string;
}) {
  const model = buildCognitiveModel({
    graph: params.conv.graph,
    prevConcepts: params.conv.concepts || [],
    baseConcepts: params.conv.concepts || [],
    baseMotifs: (params.conv as any).motifs || [],
    baseMotifLinks: (params.conv as any).motifLinks || [],
    baseContexts: (params.conv as any).contexts || [],
    locale: params.locale,
  });
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: params.motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };

  const travelPlanState =
    ((params.conv as any).travelPlanState as TravelPlanState | null) ||
    (await computeTravelPlanState({
      conversationId: params.oid,
      userId: params.userId,
      graph: model.graph,
      concepts: model.concepts,
      motifs: model.motifs,
      previous: null,
      locale: params.locale,
    }));
  const planning = await safeBuildPlanningStateBundle({
    conversationId: params.oid,
    userId: params.userId,
    locale: params.locale,
    model,
    travelPlanState,
    previousTravelPlan: (params.conv as any).travelPlanState || null,
    motifTransferState: params.motifTransferState,
    persistentMotifLibrary: await listUserMotifLibrary(params.userId, params.locale),
    taskLifecycle: params.taskLifecycle || null,
    latestUserText: params.latestUserText,
  });
  const now = new Date();
  await collections.conversations.updateOne(
    { _id: params.oid, userId: params.userId },
    {
      $set: {
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        motifReasoningView: model.motifReasoningView,
        contexts: model.contexts,
        validationStatus: model.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState: params.motifTransferState,
        taskLifecycle: params.taskLifecycle || readTaskLifecycle((params.conv as any)?.taskLifecycle),
        updatedAt: now,
      },
    }
  );
  return {
    model,
    travelPlanState,
    planning,
    updatedAt: now,
  };
}

// ==========================
// Conversations CRUD
// ==========================

convRouter.get("/", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const localeQuery = cleanInput((req.query as any)?.locale, 16);
  const localeFilter = localeQuery ? normalizeLocale(localeQuery) : null;
  const list = await collections.conversations
    .find(localeFilter ? { userId, locale: localeFilter } : { userId })
    .project({ title: 1, updatedAt: 1, locale: 1 })
    .sort({ updatedAt: -1 })
    .toArray();

  res.json(
    list.map((x) => ({
      conversationId: String(x._id),
      title: x.title,
      updatedAt: x.updatedAt,
      locale: normalizeLocale((x as any).locale),
    }))
  );
}));

convRouter.post("/", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const locale = normalizeLocale(req.body?.locale);
  const planningBootstrap = parsePlanningBootstrap(req.body?.planningBootstrap);
  const planningBootstrapHints = readPlanningBootstrapHints(planningBootstrap);
  const defaultTitle = isEnglishLocale(locale) ? "New Conversation" : "新对话";
  const requestedTitle = cleanInput(req.body?.title || defaultTitle, 80) || defaultTitle;
  const now = new Date();
  const systemPrompt = defaultSystemPrompt(locale);
  const nowIso = now.toISOString();

  const inserted = await collections.conversations.insertOne({
    userId,
    title: requestedTitle,
    locale,
    systemPrompt,
    model: config.model,
    createdAt: now,
    updatedAt: now,
    graph: emptyGraph("temp"), // 先占位，写入后再用 _id 修正
    concepts: [],
    motifs: [],
    motifLinks: [],
    motifReasoningView: { nodes: [], edges: [] },
    contexts: [],
    validationStatus: "unasked",
    motifTransferState: readMotifTransferState(null),
    taskLifecycle: readTaskLifecycle(null),
    planningBootstrapHints,
    travelPlanState: defaultTravelPlanState({
      locale,
      taskId: "temp",
      nowIso,
    }),
  } as any);

  const conversationId = String(inserted.insertedId);
  const bootstrap = await buildBootstrapGraphAndPlan({
    userId,
    locale,
    conversationId,
    bootstrap: planningBootstrap,
  });
  const finalTitle =
    requestedTitle === defaultTitle && bootstrap.autoTitle
      ? bootstrap.autoTitle.slice(0, 80)
      : requestedTitle;

  await collections.conversations.updateOne(
    { _id: inserted.insertedId, userId },
    {
      $set: {
        title: finalTitle,
        graph: bootstrap.graph,
        concepts: [],
        motifs: [],
        motifLinks: [],
        motifReasoningView: { nodes: [], edges: [] },
        contexts: [],
        validationStatus: "unasked",
        motifTransferState: readMotifTransferState(null),
        taskLifecycle: readTaskLifecycle(null),
        planningBootstrapHints,
        travelPlanState: bootstrap.travelPlanState,
      },
    }
  );

  const conv = await collections.conversations.findOne({ _id: inserted.insertedId, userId });
  if (!conv) return res.status(500).json({ error: "failed to create conversation" });

  const model = buildCognitiveModel({
    graph: conv.graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
  const travelPlanState = await computeTravelPlanState({
    conversationId: inserted.insertedId,
    userId,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    previous: null,
    locale,
  });
  const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  const persistentMotifLibrary = await listUserMotifLibrary(userId, locale);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: inserted.insertedId,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: null,
    motifTransferState,
    persistentMotifLibrary,
    taskLifecycle,
    isNewConversation: true,
  });
  await collections.conversations.updateOne(
    { _id: inserted.insertedId, userId },
    {
      $set: {
        title: finalTitle,
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        motifReasoningView: model.motifReasoningView,
        contexts: model.contexts,
        validationStatus: model.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState,
        taskLifecycle,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId,
    title: finalTitle,
    locale: normalizeLocale((conv as any).locale),
    systemPrompt: conv.systemPrompt,
    ...modelPayload(model),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
  });
}));

convRouter.get("/:id", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);

  const model = buildCognitiveModel({
    graph: conv.graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
  const travelPlanState = (conv as any).travelPlanState as TravelPlanState;
  const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  const persistentMotifLibrary = await listUserMotifLibrary(userId, locale);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary,
    taskLifecycle,
  });

  res.json({
    conversationId: id,
    title: conv.title,
    locale,
    systemPrompt: conv.systemPrompt,
    ...modelPayload(model),
    travelPlanState,
    taskDetection: (conv as any).taskDetection || planning.taskDetection,
    cognitiveState: (conv as any).cognitiveState || planning.cognitiveState,
    portfolioDocumentState: (conv as any).portfolioDocumentState || planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
  });
}));

convRouter.post("/:id/task/resume", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);
  const nextLifecycle = reopenTaskLifecycle(readTaskLifecycle((conv as any).taskLifecycle));
  const now = new Date();

  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        taskLifecycle: nextLifecycle,
        updatedAt: now,
      },
    }
  );

  const refreshedConv = await collections.conversations.findOne({ _id: oid, userId });
  if (!refreshedConv) return res.status(500).json({ error: "conversation refresh failed" });

  const model = buildCognitiveModel({
    graph: refreshedConv.graph,
    prevConcepts: refreshedConv.concepts || [],
    baseConcepts: refreshedConv.concepts || [],
    baseMotifs: (refreshedConv as any).motifs || [],
    baseMotifLinks: (refreshedConv as any).motifLinks || [],
    baseContexts: (refreshedConv as any).contexts || [],
    locale,
  });
  const travelPlanState = (refreshedConv as any).travelPlanState as TravelPlanState;
  const motifTransferState = readMotifTransferState((refreshedConv as any).motifTransferState);
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (refreshedConv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: await listUserMotifLibrary(userId, locale),
    taskLifecycle: nextLifecycle,
  });

  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId: id,
    title: refreshedConv.title,
    locale,
    systemPrompt: refreshedConv.systemPrompt,
    ...modelPayload(model),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle: nextLifecycle,
  });
}));

convRouter.put("/:id/graph", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);

  const incomingGraph = req.body?.graph;
  if (!incomingGraph || typeof incomingGraph !== "object") {
    return res.status(400).json({ error: "graph required" });
  }
  if (!Array.isArray(incomingGraph.nodes) || !Array.isArray(incomingGraph.edges)) {
    return res.status(400).json({ error: "graph.nodes and graph.edges must be arrays" });
  }

  const prevGraph: CDG = {
    id: String(conv.graph?.id || id),
    version: Number(conv.graph?.version || 0),
    nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
    edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
  };

  const normalized = normalizeGraphSnapshot(incomingGraph, {
    id: prevGraph.id,
    version: prevGraph.version,
  });
  normalized.id = prevGraph.id;
  const model = buildCognitiveModel({
    graph: normalized,
    prevConcepts: conv.concepts || [],
    baseConcepts: Array.isArray(req.body?.concepts) ? req.body.concepts : conv.concepts || [],
    baseMotifs: Array.isArray(req.body?.motifs)
      ? req.body.motifs
      : Array.isArray(req.body?.motif_graph?.motifs)
      ? req.body.motif_graph.motifs
      : (conv as any).motifs || [],
    baseMotifLinks: Array.isArray(req.body?.motifLinks)
      ? req.body.motifLinks
      : Array.isArray(req.body?.motif_graph?.motif_links)
      ? req.body.motif_graph.motif_links
      : (conv as any).motifLinks || [],
    baseContexts: Array.isArray(req.body?.contexts) ? req.body.contexts : (conv as any).contexts || [],
    locale,
  });
  const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);

  const requestAdvice = parseBoolFlag(req.body?.requestAdvice);
  const conflictGate = requestAdvice ? buildConflictGatePayload(model.motifs, locale) : null;
  const advicePrompt = String(req.body?.advicePrompt || "").trim().slice(0, 1200);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    previous: (conv as any).travelPlanState || null,
    locale,
  });
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: await listUserMotifLibrary(userId, locale),
    taskLifecycle,
  });

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        motifReasoningView: model.motifReasoningView,
        contexts: model.contexts,
        validationStatus: model.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState,
        taskLifecycle,
        updatedAt: now,
      },
    }
  );

  let assistantText = "";
  let adviceError = "";
  if (requestAdvice && !conflictGate) {
    try {
      const recent = await collections.turns
        .find({ conversationId: oid, userId })
        .sort({ createdAt: -1 })
        .limit(12)
        .toArray();
      const recentTurns = recent
        .reverse()
        .flatMap((t) => [
          { role: "user" as const, content: t.userText },
          { role: "assistant" as const, content: t.assistantText },
        ]);

      const mergedPrompt =
        advicePrompt ||
        (isEnglishLocale(locale)
          ? "The user has manually edited the intent graph. Treat this graph as the latest source of truth and provide executable next-step advice from recent dialogue. Give an action plan first, then ask 1-2 focused clarifying questions."
          : "用户已经手动修改了意图流程图。请把这个图视为最新有效意图，结合最近对话给出下一步可执行建议。先给具体行动方案，再给1-2个澄清问题。");

      assistantText = await generateAssistantTextNonStreaming({
        graph: model.graph,
        userText: mergedPrompt,
        recentTurns,
        systemPrompt: withTransferSystemPrompt({
          locale,
          baseSystemPrompt: conv.systemPrompt,
          motifTransferState,
        }),
        locale,
        motifTransferState,
      });
    } catch (e: any) {
      adviceError = String(e?.message || "advice_generation_failed");
    }
  } else if (requestAdvice && conflictGate) {
    adviceError = "blocked:motif_conflict_gate";
  }

  res.json({
    conversationId: id,
    locale,
    ...modelPayload(model),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
    updatedAt: now,
    assistantText,
    adviceError,
    conflictGate,
  });
}));

convRouter.put("/:id/concepts", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);

  if (!Array.isArray(req.body?.concepts)) {
    return res.status(400).json({ error: "concepts array required" });
  }

  const prevGraph: CDG = {
    id: String(conv.graph?.id || id),
    version: Number(conv.graph?.version || 0),
    nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
    edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
  };
  const model = buildCognitiveModel({
    graph: prevGraph,
    prevConcepts: conv.concepts || [],
    baseConcepts: req.body?.concepts,
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
  const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    previous: (conv as any).travelPlanState || null,
    locale,
  });
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: await listUserMotifLibrary(userId, locale),
    taskLifecycle,
  });

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        motifReasoningView: model.motifReasoningView,
        contexts: model.contexts,
        validationStatus: model.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState,
        taskLifecycle,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId: id,
    locale,
    ...modelPayload(model),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
    updatedAt: now,
  });
}));

// 前端加载历史 turns（默认 30 条）
convRouter.get("/:id/turns", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const limit = Math.min(Math.max(Number(req.query?.limit || 30), 1), 200);

  const turns = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  res.json(
    turns.map((t) => ({
      id: String(t._id),
      createdAt: t.createdAt,
      userText: t.userText,
      assistantText: t.assistantText,
      graphVersion: t.graphVersion,
    }))
  );
}));

// 导出当前旅行计划 PDF（含中文自然语言与按天行程）
async function handleTravelPlanPdfExport(req: AuthedRequest, res: any) {
  try {
    const userId = req.userId!;
    const id = req.params.id;

    const oid = parseObjectId(id);
    if (!oid) return res.status(400).json({ error: "invalid conversation id" });

    const conv = await collections.conversations.findOne({ _id: oid, userId });
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    const locale = normalizeLocale((conv as any).locale);
    const turns = await loadRecentTurnsForPlan({ conversationId: oid, userId, limit: 240 });

    const graph: CDG = {
      id: String(conv.graph?.id || id),
      version: Number(conv.graph?.version || 0),
      nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
      edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
    };
    const model = buildCognitiveModel({
      graph,
      prevConcepts: conv.concepts || [],
      baseConcepts: conv.concepts || [],
      baseMotifs: (conv as any).motifs || [],
      baseMotifLinks: (conv as any).motifLinks || [],
      baseContexts: (conv as any).contexts || [],
      locale,
    });
    const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
    const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    const travelPlanState =
      turns.length > 0
        ? buildTravelPlanState({
            locale,
            graph,
            concepts: model.concepts || [],
            motifs: model.motifs || [],
            taskId: String(oid),
            turns: turns.map((t) => ({
              createdAt: t.createdAt,
              userText: t.userText,
              assistantText: t.assistantText,
            })),
            previous: (conv as any).travelPlanState || null,
          })
        : ((conv as any).travelPlanState as TravelPlanState | null);
    if (!travelPlanState) {
      return res.status(400).json({ error: "no travel plan state yet, cannot export plan" });
    }
    const planning = await safeBuildPlanningStateBundle({
      conversationId: oid,
      userId,
      locale,
      model,
      travelPlanState,
      previousTravelPlan: (conv as any).travelPlanState || null,
      motifTransferState,
      persistentMotifLibrary: await listUserMotifLibrary(userId, locale),
      taskLifecycle,
    });

    const now = new Date();
    await collections.conversations.updateOne(
      { _id: oid, userId },
      {
        $set: {
          travelPlanState,
          taskDetection: planning.taskDetection,
          cognitiveState: planning.cognitiveState,
          portfolioDocumentState: planning.portfolioDocumentState,
          motifTransferState,
          taskLifecycle,
          updatedAt: now,
        },
      }
    );

    const pdf =
      planning.portfolioDocumentState?.trips?.length > 0
        ? await renderPortfolioTravelPlanPdf({
            portfolio: planning.portfolioDocumentState,
            conversationId: id,
            locale,
            fallbackPlan: travelPlanState,
          })
        : await renderTravelPlanPdf({
            plan: travelPlanState,
            conversationId: id,
            locale,
          });
    const filename = defaultTravelPlanFileName(id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=\"travel-plan.pdf\"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    return res.status(200).send(pdf);
  } catch (err: any) {
    return res.status(500).json({
      error:
        err?.message ||
        "travel plan pdf export failed",
    });
  }
}

// Keep both paths for compatibility. Prefer `/export` on frontend to avoid
// static-server extension interception on some nginx setups.
convRouter.get("/:id/travel-plan/export", asyncRoute(handleTravelPlanPdfExport));
convRouter.get("/:id/travel-plan/export.pdf", asyncRoute(handleTravelPlanPdfExport));
convRouter.post("/:id/travel-plan/export", asyncRoute(handleTravelPlanPdfExport));
convRouter.post("/:id/travel-plan/export.pdf", asyncRoute(handleTravelPlanPdfExport));

// ==========================
// Turn - Non-stream (CLI/debug)
// ==========================

convRouter.post("/:id/turn", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const locale = normalizeLocale((conv as any).locale);
  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  let taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const retrievalHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const manualReferences = parseManualReferences(req.body?.manualReferences);
  if (taskLifecycle.status === "closed") {
    return res.status(409).json(taskClosedErrorPayload(taskLifecycle));
  }

  const turnBase = await buildTurnRuntimeBase({
    conversationId: oid,
    userId,
    conv,
    locale,
    userText,
    taskLifecycle,
  });
  const graph: CDG = turnBase.graph;
  const recentTurns = turnBase.recentTurns;
  const stateContextUserTurns = turnBase.stateContextUserTurns;
  const baseConcepts = turnBase.concepts;
  const baseMotifs = turnBase.motifs;
  const baseMotifLinks = turnBase.motifLinks;
  const baseContexts = turnBase.contexts;
  const turnNumber = Number(turnBase.recentDocs.length || 0) + 1;

  const revisionProbe = registerRevisionRequestFromUtterance({
    locale,
    currentState: motifTransferState,
    userText,
  });
  motifTransferState = revisionProbe.state;
  const pendingInjection = (motifTransferState.activeInjections || []).find(
    (x) => x.injection_state === "pending_confirmation"
  );
  if (pendingInjection && isAffirmativeForTransfer(userText)) {
    motifTransferState = confirmModifiedInjection({
      currentState: motifTransferState,
      candidateId: pendingInjection.candidate_id,
    });
  } else if (pendingInjection && isNegativeForTransfer(userText)) {
    const denied = applyTransferFeedback({
      locale,
      currentState: motifTransferState,
      signal: "explicit_not_applicable",
      signalText: userText,
      candidateId: pendingInjection.candidate_id,
      motifTypeId: pendingInjection.motif_type_id,
    });
    motifTransferState = denied.state;
  }

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  preModel.motifs = applyTransferStateToMotifs({
    motifs: preModel.motifs || [],
    state: motifTransferState,
  });
  preModel.motifGraph = { ...(preModel.motifGraph || { motifs: [], motifLinks: [] }), motifs: preModel.motifs };
  const conflictGate = buildConflictGatePayload(preModel.motifs, locale);
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: baseMotifs,
      turnNumber,
      latestUserText: userText,
    });

    return res.json({
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      ...modelPayload(preModel),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState,
      taskLifecycle,
      conflictGate,
    });
  }

  // ✅ 把 conv.systemPrompt 传给 LLM
  const out = await generateTurn({
    graph,
    userText,
    recentTurns,
    stateContextUserTurns,
    systemPrompt: withTransferSystemPrompt({
      locale,
      baseSystemPrompt: conv.systemPrompt,
      motifTransferState,
      manualReferences,
    }),
    locale,
    motifTransferState,
  });

  const merged = applyPatchWithGuards(graph, out.graph_patch);
  const model = buildCognitiveModel({
    graph: merged.newGraph,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

  if (revisionProbe.followupQuestion) {
    out.assistant_text = `${String(out.assistant_text || "").trim()}\n${revisionProbe.followupQuestion}`.trim();
  }

  if (shouldEvaluateTransferRecommendations({ priorTurnCount: turnBase.recentDocs.length, motifTransferState })) {
    const motifLibrary = await listUserMotifLibrary(userId, locale);
    const currentTaskIdForRetrieval = currentTaskId((conv as any).travelPlanState || null, String(oid));
    const previewTravelPlan = buildTransferEvaluationTravelPlan({
      locale,
      conversationId: String(oid),
      graph: model.graph,
      concepts: model.concepts,
      motifs: model.motifs,
      previous: (conv as any).travelPlanState || null,
      recentTurns: turnBase.forceTaskSwitch
        ? []
        : turnBase.recentDocs
            .slice()
            .reverse()
            .map((t) => ({
              createdAt: t.createdAt,
              userText: t.userText,
              assistantText: t.assistantText,
            })),
      currentUserText: userText,
      currentAssistantText: out.assistant_text,
      forceTaskSwitch: turnBase.forceTaskSwitch,
    });
    const recommendations = buildTransferRecommendations({
      locale,
      conversationId: String(oid),
      currentTaskId: previewTravelPlan.task_id || currentTaskIdForRetrieval,
      travelPlanState: previewTravelPlan,
      retrievalHints,
      motifLibrary,
      existingState: motifTransferState,
      maxCount: 4,
    });
    motifTransferState = {
      ...motifTransferState,
      recommendations,
      lastEvaluatedAt: new Date().toISOString(),
    };
  }
  model.motifs = applyTransferStateToMotifs({
    motifs: model.motifs || [],
    state: motifTransferState,
  });
  model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };

  const now = new Date();
  await collections.turns.insertOne({
    conversationId: oid,
    userId,
    createdAt: now,
    userText,
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    graphVersion: model.graph.version,
  } as any);

  const persisted = await persistConversationModel({
    conversationId: oid,
    userId,
    model,
    updatedAt: now,
    previousTravelPlan: (conv as any).travelPlanState || null,
    locale,
    motifTransferState,
    taskLifecycle,
    forceTaskSwitch: turnBase.forceTaskSwitch,
    previousMotifs: baseMotifs,
    turnNumber,
    latestUserText: userText,
  });

  res.json({
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    ...modelPayload(model),
    travelPlanState: persisted.travelPlanState,
    taskDetection: persisted.taskDetection,
    cognitiveState: persisted.cognitiveState,
    portfolioDocumentState: persisted.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
  });
}));

// ==========================
// Turn - Stream (SSE for UX)
// ==========================

convRouter.post("/:id/turn/stream", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const locale = normalizeLocale((conv as any).locale);
  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  let taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const retrievalHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const manualReferences = parseManualReferences(req.body?.manualReferences);
  if (taskLifecycle.status === "closed") {
    return res.status(409).json(taskClosedErrorPayload(taskLifecycle));
  }

  const turnBase = await buildTurnRuntimeBase({
    conversationId: oid,
    userId,
    conv,
    locale,
    userText,
    taskLifecycle,
  });
  const graph: CDG = turnBase.graph;
  const recentTurns = turnBase.recentTurns;
  const stateContextUserTurns = turnBase.stateContextUserTurns;
  const baseConcepts = turnBase.concepts;
  const baseMotifs = turnBase.motifs;
  const baseMotifLinks = turnBase.motifLinks;
  const baseContexts = turnBase.contexts;
  const turnNumber = Number(turnBase.recentDocs.length || 0) + 1;

  const revisionProbe = registerRevisionRequestFromUtterance({
    locale,
    currentState: motifTransferState,
    userText,
  });
  motifTransferState = revisionProbe.state;
  const pendingInjection = (motifTransferState.activeInjections || []).find(
    (x) => x.injection_state === "pending_confirmation"
  );
  if (pendingInjection && isAffirmativeForTransfer(userText)) {
    motifTransferState = confirmModifiedInjection({
      currentState: motifTransferState,
      candidateId: pendingInjection.candidate_id,
    });
  } else if (pendingInjection && isNegativeForTransfer(userText)) {
    const denied = applyTransferFeedback({
      locale,
      currentState: motifTransferState,
      signal: "explicit_not_applicable",
      signalText: userText,
      candidateId: pendingInjection.candidate_id,
      motifTypeId: pendingInjection.motif_type_id,
    });
    motifTransferState = denied.state;
  }

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  preModel.motifs = applyTransferStateToMotifs({
    motifs: preModel.motifs || [],
    state: motifTransferState,
  });
  preModel.motifGraph = { ...(preModel.motifGraph || { motifs: [], motifLinks: [] }), motifs: preModel.motifs };
  const conflictGate = buildConflictGatePayload(preModel.motifs, locale);
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };

    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: baseMotifs,
      turnNumber,
      latestUserText: userText,
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();
    sseSend(res, "start", { conversationId: id, graphVersion: preModel.graph.version });
    sseSend(res, "token", { token: conflictGate.message });
    sseSend(res, "done", {
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      ...modelPayload(preModel),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState,
      taskLifecycle,
      conflictGate,
    });
    return res.end();
  }

  // SSE headers
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as any).flushHeaders?.();

  // start
  sseSend(res, "start", { conversationId: id, graphVersion: graph.version });

  // heartbeat ping
  const pingTimer = setInterval(() => {
    sseSend(res, "ping", { t: Date.now() });
  }, 15000);

  // abort handling
  const ac = new AbortController();
  let closed = false;

  req.on("close", () => {
    closed = true;
    clearInterval(pingTimer);
    ac.abort();
  });

  let sentAnyToken = false;

  try {
    // ✅ 把 conv.systemPrompt 传给流式 LLM
    const out = await generateTurnStreaming({
      graph,
      userText,
      recentTurns,
      stateContextUserTurns,
      systemPrompt: withTransferSystemPrompt({
        locale,
        baseSystemPrompt: conv.systemPrompt,
        motifTransferState,
        manualReferences,
      }),
      locale,
      signal: ac.signal,
      motifTransferState,
      onToken: (token) => {
        if (closed) return;
        if (typeof token !== "string" || token.length === 0) return;
        sentAnyToken = true;

        // ✅ token 统一发 JSON：{ token: "..." }
        sseSend(res, "token", { token });
      },
    });

    if (closed) return;

    if (revisionProbe.followupQuestion) {
      const appended = `${String(out.assistant_text || "").trim()}\n${revisionProbe.followupQuestion}`.trim();
      const delta = appended.slice(String(out.assistant_text || "").length);
      if (delta) {
        sentAnyToken = true;
        sseSend(res, "token", { token: delta });
      }
      out.assistant_text = appended;
    }

    const merged = applyPatchWithGuards(graph, out.graph_patch);
    const model = buildCognitiveModel({
      graph: merged.newGraph,
      prevConcepts: baseConcepts,
      baseConcepts,
      baseMotifs,
      baseMotifLinks,
      baseContexts,
      locale,
    });
    model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

    if (shouldEvaluateTransferRecommendations({ priorTurnCount: turnBase.recentDocs.length, motifTransferState })) {
      const motifLibrary = await listUserMotifLibrary(userId, locale);
      const currentTaskIdForRetrieval = currentTaskId((conv as any).travelPlanState || null, String(oid));
      const previewTravelPlan = buildTransferEvaluationTravelPlan({
        locale,
        conversationId: String(oid),
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        previous: (conv as any).travelPlanState || null,
        recentTurns: turnBase.forceTaskSwitch
          ? []
          : turnBase.recentDocs
              .slice()
              .reverse()
              .map((t) => ({
                createdAt: t.createdAt,
                userText: t.userText,
                assistantText: t.assistantText,
              })),
        currentUserText: userText,
        currentAssistantText: out.assistant_text,
        forceTaskSwitch: turnBase.forceTaskSwitch,
      });
      const recommendations = buildTransferRecommendations({
        locale,
        conversationId: String(oid),
        currentTaskId: previewTravelPlan.task_id || currentTaskIdForRetrieval,
        travelPlanState: previewTravelPlan,
        retrievalHints,
        motifLibrary,
        existingState: motifTransferState,
        maxCount: 4,
      });
      motifTransferState = {
        ...motifTransferState,
        recommendations,
        lastEvaluatedAt: new Date().toISOString(),
      };
    }
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };

    const now = new Date();
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      graphVersion: model.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      model,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: baseMotifs,
      turnNumber,
      latestUserText: userText,
    });

    sseSend(res, "done", {
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      ...modelPayload(model),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState,
      taskLifecycle,
    });

    clearInterval(pingTimer);
    res.end();
  } catch (e: any) {
    // 降级：若尚未吐 token，则走非流式（保证可用）
    if (!sentAnyToken && !closed) {
      try {
        const out2 = await generateTurn({
          graph,
          userText,
          recentTurns,
          stateContextUserTurns,
          systemPrompt: withTransferSystemPrompt({
            locale,
            baseSystemPrompt: conv.systemPrompt,
            motifTransferState,
            manualReferences,
          }),
          locale,
          motifTransferState,
        });

        if (revisionProbe.followupQuestion) {
          out2.assistant_text = `${String(out2.assistant_text || "").trim()}\n${revisionProbe.followupQuestion}`.trim();
        }

        const merged2 = applyPatchWithGuards(graph, out2.graph_patch);
        const model2 = buildCognitiveModel({
          graph: merged2.newGraph,
          prevConcepts: baseConcepts,
          baseConcepts,
          baseMotifs,
          baseMotifLinks,
          baseContexts,
          locale,
        });
        model2.graph.version = merged2.newGraph.version + (graphChanged(merged2.newGraph, model2.graph) ? 1 : 0);

        if (shouldEvaluateTransferRecommendations({ priorTurnCount: turnBase.recentDocs.length, motifTransferState })) {
          const motifLibrary = await listUserMotifLibrary(userId, locale);
          const currentTaskIdForRetrieval = currentTaskId((conv as any).travelPlanState || null, String(oid));
          const previewTravelPlan = buildTransferEvaluationTravelPlan({
            locale,
            conversationId: String(oid),
            graph: model2.graph,
            concepts: model2.concepts,
            motifs: model2.motifs,
            previous: (conv as any).travelPlanState || null,
            recentTurns: turnBase.forceTaskSwitch
              ? []
              : turnBase.recentDocs
                  .slice()
                  .reverse()
                  .map((t) => ({
                    createdAt: t.createdAt,
                    userText: t.userText,
                    assistantText: t.assistantText,
                  })),
            currentUserText: userText,
            currentAssistantText: out2.assistant_text,
            forceTaskSwitch: turnBase.forceTaskSwitch,
          });
          const recommendations = buildTransferRecommendations({
            locale,
            conversationId: String(oid),
            currentTaskId: previewTravelPlan.task_id || currentTaskIdForRetrieval,
            travelPlanState: previewTravelPlan,
            retrievalHints,
            motifLibrary,
            existingState: motifTransferState,
            maxCount: 4,
          });
          motifTransferState = {
            ...motifTransferState,
            recommendations,
            lastEvaluatedAt: new Date().toISOString(),
          };
        }
        model2.motifs = applyTransferStateToMotifs({
          motifs: model2.motifs || [],
          state: motifTransferState,
        });
        model2.motifGraph = { ...(model2.motifGraph || { motifs: [], motifLinks: [] }), motifs: model2.motifs };

        const now = new Date();
        await collections.turns.insertOne({
          conversationId: oid,
          userId,
          createdAt: now,
          userText,
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          graphVersion: model2.graph.version,
        } as any);

        const persisted = await persistConversationModel({
          conversationId: oid,
          userId,
          model: model2,
          updatedAt: now,
          previousTravelPlan: (conv as any).travelPlanState || null,
          locale,
          motifTransferState,
          taskLifecycle,
          forceTaskSwitch: turnBase.forceTaskSwitch,
          previousMotifs: baseMotifs,
          turnNumber,
          latestUserText: userText,
        });

        sseSend(res, "done", {
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          ...modelPayload(model2),
          travelPlanState: persisted.travelPlanState,
          taskDetection: persisted.taskDetection,
          cognitiveState: persisted.cognitiveState,
          portfolioDocumentState: persisted.portfolioDocumentState,
          motifTransferState,
          taskLifecycle,
        });

        clearInterval(pingTimer);
        res.end();
        return;
      } catch (e2: any) {
        e = e2;
      }
    }

    if (!closed) {
      sseSend(res, "error", { message: e?.message || "stream failed" });
      clearInterval(pingTimer);
      res.end();
    }
  }
}));

convRouter.post("/:id/motif-transfer/decision", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });
  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);
  const actionRaw = cleanInput(req.body?.action, 24).toLowerCase();
  const action =
    actionRaw === "adopt" || actionRaw === "modify" || actionRaw === "ignore"
      ? (actionRaw as TransferDecisionAction)
      : null;
  if (!action) return res.status(400).json({ error: "action must be one of adopt/modify/ignore" });

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const candidateId = cleanInput(req.body?.candidate_id, 220);
  if (!candidateId) return res.status(400).json({ error: "candidate_id required" });
  const recommendation =
    motifTransferState.recommendations.find((x) => cleanInput(x.candidate_id, 220) === candidateId) ||
    (req.body?.recommendation && typeof req.body.recommendation === "object"
      ? {
          candidate_id: candidateId,
          motif_type_id: cleanInput(req.body.recommendation.motif_type_id, 180),
          motif_type_title: cleanInput(req.body.recommendation.motif_type_title, 180),
          dependency: cleanInput(req.body.recommendation.dependency, 40) || "enable",
          reusable_description: cleanInput(req.body.recommendation.reusable_description, 240),
          source_task_id: cleanInput(req.body.recommendation.source_task_id, 80) || undefined,
          source_conversation_id: cleanInput(req.body.recommendation.source_conversation_id, 80) || undefined,
          status:
            cleanInput(req.body.recommendation.status, 24) === "active" ||
            cleanInput(req.body.recommendation.status, 24) === "deprecated" ||
            cleanInput(req.body.recommendation.status, 24) === "cancelled"
              ? cleanInput(req.body.recommendation.status, 24)
              : "uncertain",
          reason: cleanInput(req.body.recommendation.reason, 220),
          match_score: Number(req.body.recommendation.match_score || 0.7),
          recommended_mode:
            cleanInput(req.body.recommendation.recommended_mode, 8) === "A" ||
            cleanInput(req.body.recommendation.recommended_mode, 8) === "C"
              ? cleanInput(req.body.recommendation.recommended_mode, 8)
              : "B",
          decision_status: "pending",
          created_at: new Date().toISOString(),
        }
      : null);
  if (!recommendation) return res.status(404).json({ error: "recommendation not found" });
  const modeOverrideRaw = cleanInput(req.body?.mode_override, 8).toUpperCase();
  const modeOverride: "A" | "B" | "C" | undefined =
    modeOverrideRaw === "A" || modeOverrideRaw === "B" || modeOverrideRaw === "C" ? modeOverrideRaw : undefined;

  const decided = applyTransferDecision({
    locale,
    currentState: motifTransferState,
    recommendation: recommendation as any,
    action,
    modeOverride,
    revisedText: cleanInput(req.body?.revised_text, 320),
    note: cleanInput(req.body?.note, 220),
  });
  motifTransferState = decided.state;

  if (action === "adopt") {
    await recordTransferUsage({
      userId,
      locale,
      motifTypeId: recommendation.motif_type_id,
      action: "adopt",
      confidenceDelta: 0.05,
    });
  }
  if (action === "ignore") {
    await recordTransferUsage({
      userId,
      locale,
      motifTypeId: recommendation.motif_type_id,
      action: "ignore",
      confidenceDelta: -0.03,
    });
  }

  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    decision: decided.decision,
    followupQuestion: decided.followupQuestion,
    motifTransferState,
    ...modelPayload(refreshed.model),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));

convRouter.post("/:id/motif-transfer/feedback", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });
  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);

  const signalRaw = cleanInput(req.body?.signal, 32).toLowerCase();
  const signal =
    signalRaw === "thumbs_down" ||
    signalRaw === "retry" ||
    signalRaw === "manual_override" ||
    signalRaw === "explicit_not_applicable"
      ? (signalRaw as TransferFeedbackSignal)
      : null;
  if (!signal) {
    return res.status(400).json({ error: "signal must be one of thumbs_down/retry/manual_override/explicit_not_applicable" });
  }

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const feedback = applyTransferFeedback({
    locale,
    currentState: motifTransferState,
    signal,
    signalText: cleanInput(req.body?.signal_text, 220),
    candidateId: cleanInput(req.body?.candidate_id, 220) || undefined,
    motifTypeId: cleanInput(req.body?.motif_type_id, 180) || undefined,
  });
  motifTransferState = feedback.state;
  if (feedback.event.motif_type_id) {
    await recordTransferUsage({
      userId,
      locale,
      motifTypeId: feedback.event.motif_type_id,
      action: "feedback_negative",
      confidenceDelta: Number(feedback.event.delta || -0.08),
    });
  }

  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    event: feedback.event,
    followupQuestion: feedback.followupQuestion,
    motifTransferState,
    ...modelPayload(refreshed.model),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));

convRouter.post("/:id/motif-library/confirm", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });
  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);

  const model = buildCognitiveModel({
    graph: conv.graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
  const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
  const taskId = currentTaskId((conv as any).travelPlanState || null, String(oid));
  const shouldCloseTask = parseBoolFlag(req.body?.close_task);
  const taskLifecycle = shouldCloseTask
    ? closeTaskLifecycle(taskId)
    : readTaskLifecycle((conv as any).taskLifecycle);
  const confirmResult = await confirmMotifLibraryEntries({
    userId,
    locale,
    conversationId: String(oid),
    taskId,
    motifs: model.motifs || [],
    selections,
  });

  const motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    ...confirmResult,
    motifTransferState,
    ...modelPayload(refreshed.model),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));

convRouter.post("/:id/motif-library/revise", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });
  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);

  const motifTypeId = cleanInput(req.body?.motif_type_id, 180);
  const choiceRaw = cleanInput(req.body?.choice, 24).toLowerCase();
  const choice = choiceRaw === "overwrite" || choiceRaw === "new_version" ? (choiceRaw as RevisionChoice) : null;
  if (!motifTypeId || !choice) {
    return res.status(400).json({ error: "motif_type_id and choice(overwrite/new_version) are required" });
  }

  const revisedEntry = await reviseMotifLibraryEntry({
    userId,
    locale,
    motifTypeId,
    choice,
    title: cleanInput(req.body?.title, 180) || undefined,
    dependency: cleanInput(req.body?.dependency, 40) || undefined,
    reusableDescription: cleanInput(req.body?.reusable_description, 260) || undefined,
    abstractionText:
      req.body?.abstraction_text && typeof req.body.abstraction_text === "object"
        ? {
            L1: cleanInput(req.body.abstraction_text.L1, 180) || undefined,
            L2: cleanInput(req.body.abstraction_text.L2, 180) || undefined,
            L3: cleanInput(req.body.abstraction_text.L3, 180) || undefined,
          }
        : undefined,
    status:
      cleanInput(req.body?.status, 24) === "uncertain" ||
      cleanInput(req.body?.status, 24) === "deprecated" ||
      cleanInput(req.body?.status, 24) === "cancelled"
        ? (cleanInput(req.body?.status, 24) as any)
        : "active",
    sourceTaskId: currentTaskId((conv as any).travelPlanState || null, String(oid)),
    sourceConversationId: String(oid),
  });
  if (!revisedEntry) return res.status(404).json({ error: "motif library entry not found" });

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  motifTransferState = resolveRevisionRequest({
    currentState: motifTransferState,
    requestId: cleanInput(req.body?.request_id, 80) || undefined,
    motifTypeId,
    choice,
  });
  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    revised_entry: revisedEntry,
    motifTransferState,
    ...modelPayload(refreshed.model),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));
