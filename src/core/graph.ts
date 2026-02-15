import { randomUUID } from "node:crypto";

export type ConceptType = "goal" | "constraint" | "preference" | "belief" | "fact" | "question";
export type Strength = "hard" | "soft";
export type Status = "proposed" | "confirmed" | "rejected" | "disputed";

export type ConceptNode = {
  id: string;
  type: ConceptType;
  strength?: Strength;
  statement: string;
  status: Status;
  confidence: number;
  locked?: boolean;

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

export function applyPatchWithGuards(graph: CDG, patch: GraphPatch) {
  const idMap = new Map<string, string>();

  for (const op of patch.ops) {
    if (op.op === "add_node" && op.node.id.startsWith("t_")) {
      idMap.set(op.node.id, `n_${randomUUID()}`);
    }
    if (op.op === "add_edge" && op.edge.id.startsWith("t_")) {
      idMap.set(op.edge.id, `e_${randomUUID()}`);
    }
  }
  const rewrite = (id: string) => idMap.get(id) ?? id;

  const nodesById = new Map(graph.nodes.map(n => [n.id, n]));
  const edgesById = new Map(graph.edges.map(e => [e.id, e]));
  const locked = new Set(graph.nodes.filter(n => n.locked).map(n => n.id));

  const rewrittenOps = patch.ops.map(op => {
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

  for (const op of rewrittenOps) {
    if (op.op === "add_node") {
      if (!nodesById.has(op.node.id)) {
        nodesById.set(op.node.id, op.node);
        appliedOps.push(op);
      }
      continue;
    }

    if (op.op === "update_node") {
      if (locked.has(op.id)) continue;
      const cur = nodesById.get(op.id);
      if (!cur) continue;
      nodesById.set(op.id, { ...cur, ...op.patch });
      appliedOps.push(op);
      continue;
    }

    if (op.op === "remove_node") {
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
      // 端点必须存在
      if (!nodesById.has(op.edge.from) || !nodesById.has(op.edge.to)) continue;
      if (!edgesById.has(op.edge.id)) {
        edgesById.set(op.edge.id, op.edge);
        appliedOps.push(op);
      }
      continue;
    }

    if (op.op === "remove_edge") {
      if (!edgesById.has(op.id)) continue;
      edgesById.delete(op.id);
      appliedOps.push(op);
      continue;
    }
  }

  const newGraph: CDG = {
    ...graph,
    version: graph.version + 1,
    nodes: Array.from(nodesById.values()),
    edges: Array.from(edgesById.values()),
  };

  return { newGraph, appliedPatch: { ...patch, ops: appliedOps }, idMap: Object.fromEntries(idMap) };
}
