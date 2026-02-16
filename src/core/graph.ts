import { randomUUID } from "node:crypto";
import { inferNodeLayer, normalizeNodeLayer } from "./nodeLayer.js";
import type { NodeLayer } from "./nodeLayer.js";
export type { NodeLayer } from "./nodeLayer.js";

export type ConceptType = "goal" | "constraint" | "preference" | "belief" | "fact" | "question";
export type Strength = "hard" | "soft";
export type Status = "proposed" | "confirmed" | "rejected" | "disputed";

// ✅ 新增：风险等级（给前端映射颜色用）
export type Severity = "low" | "medium" | "high" | "critical";
export type MotifType = "belief" | "hypothesis" | "expectation" | "cognitive_step";

export type MotifStructure = {
  premises?: string[];
  inference?: string;
  conclusion?: string;
};

export type MotifEvidence = {
  id?: string;
  quote: string;
  source?: string;
  link?: string;
};

export type RevisionRecord = {
  at: string;
  action: "created" | "updated" | "replaced" | "merged";
  reason?: string;
  by?: "user" | "assistant" | "system";
};

export type ConceptNode = {
  id: string;
  type: ConceptType;
  layer?: NodeLayer;
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

  // PRD: motif/intent metadata
  motifType?: MotifType;
  claim?: string;
  structure?: MotifStructure;
  evidence?: MotifEvidence[];
  linkedIntentIds?: string[];
  rebuttalPoints?: string[];
  revisionHistory?: RevisionRecord[];
  priority?: number;
  successCriteria?: string[];
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
const ALLOWED_MOTIF_TYPES = new Set<MotifType>(["belief", "hypothesis", "expectation", "cognitive_step"]);
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
const BUDGET_HINT_RE = /预算|花费|费用|开销|贵|便宜|酒店|住宿|房费|星级/i;
const DURATION_HINT_RE = /时长|几天|多少天|周|日程|行程|节奏/i;
const DESTINATION_HINT_RE =
  /目的地|城市|国家|地区|路线|交通|高铁|飞机|机场|景点|出发|到达|行程段|flight|train|airport|city|destination/i;
const PEOPLE_HINT_RE = /同行|一家|家人|父亲|母亲|老人|儿童|三口|两人|人数/i;
const PREFERENCE_HINT_RE = /偏好|喜欢|不喜欢|感兴趣|人文|自然|文化|历史/i;
const GENERIC_RESOURCE_HINT_RE = /预算|经费|成本|资源|工时|算力|内存|gpu|人天|cost|budget|resource|cpu|memory/i;
const GENERIC_TIMELINE_HINT_RE = /截止|deadline|里程碑|周期|排期|冲刺|迭代|时长|天|周|月|季度|timeline|schedule/i;
const GENERIC_STAKEHOLDER_HINT_RE = /用户|客户|老板|团队|同事|角色|stakeholder|owner|reviewer|审批/i;
const GENERIC_RISK_HINT_RE = /风险|故障|安全|合规|隐私|法律|阻塞|依赖|上线事故|risk|security|privacy|compliance/i;
const DESTINATION_BAD_TOKEN_RE =
  /我|你|他|她|我们|时间|之外|之前|之后|必须|到场|安排|计划|pre|chi|会议|汇报|报告|论文|一天|两天|三天|四天|五天|顺带|顺便|顺路|顺道|其中|其中有|其余|其他时候|海地区|该地区|看球|观赛|比赛|演讲|发表|打卡|参观|游览|所以这|因此|另外|此外/i;

type TopologyTuning = {
  lambdaSparsity: number;
  maxRootIncoming: number;
  maxAStarSteps: number;
  transitiveCutoff: number;
};

function normalizePlaceToken(raw: string): string {
  return cleanText(raw)
    .replace(/[省市县区州郡]/g, "")
    .replace(/[\s·•\-_/]+/g, "")
    .toLowerCase();
}

function slotFamily(slot: string | null | undefined): string {
  if (!slot) return "none";
  if (slot.startsWith("slot:destination:")) return "destination";
  if (slot.startsWith("slot:duration_city:")) return "duration_city";
  if (slot.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (slot === "slot:duration_total") return "duration_total";
  if (slot === "slot:duration_meeting") return "duration_meeting";
  if (slot === "slot:people") return "people";
  if (slot === "slot:budget") return "budget";
  if (slot === "slot:lodging") return "lodging";
  if (slot === "slot:scenic_preference") return "scenic_preference";
  if (slot === "slot:health") return "health";
  if (slot === "slot:goal") return "goal";
  return slot;
}

function isPrimarySlot(slot: string | null | undefined): boolean {
  const f = slotFamily(slot);
  return f === "people" || f === "destination" || f === "duration_total" || f === "budget";
}

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

function normalizeStringArray(input: any, max = 12): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.map((x) => cleanText(x)).filter(Boolean).slice(0, max);
  return out.length ? out : undefined;
}

function normalizeMotifType(x: any): MotifType | undefined {
  const s = cleanText(x).toLowerCase();
  if (!s) return undefined;
  if (ALLOWED_MOTIF_TYPES.has(s as MotifType)) return s as MotifType;
  return undefined;
}

function normalizeMotifStructure(input: any): MotifStructure | undefined {
  if (!input || typeof input !== "object") return undefined;
  const premises = normalizeStringArray((input as any).premises, 8);
  const inference = cleanText((input as any).inference);
  const conclusion = cleanText((input as any).conclusion);
  const out: MotifStructure = {};
  if (premises) out.premises = premises;
  if (inference) out.inference = inference;
  if (conclusion) out.conclusion = conclusion;
  return Object.keys(out).length ? out : undefined;
}

function normalizeMotifEvidence(input: any): MotifEvidence[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: MotifEvidence[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const quote = cleanText((row as any).quote);
    if (!quote) continue;
    const item: MotifEvidence = { quote };
    const id = cleanText((row as any).id);
    const source = cleanText((row as any).source);
    const link = cleanText((row as any).link);
    if (id) item.id = id;
    if (source) item.source = source;
    if (link) item.link = link;
    out.push(item);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeRevisionHistory(input: any): RevisionRecord[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: RevisionRecord[] = [];
  const allowedAction = new Set<RevisionRecord["action"]>(["created", "updated", "replaced", "merged"]);
  const allowedBy = new Set<RevisionRecord["by"]>(["user", "assistant", "system"]);

  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const at = cleanText((row as any).at);
    const actionRaw = cleanText((row as any).action).toLowerCase();
    if (!at || !allowedAction.has(actionRaw as RevisionRecord["action"])) continue;
    const item: RevisionRecord = {
      at,
      action: actionRaw as RevisionRecord["action"],
    };
    const reason = cleanText((row as any).reason);
    const byRaw = cleanText((row as any).by).toLowerCase();
    if (reason) item.reason = reason;
    if (allowedBy.has(byRaw as RevisionRecord["by"])) item.by = byRaw as RevisionRecord["by"];
    out.push(item);
    if (out.length >= 10) break;
  }
  return out.length ? out : undefined;
}

function slotKeyOfNode(node: ConceptNode): string | null {
  const s = cleanText(node.statement);
  if (!s) return null;

  if (node.type === "goal") return "slot:goal";
  if (node.type === "constraint" && /^预算(?:上限)?[:：]\s*[0-9]{2,}\s*元?$/.test(s)) return "slot:budget";
  if (node.type === "constraint" && /^(?:总)?行程时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_total";
  if (node.type === "constraint" && /^会议时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_meeting";
  if (node.type === "constraint" && /^(?:会议关键日|关键会议日|论文汇报日)[:：]\s*.+$/.test(s)) {
    const m = s.match(/^(?:会议关键日|关键会议日|论文汇报日)[:：]\s*(.+)$/);
    const detail = normalizePlaceToken((m?.[1] || "").slice(0, 24));
    return `slot:meeting_critical:${detail || "default"}`;
  }
  if ((node.type === "fact" || node.type === "constraint") && /^(?:城市时长|停留时长)[:：]\s*.+\s+[0-9]{1,3}\s*天$/.test(s)) {
    const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    const rawCity = cleanText(m?.[1] || "");
    if (!rawCity) return null;
    if (DESTINATION_BAD_TOKEN_RE.test(rawCity)) return null;
    if (/[A-Za-z]/.test(rawCity) && /[\u4e00-\u9fff]/.test(rawCity)) return null;
    const city = normalizePlaceToken(rawCity);
    if (city) return `slot:duration_city:${city}`;
    return "slot:duration_city:unknown";
  }
  if (node.type === "fact" && /^同行人数[:：]\s*[0-9]{1,3}\s*人$/.test(s)) return "slot:people";
  if (node.type === "fact" && /^目的地[:：]\s*.+$/.test(s)) {
    const m = s.match(/^目的地[:：]\s*(.+)$/);
    const rawCity = cleanText(m?.[1] || "");
    if (!rawCity) return null;
    if (DESTINATION_BAD_TOKEN_RE.test(rawCity)) return null;
    if (/[A-Za-z]/.test(rawCity) && /[\u4e00-\u9fff]/.test(rawCity)) return null;
    const city = normalizePlaceToken(rawCity);
    if (city) return `slot:destination:${city}`;
    return "slot:destination:unknown";
  }
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
  const duration = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (duration?.[1]) return Number(duration[1]) + 1000;
  const cityDuration = s.match(/^(?:城市时长|停留时长)[:：]\s*.+\s+([0-9]{1,3})\s*天$/);
  if (cityDuration?.[1]) return Number(cityDuration[1]);
  const meetingDuration = s.match(/^会议时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (meetingDuration?.[1]) return Number(meetingDuration[1]) + 300;
  const people = s.match(/^同行人数[:：]\s*([0-9]{1,3})\s*人$/);
  if (people?.[1]) return Number(people[1]);
  return 0;
}

function durationDaysOfNode(node: ConceptNode): number {
  const s = cleanText(node.statement);
  const m = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (!m?.[1]) return 0;
  return Number(m[1]) || 0;
}

function chooseDurationTotalWinner(
  nodes: ConceptNode[],
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode {
  return nodes
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;

      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;

      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;

      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;

      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;

      const explicitTotalScore =
        (/^总行程时长[:：]/.test(cleanText(b.statement)) ? 1 : 0) -
        (/^总行程时长[:：]/.test(cleanText(a.statement)) ? 1 : 0);
      if (explicitTotalScore !== 0) return explicitTotalScore;

      const daysDiff = durationDaysOfNode(b) - durationDaysOfNode(a);
      if (daysDiff !== 0) return daysDiff;

      return cleanText(b.id).localeCompare(cleanText(a.id));
    })[0];
}

function chooseSlotWinner(
  nodes: ConceptNode[],
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode {
  return nodes
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;

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
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): boolean {
  const slotToNodes = new Map<string, ConceptNode[]>();
  for (const n of nodesById.values()) {
    const slot = slotKeyOfNode(n);
    if (!slot) continue;
    if (!slotToNodes.has(slot)) slotToNodes.set(slot, []);
    slotToNodes.get(slot)!.push(n);
  }

  let changed = false;
  for (const [slot, nodes] of slotToNodes.entries()) {
    if (nodes.length <= 1) continue;
    const winner =
      slotFamily(slot) === "duration_total"
        ? chooseDurationTotalWinner(nodes, touched, touchedOrder)
        : chooseSlotWinner(nodes, touched, touchedOrder);
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

function pruneInvalidStructuredNodes(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>
): boolean {
  let changed = false;
  for (const [nid, node] of nodesById.entries()) {
    const s = cleanText(node.statement);
    if (!s) continue;

    let invalid = false;
    const dest = s.match(/^目的地[:：]\s*(.+)$/);
    if (dest?.[1]) {
      const city = cleanText(dest[1]);
      if (!city || DESTINATION_BAD_TOKEN_RE.test(city) || /^的/.test(city)) invalid = true;
      if (/地区$/.test(city) && city.length <= 4) invalid = true;
      if (/(前|后)$/.test(city)) invalid = true;
    }

    const cityDur = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/);
    if (cityDur?.[1]) {
      const city = cleanText(cityDur[1]);
      if (!city || DESTINATION_BAD_TOKEN_RE.test(city) || /^的/.test(city)) invalid = true;
      if (/地区$/.test(city) && city.length <= 4) invalid = true;
      if (/(前|后)$/.test(city)) invalid = true;
    }

    if (!invalid) continue;
    nodesById.delete(nid);
    changed = true;
    for (const [eid, e] of edgesById.entries()) {
      if (e.from === nid || e.to === nid) edgesById.delete(eid);
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
  const f = slotFamily(slot);
  if (f === "people") return 1;
  if (f === "destination") return 2;
  if (f === "duration_total") return 3;
  if (f === "budget") return 4;
  if (f === "duration_city" || f === "duration_meeting" || f === "meeting_critical") return 5;
  if (f === "lodging") return 6;
  if (f === "scenic_preference") return 7;
  return 99;
}

function rootEdgeTypeForNode(node: ConceptNode, slot: string | null): EdgeType {
  const f = slotFamily(slot);
  if (f === "budget" || f === "duration_total" || f === "health" || f === "meeting_critical") return "constraint";
  if (f === "lodging") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (f === "scenic_preference") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (f === "people" || f === "destination") return "enable";
  if (f === "duration_city" || f === "duration_meeting") return "determine";
  if (node.type === "constraint") return "constraint";
  if (node.type === "question") return "determine";
  return "enable";
}

function chooseRootGoal(
  nodesById: Map<string, ConceptNode>,
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode | null {
  const goals = Array.from(nodesById.values()).filter((n) => n.type === "goal");
  if (!goals.length) return null;
  return goals
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;
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

function buildSyntheticGoalStatement(nodesById: Map<string, ConceptNode>): string {
  const destinations: string[] = [];
  let durationDays: number | null = null;

  for (const n of nodesById.values()) {
    const s = cleanText(n.statement);
    const dm = s.match(/^目的地[:：]\s*(.+)$/);
    if (dm?.[1]) {
      const city = cleanText(dm[1]).slice(0, 20);
      if (city && !destinations.includes(city)) destinations.push(city);
    }
    const tm = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
    if (tm?.[1]) {
      const days = Number(tm[1]);
      if (Number.isFinite(days) && days > 0) durationDays = Math.max(durationDays || 0, days);
    }
  }

  const destinationPhrase = destinations.slice(0, 2).join("和");
  if (destinationPhrase && durationDays) return `意图：去${destinationPhrase}旅游${durationDays}天`;
  if (destinationPhrase) return `意图：去${destinationPhrase}旅游`;
  if (durationDays) return `意图：制定${durationDays}天计划`;
  return "意图：制定任务计划";
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
    const text = cleanText(statement).toLowerCase();
    const direct = candidates.find(({ slot }) => {
      const city = slot.replace(/^slot:destination:/, "");
      return city && text.includes(city);
    });
    if (direct) return direct.node;
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
  const primaryNodes = Array.from(slotNodes.entries())
    .filter(([slot]) => isPrimarySlot(slot))
    .sort((a, b) => slotPriorityScore(a[0]) - slotPriorityScore(b[0]))
    .map(([, node]) => node);
  const secondarySlotEntries = Array.from(slotNodes.entries()).filter(
    ([slot]) => slot !== "slot:goal" && slot !== "slot:health" && !isPrimarySlot(slot)
  );

  for (const node of primaryNodes) {
    const slot = slotByNodeId.get(node.id) || null;
    putEdge(node.id, rootId, rootEdgeTypeForNode(node, slot), Math.max(0.72, (Number(node.confidence) || 0.6) * 0.9));
  }

  for (const [slot, node] of secondarySlotEntries) {
    let anchorId = rootId;
    if (slot === "slot:lodging" && slotNodes.get("slot:budget")) anchorId = slotNodes.get("slot:budget")!.id;
    if (slotFamily(slot) === "scenic_preference") {
      const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
      if (bestDestination) anchorId = bestDestination.id;
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
      const meetingDuration = slotNodes.get("slot:duration_meeting");
      if (meetingDuration) anchorId = meetingDuration.id;
      else {
        const bestDestination = pickBestSlotNode(slotNodes, "destination", node.statement);
        if (bestDestination) anchorId = bestDestination.id;
      }
    }
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
  const compactChanged = compactSingletonSlots(nodesById, edgesById, touchedNodeIds, touchedNodeOrder);
  const topologyChanged = rebalanceIntentTopology(nodesById, edgesById, touchedNodeIds, touchedNodeOrder);

  // ✅ 只有真正应用了 op 才 bump 版本（更符合“版本=结构变化”）
  const versionInc = appliedOps.length > 0 || pruneChanged || compactChanged || topologyChanged ? 1 : 0;

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
