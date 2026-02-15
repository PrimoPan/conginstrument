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
const GENERIC_RESOURCE_HINT_RE = /预算|经费|成本|资源|工时|算力|内存|gpu|人天|cost|budget|resource|cpu|memory/i;
const GENERIC_TIMELINE_HINT_RE = /截止|deadline|里程碑|周期|排期|冲刺|迭代|时长|天|周|月|季度|timeline|schedule/i;
const GENERIC_STAKEHOLDER_HINT_RE = /用户|客户|老板|团队|同事|角色|stakeholder|owner|reviewer|审批/i;
const GENERIC_RISK_HINT_RE = /风险|故障|安全|合规|隐私|法律|阻塞|依赖|上线事故|risk|security|privacy|compliance/i;

type TopologyTuning = {
  lambdaSparsity: number;
  maxRootIncoming: number;
  maxAStarSteps: number;
  transitiveCutoff: number;
};

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

function tokenizeForSimilarity(text: string): Set<string> {
  const s = cleanText(text).toLowerCase();
  if (!s) return new Set<string>();

  const tokens = new Set<string>();
  const chunks = s.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    tokens.add(chunk);

    if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
      for (let i = 0; i < chunk.length - 1; i += 1) tokens.add(chunk.slice(i, i + 2));
      continue;
    }

    if (/^[a-z0-9]+$/.test(chunk) && chunk.length >= 4) {
      for (let i = 0; i < chunk.length - 2; i += 1) tokens.add(chunk.slice(i, i + 3));
    }
  }

  return tokens;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (!union) return 0;
  return inter / union;
}

function inferPreferredSlot(node: ConceptNode, healthNode: ConceptNode | null): string | null {
  const s = cleanText(node.statement);
  if (!s) return null;

  if (healthNode && (HEALTH_RE.test(s) || GENERIC_RISK_HINT_RE.test(s))) return "slot:health";
  if (BUDGET_HINT_RE.test(s) || GENERIC_RESOURCE_HINT_RE.test(s)) return "slot:budget";
  if (/(酒店|住宿|民宿|星级|房型|房费)/i.test(s)) return "slot:lodging";
  if (DURATION_HINT_RE.test(s) || GENERIC_TIMELINE_HINT_RE.test(s)) return "slot:duration";
  if (DESTINATION_HINT_RE.test(s)) return "slot:destination";
  if (PEOPLE_HINT_RE.test(s) || GENERIC_STAKEHOLDER_HINT_RE.test(s)) return "slot:people";
  if (node.type === "preference" || PREFERENCE_HINT_RE.test(s)) return "slot:scenic_preference";
  if (node.type === "constraint" && GENERIC_RISK_HINT_RE.test(s)) return "slot:health";

  return null;
}

function slotDistancePenalty(a: string | null, b: string | null): number {
  if (!a || !b) return 0.22;
  if (a === b) return 0;
  if ((a === "slot:budget" && b === "slot:lodging") || (a === "slot:lodging" && b === "slot:budget")) return 0.12;
  if ((a === "slot:destination" && b === "slot:scenic_preference") || (a === "slot:scenic_preference" && b === "slot:destination")) {
    return 0.12;
  }
  if ((a === "slot:health" && b === "slot:duration") || (a === "slot:duration" && b === "slot:health")) return 0.18;
  return 0.32;
}

function semanticPenalty(
  node: ConceptNode,
  anchor: ConceptNode,
  nodeTokens: Set<string>,
  anchorTokens: Set<string>,
  preferredSlot: string | null,
  anchorSlot: string | null
): number {
  const sim = jaccardSimilarity(nodeTokens, anchorTokens);
  const lexical = 1 - sim;
  const slot = slotDistancePenalty(preferredSlot, anchorSlot);
  const typePenalty = node.type === anchor.type ? -0.06 : 0.06;
  const riskPenalty = HEALTH_RE.test(node.statement) && anchorSlot !== "slot:health" ? 0.2 : 0;
  return lexical + slot + typePenalty + riskPenalty;
}

function edgeTravelCost(edge: ConceptEdge): number {
  const typeBias = edge.type === "determine" ? 1.08 : edge.type === "enable" ? 0.95 : 0.88;
  const confidence = clamp01(edge.confidence, 0.6);
  return typeBias + (1 - confidence) * 0.35;
}

function buildUndirectedAdjacency(edges: ConceptEdge[]): Map<string, Array<{ to: string; cost: number }>> {
  const adj = new Map<string, Array<{ to: string; cost: number }>>();
  for (const e of edges) {
    if (e.type === "conflicts_with") continue;
    const cost = edgeTravelCost(e);
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push({ to: e.to, cost });
    adj.get(e.to)!.push({ to: e.from, cost });
  }
  return adj;
}

function chooseAnchorNodeIdAStar(params: {
  node: ConceptNode;
  rootId: string;
  nodesById: Map<string, ConceptNode>;
  slotNodes: Map<string, ConceptNode>;
  healthNode: ConceptNode | null;
  existingEdges: ConceptEdge[];
  tuning: TopologyTuning;
}): string {
  const { node, rootId, nodesById, slotNodes, healthNode, existingEdges, tuning } = params;
  const statement = cleanText(node.statement);
  if (!statement) return rootId;

  const preferredSlot = inferPreferredSlot(node, healthNode);
  if (preferredSlot && slotNodes.has(preferredSlot)) {
    const direct = slotNodes.get(preferredSlot)!;
    if (direct.id !== node.id) return direct.id;
  }

  const anchorIds = new Set<string>([rootId]);
  for (const n of slotNodes.values()) {
    if (n.id !== node.id) anchorIds.add(n.id);
  }
  for (const n of nodesById.values()) {
    if (n.id === node.id) continue;
    if ((Number(n.importance) || 0) >= 0.78 || (Number(n.confidence) || 0) >= 0.86 || n.type === "constraint") {
      anchorIds.add(n.id);
    }
  }

  const nodeTokens = tokenizeForSimilarity(statement);
  const slotCache = new Map<string, string | null>();
  const tokensCache = new Map<string, Set<string>>();
  const penalty = (anchorId: string) => {
    const anchor = nodesById.get(anchorId);
    if (!anchor) return 1.2;
    if (!tokensCache.has(anchorId)) tokensCache.set(anchorId, tokenizeForSimilarity(anchor.statement));
    if (!slotCache.has(anchorId)) slotCache.set(anchorId, slotKeyOfNode(anchor));
    return semanticPenalty(node, anchor, nodeTokens, tokensCache.get(anchorId)!, preferredSlot, slotCache.get(anchorId) || null);
  };

  let bestAnchorId = rootId;
  let bestScore = penalty(rootId) + 0.08;
  for (const anchorId of anchorIds) {
    const p = penalty(anchorId) + (anchorId === rootId ? 0.08 : 0);
    if (p < bestScore) {
      bestScore = p;
      bestAnchorId = anchorId;
    }
  }

  if (!existingEdges.length || !anchorIds.size) return bestAnchorId;

  const adj = buildUndirectedAdjacency(existingEdges);
  if (!adj.size) return bestAnchorId;

  const open: Array<{ id: string; g: number; f: number }> = [{ id: rootId, g: 0, f: penalty(rootId) }];
  const gScore = new Map<string, number>([[rootId, 0]]);
  const closed = new Set<string>();
  let steps = 0;

  while (open.length && steps < tuning.maxAStarSteps) {
    steps += 1;
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);

    if (anchorIds.has(cur.id) && cur.id !== node.id) {
      const h = penalty(cur.id);
      const score = cur.g + h;
      if (score < bestScore) {
        bestScore = score;
        bestAnchorId = cur.id;
      }
      if (cur.id !== rootId && h <= 0.2) return cur.id;
    }

    const nbs = adj.get(cur.id) || [];
    for (const nb of nbs) {
      if (nb.to === node.id) continue;
      const tentative = cur.g + nb.cost;
      if (tentative >= (gScore.get(nb.to) ?? Number.POSITIVE_INFINITY)) continue;
      gScore.set(nb.to, tentative);
      open.push({
        id: nb.to,
        g: tentative,
        f: tentative + penalty(nb.to),
      });
    }
  }

  return bestAnchorId;
}

function tarjanSCC(nodeIds: string[], edges: ConceptEdge[]): string[][] {
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const adj = new Map<string, string[]>();
  let idx = 0;
  const out: string[][] = [];

  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (e.type === "conflicts_with") continue;
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
  }

  const strongConnect = (v: string) => {
    indexById.set(v, idx);
    lowById.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indexById.has(w)) {
        strongConnect(w);
        lowById.set(v, Math.min(lowById.get(v)!, lowById.get(w)!));
      } else if (onStack.has(w)) {
        lowById.set(v, Math.min(lowById.get(v)!, indexById.get(w)!));
      }
    }

    if (lowById.get(v) === indexById.get(v)) {
      const component: string[] = [];
      while (stack.length) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length) out.push(component);
    }
  };

  for (const id of nodeIds) {
    if (!indexById.has(id)) strongConnect(id);
  }

  return out;
}

function cycleRatio(nodeIds: string[], edges: ConceptEdge[]): number {
  if (nodeIds.length <= 1 || edges.length <= 1) return 0;
  const scc = tarjanSCC(nodeIds, edges);
  let cycNodes = 0;
  for (const comp of scc) {
    if (comp.length > 1) {
      cycNodes += comp.length;
      continue;
    }
    const nid = comp[0];
    if (edges.some((e) => e.from === nid && e.to === nid && e.type !== "conflicts_with")) cycNodes += 1;
  }
  return cycNodes / Math.max(1, nodeIds.length);
}

function computeTopologyTuning(nodeCount: number, edgeCount: number, cycRatio: number): TopologyTuning {
  const n = Math.max(1, nodeCount);
  const density = edgeCount / Math.max(1, n * Math.log2(n + 1));
  const lambda = clamp01(0.38 + 0.24 * Math.tanh(density - 1) + 0.36 * cycRatio, 0.42);

  return {
    lambdaSparsity: lambda,
    maxRootIncoming: Math.max(4, Math.min(10, Math.round(9 - 4 * lambda))),
    maxAStarSteps: Math.max(20, Math.min(96, Math.round(30 + n * (0.28 + (1 - lambda) * 0.35)))),
    transitiveCutoff: Math.max(0.48, Math.min(0.9, 0.72 - lambda * 0.18)),
  };
}

function edgeKeepScore(
  edge: ConceptEdge,
  nodesById: Map<string, ConceptNode>,
  rootId: string,
  touched: Set<string>
): number {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  const typeScore = edge.type === "determine" ? 0.12 : edge.type === "enable" ? 0.44 : 0.92;
  const confidenceScore = clamp01(edge.confidence, 0.6) * 0.9;
  const importanceScore = (((Number(from?.importance) || 0) + (Number(to?.importance) || 0)) / 2) * 0.65;
  const touchedScore = touched.has(edge.from) || touched.has(edge.to) ? 0.32 : 0;
  const rootScore = edge.to === rootId ? 0.26 : 0;
  const riskScore = HEALTH_RE.test(from?.statement || "") || HEALTH_RE.test(to?.statement || "") ? 0.32 : 0;
  return typeScore + confidenceScore + importanceScore + touchedScore + rootScore + riskScore;
}

function breakCyclesByTarjan(params: {
  edges: ConceptEdge[];
  nodesById: Map<string, ConceptNode>;
  rootId: string;
  touched: Set<string>;
}): { edges: ConceptEdge[]; removedCount: number } {
  const { nodesById, rootId, touched } = params;
  const nodeIds = Array.from(nodesById.keys());
  const edges = params.edges.slice();
  let removedCount = 0;
  let rounds = 0;

  while (rounds < 64) {
    rounds += 1;
    const components = tarjanSCC(nodeIds, edges);
    const cycComponents = components.filter((comp) => {
      if (comp.length > 1) return true;
      const nid = comp[0];
      return edges.some((e) => e.from === nid && e.to === nid && e.type !== "conflicts_with");
    });
    if (!cycComponents.length) break;

    let removedThisRound = 0;
    for (const comp of cycComponents) {
      const inComp = new Set(comp);
      const candidates = edges.filter(
        (e) => e.type !== "conflicts_with" && inComp.has(e.from) && inComp.has(e.to) && e.from !== e.to
      );
      if (!candidates.length) continue;

      candidates.sort((a, b) => edgeKeepScore(a, nodesById, rootId, touched) - edgeKeepScore(b, nodesById, rootId, touched));
      const drop = candidates[0];
      const dropIndex = edges.findIndex((e) => e.id === drop.id);
      if (dropIndex < 0) continue;
      edges.splice(dropIndex, 1);
      removedCount += 1;
      removedThisRound += 1;
    }

    if (!removedThisRound) break;
  }

  return { edges, removedCount };
}

function hasDirectedPath(
  from: string,
  to: string,
  edges: ConceptEdge[],
  excludedEdgeId?: string,
  maxDepth = 12
): boolean {
  if (from === to) return true;

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === "conflicts_with") continue;
    if (excludedEdgeId && e.id === excludedEdgeId) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const q: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  const seen = new Set<string>([from]);
  while (q.length) {
    const cur = q.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const nb of adj.get(cur.id) || []) {
      if (nb === to) return true;
      if (seen.has(nb)) continue;
      seen.add(nb);
      q.push({ id: nb, depth: cur.depth + 1 });
    }
  }

  return false;
}

function reduceTransitiveEdges(params: {
  edges: ConceptEdge[];
  nodesById: Map<string, ConceptNode>;
  rootId: string;
  touched: Set<string>;
  tuning: TopologyTuning;
}): { edges: ConceptEdge[]; removedCount: number } {
  const { nodesById, rootId, touched, tuning } = params;
  const edges = params.edges.slice();
  let removedCount = 0;

  const ordered = edges
    .filter((e) => e.type !== "conflicts_with")
    .slice()
    .sort((a, b) => {
      const typeRank = (x: EdgeType) => (x === "determine" ? 0 : x === "enable" ? 1 : 2);
      const t = typeRank(a.type) - typeRank(b.type);
      if (t !== 0) return t;
      return (a.confidence || 0) - (b.confidence || 0);
    });

  for (const edge of ordered) {
    const idx = edges.findIndex((e) => e.id === edge.id);
    if (idx < 0) continue;

    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (!fromNode || !toNode) continue;
    if (edge.to === rootId && edge.type !== "determine") continue;
    if (touched.has(edge.from) || touched.has(edge.to)) continue;

    const keepScore = edgeKeepScore(edge, nodesById, rootId, touched);
    const keepThreshold = 0.92 + (1 - tuning.lambdaSparsity) * 0.5;
    if (keepScore >= keepThreshold) continue;
    if ((edge.confidence || 0) >= tuning.transitiveCutoff && edge.type !== "determine") continue;

    const outAfter = edges.filter((e) => e.type !== "conflicts_with" && e.from === edge.from && e.id !== edge.id).length;
    if (outAfter <= 0) continue;
    if (!hasDirectedPath(edge.from, edge.to, edges, edge.id, 10)) continue;

    const afterRemoval = edges.filter((e) => e.id !== edge.id);
    if (!hasDirectedPath(edge.from, rootId, afterRemoval, undefined, 14)) continue;

    edges.splice(idx, 1);
    removedCount += 1;
  }

  return { edges, removedCount };
}

function repairDisconnectedNodes(params: {
  edges: ConceptEdge[];
  nodesById: Map<string, ConceptNode>;
  rootId: string;
  slotByNodeId: Map<string, string | null>;
}): { edges: ConceptEdge[]; addedCount: number } {
  const { nodesById, rootId, slotByNodeId } = params;
  const edges = params.edges.slice();
  let addedCount = 0;

  for (const node of nodesById.values()) {
    if (node.id === rootId) continue;
    if (hasDirectedPath(node.id, rootId, edges, undefined, 14)) continue;

    const slot = slotByNodeId.get(node.id) || null;
    const type = rootEdgeTypeForNode(node, slot);
    edges.push({
      id: `e_${randomUUID()}`,
      from: node.id,
      to: rootId,
      type,
      confidence: Math.max(0.58, (Number(node.confidence) || 0.6) * 0.86),
    });
    addedCount += 1;
  }

  return { edges, addedCount };
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

  const initStructural = Array.from(nextBySig.values()).filter((e) => e.type !== "conflicts_with");
  const initCycleRatio = cycleRatio(Array.from(nodesById.keys()), initStructural);
  const tuning = computeTopologyTuning(nodesById.size, initStructural.length, initCycleRatio);

  for (const node of nodesById.values()) {
    const slot = slotByNodeId.get(node.id) || null;
    if (!node.id || node.id === rootId || slot) continue;

    const anchorId = chooseAnchorNodeIdAStar({
      node,
      rootId,
      nodesById,
      slotNodes,
      healthNode,
      existingEdges: Array.from(nextBySig.values()),
      tuning,
    });
    let edgeType: EdgeType = "determine";
    if (anchorId === rootId) edgeType = rootEdgeTypeForNode(node, slot);
    if (healthNode && anchorId === healthNode.id && node.type === "constraint") edgeType = "constraint";
    putEdge(node.id, anchorId, edgeType, Math.max(0.62, (Number(node.confidence) || 0.6) * 0.88));
  }

  const maxRootIncoming = tuning.maxRootIncoming;
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

  let nextEdges = Array.from(nextBySig.values());
  const cycleBreak = breakCyclesByTarjan({
    edges: nextEdges,
    nodesById,
    rootId,
    touched,
  });
  if (cycleBreak.removedCount > 0) changed = true;
  nextEdges = cycleBreak.edges;

  const reduced = reduceTransitiveEdges({
    edges: nextEdges,
    nodesById,
    rootId,
    touched,
    tuning,
  });
  if (reduced.removedCount > 0) changed = true;
  nextEdges = reduced.edges;

  const repaired = repairDisconnectedNodes({
    edges: nextEdges,
    nodesById,
    rootId,
    slotByNodeId,
  });
  if (repaired.addedCount > 0) changed = true;
  nextEdges = repaired.edges;

  const beforeSigSet = new Set(validExistingEdges.map((e) => edgeSignature(e.from, e.to, e.type)));
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
