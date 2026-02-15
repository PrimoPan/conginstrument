import { randomUUID } from "node:crypto";

export type ConceptType = "goal" | "constraint" | "preference" | "belief" | "fact" | "question";
export type Strength = "hard" | "soft";
export type Status = "proposed" | "confirmed" | "rejected" | "disputed";

// ✅ 新增：风险等级（给前端映射颜色用）
export type Severity = "low" | "medium" | "high" | "critical";

export type ConceptNode = {
  id: string;
  type: ConceptType;
  strength?: Strength;
  statement: string;
  status: Status;
  confidence: number;
  locked?: boolean;

  // ✅ 新增：用于“颜色 + 强调”
  severity?: Severity;     // 风险/严重程度（健康、安全、法律等）
  importance?: number;     // 0~1（对当前任务影响程度）
  tags?: string[];         // 可选：["health","mobility"] 等

  // 预留字段（你说得对：现在留着，后面不会痛）
  key?: string;
  value?: any;
  evidenceIds?: string[];
  sourceMsgIds?: string[];
};

export type EdgeType = "enable" | "constraint" | "determine" | "conflicts_with";

export type ConceptEdge = {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  confidence: number;
  phi?: string;
};

export type CDG = {
  id: string;
  version: number;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
};

export type PatchOp =
  | { op: "add_node"; node: ConceptNode }
  | { op: "update_node"; id: string; patch: Partial<ConceptNode> }
  | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: ConceptEdge }
  | { op: "remove_edge"; id: string };

export type GraphPatch = { ops: PatchOp[]; notes?: string[] };

// 默认禁止 delete（跟 patchGuard 对齐），要开 CRUD 再设 CI_ALLOW_DELETE=1
const ALLOW_DELETE = process.env.CI_ALLOW_DELETE === "1";

const ALLOWED_STATUS = new Set<Status>(["proposed", "confirmed", "rejected", "disputed"]);
const ALLOWED_STRENGTH = new Set<Strength>(["hard", "soft"]);
const ALLOWED_SEVERITY = new Set<Severity>(["low", "medium", "high", "critical"]);
const ALLOWED_NODE_TYPES = new Set<ConceptType>([
  "goal",
  "constraint",
  "preference",
  "belief",
  "fact",
  "question",
]);
const ALLOWED_EDGE_TYPES = new Set<EdgeType>(["enable", "constraint", "determine", "conflicts_with"]);

function clamp01(x: any, d = 0.6) {
  const n = Number(x);
  if (!Number.isFinite(n)) return d;
  return Math.max(0, Math.min(1, n));
}

function cleanText(s: any) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTags(tags: any): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags.map((t) => cleanText(t)).filter(Boolean).slice(0, 8);
  return out.length ? out : undefined;
}

function normalizeSeverity(x: any): Severity | undefined {
  const s = cleanText(x);
  if (!s) return undefined;
  if (ALLOWED_SEVERITY.has(s as Severity)) return s as Severity;
  return undefined;
}

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

  return {
    ...n,
    id,
    type: type as ConceptType,
    statement,
    status,
    confidence: clamp01(n.confidence, 0.6),
    strength,
    severity,
    importance,
    tags,
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

  // 预留字段（如果你未来想让 LLM 更新结构化信息）
  if (patch.key != null) out.key = cleanText(patch.key);
  if (patch.value !== undefined) out.value = patch.value;
  if (patch.evidenceIds != null && Array.isArray(patch.evidenceIds)) out.evidenceIds = patch.evidenceIds.map(String).slice(0, 12);
  if (patch.sourceMsgIds != null && Array.isArray(patch.sourceMsgIds)) out.sourceMsgIds = patch.sourceMsgIds.map(String).slice(0, 12);

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

      nodesById.set(op.id, { ...cur, ...patchNorm });
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

  // ✅ 只有真正应用了 op 才 bump 版本（更符合“版本=结构变化”）
  const versionInc = appliedOps.length > 0 ? 1 : 0;

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
