import { randomUUID } from "node:crypto";
import type { ConceptEdge, ConceptNode, EdgeType } from "./types.js";
import {
  BUDGET_HINT_RE,
  DESTINATION_BAD_TOKEN_RE,
  DESTINATION_HINT_RE,
  DURATION_HINT_RE,
  GENERIC_RESOURCE_HINT_RE,
  GENERIC_RISK_HINT_RE,
  GENERIC_STAKEHOLDER_HINT_RE,
  GENERIC_TIMELINE_HINT_RE,
  HEALTH_RE,
  PEOPLE_HINT_RE,
  PREFERENCE_HINT_RE,
  canonicalizeStructuredPlace,
  chooseRootGoal,
  chooseSlotWinner,
  cleanText,
  clamp01,
  edgeSignature,
  isPrimarySlot,
  rootEdgeTypeForNode,
  severityRank,
  slotFamily,
  slotKeyOfNode,
  slotPriorityScore,
  buildSyntheticGoalStatement,
} from "./common.js";

type TopologyTuning = {
  lambdaSparsity: number;
  maxRootIncoming: number;
  maxAStarSteps: number;
  transitiveCutoff: number;
};

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

function normalizedTopicText(text: string): string {
  return cleanText(text)
    .replace(
      /^(目的地|子地点|总行程时长|城市时长|停留时长|关键日|会议关键日|关键会议日|论文汇报日|活动偏好|景点偏好|限制因素|健康约束|语言约束|出行约束|行程约束)[:：]\s*/i,
      ""
    )
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statementSimilarity(a: string, b: string): number {
  const sa = normalizedTopicText(a).toLowerCase();
  const sb = normalizedTopicText(b).toLowerCase();
  if (!sa || !sb) return 0;

  const jac = jaccardSimilarity(tokenizeForSimilarity(sa), tokenizeForSimilarity(sb));
  let bonus = 0;
  if (sa.includes(sb) || sb.includes(sa)) bonus += 0.22;

  const eventA =
    /(看球|观赛|球迷|比赛|球场|stadium|arena|match|game|演唱会|演出|看展|展览|conference|chi|汇报|演讲|答辩)/i.test(
      sa
    );
  const eventB =
    /(看球|观赛|球迷|比赛|球场|stadium|arena|match|game|演唱会|演出|看展|展览|conference|chi|汇报|演讲|答辩)/i.test(
      sb
    );
  if (eventA && eventB) bonus += 0.14;

  return Math.max(0, Math.min(1, jac + bonus));
}

function inferPreferredSlot(node: ConceptNode, healthNode: ConceptNode | null): string | null {
  const s = cleanText(node.statement);
  if (!s) return null;

  if (/^(?:会议关键日|关键会议日|论文汇报日)[:：]/.test(s)) return "meeting_critical";
  if (/^(?:城市时长|停留时长)[:：]/.test(s)) return "duration_city";
  if (/^会议时长[:：]/.test(s)) return "duration_meeting";
  if (healthNode && (HEALTH_RE.test(s) || GENERIC_RISK_HINT_RE.test(s))) return "health";
  if (BUDGET_HINT_RE.test(s) || GENERIC_RESOURCE_HINT_RE.test(s)) return "budget";
  if (/(酒店|住宿|民宿|星级|房型|房费)/i.test(s)) return "lodging";
  if (DURATION_HINT_RE.test(s) || GENERIC_TIMELINE_HINT_RE.test(s)) return "duration_total";
  if (DESTINATION_HINT_RE.test(s)) return "destination";
  if (PEOPLE_HINT_RE.test(s) || GENERIC_STAKEHOLDER_HINT_RE.test(s)) return "people";
  if (node.type === "preference" || PREFERENCE_HINT_RE.test(s)) return "scenic_preference";
  if (node.type === "constraint" && GENERIC_RISK_HINT_RE.test(s)) return "health";

  return null;
}

function slotDistancePenalty(a: string | null, b: string | null): number {
  if (!a || !b) return 0.22;
  const af = slotFamily(a);
  const bf = slotFamily(b);
  if (af === bf) return 0;
  if ((af === "budget" && bf === "lodging") || (af === "lodging" && bf === "budget")) return 0.12;
  if ((af === "destination" && bf === "scenic_preference") || (af === "scenic_preference" && bf === "destination")) {
    return 0.12;
  }
  if ((af === "health" && bf === "duration_total") || (af === "duration_total" && bf === "health")) return 0.18;
  if ((af === "duration_city" && bf === "destination") || (af === "destination" && bf === "duration_city")) return 0.08;
  if ((af === "duration_meeting" && bf === "duration_total") || (af === "duration_total" && bf === "duration_meeting")) return 0.1;
  if ((af === "meeting_critical" && bf === "duration_meeting") || (af === "duration_meeting" && bf === "meeting_critical")) return 0.06;
  if ((af === "meeting_critical" && bf === "destination") || (af === "destination" && bf === "meeting_critical")) return 0.12;
  if ((af === "meeting_critical" && bf === "sub_location") || (af === "sub_location" && bf === "meeting_critical")) return 0.05;
  if ((af === "meeting_critical" && bf === "activity_preference") || (af === "activity_preference" && bf === "meeting_critical")) {
    return 0.04;
  }
  if ((af === "activity_preference" && bf === "sub_location") || (af === "sub_location" && bf === "activity_preference")) {
    return 0.06;
  }
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
  const riskPenalty = HEALTH_RE.test(node.statement) && slotFamily(anchorSlot) !== "health" ? 0.2 : 0;
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

function pickBestSlotNode(slotNodes: Map<string, ConceptNode>, family: string, statement = ""): ConceptNode | null {
  const candidates: Array<{ slot: string; node: ConceptNode }> = [];
  for (const [slot, node] of slotNodes.entries()) {
    if (slotFamily(slot) !== family) continue;
    candidates.push({ slot, node });
  }
  if (!candidates.length) return null;

  if (family === "destination") {
    const text = normalizedTopicText(statement).toLowerCase();
    const direct = candidates.find(({ slot }) => {
      const city = slot.replace(/^slot:destination:/, "");
      return city && text.includes(city);
    });
    if (direct) return direct.node;
  }

  const query = normalizedTopicText(statement);
  if (query) {
    const ranked = candidates
      .map((entry) => {
        const sim = statementSimilarity(query, `${entry.node.statement} ${entry.slot}`);
        return { ...entry, sim };
      })
      .sort((a, b) => {
        if (b.sim !== a.sim) return b.sim - a.sim;
        const ib = Number(b.node.importance) || 0;
        const ia = Number(a.node.importance) || 0;
        if (ib !== ia) return ib - ia;
        const cb = Number(b.node.confidence) || 0;
        const ca = Number(a.node.confidence) || 0;
        return cb - ca;
      });
    if (ranked[0]?.sim >= 0.08) return ranked[0].node;
  }

  return candidates
    .slice()
    .sort((a, b) => {
      const ib = Number(b.node.importance) || 0;
      const ia = Number(a.node.importance) || 0;
      if (ib !== ia) return ib - ia;
      const cb = Number(b.node.confidence) || 0;
      const ca = Number(a.node.confidence) || 0;
      return cb - ca;
    })[0].node;
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
  if (preferredSlot) {
    const direct = pickBestSlotNode(slotNodes, preferredSlot, statement);
    if (direct && direct.id !== node.id) return direct.id;
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
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): boolean {
  let changed = false;

  // Prune obviously malformed destination/duration nodes to keep topology stable.
  for (const n of Array.from(nodesById.values())) {
    const s = cleanText(n.statement);
    const isBadDestination =
      n.type === "fact" &&
      /^目的地[:：]\s*(.+)$/.test(s) &&
      (() => {
        const raw = cleanText((s.match(/^目的地[:：]\s*(.+)$/)?.[1] || ""));
        if (!raw) return true;
        if (DESTINATION_BAD_TOKEN_RE.test(raw)) return true;
        if (/[A-Za-z]/.test(raw) && /[\u4e00-\u9fff]/.test(raw)) return true;
        return false;
      })();
    const isBadCityDuration =
      (n.type === "fact" || n.type === "constraint") &&
      /^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/.test(s) &&
      (() => {
        const raw = cleanText((s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/)?.[1] || ""));
        if (!raw) return true;
        if (DESTINATION_BAD_TOKEN_RE.test(raw)) return true;
        if (/[A-Za-z]/.test(raw) && /[\u4e00-\u9fff]/.test(raw)) return true;
        return false;
      })();

    if (!isBadDestination && !isBadCityDuration) continue;

    nodesById.delete(n.id);
    changed = true;
    for (const [eid, e] of edgesById.entries()) {
      if (e.from === n.id || e.to === n.id) edgesById.delete(eid);
    }
  }

  let rootGoal = chooseRootGoal(nodesById, touched, touchedOrder);
  if (!rootGoal) {
    const synthetic: ConceptNode = {
      id: `n_${randomUUID()}`,
      type: "goal",
      layer: "intent",
      statement: buildSyntheticGoalStatement(nodesById),
      status: "proposed",
      confidence: 0.82,
      importance: 0.8,
    };
    nodesById.set(synthetic.id, synthetic);
    touched.add(synthetic.id);
    changed = true;
    rootGoal = synthetic;
  }
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
    const winner = chooseSlotWinner(nodes, touched, touchedOrder);
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
  const budgetNode = slotNodes.get("slot:budget") || null;
  const durationTotalNode = slotNodes.get("slot:duration_total") || null;
  const primaryNodes = Array.from(slotNodes.entries())
    .filter(([slot]) => isPrimarySlot(slot))
    .sort((a, b) => slotPriorityScore(a[0]) - slotPriorityScore(b[0]))
    .map(([, node]) => node);
  const secondarySlotEntries = Array.from(slotNodes.entries()).filter(
    ([slot]) => slot !== "slot:goal" && slot !== "slot:health" && !isPrimarySlot(slot)
  );

  for (const node of primaryNodes) {
    const slot = slotByNodeId.get(node.id) || null;
    const family = slotFamily(slot);
    let anchorId = rootId;
    let edgeType = rootEdgeTypeForNode(node, slot);

    // Make hard constraints (duration/budget) the backbone for downstream planning branches.
    if (family === "destination") {
      if (durationTotalNode && durationTotalNode.id !== node.id) {
        anchorId = durationTotalNode.id;
        edgeType = "constraint";
      } else if (budgetNode && budgetNode.id !== node.id) {
        anchorId = budgetNode.id;
        edgeType = "constraint";
      }
    } else if (family === "people") {
      if (durationTotalNode && durationTotalNode.id !== node.id) {
        anchorId = durationTotalNode.id;
        edgeType = "determine";
      }
    }

    putEdge(node.id, anchorId, edgeType, Math.max(0.72, (Number(node.confidence) || 0.6) * 0.9));
  }

  for (const [slot, node] of secondarySlotEntries) {
    let anchorId = rootId;
    if (slotFamily(slot) === "activity_preference") {
      const bestSubLocation = pickBestSlotNode(slotNodes, "sub_location", node.statement);
      if (bestSubLocation) anchorId = bestSubLocation.id;
      else {
        const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
        if (bestDestination) anchorId = bestDestination.id;
      }
    }
    if (slot === "slot:lodging" && slotNodes.get("slot:budget")) anchorId = slotNodes.get("slot:budget")!.id;
    if (slotFamily(slot) === "scenic_preference") {
      const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
      if (bestDestination) anchorId = bestDestination.id;
    }
    if (slotFamily(slot) === "sub_location") {
      const city = cleanText(slot.replace(/^slot:sub_location:/, "").split(":")[0] || "");
      const matchDestination = Array.from(slotNodes.entries()).find(
        ([k]) => slotFamily(k) === "destination" && cleanText(k).includes(city)
      );
      if (matchDestination?.[1]?.id) anchorId = matchDestination[1].id;
      else {
        const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
        if (bestDestination) anchorId = bestDestination.id;
      }
    }
    if (slotFamily(slot) === "duration_city") {
      const city = slot.replace(/^slot:duration_city:/, "");
      const matchDestination = Array.from(slotNodes.entries()).find(
        ([k]) => slotFamily(k) === "destination" && k.includes(city)
      );
      if (matchDestination?.[1]?.id) anchorId = matchDestination[1].id;
      else {
        const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
        if (bestDestination) anchorId = bestDestination.id;
      }
    }
    if (slotFamily(slot) === "duration_meeting" && slotNodes.get("slot:duration_total")) {
      anchorId = slotNodes.get("slot:duration_total")!.id;
    }
    if (slotFamily(slot) === "meeting_critical") {
      const scoredAnchors: Array<{ id: string; score: number }> = [];
      const bestActivity = pickBestSlotNode(slotNodes, "activity_preference", node.statement);
      const bestSubLocation = pickBestSlotNode(slotNodes, "sub_location", node.statement);
      const meetingDuration = slotNodes.get("slot:duration_meeting");
      const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);

      if (bestActivity) {
        scoredAnchors.push({
          id: bestActivity.id,
          score: statementSimilarity(node.statement, bestActivity.statement) + 0.16,
        });
      }
      if (bestSubLocation) {
        scoredAnchors.push({
          id: bestSubLocation.id,
          score: statementSimilarity(node.statement, bestSubLocation.statement) + 0.14,
        });
      }
      if (meetingDuration) {
        scoredAnchors.push({
          id: meetingDuration.id,
          score: statementSimilarity(node.statement, meetingDuration.statement) + 0.1,
        });
      }
      if (bestDestination) {
        scoredAnchors.push({
          id: bestDestination.id,
          score: statementSimilarity(node.statement, bestDestination.statement) + 0.08,
        });
      }

      scoredAnchors.sort((a, b) => b.score - a.score);
      if (scoredAnchors[0]?.score >= 0.22) anchorId = scoredAnchors[0].id;
      else if (meetingDuration) anchorId = meetingDuration.id;
      else if (bestDestination) anchorId = bestDestination.id;
    }
    let edgeType: EdgeType = anchorId === rootId ? rootEdgeTypeForNode(node, slot) : "determine";
    if (slotFamily(slot) === "meeting_critical") edgeType = "constraint";
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
        (isPrimarySlot(sa) ? 50 - slotPriorityScore(sa) : 0) +
        (Number(na?.importance) || 0) * 20 +
        (Number(na?.confidence) || 0) * 10 +
        severityRank(na?.severity) * 4 +
        (na?.type === "constraint" ? 3 : 0);
      const scoreB =
        (isPrimarySlot(sb) ? 50 - slotPriorityScore(sb) : 0) +
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

export { rebalanceIntentTopology };
