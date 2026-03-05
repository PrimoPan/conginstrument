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
import { buildTravelPlanState, type TravelPlanState } from "../services/travelPlan/state.js";
import {
  defaultTravelPlanFileName,
  renderPortfolioTravelPlanPdf,
  renderTravelPlanPdf,
} from "../services/travelPlan/pdf.js";
import {
  buildTaskDetection,
  buildCognitiveState,
  buildPortfolioDocumentState,
  type TaskDetection,
  type CognitiveState,
  type PortfolioDocumentState,
} from "../services/planningState.js";
import { normalizeLocale, isEnglishLocale, type AppLocale } from "../i18n/locale.js";
import type { ConceptItem } from "../services/concepts.js";

export const convRouter = Router();
convRouter.use(authMiddleware);

function defaultSystemPrompt(locale: AppLocale) {
  if (isEnglishLocale(locale)) {
    return `You are CogInstrument's assistant. Help the user complete the current task and ask focused clarification questions about goals, constraints, and preferences. Each conversation is an isolated new session, and you must not use information from other sessions.`;
  }
  return `你是CogInstrument的助手，目标是帮助用户完成当前任务，并通过提问澄清用户的目标/约束/偏好。每个conversation都是独立的新会话，不要引用其他会话信息。`;
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
  const sourceMap: Record<string, string> = {};
  constraints.forEach((_, idx) => {
    sourceMap[`constraints.${idx}`] = "transferred_pattern_based";
  });
  openQuestions.forEach((_, idx) => {
    sourceMap[`open_questions.${idx}`] = "transferred_pattern_based";
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
  const keepConsistentText = cleanInput(params.bootstrap.keepConsistentText, 420);
  const keepTextLower = keepConsistentText.toLowerCase();
  const keepTokens = tokenize(keepConsistentText);

  let sourceConcepts: ConceptItem[] = [];
  if (params.bootstrap.sourceConversationId) {
    const sourceOid = parseObjectId(params.bootstrap.sourceConversationId);
    if (sourceOid) {
      const sourceConv = await collections.conversations.findOne({
        _id: sourceOid,
        userId: params.userId,
      });
      if (sourceConv && Array.isArray((sourceConv as any)?.concepts)) {
        sourceConcepts = ((sourceConv as any).concepts || []) as ConceptItem[];
      }
    }
  }

  const autoCarryConcepts: Array<{ concept: ConceptItem; origin: "explicit" | "auto" }> = [];
  const softCarryConcepts: Array<{ concept: ConceptItem; reason: string }> = [];
  const seenAutoCarry = new Set<string>();
  const seenSoftCarry = new Set<string>();
  const carryStableProfile = params.bootstrap.carryStableProfile !== false;
  const carryHealthReligion = params.bootstrap.carryHealthReligion !== false;

  const conceptIdentity = (concept: ConceptItem): string => {
    const semantic = conceptSemanticKey(concept);
    const id = cleanInput(concept?.id, 120);
    return semantic || id || cleanInput(concept?.title, 120);
  };
  const pushAuto = (concept: ConceptItem, origin: "explicit" | "auto") => {
    const key = conceptIdentity(concept);
    if (!key || seenAutoCarry.has(key)) return;
    seenAutoCarry.add(key);
    autoCarryConcepts.push({ concept, origin });
  };
  const pushSoft = (concept: ConceptItem, reason: string) => {
    const key = conceptIdentity(concept);
    if (!key || seenSoftCarry.has(key) || seenAutoCarry.has(key)) return;
    seenSoftCarry.add(key);
    softCarryConcepts.push({ concept, reason });
  };

  for (const concept of sourceConcepts) {
    const explicitMatched = keepConsistentText && carriesByKeepText(concept, keepTokens, keepTextLower);
    if (explicitMatched) {
      pushAuto(concept, "explicit");
      continue;
    }

    if (shouldExcludeCrossTripCarry(concept)) continue;

    if (!carryStableProfile) {
      if (carryHealthReligion && isCarryHealthReligionConcept(concept)) {
        pushAuto(concept, "auto");
      }
      continue;
    }

    const policy = inferStableCarryPolicy(concept);
    if (!policy) continue;
    if (policy.level === "hard_auto") {
      pushAuto(concept, "auto");
    } else {
      pushSoft(concept, policy.reason);
    }
  }

  const nodes: CDG["nodes"] = [];
  const edges: CDG["edges"] = [];
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

  autoCarryConcepts.slice(0, 12).forEach((carry, idx) => {
    const concept = carry.concept;
    const semantic = cleanInput((concept as any)?.semanticKey, 180);
    const title = cleanInput((concept as any)?.title, 120);
    const nodeId = stableGraphItemId("n_carry", `${semantic || title || "constraint"}_${idx}`);
    const type = mapConceptKind((concept as any)?.kind);
    const explicit = carry.origin === "explicit";
    nodes.push({
      id: nodeId,
      type,
      layer: defaultLayerForType(type) as any,
      strength: defaultStrengthForType(type) as any,
      statement: explicit
        ? title || cleanInput((concept as any)?.description, 120) || `Carry ${idx + 1}`
        : isEnglishLocale(params.locale)
        ? `Carry-over candidate: ${title || cleanInput((concept as any)?.description, 100) || `Item ${idx + 1}`}`
        : `待确认沿用:${title || cleanInput((concept as any)?.description, 100) || `条目${idx + 1}`}`,
      status: explicit ? "confirmed" : "proposed",
      confidence: explicit
        ? Math.max(0.56, Math.min(0.98, Number((concept as any)?.score) || 0.82))
        : Math.max(0.5, Math.min(0.88, Number((concept as any)?.score) || 0.74)),
      importance: explicit
        ? Math.max(0.56, Math.min(0.98, Number((concept as any)?.score) || 0.82))
        : Math.max(0.5, Math.min(0.88, Number((concept as any)?.score) || 0.74)),
      key: semantic || `slot:freeform:${type}:${slugToken(title || `carry_${idx + 1}`)}`,
      sourceMsgIds: uniqValues(
        explicit
          ? [
              "manual_user_bootstrap",
              "planning_bootstrap",
              `transfer_from:${cleanInput(params.bootstrap?.sourceConversationId, 24) || "history"}`,
            ]
          : [
              "transfer_pattern_candidate",
              "planning_bootstrap",
              `transfer_from:${cleanInput(params.bootstrap?.sourceConversationId, 24) || "history"}`,
            ],
        8
      ),
      validation_status: explicit ? "resolved" : "pending",
      value: {
        provenance: "planning_bootstrap",
        transfer_from: cleanInput(params.bootstrap?.sourceConversationId, 80) || undefined,
        transfer_reason: explicit ? "explicit_user_keep_consistency" : "transferred_pattern_based",
        conceptState: {
          validation_status: explicit ? "resolved" : "pending",
        },
      },
    } as any);
    if (destinationNodeId) {
      edges.push({
        id: stableGraphItemId("e_boot", `${nodeId}->${destinationNodeId}:constraint`),
        from: nodeId,
        to: destinationNodeId,
        type: "constraint",
        confidence: 0.84,
      });
    }
  });

  if (keepConsistentText && !autoCarryConcepts.length) {
    const nodeId = stableGraphItemId("n_keep", keepConsistentText);
    nodes.push({
      id: nodeId,
      type: "constraint",
      layer: "requirement",
      strength: "soft",
      statement: isEnglishLocale(params.locale)
        ? `Keep consistent: ${keepConsistentText}`
        : `保持一致:${keepConsistentText}`,
      status: "confirmed",
      confidence: 0.8,
      importance: 0.78,
      key: `slot:constraint:limiting:other:${slugToken(keepConsistentText, 40) || "carry"}`,
      sourceMsgIds: ["manual_user_bootstrap", "planning_bootstrap"],
      validation_status: "resolved",
      value: {
        provenance: "planning_bootstrap",
        conceptState: {
          validation_status: "resolved",
        },
      },
    } as any);
    if (destinationNodeId) {
      edges.push({
        id: stableGraphItemId("e_boot", `${nodeId}->${destinationNodeId}:constraint`),
        from: nodeId,
        to: destinationNodeId,
        type: "constraint",
        confidence: 0.78,
      });
    }
  }

  const graph: CDG = {
    id: params.conversationId,
    version: 0,
    nodes: nodes.slice(0, 32),
    edges: edges.slice(0, 48),
  };

  const carryTitles = autoCarryConcepts
    .map((x) => cleanInput((x.concept as any)?.title, 120))
    .filter(Boolean)
    .slice(0, 8);
  const constraints = carryTitles;
  if (keepConsistentText && !carryTitles.length) constraints.push(keepConsistentText);
  const softCarryQuestions = uniqValues(
    softCarryConcepts
      .slice(0, 8)
      .map((x) => buildSoftCarryQuestion({ locale: params.locale, concept: x.concept })),
    8
  );

  const summary = destination
    ? isEnglishLocale(params.locale)
      ? `New trip to ${destination}. Reusable baseline constraints are preloaded, with additional carry-over items pending confirmation.`
      : `已创建前往${destination}的新旅行规划，并预置可复用约束；部分跨行程信息待你确认后沿用。`
    : isEnglishLocale(params.locale)
    ? "A new trip planning session is created with reusable constraints preloaded."
    : "已创建新的旅行规划会话，并预置可复用约束。";
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
    constraints,
    openQuestions: softCarryQuestions,
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
  });
}

type PlanningStateBundle = {
  taskDetection: TaskDetection;
  cognitiveState: CognitiveState;
  portfolioDocumentState: PortfolioDocumentState;
};

type PersistedConversationSnapshot = PlanningStateBundle & {
  travelPlanState: TravelPlanState;
};

async function buildPlanningStateBundle(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  locale: AppLocale;
  model: ReturnType<typeof buildCognitiveModel>;
  travelPlanState: TravelPlanState;
  previousTravelPlan?: TravelPlanState | null;
}): Promise<PlanningStateBundle> {
  const convs = await collections.conversations
    .find({ userId: params.userId })
    .project({ title: 1, travelPlanState: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .limit(80)
    .toArray();
  const conversationRecords = convs.map((c) => ({
    conversationId: String(c._id),
    title: String((c as any)?.title || ""),
    travelPlanState: (c as any)?.travelPlanState || null,
    updatedAt: (c as any)?.updatedAt,
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
  });

  const cognitiveState = buildCognitiveState({
    conversationId: String(params.conversationId),
    locale: params.locale,
    model: params.model,
    travelPlanState: params.travelPlanState,
    conversations: conversationRecords,
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

async function persistConversationModel(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  model: ReturnType<typeof buildCognitiveModel>;
  updatedAt: Date;
  previousTravelPlan?: TravelPlanState | null;
  locale: AppLocale;
}): Promise<PersistedConversationSnapshot> {
  const travelPlanState = await computeTravelPlanState({
    conversationId: params.conversationId,
    userId: params.userId,
    graph: params.model.graph,
    concepts: params.model.concepts,
    motifs: params.model.motifs,
    previous: params.previousTravelPlan || null,
    locale: params.locale,
  });
  const planning = await buildPlanningStateBundle({
    conversationId: params.conversationId,
    userId: params.userId,
    locale: params.locale,
    model: params.model,
    travelPlanState,
    previousTravelPlan: params.previousTravelPlan || null,
  });
  await collections.conversations.updateOne(
    { _id: params.conversationId, userId: params.userId },
    {
      $set: {
        graph: params.model.graph,
        concepts: params.model.concepts,
        motifs: params.model.motifs,
        motifLinks: params.model.motifLinks,
        motifReasoningView: params.model.motifReasoningView,
        contexts: params.model.contexts,
        validationStatus: params.model.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
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

// ==========================
// Conversations CRUD
// ==========================

convRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const list = await collections.conversations
    .find({ userId })
    .project({ title: 1, updatedAt: 1 })
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
});

convRouter.post("/", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const locale = normalizeLocale(req.body?.locale);
  const planningBootstrap = parsePlanningBootstrap(req.body?.planningBootstrap);
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
  const planning = await buildPlanningStateBundle({
    conversationId: inserted.insertedId,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: null,
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
  });
});

convRouter.get("/:id", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
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
  const travelPlanState = (conv as any).travelPlanState as TravelPlanState;
  const planning = await buildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
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
  });
});

convRouter.put("/:id/graph", async (req: AuthedRequest, res) => {
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
  const planning = await buildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
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
        systemPrompt: conv.systemPrompt,
        locale,
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
    updatedAt: now,
    assistantText,
    adviceError,
    conflictGate,
  });
});

convRouter.put("/:id/concepts", async (req: AuthedRequest, res) => {
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
  const planning = await buildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    model,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
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
    updatedAt: now,
  });
});

// 前端加载历史 turns（默认 30 条）
convRouter.get("/:id/turns", async (req: AuthedRequest, res) => {
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
});

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
    const planning = await buildPlanningStateBundle({
      conversationId: oid,
      userId,
      locale,
      model,
      travelPlanState,
      previousTravelPlan: (conv as any).travelPlanState || null,
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
convRouter.get("/:id/travel-plan/export", handleTravelPlanPdfExport);
convRouter.get("/:id/travel-plan/export.pdf", handleTravelPlanPdfExport);
convRouter.post("/:id/travel-plan/export", handleTravelPlanPdfExport);
convRouter.post("/:id/travel-plan/export.pdf", handleTravelPlanPdfExport);

// ==========================
// Turn - Non-stream (CLI/debug)
// ==========================

convRouter.post("/:id/turn", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const graph: CDG = conv.graph;
  const locale = normalizeLocale((conv as any).locale);

  // recent turns：取最近 10 轮（更像“有记忆”）
  const recent = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  const recentTurns = recent
    .reverse()
    .flatMap((t) => [
      { role: "user" as const, content: t.userText },
      { role: "assistant" as const, content: t.assistantText },
    ]);
  const stateContextUserTurns = await loadRecentUserTextsForState({
    conversationId: oid,
    userId,
    limit: 140,
  });

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
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
    });

    return res.json({
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      ...modelPayload(preModel),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      conflictGate,
    });
  }

  // ✅ 把 conv.systemPrompt 传给 LLM
  const out = await generateTurn({
    graph,
    userText,
    recentTurns,
    stateContextUserTurns,
    systemPrompt: conv.systemPrompt,
    locale,
  });

  const merged = applyPatchWithGuards(graph, out.graph_patch);
  const model = buildCognitiveModel({
    graph: merged.newGraph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
  model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

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
  });

  res.json({
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    ...modelPayload(model),
    travelPlanState: persisted.travelPlanState,
    taskDetection: persisted.taskDetection,
    cognitiveState: persisted.cognitiveState,
    portfolioDocumentState: persisted.portfolioDocumentState,
  });
});

// ==========================
// Turn - Stream (SSE for UX)
// ==========================

convRouter.post("/:id/turn/stream", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const graph: CDG = conv.graph;
  const locale = normalizeLocale((conv as any).locale);

  // recent turns：取最近 10 轮
  const recent = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  const recentTurns = recent
    .reverse()
    .flatMap((t) => [
      { role: "user" as const, content: t.userText },
      { role: "assistant" as const, content: t.assistantText },
    ]);
  const stateContextUserTurns = await loadRecentUserTextsForState({
    conversationId: oid,
    userId,
    limit: 140,
  });

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
    locale,
  });
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
      systemPrompt: conv.systemPrompt,
      locale,
      signal: ac.signal,
      onToken: (token) => {
        if (closed) return;
        if (typeof token !== "string" || token.length === 0) return;
        sentAnyToken = true;

        // ✅ token 统一发 JSON：{ token: "..." }
        sseSend(res, "token", { token });
      },
    });

    if (closed) return;

    const merged = applyPatchWithGuards(graph, out.graph_patch);
    const model = buildCognitiveModel({
      graph: merged.newGraph,
      prevConcepts: conv.concepts || [],
      baseConcepts: conv.concepts || [],
      baseMotifs: (conv as any).motifs || [],
      baseMotifLinks: (conv as any).motifLinks || [],
      baseContexts: (conv as any).contexts || [],
      locale,
    });
    model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

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
    });

    sseSend(res, "done", {
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      ...modelPayload(model),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
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
          systemPrompt: conv.systemPrompt,
          locale,
        });

        const merged2 = applyPatchWithGuards(graph, out2.graph_patch);
        const model2 = buildCognitiveModel({
          graph: merged2.newGraph,
          prevConcepts: conv.concepts || [],
          baseConcepts: conv.concepts || [],
          baseMotifs: (conv as any).motifs || [],
          baseMotifLinks: (conv as any).motifLinks || [],
          baseContexts: (conv as any).contexts || [],
          locale,
        });
        model2.graph.version = merged2.newGraph.version + (graphChanged(merged2.newGraph, model2.graph) ? 1 : 0);

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
        });

        sseSend(res, "done", {
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          ...modelPayload(model2),
          travelPlanState: persisted.travelPlanState,
          taskDetection: persisted.taskDetection,
          cognitiveState: persisted.cognitiveState,
          portfolioDocumentState: persisted.portfolioDocumentState,
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
});
