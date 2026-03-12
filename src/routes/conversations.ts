import { Router } from "express";
import { ObjectId } from "mongodb";
import { authMiddleware, AuthedRequest } from "../middleware/auth.js";
import { collections } from "../db/mongo.js";
import { generateTurn, generateTurnStreaming } from "../services/llm.js";
import { applyPatchWithGuards, normalizeGraphSnapshot } from "../core/graph.js";
import type { CDG, ConceptNode, EdgeType } from "../core/graph.js";
import { config } from "../server/config.js";
import { normalizeConversationModel, type ConversationModel } from "../server/conversationModel.js";
import {
  DEFAULT_EXPERIMENT_ARM,
  emptyMotifReasoningView,
  isPureChatControlArm,
  isMotifEnabledForArm,
  normalizeExperimentArm,
  sanitizeMotifPayloadForArm,
  type ExperimentArm,
} from "../server/experimentArm.js";
import {
  generateAssistantTextNonStreaming,
  generatePlainAssistantTextNonStreaming,
  streamPlainAssistantText,
} from "../services/chatResponder.js";
import { buildCognitiveModel } from "../services/cognitiveModel.js";
import { buildConflictGatePayload } from "../services/motif/conflictGate.js";
import {
  normalizeMotifClarificationState,
  resolveMotifClarificationTurn,
  updateMotifClarificationState,
  type MotifClarificationState,
} from "../services/motif/clarificationLoop.js";
import { planMotifQuestion } from "../services/motif/questionPlanner.js";
import {
  buildTravelTaskId,
  buildTravelPlanState,
  buildTravelPlanSourceMapKey,
  nextTravelTaskOrdinal,
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
import { semanticKeyForNode } from "../services/concepts.js";
import {
  applyTransferDecision,
  applyTransferDecisionBatch,
  confirmTransferInjections,
  confirmTransferInjection,
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
  appendFollowupQuestion,
  registerRevisionRequestFromUtterance,
  resolveRevisionRequest,
  type RevisionChoice,
} from "../services/motifTransfer/revision.js";
import { buildTransferredConstraintPrompt, applyTransferStateToMotifs } from "../services/motifTransfer/application.js";
import {
  annotateMotifExtractionMeta,
  normalizeMotifTransferState,
} from "../services/motifTransfer/state.js";
import { enrichMotifDisplayTitles } from "../services/motif/displayTitles.js";
import { asyncRoute } from "./asyncRoute.js";

export const convRouter = Router();
convRouter.use(authMiddleware);

function conversationExperimentArm(conv: any): ExperimentArm {
  return normalizeExperimentArm((conv as any)?.experiment_arm);
}

function allowMotifFeatures(experimentArm: ExperimentArm): boolean {
  return isMotifEnabledForArm(experimentArm);
}

function isPureChatArm(experimentArm: ExperimentArm): boolean {
  return isPureChatControlArm(experimentArm);
}

function defaultSystemPrompt(locale: AppLocale, experimentArm: ExperimentArm = DEFAULT_EXPERIMENT_ARM) {
  if (isEnglishLocale(locale)) {
    if (isPureChatArm(experimentArm)) {
      return `You are CogInstrument's control assistant. Reply as a normal helpful assistant in plain chat. Do not mention graphs, motifs, task state, planning state, or experiment grouping.`;
    }
    if (!allowMotifFeatures(experimentArm)) {
      return `You are CogInstrument's assistant. Help the user complete the current trip-planning task and ask focused clarification questions about goals, constraints, preferences, and logistics. Keep the conversation grounded in the current task only.`;
    }
    return `You are CogInstrument's assistant. Help the user complete the current task and ask focused clarification questions about goals, constraints, and preferences. Each conversation is isolated by default; only use cross-task motifs when the user has explicitly adopted them.`;
  }
  if (isPureChatArm(experimentArm)) {
    return `你是CogInstrument的对照组助手。请按普通LLM对话方式自然回答，不要提及图谱、motif、任务状态、规划状态或实验分组。`;
  }
  if (!allowMotifFeatures(experimentArm)) {
    return `你是CogInstrument的助手，目标是帮助用户完成当前旅行规划任务，并通过提问澄清用户的目标、约束、偏好和执行细节。请始终聚焦当前任务本身。`;
  }
  return `你是CogInstrument的助手，目标是帮助用户完成当前任务，并通过提问澄清用户的目标/约束/偏好。默认每个conversation独立；仅当用户明确采用迁移规则时，才可引用跨任务信息。`;
}

function emptyGraph(conversationId: string): CDG {
  return { id: conversationId, version: 0, nodes: [], edges: [] };
}

function emptyGraphPatch() {
  return { ops: [] as any[] };
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

export type ManualGraphOverrideEdge = {
  fromRef: string;
  toRef: string;
  type: EdgeType;
  confidence: number;
  state: "active" | "removed";
  updatedAt: string;
};

export type ManualGraphOverrideNode = {
  nodeRef: string;
  state: "active" | "removed";
  updatedAt: string;
};

export type ManualGraphOverrides = {
  edges: ManualGraphOverrideEdge[];
  nodes: ManualGraphOverrideNode[];
};

export function emptyManualGraphOverrides(): ManualGraphOverrides {
  return { edges: [], nodes: [] };
}

function cleanOverrideRef(input: unknown, max = 180): string {
  return String(input ?? "").trim().slice(0, max);
}

export function normalizeManualGraphOverrides(raw: any): ManualGraphOverrides {
  const edges = Array.isArray(raw?.edges) ? raw.edges : [];
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const seen = new Set<string>();
  const out: ManualGraphOverrideEdge[] = [];
  for (const edge of edges) {
    const fromRef = cleanOverrideRef(edge?.fromRef);
    const toRef = cleanOverrideRef(edge?.toRef);
    const type = cleanOverrideRef(edge?.type) as EdgeType;
    const state = cleanOverrideRef(edge?.state) as ManualGraphOverrideEdge["state"];
    if (!fromRef || !toRef || fromRef === toRef) continue;
    if (!["enable", "constraint", "determine", "conflicts_with"].includes(type)) continue;
    if (state !== "active" && state !== "removed") continue;
    const key = `${fromRef}|${toRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fromRef,
      toRef,
      type,
      confidence: Number.isFinite(Number(edge?.confidence)) ? Math.max(0, Math.min(1, Number(edge.confidence))) : 0.72,
      state,
      updatedAt: cleanOverrideRef(edge?.updatedAt, 48) || new Date().toISOString(),
    });
  }

  const seenNodes = new Set<string>();
  const outNodes: ManualGraphOverrideNode[] = [];
  for (const node of nodes) {
    const nodeRef = cleanOverrideRef(node?.nodeRef);
    const state = cleanOverrideRef(node?.state) as ManualGraphOverrideNode["state"];
    if (!nodeRef) continue;
    if (state !== "active" && state !== "removed") continue;
    if (seenNodes.has(nodeRef)) continue;
    seenNodes.add(nodeRef);
    outNodes.push({
      nodeRef,
      state,
      updatedAt: cleanOverrideRef(node?.updatedAt, 48) || new Date().toISOString(),
    });
  }
  return { edges: out, nodes: outNodes };
}

function nodeRefForOverride(node: ConceptNode | null | undefined): string {
  if (!node) return "";
  const directKey = cleanOverrideRef((node as any).key);
  if (directKey) return directKey;
  const semanticKey = cleanOverrideRef(semanticKeyForNode(node));
  if (semanticKey) return semanticKey;
  const nodeId = cleanOverrideRef(node.id, 120);
  return nodeId ? `id:${nodeId}` : "";
}

function edgePairRefKey(fromRef: string, toRef: string): string {
  return `${fromRef}|${toRef}`;
}

function resolveNodeIdFromOverrideRef(graph: CDG, ref: string): string {
  const target = cleanOverrideRef(ref);
  if (!target) return "";
  if (target.startsWith("id:")) {
    const nodeId = cleanOverrideRef(target.slice(3), 120);
    return (graph.nodes || []).some((node) => node.id === nodeId) ? nodeId : "";
  }
  const byKey = (graph.nodes || []).find((node) => cleanOverrideRef((node as any).key) === target);
  if (byKey?.id) return byKey.id;
  const bySemantic = (graph.nodes || []).find((node) => cleanOverrideRef(semanticKeyForNode(node)) === target);
  return bySemantic?.id || "";
}

function edgeOverridesFromGraph(graph: CDG): Map<string, ManualGraphOverrideEdge> {
  const nodeById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const map = new Map<string, ManualGraphOverrideEdge>();
  for (const edge of graph.edges || []) {
    const fromRef = nodeRefForOverride(nodeById.get(edge.from));
    const toRef = nodeRefForOverride(nodeById.get(edge.to));
    if (!fromRef || !toRef || fromRef === toRef) continue;
    map.set(edgePairRefKey(fromRef, toRef), {
      fromRef,
      toRef,
      type: edge.type,
      confidence: Number.isFinite(Number(edge.confidence)) ? Math.max(0, Math.min(1, Number(edge.confidence))) : 0.72,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
  }
  return map;
}

function nodeOverridesFromGraph(graph: CDG): Map<string, ManualGraphOverrideNode> {
  const map = new Map<string, ManualGraphOverrideNode>();
  for (const node of graph.nodes || []) {
    const nodeRef = nodeRefForOverride(node);
    if (!nodeRef) continue;
    map.set(nodeRef, {
      nodeRef,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
  }
  return map;
}

export function rebuildManualGraphOverrides(params: {
  prevGraph: CDG;
  nextGraph: CDG;
  existing: ManualGraphOverrides;
  updatedAt: string;
}): ManualGraphOverrides {
  const prevPairs = edgeOverridesFromGraph(params.prevGraph);
  const nextPairs = edgeOverridesFromGraph(params.nextGraph);
  const merged = new Map<string, ManualGraphOverrideEdge>();
  const prevNodes = nodeOverridesFromGraph(params.prevGraph);
  const nextNodes = nodeOverridesFromGraph(params.nextGraph);
  const mergedNodes = new Map<string, ManualGraphOverrideNode>();

  const normalizedExisting = normalizeManualGraphOverrides(params.existing);
  for (const edge of normalizedExisting.edges) {
    merged.set(edgePairRefKey(edge.fromRef, edge.toRef), edge);
  }
  for (const node of normalizedExisting.nodes) {
    mergedNodes.set(node.nodeRef, node);
  }

  for (const [pairKey, nextEdge] of nextPairs.entries()) {
    const prevEdge = prevPairs.get(pairKey);
    if (!prevEdge) {
      merged.set(pairKey, { ...nextEdge, state: "active", updatedAt: params.updatedAt });
      continue;
    }
    const existingOverride = merged.get(pairKey);
    if (prevEdge.type !== nextEdge.type) {
      merged.set(pairKey, { ...nextEdge, state: "active", updatedAt: params.updatedAt });
      continue;
    }
    if (existingOverride?.state === "active") {
      merged.set(pairKey, {
        ...existingOverride,
        type: nextEdge.type,
        confidence: nextEdge.confidence,
      });
    }
  }

  for (const [pairKey, prevEdge] of prevPairs.entries()) {
    if (nextPairs.has(pairKey)) continue;
    merged.set(pairKey, {
      ...prevEdge,
      state: "removed",
      updatedAt: params.updatedAt,
    });
  }

  for (const [nodeRef, nextNode] of nextNodes.entries()) {
    const prevNode = prevNodes.get(nodeRef);
    if (!prevNode) {
      mergedNodes.set(nodeRef, { ...nextNode, state: "active", updatedAt: params.updatedAt });
      continue;
    }
    const existingOverride = mergedNodes.get(nodeRef);
    if (!existingOverride || existingOverride.state === "removed") {
      mergedNodes.set(nodeRef, {
        nodeRef,
        state: "active",
        updatedAt: params.updatedAt,
      });
      continue;
    }
    mergedNodes.set(nodeRef, {
      ...existingOverride,
      state: "active",
    });
  }

  for (const [nodeRef, prevNode] of prevNodes.entries()) {
    if (nextNodes.has(nodeRef)) continue;
    mergedNodes.set(nodeRef, {
      ...prevNode,
      state: "removed",
      updatedAt: params.updatedAt,
    });
  }

  const edges = Array.from(merged.values()).filter((edge) => !!edge.fromRef && !!edge.toRef && edge.fromRef !== edge.toRef);
  const nodes = Array.from(mergedNodes.values()).filter((node) => !!node.nodeRef);
  return normalizeManualGraphOverrides({ edges, nodes });
}

export function applyManualGraphOverrides(graph: CDG, rawOverrides: ManualGraphOverrides | null | undefined): CDG {
  const overrides = normalizeManualGraphOverrides(rawOverrides);
  if (!overrides.edges.length && !overrides.nodes.length) return graph;
  const removedNodeRefs = new Set(
    overrides.nodes
      .filter((node) => node.state === "removed")
      .map((node) => node.nodeRef)
  );
  const shouldKeepNode = (node: ConceptNode) => {
    const nodeRef = nodeRefForOverride(node);
    return !nodeRef || !removedNodeRefs.has(nodeRef);
  };

  const nextNodes = (graph.nodes || []).filter((node) => shouldKeepNode(node));
  const nodeById = new Map(nextNodes.map((node) => [node.id, node]));
  const overridesByPair = new Map(overrides.edges.map((edge) => [edgePairRefKey(edge.fromRef, edge.toRef), edge]));
  const nextEdges = [];
  const presentPairs = new Set<string>();

  for (const edge of graph.edges || []) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    const fromRef = nodeRefForOverride(nodeById.get(edge.from));
    const toRef = nodeRefForOverride(nodeById.get(edge.to));
    if (!fromRef || !toRef) {
      nextEdges.push(edge);
      continue;
    }
    const pairKey = edgePairRefKey(fromRef, toRef);
    if (presentPairs.has(pairKey)) continue;
    presentPairs.add(pairKey);
    const override = overridesByPair.get(pairKey);
    if (override?.state === "removed") continue;
    if (override?.state === "active") {
      nextEdges.push({
        ...edge,
        type: override.type,
        confidence: override.confidence,
      });
      continue;
    }
    nextEdges.push(edge);
  }

  for (const override of overrides.edges) {
    if (override.state !== "active") continue;
    const pairKey = edgePairRefKey(override.fromRef, override.toRef);
    if (presentPairs.has(pairKey)) continue;
    const fromId = resolveNodeIdFromOverrideRef(graph, override.fromRef);
    const toId = resolveNodeIdFromOverrideRef(graph, override.toRef);
    if (!fromId || !toId || fromId === toId) continue;
    presentPairs.add(pairKey);
    nextEdges.push({
      id: `e_override_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      from: fromId,
      to: toId,
      type: override.type,
      confidence: override.confidence,
    });
  }

  return {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
  };
}

function parseBoolFlag(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

function conversationModelFromDoc(conv: any): ConversationModel {
  return normalizeConversationModel((conv as any)?.model, config.model);
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
  sourceTaskId?: string;
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
  const sourceTaskId = cleanInput(raw?.sourceTaskId, 80);
  const sourceConversationId = cleanInput(raw?.sourceConversationId, 80);
  const destination = cleanInput(raw?.destination, 80);
  const keepConsistentText = cleanInput(raw?.keepConsistentText, 400);
  const hasHealthReligion =
    raw?.carryHealthReligion == null ? true : parseBoolFlag(raw?.carryHealthReligion);
  const hasStableProfile =
    raw?.carryStableProfile == null ? hasHealthReligion : parseBoolFlag(raw?.carryStableProfile);
  if (!sourceTaskId && !sourceConversationId && !destination && !keepConsistentText && hasHealthReligion && hasStableProfile) {
    return null;
  }
  return {
    sourceTaskId: sourceTaskId || undefined,
    sourceConversationId: sourceConversationId || undefined,
    destination: destination || undefined,
    keepConsistentText: keepConsistentText || undefined,
    carryHealthReligion: hasHealthReligion,
    carryStableProfile: hasStableProfile,
  };
}

function transferRecommendationsEnabled(
  hints: PlanningBootstrapHints | null | undefined,
  experimentArm: ExperimentArm = DEFAULT_EXPERIMENT_ARM
): boolean {
  if (!allowMotifFeatures(experimentArm)) return false;
  return !!cleanInput(hints?.destination, 80);
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

function readMotifClarificationState(raw: any): MotifClarificationState {
  return normalizeMotifClarificationState(raw);
}

function emptyMotifTransferState() {
  return readMotifTransferState(null);
}

function motifTransferStateForArm(
  experimentArm: ExperimentArm,
  state?: MotifTransferState | null
): MotifTransferState {
  return allowMotifFeatures(experimentArm) ? readMotifTransferState(state) : emptyMotifTransferState();
}

function motifClarificationStateForArm(
  experimentArm: ExperimentArm,
  state?: MotifClarificationState | null
): MotifClarificationState {
  return allowMotifFeatures(experimentArm) ? readMotifClarificationState(state) : readMotifClarificationState(null);
}

function sanitizeModelForExperimentArm(
  model: ReturnType<typeof buildCognitiveModel>,
  experimentArm: ExperimentArm
) {
  return sanitizeMotifPayloadForArm(model, experimentArm);
}

function rejectMotifDisabled(res: any) {
  return res.status(409).json({ error: "motif_disabled_for_experiment_arm" });
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
  transferRecommendationsEnabled: boolean;
}): boolean {
  if (!params.transferRecommendationsEnabled) return false;
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

function nextMotifClarificationState(params: {
  currentState?: MotifClarificationState | null;
  model: ReturnType<typeof buildCognitiveModel>;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  locale: AppLocale;
  motifTransferState?: MotifTransferState | null;
  askedAt?: string;
}): MotifClarificationState {
  const plan = planMotifQuestion({
    motifs: params.model.motifs || [],
    concepts: params.model.concepts || [],
    recentTurns: params.recentTurns || [],
    locale: params.locale,
    transferState: params.motifTransferState || null,
  });
  return updateMotifClarificationState({
    currentState: params.currentState,
    plan,
    motifs: params.model.motifs || [],
    askedAt: params.askedAt,
  });
}

function motifOverrideFingerprint(motif: any) {
  return JSON.stringify({
    title: cleanInput(motif?.title, 180),
    description: cleanInput(motif?.description, 260),
    status: cleanInput(motif?.status, 32),
    relation: cleanInput(motif?.relation || motif?.dependencyClass, 40),
    source_concept_ids: Array.isArray(motif?.source_concept_ids)
      ? motif.source_concept_ids.map((x: any) => cleanInput(x, 120))
      : Array.isArray(motif?.roles?.sources)
      ? motif.roles.sources.map((x: any) => cleanInput(x, 120))
      : [],
    target_concept_id:
      cleanInput(motif?.target_concept_id, 120) ||
      cleanInput(motif?.anchorConceptId, 120) ||
      cleanInput(motif?.roles?.target, 120),
    concept_ids: Array.isArray(motif?.conceptIds) ? motif.conceptIds.map((x: any) => cleanInput(x, 120)) : [],
    causal_operator: cleanInput(motif?.causalOperator, 40),
  });
}

function mergeGraphSaveBaseMotifs(params: {
  stored?: any[];
  incoming?: any[];
}): any[] {
  const stored = Array.isArray(params.stored) ? params.stored : [];
  const incoming = Array.isArray(params.incoming) ? params.incoming : [];
  if (!incoming.length) return stored;

  const merged = new Map<string, any>();
  for (const motif of stored) {
    const id = cleanInput((motif as any)?.id, 180) || cleanInput((motif as any)?.motif_id, 180);
    if (!id) continue;
    merged.set(id, motif);
  }
  for (const motif of incoming) {
    const id = cleanInput((motif as any)?.id, 180) || cleanInput((motif as any)?.motif_id, 180);
    if (!id) continue;
    merged.set(id, motif);
  }
  return Array.from(merged.values());
}

function detectTransferredMotifOverrides(params: {
  previousMotifs: any[];
  nextMotifs: any[];
  motifTransferState: MotifTransferState;
}): Array<{ motifTypeId: string; signalText: string }> {
  const previousById = new Map((params.previousMotifs || []).map((motif: any) => [cleanInput(motif?.id, 140), motif]));
  const activeTypeIds = new Set(
    (params.motifTransferState.activeInjections || [])
      .filter((item) => item.injection_state === "injected" || item.injection_state === "pending_confirmation")
      .map((item) => cleanInput(item.motif_type_id, 180))
      .filter(Boolean)
  );
  const changedByType = new Map<string, Set<string>>();

  for (const motif of params.nextMotifs || []) {
    const motifId = cleanInput(motif?.id, 140);
    const motifTypeId = cleanInput(motif?.motif_type_id, 180);
    if (!motifId || !motifTypeId || !activeTypeIds.has(motifTypeId)) continue;
    const previous = previousById.get(motifId);
    if (!previous) continue;
    const previousData = JSON.parse(motifOverrideFingerprint(previous));
    const nextData = JSON.parse(motifOverrideFingerprint(motif));
    const changedFields = Object.keys(nextData).filter(
      (field) => JSON.stringify((previousData as any)[field]) !== JSON.stringify((nextData as any)[field])
    );
    if (!changedFields.length) continue;
    if (!changedByType.has(motifTypeId)) changedByType.set(motifTypeId, new Set<string>());
    for (const field of changedFields) changedByType.get(motifTypeId)!.add(field);
  }

  return Array.from(changedByType.entries()).map(([motifTypeId, fields]) => ({
    motifTypeId,
    signalText: `manual_motif_override:${Array.from(fields).sort().join(",")}`,
  }));
}

type ConversationPlanningBootstrap = {
  sourceTaskId?: string;
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
  const sourceTaskId = cleanInput((raw as any).sourceTaskId, 80);
  const sourceConversationId = cleanInput((raw as any).sourceConversationId, 80);
  const destination = cleanInput((raw as any).destination, 80);
  const keepConsistentText = cleanInput((raw as any).keepConsistentText, 400);
  const carryHealthReligionRaw = (raw as any).carryHealthReligion;
  const carryStableProfileRaw = (raw as any).carryStableProfile;
  const carryHealthReligion =
    carryHealthReligionRaw == null ? true : parseBoolFlag(carryHealthReligionRaw);
  const carryStableProfile =
    carryStableProfileRaw == null ? carryHealthReligion : parseBoolFlag(carryStableProfileRaw);

  if (!sourceTaskId && !sourceConversationId && !destination && !keepConsistentText) return null;
  return {
    sourceTaskId: sourceTaskId || undefined,
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
  experimentArm: ExperimentArm;
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
      ? allowMotifFeatures(params.experimentArm)
        ? `New trip to ${destination}. Start with this trip's needs first. After the first assistant reply, the sidebar will quietly suggest a few past patterns you may want to keep.`
        : `New trip to ${destination}. Start by describing this trip's needs, constraints, and preferences.`
      : allowMotifFeatures(params.experimentArm)
      ? `已创建前往${destination}的新旅行规划。你先说这次的需求；首轮 assistant 回复后，右侧会静默推荐几条可能还能沿用的历史思路。`
      : `已创建前往${destination}的新旅行规划。你可以先说这次的需求、约束和偏好。`
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
  taskId?: string;
  since?: string;
  sortDirection?: 1 | -1;
}) {
  const limit = Math.max(1, Math.min(params.limit || 120, 320));
  const taskId = cleanInput(params.taskId, 120);
  const sinceIso = cleanInput(params.since, 48);
  const sortDirection = params.sortDirection === -1 ? -1 : 1;
  const fallbackFilter: Record<string, any> = {
    conversationId: params.conversationId,
    userId: params.userId,
  };
  if (sinceIso) fallbackFilter.createdAt = { $gt: new Date(sinceIso) };

  if (taskId) {
    const scoped = await collections.turns
      .find({ conversationId: params.conversationId, userId: params.userId, taskId })
      .sort({ createdAt: sortDirection })
      .limit(limit)
      .toArray();
    if (scoped.length) return scoped;
  }

  return collections.turns
    .find(fallbackFilter)
    .sort({ createdAt: sortDirection })
    .limit(limit)
    .toArray();
}

async function loadRecentUserTextsForState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
  taskId?: string;
  since?: string;
}) {
  const limit = Math.max(8, Math.min(params.limit || 120, 320));
  const taskId = cleanInput(params.taskId, 120);
  const sinceIso = cleanInput(params.since, 48);
  const fallbackFilter: Record<string, any> = {
    conversationId: params.conversationId,
    userId: params.userId,
  };
  if (sinceIso) fallbackFilter.createdAt = { $gt: new Date(sinceIso) };

  let docs =
    taskId
      ? await collections.turns
          .find({ conversationId: params.conversationId, userId: params.userId, taskId })
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray()
      : [];
  if (!docs.length) {
    docs = await collections.turns
      .find(fallbackFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }
  return docs
    .reverse()
    .map((t) => String(t.userText || "").trim())
    .filter(Boolean);
}

async function loadRecentTurnsForPlainChat(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
}) {
  const docs = await loadRecentTurnsForPlan({
    conversationId: params.conversationId,
    userId: params.userId,
    limit: params.limit || 18,
    sortDirection: 1,
  });
  return docs.flatMap((t) => {
    const items: Array<{ role: "user" | "assistant"; content: string }> = [];
    const userText = String(t.userText || "").trim();
    const assistantText = String(t.assistantText || "").trim();
    if (userText) items.push({ role: "user", content: userText });
    if (assistantText) items.push({ role: "assistant", content: assistantText });
    return items;
  });
}

type PlainChatCarryoverContext = {
  destination?: string;
  keepConsistentText?: string;
  sourceConversationTitle?: string;
  previousTurn?: {
    userText: string;
    assistantText: string;
  } | null;
};

async function loadPlainChatCarryoverContext(params: {
  userId: ObjectId;
  conversationId: string;
  planningBootstrapHints?: PlanningBootstrapHints | null;
}) {
  const hints = params.planningBootstrapHints || null;
  if (!hints) return null;

  const destination = cleanInput(hints.destination, 80) || undefined;
  const keepConsistentText = cleanInput(hints.keepConsistentText, 400) || undefined;
  const sourceConversationId = cleanInput(hints.sourceConversationId, 80);
  let sourceConversationTitle = "";
  let previousTurn: PlainChatCarryoverContext["previousTurn"] = null;

  if (sourceConversationId && sourceConversationId !== params.conversationId) {
    const sourceOid = parseObjectId(sourceConversationId);
    if (sourceOid) {
      const sourceConversation = await collections.conversations.findOne(
        { _id: sourceOid, userId: params.userId },
        { projection: { title: 1 } }
      );
      sourceConversationTitle = cleanInput(sourceConversation?.title, 120);
      const docs = await collections.turns
        .find({ conversationId: sourceOid, userId: params.userId })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();
      const latest = docs[0];
      const userText = cleanInput(latest?.userText, 260);
      const assistantText = cleanInput(latest?.assistantText, 360);
      if (userText || assistantText) {
        previousTurn = {
          userText,
          assistantText,
        };
      }
    }
  }

  if (!destination && !keepConsistentText && !previousTurn) return null;

  return {
    destination,
    keepConsistentText,
    sourceConversationTitle: sourceConversationTitle || undefined,
    previousTurn,
  } satisfies PlainChatCarryoverContext;
}

function withPlainChatCarryoverPrompt(params: {
  locale: AppLocale;
  baseSystemPrompt: string;
  carryover?: PlainChatCarryoverContext | null;
}) {
  const carryover = params.carryover || null;
  if (!carryover) return params.baseSystemPrompt;

  const parts = [params.baseSystemPrompt];
  if (carryover.destination) {
    parts.push(
      isEnglishLocale(params.locale)
        ? `Current trip topic: ${carryover.destination}. Treat this as the destination for the new trip conversation.`
        : `当前这轮旅行对话的目的地是：${carryover.destination}。请把它作为本次新旅行的当前主题。`
    );
  }
  if (carryover.keepConsistentText) {
    parts.push(
      isEnglishLocale(params.locale)
        ? `User asked to keep these points consistent in the new trip: ${carryover.keepConsistentText}`
        : `用户希望这次继续保持这些点：${carryover.keepConsistentText}`
    );
  }
  if (carryover.previousTurn && (carryover.previousTurn.userText || carryover.previousTurn.assistantText)) {
    parts.push(
      isEnglishLocale(params.locale)
        ? [
            `Lightweight carry-over from the previous session${carryover.sourceConversationTitle ? ` (${carryover.sourceConversationTitle})` : ""}:`,
            `This is only a soft reference from the last turn of the prior session. If it conflicts with the user's new request, follow the new request.`,
            carryover.previousTurn.userText ? `Previous user: ${carryover.previousTurn.userText}` : "",
            carryover.previousTurn.assistantText ? `Previous assistant: ${carryover.previousTurn.assistantText}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `上一轮会话${carryover.sourceConversationTitle ? `（${carryover.sourceConversationTitle}）` : ""}的轻量参考：`,
            `下面只是一条来自上一轮最后一轮问答的软参考；如果和用户这次的新要求冲突，优先遵循这次的新要求。`,
            carryover.previousTurn.userText ? `上一轮用户：${carryover.previousTurn.userText}` : "",
            carryover.previousTurn.assistantText ? `上一轮助手：${carryover.previousTurn.assistantText}` : "",
          ]
            .filter(Boolean)
            .join("\n")
    );
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function buildPureChatModel(locale: AppLocale, conversationId: string, conv?: any) {
  const graph = conv?.graph && typeof conv.graph === "object" ? conv.graph : emptyGraph(conversationId);
  const model = buildCognitiveModel({
    graph,
    prevConcepts: [],
    baseConcepts: [],
    baseMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
    locale,
  });
  model.graph = graph;
  model.concepts = [];
  model.motifs = [];
  model.motifLinks = [];
  model.motifGraph = { motifs: [], motifLinks: [] };
  model.motifReasoningView = emptyMotifReasoningView();
  model.contexts = [];
  model.validationStatus = "unasked";
  return model;
}

function latestArchivedTaskClosedAt(plan: TravelPlanState | null | undefined): string | undefined {
  const history = Array.isArray(plan?.task_history) ? plan?.task_history || [] : [];
  const last = history[history.length - 1];
  return cleanInput(last?.closed_at, 48) || undefined;
}

function predictCurrentTaskId(params: {
  conversationId: ObjectId | string;
  previousTravelPlan?: TravelPlanState | null;
  forceTaskSwitch?: boolean;
}): string {
  const baseTaskId =
    cleanInput(params.previousTravelPlan?.task_id, 80) ||
    buildTravelTaskId(String(params.conversationId || ""), 1) ||
    "task_default";
  if (!params.forceTaskSwitch) return baseTaskId;
  return buildTravelTaskId(
    String(params.conversationId || "") || baseTaskId,
    nextTravelTaskOrdinal(params.previousTravelPlan || null)
  );
}

function activeTaskScope(plan: TravelPlanState | null | undefined, fallback: string) {
  return {
    taskId: currentTaskId(plan, fallback),
    since: latestArchivedTaskClosedAt(plan),
  };
}

export async function computeTravelPlanState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  graph: CDG;
  concepts?: any[];
  motifs?: any[];
  previous?: TravelPlanState | null;
  locale: AppLocale;
  forceTaskSwitch?: boolean;
  queryTaskId?: string;
  since?: string;
}): Promise<TravelPlanState> {
  const turns = await loadRecentTurnsForPlan({
    conversationId: params.conversationId,
    userId: params.userId,
    limit: 160,
    taskId: params.queryTaskId,
    since: params.since,
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
  manualGraphOverrides: ManualGraphOverrides;
  recentDocs: any[];
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  stateContextUserTurns: string[];
  forceTaskSwitch: boolean;
  activeTaskId: string;
  predictedTaskId: string;
  taskSince?: string;
};

function shouldResetTurnBaseline(taskDetection: TaskDetection): boolean {
  return (
    !!taskDetection?.is_task_switch &&
    (taskDetection.switch_reason_code === "explicit_restart" ||
      taskDetection.switch_reason_code === "destination_switch")
  );
}

export async function buildTurnRuntimeBase(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  conv: any;
  locale: AppLocale;
  userText: string;
  experimentArm?: ExperimentArm;
  taskLifecycle?: TaskLifecycleState | null;
}): Promise<TurnRuntimeBase> {
  const experimentArm = normalizeExperimentArm(params.experimentArm);
  const motifEnabled = allowMotifFeatures(experimentArm);
  const taskDetection = detectTaskSwitchFromLatestUserTurn({
    conversationId: String(params.conversationId),
    locale: params.locale,
    latestUserText: params.userText,
    previousTravelPlan: (params.conv as any).travelPlanState || null,
    taskLifecycle: params.taskLifecycle || null,
  });
  const forceTaskSwitch = shouldResetTurnBaseline(taskDetection);
  const previousTravelPlan = ((params.conv as any).travelPlanState as TravelPlanState | null) || null;
  const activeTaskId = currentTaskId(previousTravelPlan, String(params.conversationId));
  const taskSince = latestArchivedTaskClosedAt(previousTravelPlan);
  const predictedTaskId = predictCurrentTaskId({
    conversationId: params.conversationId,
    previousTravelPlan,
    forceTaskSwitch,
  });
  const recent = forceTaskSwitch
    ? []
    : await loadRecentTurnsForPlan({
        conversationId: params.conversationId,
        userId: params.userId,
        taskId: activeTaskId,
        since: taskSince,
        limit: 10,
        sortDirection: -1,
      });
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
        taskId: activeTaskId,
        since: taskSince,
      });

  return {
    graph: forceTaskSwitch ? emptyGraph(String(params.conversationId)) : params.conv.graph,
    concepts: forceTaskSwitch ? [] : params.conv.concepts || [],
    motifs: forceTaskSwitch || !motifEnabled ? [] : (params.conv as any).motifs || [],
    motifLinks: forceTaskSwitch || !motifEnabled ? [] : (params.conv as any).motifLinks || [],
    contexts: forceTaskSwitch || !motifEnabled ? [] : (params.conv as any).contexts || [],
    manualGraphOverrides: forceTaskSwitch
      ? emptyManualGraphOverrides()
      : normalizeManualGraphOverrides((params.conv as any).manualGraphOverrides),
    recentDocs: recent,
    recentTurns,
    stateContextUserTurns,
    forceTaskSwitch,
    activeTaskId,
    predictedTaskId,
    taskSince,
  };
}

type PersistedConversationSnapshot = PlanningStateBundle & {
  travelPlanState: TravelPlanState;
};

type PlanningStateBundleParams = {
  conversationId: ObjectId;
  userId: ObjectId;
  locale: AppLocale;
  experimentArm: ExperimentArm;
  model: ReturnType<typeof buildCognitiveModel>;
  travelPlanState: TravelPlanState;
  previousTravelPlan?: TravelPlanState | null;
  motifTransferState?: MotifTransferState | null;
  persistentMotifLibrary?: Awaited<ReturnType<typeof listUserMotifLibrary>>;
  planningBootstrapHints?: PlanningBootstrapHints | null;
  taskLifecycle?: TaskLifecycleState | null;
  latestUserText?: string;
  isNewConversation?: boolean;
};

function buildPersistedTaskDetection(params: PlanningStateBundleParams): TaskDetection {
  const conversationId = String(params.travelPlanState.task_id || params.conversationId);
  const currentDestinationScope =
    (params.travelPlanState as any)?.destination_scope ||
    params.travelPlanState.destinations ||
    [];
  const previousDestinationScope =
    (params.previousTravelPlan as any)?.destination_scope ||
    params.previousTravelPlan?.destinations ||
    [];

  if (params.isNewConversation) {
    return buildTaskDetection({
      conversationId,
      locale: params.locale,
      currentDestinations: currentDestinationScope,
      previousDestinations: previousDestinationScope,
      isNewConversation: true,
      taskLifecycle: params.taskLifecycle || null,
      latestUserText: params.latestUserText,
      tripGoalSummary: cleanInput(params.travelPlanState.trip_goal_summary || params.travelPlanState.summary, 220),
      travelers: Array.isArray(params.travelPlanState.travelers) ? params.travelPlanState.travelers : [],
      duration: cleanInput(params.travelPlanState.travel_dates_or_duration, 80) || undefined,
    });
  }

  if (cleanInput(params.latestUserText, 320)) {
    return detectTaskSwitchFromLatestUserTurn({
      conversationId,
      locale: params.locale,
      latestUserText: params.latestUserText,
      previousTravelPlan: params.previousTravelPlan || null,
      taskLifecycle: params.taskLifecycle || null,
    });
  }

  return buildTaskDetection({
    conversationId,
    locale: params.locale,
    currentDestinations: currentDestinationScope,
    previousDestinations: previousDestinationScope,
    taskLifecycle: params.taskLifecycle || null,
    latestUserText: params.latestUserText,
    tripGoalSummary: cleanInput(params.travelPlanState.trip_goal_summary || params.travelPlanState.summary, 220),
    travelers: Array.isArray(params.travelPlanState.travelers) ? params.travelPlanState.travelers : [],
    duration: cleanInput(params.travelPlanState.travel_dates_or_duration, 80) || undefined,
  });
}

async function buildPlanningStateBundle(params: PlanningStateBundleParams): Promise<PlanningStateBundle> {
  const convs = await collections.conversations
    .find({ userId: params.userId, locale: params.locale, experiment_arm: params.experimentArm })
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

  const taskDetection = buildPersistedTaskDetection(params);

  const cognitiveState = buildCognitiveState({
    conversationId: String(params.conversationId),
    locale: params.locale,
    model: params.model,
    travelPlanState: params.travelPlanState,
    conversations: conversationRecords,
    motifTransferState: params.motifTransferState || null,
    persistentMotifLibrary: allowMotifFeatures(params.experimentArm)
      ? params.persistentMotifLibrary || []
      : [],
    motifLibraryScope: params.planningBootstrapHints
      ? {
          sourceTaskId: params.planningBootstrapHints.sourceTaskId,
          sourceConversationId: params.planningBootstrapHints.sourceConversationId,
        }
      : null,
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
  return {
    taskDetection: buildPersistedTaskDetection(params),
    cognitiveState: buildCognitiveState({
      conversationId: String(params.conversationId),
      locale: params.locale,
      model: params.model,
      travelPlanState: params.travelPlanState,
      conversations: conversationRecords,
      motifTransferState: params.motifTransferState || null,
      persistentMotifLibrary: allowMotifFeatures(params.experimentArm)
        ? params.persistentMotifLibrary || []
        : [],
      motifLibraryScope: params.planningBootstrapHints
        ? {
            sourceTaskId: params.planningBootstrapHints.sourceTaskId,
            sourceConversationId: params.planningBootstrapHints.sourceConversationId,
          }
        : null,
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

async function applyDisplayTitlesToModel(params: {
  model: ReturnType<typeof buildCognitiveModel>;
  previousMotifs?: any[];
  previousConcepts?: any[];
  locale: AppLocale;
  conversationModel?: string;
}) {
  const motifs = await enrichMotifDisplayTitles({
    motifs: Array.isArray(params.model.motifs) ? params.model.motifs : [],
    concepts: Array.isArray(params.model.concepts) ? params.model.concepts : [],
    previousMotifs: Array.isArray(params.previousMotifs) ? params.previousMotifs : [],
    previousConcepts: Array.isArray(params.previousConcepts) ? params.previousConcepts : [],
    locale: params.locale,
    model: params.conversationModel,
  });
  params.model.motifs = motifs;
  params.model.motifGraph = {
    ...(params.model.motifGraph || { motifs: [], motifLinks: [] }),
    motifs,
  };
  const namingByMotifId = new Map(
    motifs.map((motif) => [
      motif.id,
      {
        patternType: String((motif as any).pattern_type || (motif as any).motif_type_title || motif.title || "").trim(),
        instanceTitle: String(motif.display_title || motif.title || "").trim(),
      },
    ])
  );
  if (params.model.motifReasoningView?.nodes) {
    params.model.motifReasoningView = {
      ...params.model.motifReasoningView,
      nodes: (params.model.motifReasoningView.nodes || []).map((node: any) => ({
        ...node,
        title: namingByMotifId.get(String(node?.motifId || ""))?.patternType || node.title,
        patternType:
          namingByMotifId.get(String(node?.motifId || ""))?.patternType ||
          cleanInput(node?.patternType, 160) ||
          undefined,
        instanceTitle:
          namingByMotifId.get(String(node?.motifId || ""))?.instanceTitle ||
          cleanInput(node?.instanceTitle, 160) ||
          undefined,
      })),
    };
  }
  return params.model;
}

async function persistConversationModel(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  experimentArm: ExperimentArm;
  model: ReturnType<typeof buildCognitiveModel>;
  updatedAt: Date;
  previousTravelPlan?: TravelPlanState | null;
  locale: AppLocale;
  motifTransferState?: MotifTransferState | null;
  taskLifecycle?: TaskLifecycleState;
  forceTaskSwitch?: boolean;
  previousMotifs?: any[];
  previousConcepts?: any[];
  turnNumber?: number;
  latestUserText?: string;
  planningBootstrapHints?: PlanningBootstrapHints | null;
  manualGraphOverrides?: ManualGraphOverrides | null;
  motifClarificationState?: MotifClarificationState | null;
  queryTaskId?: string;
  since?: string;
  conversationModel?: string;
}): Promise<PersistedConversationSnapshot> {
  const nextMotifTransferState = motifTransferStateForArm(params.experimentArm, params.motifTransferState || null);
  let modelWithTransfer = params.model;
  if (allowMotifFeatures(params.experimentArm)) {
    const motifsWithTransfer = applyTransferStateToMotifs({
      motifs: annotateMotifExtractionMeta({
        motifs: params.model.motifs || [],
        previousMotifs: Array.isArray(params.previousMotifs) ? (params.previousMotifs as any) : [],
        turnNumber: Number(params.turnNumber || 0) > 0 ? Number(params.turnNumber) : 1,
      }),
      state: nextMotifTransferState,
    });
    modelWithTransfer = {
      ...params.model,
      motifs: motifsWithTransfer,
      motifGraph: {
        ...(params.model.motifGraph || { motifs: [], motifLinks: [] }),
        motifs: motifsWithTransfer,
      },
    };
    await applyDisplayTitlesToModel({
      model: modelWithTransfer,
      previousMotifs: params.previousMotifs,
      previousConcepts: params.previousConcepts,
      locale: params.locale,
      conversationModel: params.conversationModel,
    });
  }
  modelWithTransfer = sanitizeModelForExperimentArm(modelWithTransfer, params.experimentArm);
  params.model.motifs = modelWithTransfer.motifs;
  params.model.motifLinks = modelWithTransfer.motifLinks;
  params.model.contexts = modelWithTransfer.contexts;
  params.model.motifGraph = modelWithTransfer.motifGraph;
  params.model.motifReasoningView = modelWithTransfer.motifReasoningView;
  const travelPlanState = await computeTravelPlanState({
    conversationId: params.conversationId,
    userId: params.userId,
    graph: modelWithTransfer.graph,
    concepts: modelWithTransfer.concepts,
    motifs: modelWithTransfer.motifs,
    previous: params.previousTravelPlan || null,
    locale: params.locale,
    forceTaskSwitch: !!params.forceTaskSwitch,
    queryTaskId: params.queryTaskId,
    since: params.since,
  });
  const persistentMotifLibrary = allowMotifFeatures(params.experimentArm)
    ? await listUserMotifLibrary(params.userId, params.locale)
    : [];
  const planning = await safeBuildPlanningStateBundle({
    conversationId: params.conversationId,
    userId: params.userId,
    locale: params.locale,
    experimentArm: params.experimentArm,
    model: modelWithTransfer,
    travelPlanState,
    previousTravelPlan: params.previousTravelPlan || null,
    motifTransferState: nextMotifTransferState,
    persistentMotifLibrary,
    planningBootstrapHints: params.planningBootstrapHints || null,
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
        motifTransferState: nextMotifTransferState,
        motifClarificationState: motifClarificationStateForArm(params.experimentArm, params.motifClarificationState || null),
        taskLifecycle: params.taskLifecycle || readTaskLifecycle(null),
        manualGraphOverrides: normalizeManualGraphOverrides(params.manualGraphOverrides),
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

function modelPayload(
  model: ReturnType<typeof buildCognitiveModel>,
  experimentArm: ExperimentArm = DEFAULT_EXPERIMENT_ARM
) {
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  const reasoning_steps = normalizeReasoningSteps(safeModel);
  return {
    algorithm_version: safeModel.algorithmVersion || "v3",
    algorithm_pipeline: safeModel.algorithmPipeline,
    graph: safeModel.graph,
    concept_graph: safeModel.conceptGraph,
    motifs: safeModel.motifs,
    motifLinks: safeModel.motifLinks,
    motif_graph: {
      motifs: safeModel.motifGraph.motifs,
      motif_links: safeModel.motifGraph.motifLinks,
    },
    motifReasoningView: safeModel.motifReasoningView,
    motifInvariantReport: safeModel.motifInvariantReport,
    reasoning_steps,
    concepts: safeModel.concepts,
    contexts: safeModel.contexts,
    validation_status: safeModel.validationStatus,
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
  experimentArm: ExperimentArm;
  conv: any;
  motifTransferState: MotifTransferState;
  motifClarificationState?: MotifClarificationState | null;
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
  const nextMotifTransferState = motifTransferStateForArm(params.experimentArm, params.motifTransferState);
  if (allowMotifFeatures(params.experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: nextMotifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  }
  const safeModel = sanitizeModelForExperimentArm(model, params.experimentArm);
  const taskScope = activeTaskScope((params.conv as any).travelPlanState || null, String(params.oid));

  const travelPlanState =
    ((params.conv as any).travelPlanState as TravelPlanState | null) ||
    (await computeTravelPlanState({
      conversationId: params.oid,
      userId: params.userId,
      graph: safeModel.graph,
      concepts: safeModel.concepts,
      motifs: safeModel.motifs,
      previous: null,
      locale: params.locale,
      queryTaskId: taskScope.taskId,
      since: taskScope.since,
    }));
  const planningBootstrapHints = readPlanningBootstrapHints((params.conv as any).planningBootstrapHints);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: params.oid,
    userId: params.userId,
    locale: params.locale,
    experimentArm: params.experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: (params.conv as any).travelPlanState || null,
    motifTransferState: nextMotifTransferState,
    persistentMotifLibrary: allowMotifFeatures(params.experimentArm)
      ? await listUserMotifLibrary(params.userId, params.locale)
      : [],
    planningBootstrapHints,
    taskLifecycle: params.taskLifecycle || null,
    latestUserText: params.latestUserText,
  });
  const now = new Date();
  await collections.conversations.updateOne(
    { _id: params.oid, userId: params.userId },
    {
      $set: {
        graph: safeModel.graph,
        concepts: safeModel.concepts,
        motifs: safeModel.motifs,
        motifLinks: safeModel.motifLinks,
        motifReasoningView: safeModel.motifReasoningView,
        contexts: safeModel.contexts,
        validationStatus: safeModel.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState: nextMotifTransferState,
        motifClarificationState: motifClarificationStateForArm(
          params.experimentArm,
          params.motifClarificationState || readMotifClarificationState((params.conv as any).motifClarificationState)
        ),
        taskLifecycle: params.taskLifecycle || readTaskLifecycle((params.conv as any)?.taskLifecycle),
        updatedAt: now,
      },
    }
  );
  return {
    model: safeModel,
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
  const experimentArm = normalizeExperimentArm((req.query as any)?.experiment_arm);
  const list = await collections.conversations
    .find(localeFilter ? { userId, locale: localeFilter, experiment_arm: experimentArm } : { userId, experiment_arm: experimentArm })
    .project({ title: 1, updatedAt: 1, locale: 1, experiment_arm: 1 })
    .sort({ updatedAt: -1 })
    .toArray();

  res.json(
    list.map((x) => ({
      conversationId: String(x._id),
      title: x.title,
      updatedAt: x.updatedAt,
      locale: normalizeLocale((x as any).locale),
      experiment_arm: normalizeExperimentArm((x as any).experiment_arm),
    }))
  );
}));

convRouter.post("/", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const locale = normalizeLocale(req.body?.locale);
  const experimentArm = normalizeExperimentArm(req.body?.experiment_arm);
  const conversationModel = normalizeConversationModel(req.body?.model, config.model);
  const planningBootstrap = parsePlanningBootstrap(req.body?.planningBootstrap);
  const planningBootstrapHints = readPlanningBootstrapHints(planningBootstrap);
  const nextTransferRecommendationsEnabled = transferRecommendationsEnabled(planningBootstrapHints, experimentArm);
  const defaultTitle = isEnglishLocale(locale) ? "New Conversation" : "新对话";
  const requestedTitle = cleanInput(req.body?.title || defaultTitle, 80) || defaultTitle;
  const now = new Date();
  const systemPrompt = defaultSystemPrompt(locale, experimentArm);
  const nowIso = now.toISOString();

  const inserted = await collections.conversations.insertOne({
    userId,
    title: requestedTitle,
    locale,
    experiment_arm: experimentArm,
    systemPrompt,
    model: conversationModel,
    createdAt: now,
    updatedAt: now,
    graph: emptyGraph("temp"), // 先占位，写入后再用 _id 修正
    concepts: [],
    motifs: [],
    motifLinks: [],
    motifReasoningView: emptyMotifReasoningView(),
    contexts: [],
    validationStatus: "unasked",
    motifTransferState: motifTransferStateForArm(experimentArm, null),
    taskLifecycle: readTaskLifecycle(null),
    manualGraphOverrides: emptyManualGraphOverrides(),
    planningBootstrapHints,
    travelPlanState: defaultTravelPlanState({
      locale,
      taskId: "temp",
      nowIso,
    }),
  } as any);

  const conversationId = String(inserted.insertedId);
  if (isPureChatArm(experimentArm)) {
    const graph = emptyGraph(conversationId);
    await collections.conversations.updateOne(
      { _id: inserted.insertedId, userId },
      {
        $set: {
          title: requestedTitle,
          model: conversationModel,
          graph,
          concepts: [],
          motifs: [],
          motifLinks: [],
          motifReasoningView: emptyMotifReasoningView(),
          contexts: [],
          validationStatus: "unasked",
          motifTransferState: motifTransferStateForArm(experimentArm, null),
          motifClarificationState: motifClarificationStateForArm(experimentArm, null),
          planningBootstrapHints,
          travelPlanState: null,
          taskDetection: null,
          cognitiveState: null,
          portfolioDocumentState: null,
          taskLifecycle: null,
          updatedAt: now,
        },
      }
    );

    const safeModel = sanitizeModelForExperimentArm(buildPureChatModel(locale, conversationId, { graph }), experimentArm);
    return res.json({
      conversationId,
      title: requestedTitle,
      locale,
      experiment_arm: experimentArm,
      model: conversationModel,
      systemPrompt,
      ...modelPayload(safeModel, experimentArm),
      travelPlanState: null,
      taskDetection: null,
      cognitiveState: null,
      portfolioDocumentState: null,
      motifTransferState: null,
      taskLifecycle: null,
      transferRecommendationsEnabled: false,
    });
  }

  const bootstrap = await buildBootstrapGraphAndPlan({
    userId,
    locale,
    conversationId,
    experimentArm,
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
        model: conversationModel,
        graph: bootstrap.graph,
        concepts: [],
        motifs: [],
        motifLinks: [],
        motifReasoningView: emptyMotifReasoningView(),
        contexts: [],
        validationStatus: "unasked",
        motifTransferState: motifTransferStateForArm(experimentArm, null),
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
  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  let motifClarificationState = readMotifClarificationState((conv as any).motifClarificationState);
  if (!allowMotifFeatures(experimentArm)) {
    motifTransferState = motifTransferStateForArm(experimentArm, null);
    motifClarificationState = motifClarificationStateForArm(experimentArm, null);
  }
  const manualTransferOverrides = detectTransferredMotifOverrides({
    previousMotifs: (conv as any).motifs || [],
    nextMotifs: Array.isArray(req.body?.motifs)
      ? req.body.motifs
      : Array.isArray(req.body?.motif_graph?.motifs)
      ? req.body.motif_graph.motifs
      : [],
    motifTransferState,
  });
  for (const override of manualTransferOverrides) {
    const feedback = applyTransferFeedback({
      locale,
      currentState: motifTransferState,
      signal: "manual_override",
      signalText: override.signalText,
      motifTypeId: override.motifTypeId,
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
  }
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  if (allowMotifFeatures(experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    await applyDisplayTitlesToModel({
      model,
      previousMotifs: (conv as any).motifs || [],
      previousConcepts: conv.concepts || [],
      locale,
      conversationModel,
    });
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  const travelPlanState = await computeTravelPlanState({
    conversationId: inserted.insertedId,
    userId,
    graph: safeModel.graph,
    concepts: safeModel.concepts,
    motifs: safeModel.motifs,
    previous: null,
    locale,
  });
  const persistentMotifLibrary = allowMotifFeatures(experimentArm)
    ? await listUserMotifLibrary(userId, locale)
    : [];
  const planning = await safeBuildPlanningStateBundle({
    conversationId: inserted.insertedId,
    userId,
    locale,
    experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: null,
    motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
    persistentMotifLibrary,
    planningBootstrapHints,
    taskLifecycle,
    isNewConversation: true,
  });
  await collections.conversations.updateOne(
    { _id: inserted.insertedId, userId },
    {
      $set: {
        title: finalTitle,
        graph: safeModel.graph,
        concepts: safeModel.concepts,
        motifs: safeModel.motifs,
        motifLinks: safeModel.motifLinks,
        motifReasoningView: safeModel.motifReasoningView,
        contexts: safeModel.contexts,
        validationStatus: safeModel.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
        taskLifecycle,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId,
    title: finalTitle,
    locale: normalizeLocale((conv as any).locale),
    experiment_arm: experimentArm,
    model: conversationModel,
    systemPrompt: conv.systemPrompt,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
    taskLifecycle,
    transferRecommendationsEnabled: nextTransferRecommendationsEnabled,
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const planningBootstrapHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const nextTransferRecommendationsEnabled = transferRecommendationsEnabled(planningBootstrapHints, experimentArm);

  if (isPureChatArm(experimentArm)) {
    const safeModel = sanitizeModelForExperimentArm(buildPureChatModel(locale, id, conv), experimentArm);
    return res.json({
      conversationId: id,
      title: conv.title,
      locale,
      experiment_arm: experimentArm,
      model: conversationModel,
      systemPrompt: conv.systemPrompt,
      ...modelPayload(safeModel, experimentArm),
      travelPlanState: null,
      taskDetection: null,
      cognitiveState: null,
      portfolioDocumentState: null,
      motifTransferState: null,
      taskLifecycle: null,
      transferRecommendationsEnabled: false,
    });
  }

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
  const motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  if (allowMotifFeatures(experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  const persistentMotifLibrary = await listUserMotifLibrary(userId, locale);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: allowMotifFeatures(experimentArm) ? persistentMotifLibrary : [],
    planningBootstrapHints,
    taskLifecycle,
  });

  res.json({
    conversationId: id,
    title: conv.title,
    locale,
    experiment_arm: experimentArm,
    model: conversationModel,
    systemPrompt: conv.systemPrompt,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState,
    taskDetection: (conv as any).taskDetection || planning.taskDetection,
    cognitiveState: (conv as any).cognitiveState || planning.cognitiveState,
    portfolioDocumentState: (conv as any).portfolioDocumentState || planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
    transferRecommendationsEnabled: nextTransferRecommendationsEnabled,
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  const nextLifecycle = reopenTaskLifecycle(readTaskLifecycle((conv as any).taskLifecycle));
  const now = new Date();
  const nextTransferRecommendationsEnabled = transferRecommendationsEnabled(
    readPlanningBootstrapHints((conv as any).planningBootstrapHints),
    experimentArm
  );

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
  const motifTransferState = motifTransferStateForArm(experimentArm, (refreshedConv as any).motifTransferState);
  if (allowMotifFeatures(experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: (refreshedConv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: allowMotifFeatures(experimentArm) ? await listUserMotifLibrary(userId, locale) : [],
    planningBootstrapHints: readPlanningBootstrapHints((refreshedConv as any).planningBootstrapHints),
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
    experiment_arm: experimentArm,
    model: conversationModel,
    systemPrompt: refreshedConv.systemPrompt,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle: nextLifecycle,
    transferRecommendationsEnabled: nextTransferRecommendationsEnabled,
  });
}));

convRouter.put("/:id/model", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const experimentArm = conversationExperimentArm(conv);

  const model = normalizeConversationModel(req.body?.model, conversationModelFromDoc(conv));
  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        model,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId: String(oid),
    experiment_arm: experimentArm,
    model,
    updatedAt: now.toISOString(),
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  const nextTransferRecommendationsEnabled = transferRecommendationsEnabled(
    readPlanningBootstrapHints((conv as any).planningBootstrapHints),
    experimentArm
  );

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
  const manualGraphOverrides = rebuildManualGraphOverrides({
    prevGraph,
    nextGraph: normalized,
    existing: normalizeManualGraphOverrides((conv as any).manualGraphOverrides),
    updatedAt: new Date().toISOString(),
  });
  const model = buildCognitiveModel({
    graph: normalized,
    prevConcepts: conv.concepts || [],
    baseConcepts: Array.isArray(req.body?.concepts) ? req.body.concepts : conv.concepts || [],
    baseMotifs: allowMotifFeatures(experimentArm)
      ? mergeGraphSaveBaseMotifs({
          stored: (conv as any).motifs || [],
          incoming: Array.isArray(req.body?.motifs)
            ? req.body.motifs
            : Array.isArray(req.body?.motif_graph?.motifs)
            ? req.body.motif_graph.motifs
            : [],
        })
      : [],
    baseMotifLinks: allowMotifFeatures(experimentArm)
      ? Array.isArray(req.body?.motifLinks)
        ? req.body.motifLinks
        : Array.isArray(req.body?.motif_graph?.motif_links)
        ? req.body.motif_graph.motif_links
        : (conv as any).motifLinks || []
      : [],
    baseContexts: allowMotifFeatures(experimentArm)
      ? Array.isArray(req.body?.contexts)
        ? req.body.contexts
        : (conv as any).contexts || []
      : [],
    locale,
  });
  const motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const planningBootstrapHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const taskScope = activeTaskScope((conv as any).travelPlanState || null, String(oid));
  if (allowMotifFeatures(experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    await applyDisplayTitlesToModel({
      model,
      previousMotifs: (conv as any).motifs || [],
      previousConcepts: conv.concepts || [],
      locale,
      conversationModel,
    });
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);

  const requestAdvice = parseBoolFlag(req.body?.requestAdvice);
  const conflictGate =
    requestAdvice && allowMotifFeatures(experimentArm) ? buildConflictGatePayload(safeModel.motifs, locale) : null;
  const advicePrompt = String(req.body?.advicePrompt || "").trim().slice(0, 1200);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: safeModel.graph,
    concepts: safeModel.concepts,
    motifs: safeModel.motifs,
    previous: (conv as any).travelPlanState || null,
    locale,
    queryTaskId: taskScope.taskId,
    since: taskScope.since,
  });
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: allowMotifFeatures(experimentArm) ? await listUserMotifLibrary(userId, locale) : [],
    planningBootstrapHints,
    taskLifecycle,
  });
  const motifClarificationState = motifClarificationStateForArm(experimentArm, null);

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: safeModel.graph,
        concepts: safeModel.concepts,
        motifs: safeModel.motifs,
        motifLinks: safeModel.motifLinks,
        motifReasoningView: safeModel.motifReasoningView,
        contexts: safeModel.contexts,
        validationStatus: safeModel.validationStatus,
        travelPlanState,
        taskDetection: planning.taskDetection,
        cognitiveState: planning.cognitiveState,
        portfolioDocumentState: planning.portfolioDocumentState,
        motifTransferState,
        motifClarificationState,
        taskLifecycle,
        manualGraphOverrides,
        updatedAt: now,
      },
    }
  );

  let assistantText = "";
  let adviceError = "";
  if (requestAdvice && !conflictGate) {
    try {
      const recent = await loadRecentTurnsForPlan({
        conversationId: oid,
        userId,
        taskId: taskScope.taskId,
        since: taskScope.since,
        limit: 12,
        sortDirection: -1,
      });
      const recentTurns = recent
        .slice()
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
        graph: safeModel.graph,
        userText: mergedPrompt,
        recentTurns,
        systemPrompt: allowMotifFeatures(experimentArm)
          ? withTransferSystemPrompt({
              locale,
              baseSystemPrompt: conv.systemPrompt,
              motifTransferState,
            })
          : conv.systemPrompt,
        locale,
        model: conversationModel,
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
    experiment_arm: experimentArm,
    model: conversationModel,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    motifClarificationState,
    taskLifecycle,
    updatedAt: now,
    assistantText,
    adviceError,
    conflictGate,
    transferRecommendationsEnabled: nextTransferRecommendationsEnabled,
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  const nextTransferRecommendationsEnabled = transferRecommendationsEnabled(
    readPlanningBootstrapHints((conv as any).planningBootstrapHints),
    experimentArm
  );

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
    baseMotifs: allowMotifFeatures(experimentArm) ? (conv as any).motifs || [] : [],
    baseMotifLinks: allowMotifFeatures(experimentArm) ? (conv as any).motifLinks || [] : [],
    baseContexts: allowMotifFeatures(experimentArm) ? (conv as any).contexts || [] : [],
    locale,
  });
  const motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const planningBootstrapHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const taskScope = activeTaskScope((conv as any).travelPlanState || null, String(oid));
  if (allowMotifFeatures(experimentArm)) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    await applyDisplayTitlesToModel({
      model,
      previousMotifs: (conv as any).motifs || [],
      previousConcepts: conv.concepts || [],
      locale,
      conversationModel,
    });
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: safeModel.graph,
    concepts: safeModel.concepts,
    motifs: safeModel.motifs,
    previous: (conv as any).travelPlanState || null,
    locale,
    queryTaskId: taskScope.taskId,
    since: taskScope.since,
  });
  const planning = await safeBuildPlanningStateBundle({
    conversationId: oid,
    userId,
    locale,
    experimentArm,
    model: safeModel,
    travelPlanState,
    previousTravelPlan: (conv as any).travelPlanState || null,
    motifTransferState,
    persistentMotifLibrary: allowMotifFeatures(experimentArm) ? await listUserMotifLibrary(userId, locale) : [],
    planningBootstrapHints,
    taskLifecycle,
  });

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: safeModel.graph,
        concepts: safeModel.concepts,
        motifs: safeModel.motifs,
        motifLinks: safeModel.motifLinks,
        motifReasoningView: safeModel.motifReasoningView,
        contexts: safeModel.contexts,
        validationStatus: safeModel.validationStatus,
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
    experiment_arm: experimentArm,
    model: conversationModel,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState,
    taskDetection: planning.taskDetection,
    cognitiveState: planning.cognitiveState,
    portfolioDocumentState: planning.portfolioDocumentState,
    motifTransferState,
    taskLifecycle,
    updatedAt: now,
    transferRecommendationsEnabled: nextTransferRecommendationsEnabled,
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
      taskId: cleanInput((t as any).taskId, 120) || undefined,
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
    const experimentArm = conversationExperimentArm(conv);
    const taskScope = activeTaskScope((conv as any).travelPlanState || null, String(oid));

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
    const motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
    const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
    const planningBootstrapHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
    if (allowMotifFeatures(experimentArm)) {
      model.motifs = applyTransferStateToMotifs({
        motifs: model.motifs || [],
        state: motifTransferState,
      });
      model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    }
    const safeModel = sanitizeModelForExperimentArm(model, experimentArm);
    const travelPlanState =
      (conv as any).travelPlanState
        ? await computeTravelPlanState({
            conversationId: oid,
            userId,
            graph,
            concepts: safeModel.concepts || [],
            motifs: safeModel.motifs || [],
            previous: (conv as any).travelPlanState || null,
            locale,
            queryTaskId: taskScope.taskId,
            since: taskScope.since,
          })
        : ((conv as any).travelPlanState as TravelPlanState | null);
    if (!travelPlanState) {
      return res.status(400).json({ error: "no travel plan state yet, cannot export plan" });
    }
    const planning = await safeBuildPlanningStateBundle({
      conversationId: oid,
      userId,
      locale,
      experimentArm,
      model: safeModel,
      travelPlanState,
      previousTravelPlan: (conv as any).travelPlanState || null,
      motifTransferState,
      persistentMotifLibrary: allowMotifFeatures(experimentArm) ? await listUserMotifLibrary(userId, locale) : [],
      planningBootstrapHints,
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  if (isPureChatArm(experimentArm)) {
    const recentTurns = await loadRecentTurnsForPlainChat({
      conversationId: oid,
      userId,
      limit: config.plainChatHistoryTurnLimit,
    });
    const carryover =
      recentTurns.length === 0
        ? await loadPlainChatCarryoverContext({
            userId,
            conversationId: String(oid),
            planningBootstrapHints: readPlanningBootstrapHints((conv as any).planningBootstrapHints),
          })
        : null;
    const assistantText = await generatePlainAssistantTextNonStreaming({
      userText,
      recentTurns,
      systemPrompt: withPlainChatCarryoverPrompt({
        locale,
        baseSystemPrompt: conv.systemPrompt,
        carryover,
      }),
      locale,
      model: conversationModel,
    });
    const now = new Date();
    const graph = conv?.graph && typeof conv.graph === "object" ? conv.graph : emptyGraph(String(oid));
    const graphPatch = emptyGraphPatch();
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText,
      graphPatch,
      graphVersion: Number(graph.version || 0),
    } as any);
    await collections.conversations.updateOne(
      { _id: oid, userId },
      {
        $set: {
          updatedAt: now,
          graph,
          concepts: [],
          motifs: [],
          motifLinks: [],
          motifReasoningView: emptyMotifReasoningView(),
          contexts: [],
          travelPlanState: null,
          taskDetection: null,
          cognitiveState: null,
          portfolioDocumentState: null,
          motifTransferState: null,
          motifClarificationState: null,
          taskLifecycle: null,
        },
      }
    );
    const safeModel = sanitizeModelForExperimentArm(buildPureChatModel(locale, String(oid), { graph }), experimentArm);
    return res.json({
      assistantText,
      graphPatch,
      experiment_arm: experimentArm,
      model: conversationModel,
      ...modelPayload(safeModel, experimentArm),
      travelPlanState: null,
      taskDetection: null,
      cognitiveState: null,
      portfolioDocumentState: null,
      motifTransferState: null,
      taskLifecycle: null,
      transferRecommendationsEnabled: false,
    });
  }
  const motifEnabled = allowMotifFeatures(experimentArm);
  let motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  let motifClarificationState = motifClarificationStateForArm(experimentArm, (conv as any).motifClarificationState);
  let taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const retrievalHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const allowTransferRecommendations = transferRecommendationsEnabled(retrievalHints, experimentArm);
  const manualReferences = motifEnabled ? parseManualReferences(req.body?.manualReferences) : [];
  if (taskLifecycle.status === "closed") {
    return res.status(409).json(taskClosedErrorPayload(taskLifecycle));
  }

  const turnBase = await buildTurnRuntimeBase({
    conversationId: oid,
    userId,
    conv,
    locale,
    userText,
    experimentArm,
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
  const clarificationResolved = motifEnabled
    ? resolveMotifClarificationTurn({
        locale,
        currentState: motifClarificationState,
        motifs: baseMotifs,
        userText,
      })
    : { state: motifClarificationState, motifs: [] as typeof baseMotifs };
  motifClarificationState = clarificationResolved.state;
  const turnBaseMotifs = clarificationResolved.motifs;

  const revisionProbe = motifEnabled
    ? registerRevisionRequestFromUtterance({
        locale,
        currentState: motifTransferState,
        userText,
      })
    : { state: motifTransferState, followupQuestion: "" };
  motifTransferState = revisionProbe.state;
  if (motifEnabled) {
    const pendingInjection = (motifTransferState.activeInjections || []).find(
      (x) => x.injection_state === "pending_confirmation"
    );
    if (pendingInjection && isAffirmativeForTransfer(userText)) {
      const confirmed = confirmTransferInjection({
        currentState: motifTransferState,
        candidateId: pendingInjection.candidate_id,
      });
      motifTransferState = confirmed.state;
      if (confirmed.decision) {
        await recordTransferUsage({
          userId,
          locale,
          motifTypeId: pendingInjection.motif_type_id,
          action: "adopt",
          confidenceDelta: 0.05,
        });
      }
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
  }

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs: turnBaseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  if (motifEnabled) {
    preModel.motifs = applyTransferStateToMotifs({
      motifs: preModel.motifs || [],
      state: motifTransferState,
    });
    preModel.motifGraph = { ...(preModel.motifGraph || { motifs: [], motifLinks: [] }), motifs: preModel.motifs };
  }
  const safePreModel = sanitizeModelForExperimentArm(preModel, experimentArm);
  const conflictGate = motifEnabled ? buildConflictGatePayload(preModel.motifs, locale) : null;
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      taskId: turnBase.predictedTaskId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      experimentArm,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      motifClarificationState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: turnBaseMotifs,
      previousConcepts: baseConcepts,
      turnNumber,
      latestUserText: userText,
      planningBootstrapHints: retrievalHints,
      manualGraphOverrides: turnBase.manualGraphOverrides,
      queryTaskId: turnBase.predictedTaskId,
      since: turnBase.taskSince,
      conversationModel,
    });

    return res.json({
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      experiment_arm: experimentArm,
      model: conversationModel,
      ...modelPayload(safePreModel, experimentArm),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
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
    systemPrompt: motifEnabled
      ? withTransferSystemPrompt({
          locale,
          baseSystemPrompt: conv.systemPrompt,
          motifTransferState,
          manualReferences,
        })
      : conv.systemPrompt,
    locale,
    model: conversationModel,
    motifTransferState,
  });

  const merged = applyPatchWithGuards(graph, out.graph_patch);
  const graphWithOverrides = applyManualGraphOverrides(merged.newGraph, turnBase.manualGraphOverrides);
  const model = buildCognitiveModel({
    graph: graphWithOverrides,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs: turnBaseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  model.graph.version = graphWithOverrides.version + (graphChanged(graphWithOverrides, model.graph) ? 1 : 0);

  if (revisionProbe.followupQuestion) {
    out.assistant_text = appendFollowupQuestion(String(out.assistant_text || ""), revisionProbe.followupQuestion);
  }

  if (
    motifEnabled &&
    shouldEvaluateTransferRecommendations({
      priorTurnCount: turnBase.recentDocs.length,
      motifTransferState,
      transferRecommendationsEnabled: allowTransferRecommendations,
    })
  ) {
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
  if (motifEnabled) {
    model.motifs = applyTransferStateToMotifs({
      motifs: model.motifs || [],
      state: motifTransferState,
    });
    model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
    motifClarificationState = nextMotifClarificationState({
      currentState: motifClarificationState,
      model,
      recentTurns,
      locale,
      motifTransferState,
      askedAt: new Date().toISOString(),
    });
  }
  const safeModel = sanitizeModelForExperimentArm(model, experimentArm);

  const now = new Date();
  await collections.turns.insertOne({
    conversationId: oid,
    userId,
    taskId: turnBase.predictedTaskId,
    createdAt: now,
    userText,
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    graphVersion: model.graph.version,
  } as any);

  const persisted = await persistConversationModel({
    conversationId: oid,
    userId,
    experimentArm,
    model,
    updatedAt: now,
    previousTravelPlan: (conv as any).travelPlanState || null,
    locale,
    motifTransferState,
    motifClarificationState,
    taskLifecycle,
    forceTaskSwitch: turnBase.forceTaskSwitch,
    previousMotifs: turnBaseMotifs,
    previousConcepts: baseConcepts,
    turnNumber,
    latestUserText: userText,
    planningBootstrapHints: retrievalHints,
    manualGraphOverrides: turnBase.manualGraphOverrides,
    queryTaskId: turnBase.predictedTaskId,
    since: turnBase.taskSince,
    conversationModel,
  });

  res.json({
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    experiment_arm: experimentArm,
    model: conversationModel,
    ...modelPayload(safeModel, experimentArm),
    travelPlanState: persisted.travelPlanState,
    taskDetection: persisted.taskDetection,
    cognitiveState: persisted.cognitiveState,
    portfolioDocumentState: persisted.portfolioDocumentState,
    motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
    taskLifecycle,
    transferRecommendationsEnabled: allowTransferRecommendations,
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
  const experimentArm = conversationExperimentArm(conv);
  const conversationModel = conversationModelFromDoc(conv);
  if (isPureChatArm(experimentArm)) {
    const recentTurns = await loadRecentTurnsForPlainChat({
      conversationId: oid,
      userId,
      limit: config.plainChatHistoryTurnLimit,
    });
    const carryover =
      recentTurns.length === 0
        ? await loadPlainChatCarryoverContext({
            userId,
            conversationId: String(oid),
            planningBootstrapHints: readPlanningBootstrapHints((conv as any).planningBootstrapHints),
          })
        : null;
    const graph = conv?.graph && typeof conv.graph === "object" ? conv.graph : emptyGraph(String(oid));
    const graphPatch = emptyGraphPatch();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();

    sseSend(res, "start", { conversationId: id, graphVersion: Number(graph.version || 0) });

    const pingTimer = setInterval(() => {
      sseSend(res, "ping", { t: Date.now() });
    }, 15000);

    const ac = new AbortController();
    let closed = false;
    req.on("close", () => {
      closed = true;
      clearInterval(pingTimer);
      ac.abort();
    });

    let assistantText = "";
    let sentAnyToken = false;

    try {
      assistantText = await streamPlainAssistantText({
        userText,
        recentTurns,
        systemPrompt: withPlainChatCarryoverPrompt({
          locale,
          baseSystemPrompt: conv.systemPrompt,
          carryover,
        }),
        locale,
        model: conversationModel,
        signal: ac.signal,
        onToken: (token) => {
          if (closed) return;
          if (typeof token !== "string" || token.length === 0) return;
          sentAnyToken = true;
          sseSend(res, "token", { token });
        },
      });
    } catch (e: any) {
      if (!sentAnyToken && !closed) {
        try {
          assistantText = await generatePlainAssistantTextNonStreaming({
            userText,
            recentTurns,
            systemPrompt: withPlainChatCarryoverPrompt({
              locale,
              baseSystemPrompt: conv.systemPrompt,
              carryover,
            }),
            locale,
            model: conversationModel,
          });
          if (assistantText) {
            sentAnyToken = true;
            sseSend(res, "token", { token: assistantText });
          }
        } catch (fallbackError: any) {
          sseSend(res, "error", { message: fallbackError?.message || e?.message || "stream failed" });
          clearInterval(pingTimer);
          res.end();
          return;
        }
      } else if (!closed) {
        sseSend(res, "error", { message: e?.message || "stream failed" });
        clearInterval(pingTimer);
        res.end();
        return;
      }
    }

    if (closed) return;

    const now = new Date();
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText,
      graphPatch,
      graphVersion: Number(graph.version || 0),
    } as any);
    await collections.conversations.updateOne(
      { _id: oid, userId },
      {
        $set: {
          updatedAt: now,
          graph,
          concepts: [],
          motifs: [],
          motifLinks: [],
          motifReasoningView: emptyMotifReasoningView(),
          contexts: [],
          travelPlanState: null,
          taskDetection: null,
          cognitiveState: null,
          portfolioDocumentState: null,
          motifTransferState: null,
          motifClarificationState: null,
          taskLifecycle: null,
        },
      }
    );
    const safeModel = sanitizeModelForExperimentArm(buildPureChatModel(locale, String(oid), { graph }), experimentArm);
    sseSend(res, "done", {
      assistantText,
      graphPatch,
      experiment_arm: experimentArm,
      model: conversationModel,
      ...modelPayload(safeModel, experimentArm),
      travelPlanState: null,
      taskDetection: null,
      cognitiveState: null,
      portfolioDocumentState: null,
      motifTransferState: null,
      taskLifecycle: null,
      transferRecommendationsEnabled: false,
    });

    clearInterval(pingTimer);
    return res.end();
  }
  const motifEnabled = allowMotifFeatures(experimentArm);
  let motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  let motifClarificationState = motifClarificationStateForArm(experimentArm, (conv as any).motifClarificationState);
  let taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
  const retrievalHints = readPlanningBootstrapHints((conv as any).planningBootstrapHints);
  const allowTransferRecommendations = transferRecommendationsEnabled(retrievalHints, experimentArm);
  const manualReferences = motifEnabled ? parseManualReferences(req.body?.manualReferences) : [];
  if (taskLifecycle.status === "closed") {
    return res.status(409).json(taskClosedErrorPayload(taskLifecycle));
  }

  const turnBase = await buildTurnRuntimeBase({
    conversationId: oid,
    userId,
    conv,
    locale,
    userText,
    experimentArm,
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
  const clarificationResolved = motifEnabled
    ? resolveMotifClarificationTurn({
        locale,
        currentState: motifClarificationState,
        motifs: baseMotifs,
        userText,
      })
    : { state: motifClarificationState, motifs: [] as typeof baseMotifs };
  motifClarificationState = clarificationResolved.state;
  const turnBaseMotifs = clarificationResolved.motifs;

  const revisionProbe = motifEnabled
    ? registerRevisionRequestFromUtterance({
        locale,
        currentState: motifTransferState,
        userText,
      })
    : { state: motifTransferState, followupQuestion: "" };
  motifTransferState = revisionProbe.state;
  if (motifEnabled) {
    const pendingInjection = (motifTransferState.activeInjections || []).find(
      (x) => x.injection_state === "pending_confirmation"
    );
    if (pendingInjection && isAffirmativeForTransfer(userText)) {
      const confirmed = confirmTransferInjection({
        currentState: motifTransferState,
        candidateId: pendingInjection.candidate_id,
      });
      motifTransferState = confirmed.state;
      if (confirmed.decision) {
        await recordTransferUsage({
          userId,
          locale,
          motifTypeId: pendingInjection.motif_type_id,
          action: "adopt",
          confidenceDelta: 0.05,
        });
      }
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
  }

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: baseConcepts,
    baseConcepts,
    baseMotifs: turnBaseMotifs,
    baseMotifLinks,
    baseContexts,
    locale,
  });
  if (motifEnabled) {
    preModel.motifs = applyTransferStateToMotifs({
      motifs: preModel.motifs || [],
      state: motifTransferState,
    });
    preModel.motifGraph = { ...(preModel.motifGraph || { motifs: [], motifLinks: [] }), motifs: preModel.motifs };
  }
  const safePreModel = sanitizeModelForExperimentArm(preModel, experimentArm);
  const conflictGate = motifEnabled ? buildConflictGatePayload(preModel.motifs, locale) : null;
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };

    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      taskId: turnBase.predictedTaskId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      experimentArm,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      motifClarificationState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: turnBaseMotifs,
      previousConcepts: baseConcepts,
      turnNumber,
      latestUserText: userText,
      planningBootstrapHints: retrievalHints,
      manualGraphOverrides: turnBase.manualGraphOverrides,
      queryTaskId: turnBase.predictedTaskId,
      since: turnBase.taskSince,
      conversationModel,
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
      experiment_arm: experimentArm,
      model: conversationModel,
      ...modelPayload(safePreModel, experimentArm),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
      taskLifecycle,
      conflictGate,
      transferRecommendationsEnabled: allowTransferRecommendations,
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
      systemPrompt: motifEnabled
        ? withTransferSystemPrompt({
            locale,
            baseSystemPrompt: conv.systemPrompt,
            motifTransferState,
            manualReferences,
          })
        : conv.systemPrompt,
      locale,
      model: conversationModel,
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
      const appended = appendFollowupQuestion(String(out.assistant_text || ""), revisionProbe.followupQuestion);
      const delta = appended.slice(String(out.assistant_text || "").length);
      if (delta) {
        sentAnyToken = true;
        sseSend(res, "token", { token: delta });
      }
      out.assistant_text = appended;
    }

    const merged = applyPatchWithGuards(graph, out.graph_patch);
    const graphWithOverrides = applyManualGraphOverrides(merged.newGraph, turnBase.manualGraphOverrides);
    const model = buildCognitiveModel({
      graph: graphWithOverrides,
      prevConcepts: baseConcepts,
      baseConcepts,
      baseMotifs: turnBaseMotifs,
      baseMotifLinks,
      baseContexts,
      locale,
    });
    model.graph.version = graphWithOverrides.version + (graphChanged(graphWithOverrides, model.graph) ? 1 : 0);

    if (
      motifEnabled &&
      shouldEvaluateTransferRecommendations({
        priorTurnCount: turnBase.recentDocs.length,
        motifTransferState,
        transferRecommendationsEnabled: allowTransferRecommendations,
      })
    ) {
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
    if (motifEnabled) {
      model.motifs = applyTransferStateToMotifs({
        motifs: model.motifs || [],
        state: motifTransferState,
      });
      model.motifGraph = { ...(model.motifGraph || { motifs: [], motifLinks: [] }), motifs: model.motifs };
      motifClarificationState = nextMotifClarificationState({
        currentState: motifClarificationState,
        model,
        recentTurns,
        locale,
        motifTransferState,
        askedAt: new Date().toISOString(),
      });
    }
    const safeModel = sanitizeModelForExperimentArm(model, experimentArm);

    const now = new Date();
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      taskId: turnBase.predictedTaskId,
      createdAt: now,
      userText,
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      graphVersion: model.graph.version,
    } as any);

    const persisted = await persistConversationModel({
      conversationId: oid,
      userId,
      experimentArm,
      model,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
      locale,
      motifTransferState,
      motifClarificationState,
      taskLifecycle,
      forceTaskSwitch: turnBase.forceTaskSwitch,
      previousMotifs: turnBaseMotifs,
      previousConcepts: baseConcepts,
      turnNumber,
      latestUserText: userText,
      planningBootstrapHints: retrievalHints,
      manualGraphOverrides: turnBase.manualGraphOverrides,
      queryTaskId: turnBase.predictedTaskId,
      since: turnBase.taskSince,
      conversationModel,
    });

    sseSend(res, "done", {
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      experiment_arm: experimentArm,
      model: conversationModel,
      ...modelPayload(safeModel, experimentArm),
      travelPlanState: persisted.travelPlanState,
      taskDetection: persisted.taskDetection,
      cognitiveState: persisted.cognitiveState,
      portfolioDocumentState: persisted.portfolioDocumentState,
      motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
      taskLifecycle,
      transferRecommendationsEnabled: allowTransferRecommendations,
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
          systemPrompt: motifEnabled
            ? withTransferSystemPrompt({
                locale,
                baseSystemPrompt: conv.systemPrompt,
                motifTransferState,
                manualReferences,
              })
            : conv.systemPrompt,
          locale,
          model: conversationModel,
          motifTransferState,
        });

        if (revisionProbe.followupQuestion) {
          out2.assistant_text = appendFollowupQuestion(String(out2.assistant_text || ""), revisionProbe.followupQuestion);
        }

        const merged2 = applyPatchWithGuards(graph, out2.graph_patch);
        const graphWithOverrides2 = applyManualGraphOverrides(merged2.newGraph, turnBase.manualGraphOverrides);
        const model2 = buildCognitiveModel({
          graph: graphWithOverrides2,
          prevConcepts: baseConcepts,
          baseConcepts,
          baseMotifs: turnBaseMotifs,
          baseMotifLinks,
          baseContexts,
          locale,
        });
        model2.graph.version =
          graphWithOverrides2.version + (graphChanged(graphWithOverrides2, model2.graph) ? 1 : 0);

        if (
          motifEnabled &&
          shouldEvaluateTransferRecommendations({
            priorTurnCount: turnBase.recentDocs.length,
            motifTransferState,
            transferRecommendationsEnabled: allowTransferRecommendations,
          })
        ) {
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
        if (motifEnabled) {
          model2.motifs = applyTransferStateToMotifs({
            motifs: model2.motifs || [],
            state: motifTransferState,
          });
          model2.motifGraph = { ...(model2.motifGraph || { motifs: [], motifLinks: [] }), motifs: model2.motifs };
          motifClarificationState = nextMotifClarificationState({
            currentState: motifClarificationState,
            model: model2,
            recentTurns,
            locale,
            motifTransferState,
            askedAt: new Date().toISOString(),
          });
        }
        const safeModel2 = sanitizeModelForExperimentArm(model2, experimentArm);

        const now = new Date();
        await collections.turns.insertOne({
          conversationId: oid,
          userId,
          taskId: turnBase.predictedTaskId,
          createdAt: now,
          userText,
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          graphVersion: model2.graph.version,
        } as any);

        const persisted = await persistConversationModel({
          conversationId: oid,
          userId,
          experimentArm,
          model: model2,
          updatedAt: now,
          previousTravelPlan: (conv as any).travelPlanState || null,
          locale,
          motifTransferState,
          motifClarificationState,
          taskLifecycle,
          forceTaskSwitch: turnBase.forceTaskSwitch,
          previousMotifs: turnBaseMotifs,
          previousConcepts: baseConcepts,
          turnNumber,
          latestUserText: userText,
          planningBootstrapHints: retrievalHints,
          manualGraphOverrides: turnBase.manualGraphOverrides,
          queryTaskId: turnBase.predictedTaskId,
          since: turnBase.taskSince,
          conversationModel,
        });

        sseSend(res, "done", {
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          experiment_arm: experimentArm,
          model: conversationModel,
          ...modelPayload(safeModel2, experimentArm),
          travelPlanState: persisted.travelPlanState,
          taskDetection: persisted.taskDetection,
          cognitiveState: persisted.cognitiveState,
          portfolioDocumentState: persisted.portfolioDocumentState,
          motifTransferState: motifTransferStateForArm(experimentArm, motifTransferState),
          taskLifecycle,
          transferRecommendationsEnabled: allowTransferRecommendations,
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
  const experimentArm = conversationExperimentArm(conv);
  if (!allowMotifFeatures(experimentArm)) return rejectMotifDisabled(res);
  const actionRaw = cleanInput(req.body?.action, 24).toLowerCase();
  const action =
    actionRaw === "adopt" || actionRaw === "modify" || actionRaw === "ignore" || actionRaw === "confirm"
      ? (actionRaw as TransferDecisionAction)
      : null;
  if (!action) return res.status(400).json({ error: "action must be one of adopt/modify/ignore/confirm" });

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);
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
  const applicationScope = cleanInput(req.body?.application_scope, 24) === "local" ? "local" : "trip";

  if (action === "confirm") {
    const confirmed = confirmTransferInjection({
      currentState: motifTransferState,
      candidateId,
    });
    motifTransferState = confirmed.state;
    if (!confirmed.decision) {
      return res.status(409).json({ error: "candidate is not awaiting confirmation" });
    }

    await recordTransferUsage({
      userId,
      locale,
      motifTypeId: recommendation.motif_type_id,
      action: "adopt",
      confidenceDelta: 0.05,
    });

    const refreshed = await refreshConversationTransferProjection({
      oid,
      userId,
      locale,
      experimentArm,
      conv,
      motifTransferState,
      taskLifecycle,
    });

    return res.json({
      ok: true,
      decision: confirmed.decision,
      experiment_arm: experimentArm,
      motifTransferState,
      ...modelPayload(refreshed.model, experimentArm),
      travelPlanState: refreshed.travelPlanState,
      taskDetection: refreshed.planning.taskDetection,
      cognitiveState: refreshed.planning.cognitiveState,
      portfolioDocumentState: refreshed.planning.portfolioDocumentState,
      taskLifecycle,
      updatedAt: refreshed.updatedAt,
    });
  }

  const decided = applyTransferDecision({
    locale,
    currentState: motifTransferState,
    recommendation: recommendation as any,
    action,
    modeOverride,
    revisedText: cleanInput(req.body?.revised_text, 320),
    note: cleanInput(req.body?.note, 220),
    applicationScope,
  });
  motifTransferState = decided.state;

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
    experimentArm,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    decision: decided.decision,
    followupQuestion: decided.followupQuestion,
    experiment_arm: experimentArm,
    motifTransferState,
    ...modelPayload(refreshed.model, experimentArm),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));

convRouter.post("/:id/motif-transfer/batch-decision", asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const oid = parseObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });
  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const locale = normalizeLocale((conv as any).locale);
  const experimentArm = conversationExperimentArm(conv);
  if (!allowMotifFeatures(experimentArm)) return rejectMotifDisabled(res);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);

  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 24) : [];
  if (!items.length) return res.status(400).json({ error: "items array required" });

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  const decisions: any[] = [];
  const followupQuestions: string[] = [];

  for (const raw of items) {
    const actionRaw = cleanInput(raw?.action, 24).toLowerCase();
    const action =
      actionRaw === "adopt" || actionRaw === "modify" || actionRaw === "ignore" || actionRaw === "confirm"
        ? (actionRaw as TransferDecisionAction)
        : null;
    const candidateId = cleanInput(raw?.candidate_id, 220);
    if (!action || !candidateId) {
      return res.status(400).json({ error: "each item requires candidate_id and action(adopt/modify/ignore/confirm)" });
    }

    if (action === "confirm") {
      const confirmed = confirmTransferInjections({
        currentState: motifTransferState,
        candidateIds: [candidateId],
      });
      motifTransferState = confirmed.state;
      if (!confirmed.decisions.length) return res.status(409).json({ error: `candidate ${candidateId} is not awaiting confirmation` });
      const rec = motifTransferState.recommendations.find((x) => cleanInput(x.candidate_id, 220) === candidateId);
      if (rec?.motif_type_id) {
        await recordTransferUsage({
          userId,
          locale,
          motifTypeId: rec.motif_type_id,
          action: "adopt",
          confidenceDelta: 0.05,
        });
      }
      decisions.push(...confirmed.decisions);
      continue;
    }

    const recommendation =
      motifTransferState.recommendations.find((x) => cleanInput(x.candidate_id, 220) === candidateId) ||
      (raw?.recommendation && typeof raw.recommendation === "object"
        ? {
            candidate_id: candidateId,
            motif_type_id: cleanInput(raw.recommendation.motif_type_id, 180),
            motif_type_title: cleanInput(raw.recommendation.motif_type_title, 180),
            dependency: cleanInput(raw.recommendation.dependency, 40) || "enable",
            reusable_description: cleanInput(raw.recommendation.reusable_description, 240),
            source_task_id: cleanInput(raw.recommendation.source_task_id, 80) || undefined,
            source_conversation_id: cleanInput(raw.recommendation.source_conversation_id, 80) || undefined,
            status:
              cleanInput(raw.recommendation.status, 24) === "active" ||
              cleanInput(raw.recommendation.status, 24) === "deprecated" ||
              cleanInput(raw.recommendation.status, 24) === "cancelled"
                ? cleanInput(raw.recommendation.status, 24)
                : "uncertain",
            reason: cleanInput(raw.recommendation.reason, 220),
            match_score: Number(raw.recommendation.match_score || 0.7),
            recommended_mode:
              cleanInput(raw.recommendation.recommended_mode, 8) === "A" ||
              cleanInput(raw.recommendation.recommended_mode, 8) === "C"
                ? cleanInput(raw.recommendation.recommended_mode, 8)
                : "B",
            decision_status: "pending",
            created_at: new Date().toISOString(),
          }
        : null);
    if (!recommendation) return res.status(404).json({ error: `recommendation ${candidateId} not found` });

    const decided = applyTransferDecisionBatch({
      locale,
      currentState: motifTransferState,
      items: [
        {
          recommendation: recommendation as any,
          action,
          modeOverride:
            cleanInput(raw?.mode_override, 8).toUpperCase() === "A" ||
            cleanInput(raw?.mode_override, 8).toUpperCase() === "B" ||
            cleanInput(raw?.mode_override, 8).toUpperCase() === "C"
              ? (cleanInput(raw?.mode_override, 8).toUpperCase() as any)
              : undefined,
          revisedText: cleanInput(raw?.revised_text, 320) || undefined,
          note: cleanInput(raw?.note, 220) || undefined,
          applicationScope: cleanInput(raw?.application_scope, 24) === "local" ? "local" : "trip",
        },
      ],
    });
    motifTransferState = decided.state;
    decisions.push(...decided.decisions);
    followupQuestions.push(...decided.followupQuestions);
    if (action === "ignore") {
      await recordTransferUsage({
        userId,
        locale,
        motifTypeId: recommendation.motif_type_id,
        action: "ignore",
        confidenceDelta: -0.03,
      });
    }
  }

  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    experimentArm,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    decisions,
    followupQuestions: Array.from(new Set(followupQuestions.filter(Boolean))),
    experiment_arm: experimentArm,
    motifTransferState,
    ...modelPayload(refreshed.model, experimentArm),
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
  const experimentArm = conversationExperimentArm(conv);
  if (!allowMotifFeatures(experimentArm)) return rejectMotifDisabled(res);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);

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
    experimentArm,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    event: feedback.event,
    followupQuestion: feedback.followupQuestion,
    experiment_arm: experimentArm,
    motifTransferState,
    ...modelPayload(refreshed.model, experimentArm),
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
  const experimentArm = conversationExperimentArm(conv);

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
  if (!allowMotifFeatures(experimentArm) && !(shouldCloseTask && selections.length === 0)) {
    return rejectMotifDisabled(res);
  }
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

  const motifTransferState = motifTransferStateForArm(experimentArm, (conv as any).motifTransferState);
  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    experimentArm,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    ...confirmResult,
    experiment_arm: experimentArm,
    motifTransferState,
    ...modelPayload(refreshed.model, experimentArm),
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
  const experimentArm = conversationExperimentArm(conv);
  if (!allowMotifFeatures(experimentArm)) return rejectMotifDisabled(res);
  const taskLifecycle = readTaskLifecycle((conv as any).taskLifecycle);

  const motifTypeId = cleanInput(req.body?.motif_type_id, 180);
  const choiceRaw = cleanInput(req.body?.choice, 24).toLowerCase();
  const choice = choiceRaw === "overwrite" || choiceRaw === "new_version" ? (choiceRaw as RevisionChoice) : null;
  if (!motifTypeId || !choice) {
    return res.status(400).json({ error: "motif_type_id and choice(overwrite/new_version) are required" });
  }

  const revisedResult = await reviseMotifLibraryEntry({
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
  if (!revisedResult) return res.status(404).json({ error: "motif library entry not found" });
  const currentVersion =
    revisedResult.entry.versions.find((item) => cleanInput(item.version_id, 120) === cleanInput(revisedResult.entry.current_version_id, 120)) ||
    revisedResult.entry.versions[revisedResult.entry.versions.length - 1];

  let motifTransferState = readMotifTransferState((conv as any).motifTransferState);
  motifTransferState = resolveRevisionRequest({
    currentState: motifTransferState,
    requestId: cleanInput(req.body?.request_id, 80) || undefined,
    motifTypeId,
    choice,
    revisedTitle: cleanInput(currentVersion?.title, 180) || cleanInput(revisedResult.entry.motif_type_title, 180),
    revisedDependency: cleanInput(currentVersion?.dependency, 40) || cleanInput(revisedResult.entry.dependency, 40),
    revisedText: cleanInput(currentVersion?.reusable_description, 260),
    revisedVersionId: cleanInput(currentVersion?.version_id, 120),
    targetCandidateIds: Array.isArray(req.body?.target_candidate_ids)
      ? req.body.target_candidate_ids.map((x: any) => cleanInput(x, 220)).filter(Boolean)
      : undefined,
  });
  const refreshed = await refreshConversationTransferProjection({
    oid,
    userId,
    locale,
    experimentArm,
    conv,
    motifTransferState,
    taskLifecycle,
  });

  res.json({
    ok: true,
    revised_entry: revisedResult.entry,
    revision_summary: revisedResult.summary,
    experiment_arm: experimentArm,
    motifTransferState,
    ...modelPayload(refreshed.model, experimentArm),
    travelPlanState: refreshed.travelPlanState,
    taskDetection: refreshed.planning.taskDetection,
    cognitiveState: refreshed.planning.cognitiveState,
    portfolioDocumentState: refreshed.planning.portfolioDocumentState,
    taskLifecycle,
    updatedAt: refreshed.updatedAt,
  });
}));
