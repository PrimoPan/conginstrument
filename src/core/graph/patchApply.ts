import { randomUUID } from "node:crypto";
import { inferNodeLayer, normalizeNodeLayer } from "../nodeLayer.js";
import type { CDG, ConceptEdge, ConceptNode, ConceptType, EdgeType, GraphPatch, PatchOp, Status, Strength } from "./types.js";
import {
  ALLOW_DELETE,
  ALLOWED_EDGE_TYPES,
  ALLOWED_NODE_TYPES,
  ALLOWED_STATUS,
  ALLOWED_STRENGTH,
  cleanText,
  clamp01,
  compactSingletonSlots,
  edgeSignature,
  normalizeMotifEvidence,
  normalizeMotifStructure,
  normalizeMotifType,
  normalizeRevisionHistory,
  normalizeSeverity,
  normalizeStringArray,
  normalizeTags,
  pruneInvalidStructuredNodes,
  pruneNoisyDurationOutliers,
} from "./common.js";
import { rebalanceIntentTopology } from "./topology.js";

function normalizeNodeForInsert(n: ConceptNode): ConceptNode | null {
  const id = cleanText(n.id);
  const type = cleanText(n.type);
  const statement = cleanText(n.statement);
  if (!id) return null;
  if (!ALLOWED_NODE_TYPES.has(type as ConceptType)) return null;
  if (!statement) return null;

  const statusRaw = cleanText(n.status);
  const status: Status = (ALLOWED_STATUS.has(statusRaw as Status) ? (statusRaw as Status) : "proposed");

  const strengthRaw = cleanText(n.strength);
  const strength: Strength | undefined =
    ALLOWED_STRENGTH.has(strengthRaw as Strength) ? (strengthRaw as Strength) : undefined;

  const severity = normalizeSeverity((n as any).severity);
  const importance = n.importance != null ? clamp01(n.importance, 0.5) : undefined;
  const tags = normalizeTags((n as any).tags);
  const motifType = normalizeMotifType((n as any).motifType);
  const claim = cleanText((n as any).claim);
  const structure = normalizeMotifStructure((n as any).structure);
  const evidence = normalizeMotifEvidence((n as any).evidence);
  const linkedIntentIds = normalizeStringArray((n as any).linkedIntentIds, 8);
  const rebuttalPoints = normalizeStringArray((n as any).rebuttalPoints, 8);
  const revisionHistory = normalizeRevisionHistory((n as any).revisionHistory);
  const priority = n.priority != null ? clamp01(n.priority, 0.65) : undefined;
  const successCriteria = normalizeStringArray((n as any).successCriteria, 8);
  const evidenceIds = normalizeStringArray((n as any).evidenceIds, 12);
  const sourceMsgIds = normalizeStringArray((n as any).sourceMsgIds, 12);
  const layer =
    normalizeNodeLayer((n as any).layer) ||
    inferNodeLayer({
      type,
      statement,
      strength,
      severity,
      importance,
      tags,
      locked: !!n.locked,
    });

  return {
    ...n,
    id,
    type: type as ConceptType,
    layer,
    statement,
    status,
    confidence: clamp01(n.confidence, 0.6),
    strength,
    severity,
    importance,
    tags,
    key: n.key != null ? cleanText(n.key) : undefined,
    value: n.value,
    evidenceIds,
    sourceMsgIds,
    motifType,
    claim: claim || undefined,
    structure,
    evidence,
    linkedIntentIds,
    rebuttalPoints,
    revisionHistory,
    priority,
    successCriteria,
  };
}

function normalizeEdgeForInsert(e: ConceptEdge): ConceptEdge | null {
  const id = cleanText(e.id);
  const from = cleanText(e.from);
  const to = cleanText(e.to);
  const type = cleanText(e.type);

  if (!id || !from || !to) return null;
  if (!ALLOWED_EDGE_TYPES.has(type as EdgeType)) return null;

  return {
    ...e,
    id,
    from,
    to,
    type: type as EdgeType,
    confidence: clamp01(e.confidence, 0.6),
    phi: e.phi != null ? cleanText(e.phi) : undefined,
  };
}

/**
 * 用于“前端整图编辑后保存”场景：
 * - 仅做字段合法化、ID 修复、悬挂边过滤、重复边去重
 * - 不做槽位压缩/拓扑重平衡，尽量保留用户手工结构
 */
export function normalizeGraphSnapshot(input: any, base?: { id?: string; version?: number }): CDG {
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input?.edges) ? input.edges : [];

  const nodes: ConceptNode[] = [];
  const nodeIdRemap = new Map<string, string>();
  const usedNodeIds = new Set<string>();

  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== "object") continue;

    const originalId = cleanText((rawNode as any).id);
    let candidateId = originalId || `n_${randomUUID()}`;
    if (usedNodeIds.has(candidateId)) candidateId = `n_${randomUUID()}`;

    const normalized = normalizeNodeForInsert({
      ...(rawNode as any),
      id: candidateId,
    } as ConceptNode);
    if (!normalized) continue;

    let finalId = normalized.id;
    if (usedNodeIds.has(finalId)) {
      finalId = `n_${randomUUID()}`;
      normalized.id = finalId;
    }

    usedNodeIds.add(finalId);
    if (originalId && originalId !== finalId) nodeIdRemap.set(originalId, finalId);
    nodes.push(normalized);
  }

  const validNodeIds = new Set(nodes.map((n) => n.id));
  const edges: ConceptEdge[] = [];
  const usedEdgeIds = new Set<string>();
  const edgeSigSet = new Set<string>();

  for (const rawEdge of rawEdges) {
    if (!rawEdge || typeof rawEdge !== "object") continue;

    const rawFrom = cleanText((rawEdge as any).from);
    const rawTo = cleanText((rawEdge as any).to);
    const from = nodeIdRemap.get(rawFrom) || rawFrom;
    const to = nodeIdRemap.get(rawTo) || rawTo;
    if (!validNodeIds.has(from) || !validNodeIds.has(to)) continue;

    const rawId = cleanText((rawEdge as any).id);
    let edgeId = rawId || `e_${randomUUID()}`;
    if (usedEdgeIds.has(edgeId)) edgeId = `e_${randomUUID()}`;

    const normalized = normalizeEdgeForInsert({
      ...(rawEdge as any),
      id: edgeId,
      from,
      to,
    } as ConceptEdge);
    if (!normalized) continue;

    const sig = edgeSignature(normalized.from, normalized.to, normalized.type);
    if (edgeSigSet.has(sig)) continue;

    edgeSigSet.add(sig);
    usedEdgeIds.add(normalized.id);
    edges.push(normalized);
  }

  return {
    id: cleanText(base?.id || input?.id || ""),
    version: Number(base?.version || input?.version || 0),
    nodes,
    edges,
  };
}

/**
 * update_node 防穿透：不允许 patch 改 id/type/locked
 * （不然模型一旦发癫，你整个图结构会崩）
 */
function normalizeNodePatch(patch: Partial<ConceptNode>): Partial<ConceptNode> {
  const out: Partial<ConceptNode> = {};

  if (typeof patch.statement === "string" && cleanText(patch.statement)) out.statement = cleanText(patch.statement);

  if (typeof patch.status === "string" && ALLOWED_STATUS.has(cleanText(patch.status) as Status)) {
    out.status = cleanText(patch.status) as Status;
  }

  if (patch.confidence != null) out.confidence = clamp01(patch.confidence, 0.6);

  if (typeof patch.strength === "string" && ALLOWED_STRENGTH.has(cleanText(patch.strength) as Strength)) {
    out.strength = cleanText(patch.strength) as Strength;
  }

  // ✅ 新增
  if ((patch as any).severity != null) {
    const sev = normalizeSeverity((patch as any).severity);
    if (sev) (out as any).severity = sev;
  }

  if ((patch as any).importance != null) {
    (out as any).importance = clamp01((patch as any).importance, 0.5);
  }

  if ((patch as any).tags != null) {
    const tags = normalizeTags((patch as any).tags);
    if (tags) (out as any).tags = tags;
  }

  if ((patch as any).layer != null) {
    const layer = normalizeNodeLayer((patch as any).layer);
    if (layer) (out as any).layer = layer;
  }

  // 预留字段（如果你未来想让 LLM 更新结构化信息）
  if (patch.key != null) out.key = cleanText(patch.key);
  if (patch.value !== undefined) out.value = patch.value;
  if (patch.evidenceIds != null) out.evidenceIds = normalizeStringArray(patch.evidenceIds, 12);
  if (patch.sourceMsgIds != null) out.sourceMsgIds = normalizeStringArray(patch.sourceMsgIds, 12);

  if ((patch as any).motifType != null) (out as any).motifType = normalizeMotifType((patch as any).motifType);
  if ((patch as any).claim != null) (out as any).claim = cleanText((patch as any).claim) || undefined;
  if ((patch as any).structure != null) (out as any).structure = normalizeMotifStructure((patch as any).structure);
  if ((patch as any).evidence != null) (out as any).evidence = normalizeMotifEvidence((patch as any).evidence);
  if ((patch as any).linkedIntentIds != null)
    (out as any).linkedIntentIds = normalizeStringArray((patch as any).linkedIntentIds, 8);
  if ((patch as any).rebuttalPoints != null)
    (out as any).rebuttalPoints = normalizeStringArray((patch as any).rebuttalPoints, 8);
  if ((patch as any).revisionHistory != null)
    (out as any).revisionHistory = normalizeRevisionHistory((patch as any).revisionHistory);
  if ((patch as any).priority != null) (out as any).priority = clamp01((patch as any).priority, 0.65);
  if ((patch as any).successCriteria != null)
    (out as any).successCriteria = normalizeStringArray((patch as any).successCriteria, 8);

  return out;
}

export function applyPatchWithGuards(graph: CDG, patch: GraphPatch) {
  const idMap = new Map<string, string>();

  // 1) 先把 patch 里所有临时 id（t_）映射成稳定 id
  for (const op of patch.ops) {
    if (op.op === "add_node" && typeof op.node?.id === "string" && op.node.id.startsWith("t_")) {
      idMap.set(op.node.id, `n_${randomUUID()}`);
    }
    if (op.op === "add_edge" && typeof op.edge?.id === "string" && op.edge.id.startsWith("t_")) {
      idMap.set(op.edge.id, `e_${randomUUID()}`);
    }
  }
  const rewrite = (id: string) => idMap.get(id) ?? id;

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const locked = new Set(graph.nodes.filter((n) => n.locked).map((n) => n.id));
  const touchedNodeIds = new Set<string>();
  const touchedNodeOrder = new Map<string, number>();
  let touchSeq = 1;

  // 2) rewrite 临时 id（包括 edge.from/to）
  const rewrittenOps = patch.ops.map((op) => {
    if (op.op === "add_node") return { ...op, node: { ...op.node, id: rewrite(op.node.id) } };
    if (op.op === "update_node") return { ...op, id: rewrite(op.id) };
    if (op.op === "remove_node") return { ...op, id: rewrite(op.id) };
    if (op.op === "add_edge") {
      return {
        ...op,
        edge: {
          ...op.edge,
          id: rewrite(op.edge.id),
          from: rewrite(op.edge.from),
          to: rewrite(op.edge.to),
        },
      };
    }
    if (op.op === "remove_edge") return { ...op, id: rewrite(op.id) };
    return op;
  });

  const appliedOps: PatchOp[] = [];

  // 3) 执行 patch
  for (const op of rewrittenOps) {
    if (op.op === "add_node") {
      const node = normalizeNodeForInsert(op.node);
      if (!node) continue;

      if (!nodesById.has(node.id)) {
        nodesById.set(node.id, node);
        touchedNodeIds.add(node.id);
        touchedNodeOrder.set(node.id, touchSeq++);
        appliedOps.push({ ...op, node });
      }
      continue;
    }

    if (op.op === "update_node") {
      if (locked.has(op.id)) continue;

      const cur = nodesById.get(op.id);
      if (!cur) continue;

      const patchNorm = normalizeNodePatch(op.patch || {});
      if (Object.keys(patchNorm).length === 0) continue;

      const merged = { ...cur, ...patchNorm } as ConceptNode;
      merged.layer =
        normalizeNodeLayer((merged as any).layer) ||
        inferNodeLayer({
          type: merged.type,
          statement: merged.statement,
          strength: merged.strength,
          severity: merged.severity,
          importance: merged.importance,
          tags: merged.tags,
          locked: merged.locked,
        });

      nodesById.set(op.id, merged);
      touchedNodeIds.add(op.id);
      touchedNodeOrder.set(op.id, touchSeq++);
      appliedOps.push({ ...op, patch: patchNorm });
      continue;
    }

    if (op.op === "remove_node") {
      if (!ALLOW_DELETE) continue;
      if (locked.has(op.id)) continue;
      if (!nodesById.has(op.id)) continue;

      nodesById.delete(op.id);
      for (const [eid, e] of edgesById.entries()) {
        if (e.from === op.id || e.to === op.id) edgesById.delete(eid);
      }
      appliedOps.push(op);
      continue;
    }

    if (op.op === "add_edge") {
      const edge = normalizeEdgeForInsert(op.edge);
      if (!edge) continue;

      // 端点必须存在
      if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;

      if (!edgesById.has(edge.id)) {
        edgesById.set(edge.id, edge);
        appliedOps.push({ ...op, edge });
      }
      continue;
    }

    if (op.op === "remove_edge") {
      if (!ALLOW_DELETE) continue;
      if (!edgesById.has(op.id)) continue;

      edgesById.delete(op.id);
      appliedOps.push(op);
      continue;
    }
  }

  const pruneChanged = pruneInvalidStructuredNodes(nodesById, edgesById);
  const durationOutlierPruneChanged = pruneNoisyDurationOutliers(nodesById, edgesById);
  const compactChanged = compactSingletonSlots(nodesById, edgesById, touchedNodeIds, touchedNodeOrder);
  const topologyChanged = rebalanceIntentTopology(nodesById, edgesById, touchedNodeIds, touchedNodeOrder);

  // ✅ 只有真正应用了 op 才 bump 版本（更符合“版本=结构变化”）
  const versionInc =
    appliedOps.length > 0 || pruneChanged || durationOutlierPruneChanged || compactChanged || topologyChanged
      ? 1
      : 0;

  const newGraph: CDG = {
    ...graph,
    version: graph.version + versionInc,
    nodes: Array.from(nodesById.values()),
    edges: Array.from(edgesById.values()),
  };

  return {
    newGraph,
    appliedPatch: { ...patch, ops: appliedOps },
    idMap: Object.fromEntries(idMap),
  };
}
