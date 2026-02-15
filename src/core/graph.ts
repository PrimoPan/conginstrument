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
const HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;
const PRIMARY_SLOT_KEYS = new Set<string>([
  "slot:people",
  "slot:destination",
  "slot:duration",
  "slot:budget",
]);
const BUDGET_HINT_RE = /预算|花费|费用|开销|贵|便宜|酒店|住宿|房费|星级/i;
const DURATION_HINT_RE = /时长|几天|多少天|周|日程|行程|节奏/i;
const DESTINATION_HINT_RE = /目的地|城市|路线|交通|高铁|飞机|景点|昆明|大理|丽江|香格里拉|云南|江苏|盐城/i;
const PEOPLE_HINT_RE = /同行|一家|家人|父亲|母亲|老人|儿童|三口|两人|人数/i;
const PREFERENCE_HINT_RE = /偏好|喜欢|不喜欢|感兴趣|人文|自然|文化|历史/i;

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

function slotKeyOfNode(node: ConceptNode): string | null {
  const s = cleanText(node.statement);
  if (!s) return null;

  if (node.type === "goal") return "slot:goal";
  if (node.type === "constraint" && /^预算(?:上限)?[:：]\s*[0-9]{2,}\s*元?$/.test(s)) return "slot:budget";
  if (node.type === "constraint" && /^行程时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration";
  if (node.type === "fact" && /^同行人数[:：]\s*[0-9]{1,3}\s*人$/.test(s)) return "slot:people";
  if (node.type === "fact" && /^目的地[:：]\s*.+$/.test(s)) return "slot:destination";
  if ((node.type === "preference" || node.type === "constraint") && /^景点偏好[:：]\s*.+$/.test(s)) return "slot:scenic_preference";
  if (
    (node.type === "preference" || node.type === "constraint") &&
    (/^(住宿偏好|酒店偏好|住宿标准|酒店标准)[:：]/.test(s) ||
      /(全程|尽量|优先).{0,8}(住|入住).{0,8}(酒店|民宿|星级)/.test(s) ||
      /(五星|四星|三星).{0,6}(酒店)/.test(s))
  ) {
    return "slot:lodging";
  }
  if (node.type === "constraint" && HEALTH_RE.test(s)) return "slot:health";
  return null;
}

function statementNumericHint(node: ConceptNode): number {
  const s = cleanText(node.statement);
  const budget = s.match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
  if (budget?.[1]) return Number(budget[1]);
  const duration = s.match(/^行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (duration?.[1]) return Number(duration[1]);
  const people = s.match(/^同行人数[:：]\s*([0-9]{1,3})\s*人$/);
  if (people?.[1]) return Number(people[1]);
  return 0;
}

function chooseSlotWinner(nodes: ConceptNode[], touched: Set<string>): ConceptNode {
  return nodes
    .slice()
    .sort((a, b) => {
      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;

      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;

      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;

      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;

      const numericScore = statementNumericHint(b) - statementNumericHint(a);
      if (numericScore !== 0) return numericScore;

      return cleanText(b.id).localeCompare(cleanText(a.id));
    })[0];
}

function compactSingletonSlots(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>,
  touched: Set<string>
): boolean {
  const slotToNodes = new Map<string, ConceptNode[]>();
  for (const n of nodesById.values()) {
    const slot = slotKeyOfNode(n);
    if (!slot) continue;
    if (!slotToNodes.has(slot)) slotToNodes.set(slot, []);
    slotToNodes.get(slot)!.push(n);
  }

  let changed = false;
  for (const nodes of slotToNodes.values()) {
    if (nodes.length <= 1) continue;
    const winner = chooseSlotWinner(nodes, touched);
    for (const n of nodes) {
      if (n.id === winner.id) continue;
      nodesById.delete(n.id);
      changed = true;
      for (const [eid, e] of edgesById.entries()) {
        if (e.from === n.id || e.to === n.id) edgesById.delete(eid);
      }
    }
  }

  return changed;
}

function severityRank(sev?: Severity): number {
  if (sev === "critical") return 4;
  if (sev === "high") return 3;
  if (sev === "medium") return 2;
  if (sev === "low") return 1;
  return 0;
}

function edgeSignature(from: string, to: string, type: EdgeType): string {
  return `${from}|${to}|${type}`;
}

function slotPriorityScore(slot: string | null | undefined): number {
  if (slot === "slot:people") return 1;
  if (slot === "slot:destination") return 2;
  if (slot === "slot:duration") return 3;
  if (slot === "slot:budget") return 4;
  if (slot === "slot:lodging") return 5;
  if (slot === "slot:scenic_preference") return 6;
  return 99;
}

function rootEdgeTypeForNode(node: ConceptNode, slot: string | null): EdgeType {
  if (slot === "slot:budget" || slot === "slot:duration" || slot === "slot:health") return "constraint";
  if (slot === "slot:lodging") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (slot === "slot:scenic_preference") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (slot === "slot:people" || slot === "slot:destination") return "enable";
  if (node.type === "constraint") return "constraint";
  if (node.type === "question") return "determine";
  return "enable";
}

function chooseRootGoal(nodesById: Map<string, ConceptNode>, touched: Set<string>): ConceptNode | null {
  const goals = Array.from(nodesById.values()).filter((n) => n.type === "goal");
  if (!goals.length) return null;
  return goals
    .slice()
    .sort((a, b) => {
      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;
      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;
      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;
      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;
      return cleanText(a.statement).length - cleanText(b.statement).length;
    })[0];
}

function chooseAnchorNodeId(
  node: ConceptNode,
  rootId: string,
  slotNodes: Map<string, ConceptNode>,
  healthNode: ConceptNode | null
): string {
  const s = cleanText(node.statement);
  if (!s) return rootId;

  if (healthNode && HEALTH_RE.test(s)) return healthNode.id;
  if (slotNodes.has("slot:budget") && BUDGET_HINT_RE.test(s)) return slotNodes.get("slot:budget")!.id;
  if (slotNodes.has("slot:lodging") && /(酒店|住宿|民宿|星级|房型|房费)/i.test(s)) return slotNodes.get("slot:lodging")!.id;
  if (slotNodes.has("slot:duration") && DURATION_HINT_RE.test(s)) return slotNodes.get("slot:duration")!.id;
  if (slotNodes.has("slot:destination") && DESTINATION_HINT_RE.test(s)) return slotNodes.get("slot:destination")!.id;
  if (slotNodes.has("slot:people") && PEOPLE_HINT_RE.test(s)) return slotNodes.get("slot:people")!.id;
  if (node.type === "preference" || PREFERENCE_HINT_RE.test(s)) {
    if (slotNodes.has("slot:scenic_preference")) return slotNodes.get("slot:scenic_preference")!.id;
    if (slotNodes.has("slot:destination")) return slotNodes.get("slot:destination")!.id;
  }

  return rootId;
}

function rebalanceIntentTopology(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>,
  touched: Set<string>
): boolean {
  let changed = false;
  const rootGoal = chooseRootGoal(nodesById, touched);
  if (!rootGoal) return false;
  const rootId = rootGoal.id;

  for (const n of Array.from(nodesById.values())) {
    if (n.type !== "goal" || n.id === rootId) continue;
    nodesById.delete(n.id);
    changed = true;
    for (const [eid, e] of edgesById.entries()) {
      if (e.from === n.id || e.to === n.id) edgesById.delete(eid);
    }
  }

  const slotGroups = new Map<string, ConceptNode[]>();
  for (const n of nodesById.values()) {
    const slot = slotKeyOfNode(n);
    if (!slot) continue;
    if (!slotGroups.has(slot)) slotGroups.set(slot, []);
    slotGroups.get(slot)!.push(n);
  }

  const slotNodes = new Map<string, ConceptNode>();
  for (const [slot, nodes] of slotGroups.entries()) {
    if (!nodes.length) continue;
    const winner = chooseSlotWinner(nodes, touched);
    slotNodes.set(slot, winner);
    for (const n of nodes) {
      if (n.id === winner.id) continue;
      nodesById.delete(n.id);
      changed = true;
      for (const [eid, e] of edgesById.entries()) {
        if (e.from === n.id || e.to === n.id) edgesById.delete(eid);
      }
    }
  }

  const slotByNodeId = new Map<string, string | null>();
  for (const n of nodesById.values()) slotByNodeId.set(n.id, slotKeyOfNode(n));

  const validExistingEdges = Array.from(edgesById.values()).filter(
    (e) => nodesById.has(e.from) && nodesById.has(e.to) && e.from !== e.to
  );
  const existingBySig = new Map<string, ConceptEdge>();
  for (const e of validExistingEdges) {
    existingBySig.set(edgeSignature(e.from, e.to, e.type), e);
  }

  const nextBySig = new Map<string, ConceptEdge>();
  const putEdge = (from: string, to: string, type: EdgeType, confidence: number) => {
    if (!from || !to || from === to) return;
    if (!nodesById.has(from) || !nodesById.has(to)) return;
    const sig = edgeSignature(from, to, type);
    if (nextBySig.has(sig)) return;
    const old = existingBySig.get(sig);
    if (old) {
      nextBySig.set(sig, { ...old, confidence: clamp01(Math.max(old.confidence, confidence), 0.7) });
      return;
    }
    nextBySig.set(sig, {
      id: `e_${randomUUID()}`,
      from,
      to,
      type,
      confidence: clamp01(confidence, 0.7),
    });
  };

  for (const e of validExistingEdges) {
    if (e.type !== "conflicts_with") continue;
    putEdge(e.from, e.to, "conflicts_with", e.confidence || 0.6);
  }

  const healthNode = slotNodes.get("slot:health") || null;
  const primaryNodes = Array.from(slotNodes.entries())
    .filter(([slot]) => PRIMARY_SLOT_KEYS.has(slot))
    .sort((a, b) => slotPriorityScore(a[0]) - slotPriorityScore(b[0]))
    .map(([, node]) => node);
  const secondarySlotEntries = Array.from(slotNodes.entries()).filter(
    ([slot]) => slot !== "slot:goal" && slot !== "slot:health" && !PRIMARY_SLOT_KEYS.has(slot)
  );

  for (const node of primaryNodes) {
    const slot = slotByNodeId.get(node.id) || null;
    putEdge(node.id, rootId, rootEdgeTypeForNode(node, slot), Math.max(0.72, (Number(node.confidence) || 0.6) * 0.9));
  }

  for (const [slot, node] of secondarySlotEntries) {
    let anchorId = rootId;
    if (slot === "slot:lodging" && slotNodes.get("slot:budget")) anchorId = slotNodes.get("slot:budget")!.id;
    if (slot === "slot:scenic_preference" && slotNodes.get("slot:destination")) anchorId = slotNodes.get("slot:destination")!.id;
    const edgeType: EdgeType = anchorId === rootId ? rootEdgeTypeForNode(node, slot) : "determine";
    putEdge(node.id, anchorId, edgeType, Math.max(0.68, (Number(node.confidence) || 0.6) * 0.88));
  }

  if (healthNode) {
    putEdge(healthNode.id, rootId, "constraint", Math.max(0.86, Number(healthNode.confidence) || 0.86));
    for (const node of primaryNodes) {
      if (node.id === healthNode.id) continue;
      putEdge(node.id, healthNode.id, "determine", 0.72);
    }
  }

  for (const node of nodesById.values()) {
    const slot = slotByNodeId.get(node.id) || null;
    if (!node.id || node.id === rootId || slot) continue;

    const anchorId = chooseAnchorNodeId(node, rootId, slotNodes, healthNode);
    let edgeType: EdgeType = "determine";
    if (anchorId === rootId) edgeType = rootEdgeTypeForNode(node, slot);
    if (healthNode && anchorId === healthNode.id && node.type === "constraint") edgeType = "constraint";
    putEdge(node.id, anchorId, edgeType, Math.max(0.62, (Number(node.confidence) || 0.6) * 0.88));
  }

  const maxRootIncoming = 6;
  const primaryIds = new Set(primaryNodes.map((n) => n.id));
  const rootIncoming = Array.from(nextBySig.values()).filter(
    (e) => e.to === rootId && (!healthNode || e.from !== healthNode.id)
  );
  if (rootIncoming.length > maxRootIncoming) {
    const optional = rootIncoming.filter((e) => !primaryIds.has(e.from));
    optional.sort((a, b) => {
      const na = nodesById.get(a.from);
      const nb = nodesById.get(b.from);
      const sa = slotByNodeId.get(a.from);
      const sb = slotByNodeId.get(b.from);
      const scoreA =
        (sa && PRIMARY_SLOT_KEYS.has(sa) ? 50 - slotPriorityScore(sa) : 0) +
        (Number(na?.importance) || 0) * 20 +
        (Number(na?.confidence) || 0) * 10 +
        severityRank(na?.severity) * 4 +
        (na?.type === "constraint" ? 3 : 0);
      const scoreB =
        (sb && PRIMARY_SLOT_KEYS.has(sb) ? 50 - slotPriorityScore(sb) : 0) +
        (Number(nb?.importance) || 0) * 20 +
        (Number(nb?.confidence) || 0) * 10 +
        severityRank(nb?.severity) * 4 +
        (nb?.type === "constraint" ? 3 : 0);
      return scoreB - scoreA;
    });
    const mustKeepCount = rootIncoming.length - optional.length;
    const allowedOptional = Math.max(0, maxRootIncoming - mustKeepCount);
    const keepOptional = new Set(optional.slice(0, allowedOptional).map((e) => edgeSignature(e.from, e.to, e.type)));

    for (const e of optional) {
      const sig = edgeSignature(e.from, e.to, e.type);
      if (keepOptional.has(sig)) continue;
      nextBySig.delete(sig);
      changed = true;
    }
  }

  const beforeSigSet = new Set(validExistingEdges.map((e) => edgeSignature(e.from, e.to, e.type)));
  const nextEdges = Array.from(nextBySig.values());
  const afterSigSet = new Set(nextEdges.map((e) => edgeSignature(e.from, e.to, e.type)));
  if (beforeSigSet.size !== afterSigSet.size) changed = true;
  if (!changed) {
    for (const sig of beforeSigSet) {
      if (!afterSigSet.has(sig)) {
        changed = true;
        break;
      }
    }
  }

  edgesById.clear();
  const usedEdgeIds = new Set<string>();
  for (const e of nextEdges) {
    let id = e.id;
    if (!id || usedEdgeIds.has(id)) id = `e_${randomUUID()}`;
    usedEdgeIds.add(id);
    edgesById.set(id, { ...e, id });
  }

  return changed;
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
  const touchedNodeIds = new Set<string>();

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
      touchedNodeIds.add(op.id);
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

  const compactChanged = compactSingletonSlots(nodesById, edgesById, touchedNodeIds);
  const topologyChanged = rebalanceIntentTopology(nodesById, edgesById, touchedNodeIds);

  // ✅ 只有真正应用了 op 才 bump 版本（更符合“版本=结构变化”）
  const versionInc = appliedOps.length > 0 || compactChanged || topologyChanged ? 1 : 0;

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
