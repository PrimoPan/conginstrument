// src/services/graphUpdater.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG, GraphPatch, Severity, Strength } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph]", ...args);
}

const PATCH_START = "<<<PATCH_JSON>>>";
const PATCH_END = "<<<END_PATCH_JSON>>>";

// 你可以给建图单独指定模型（更稳/更便宜都行）
const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;

const RISK_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;
const HARD_CONSTRAINT_RE = /不能|不宜|避免|禁忌|必须|只能|不要|不可|不得|无法|不方便|不能够/i;

function cleanStatement(s: any, maxLen = 180) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(用户任务|任务|用户补充)[:：]\s*/i, "")
    .trim()
    .slice(0, maxLen);
}

function inferRiskMeta(statement: string): { severity: Severity; importance: number; tags: string[] } | null {
  const s = cleanStatement(statement, 300);
  if (!s) return null;
  if (!RISK_HEALTH_RE.test(s)) return null;

  const critical = /心脏|冠心|心血管|急救|cardiac|heart/i.test(s);
  return {
    severity: critical ? "critical" : "high",
    importance: 0.9,
    tags: ["health"],
  };
}

function inferFallbackNodeType(userText: string): "constraint" | "fact" {
  const s = cleanStatement(userText, 300);
  if (HARD_CONSTRAINT_RE.test(s) || RISK_HEALTH_RE.test(s)) return "constraint";
  return "fact";
}

function mergeTags(a?: string[], b?: string[]) {
  const set = new Set<string>([...(a || []), ...(b || [])].map((x) => String(x).trim()).filter(Boolean));
  return set.size ? Array.from(set).slice(0, 8) : undefined;
}

function mergeEvidence(a?: string[], b?: string[]) {
  const set = new Set<string>([...(a || []), ...(b || [])].map((x) => cleanStatement(x, 60)).filter(Boolean));
  return set.size ? Array.from(set).slice(0, 6) : undefined;
}

function inferEvidenceFromStatement(userText: string, statement: string): string[] | undefined {
  const t = String(userText || "");
  const s = cleanStatement(statement, 120);
  if (!t || !s) return undefined;

  const colonIdx = s.indexOf("：");
  if (colonIdx > 0) {
    const rhs = cleanStatement(s.slice(colonIdx + 1), 40);
    if (rhs && t.includes(rhs)) return [rhs];
  }

  const words = s
    .split(/[，。,；;、\s]/)
    .map((x) => cleanStatement(x, 24))
    .filter((x) => x.length >= 2);

  const hit = words.find((w) => t.includes(w));
  if (hit) return [hit];

  if (t.includes(s)) return [s];
  return undefined;
}

function mergeTextSegments(parts: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join("\n");
}

function pickBudgetFromText(text: string): { value: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;

  const wanPatterns = [
    /(?:总预算|预算|经费|花费|费用)(?:大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]+(?:\.[0-9]+)?)\s*万/i,
    /([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?\s*(?:预算|经费|花费|费用)?/i,
  ];
  for (const re of wanPatterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const n = Number(m[1]);
    const value = Math.round(n * 10000);
    if (!Number.isFinite(value) || value <= 0) continue;
    return {
      value,
      evidence: cleanStatement(m[0] || `${m[1]}万`, 40),
    };
  }

  const yuanPatterns = [
    /(?:总预算|预算|经费|花费|费用)(?:大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]{3,9})(?:\s*[-~到至]\s*[0-9]{3,9})?\s*(?:元|块|人民币)?/i,
    /([0-9]{3,9})\s*(?:元|块|人民币)\s*(?:预算|总预算|经费|花费|费用)?/i,
  ];
  for (const re of yuanPatterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return {
      value,
      evidence: cleanStatement(m[0] || `${m[1]}元`, 40),
    };
  }

  return null;
}

function enrichNodeRisk(node: any) {
  if (!node || typeof node !== "object") return node;

  const statement = cleanStatement(node.statement);
  if (!statement) return node;

  const out: any = { ...node, statement };
  const risk = inferRiskMeta(statement);

  if (risk) {
    out.severity = out.severity || risk.severity;
    out.importance = out.importance != null ? Math.max(Number(out.importance) || 0, risk.importance) : risk.importance;
    out.tags = mergeTags(out.tags, risk.tags);
  }

  if (out.type === "constraint" && HARD_CONSTRAINT_RE.test(statement) && !out.strength) {
    out.strength = "hard";
  }

  return out;
}

function enrichPatchRiskAndText(patch: GraphPatch, latestUserText: string): GraphPatch {
  const ops = (patch.ops || []).map((op: any) => {
    if (op?.op === "add_node" && op.node) {
      const node = enrichNodeRisk(op.node);
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, node?.statement || "");
      return {
        ...op,
        node: {
          ...node,
          evidenceIds: mergeEvidence(node?.evidenceIds, inferredEvidence),
          sourceMsgIds: mergeEvidence(node?.sourceMsgIds, ["latest_user"]),
        },
      };
    }
    if (op?.op === "update_node" && op.patch && typeof op.patch === "object") {
      const p = { ...op.patch };
      if (typeof p.statement === "string") p.statement = cleanStatement(p.statement);
      const risk = inferRiskMeta(p.statement);
      if (risk) {
        p.severity = p.severity || risk.severity;
        p.importance = p.importance != null ? Math.max(Number(p.importance) || 0, risk.importance) : risk.importance;
        p.tags = mergeTags(p.tags, risk.tags);
      }
      if (p.statement && HARD_CONSTRAINT_RE.test(p.statement) && !p.strength) p.strength = "hard";
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, p.statement || "");
      p.evidenceIds = mergeEvidence(p.evidenceIds, inferredEvidence);
      p.sourceMsgIds = mergeEvidence(p.sourceMsgIds, ["latest_user"]);
      return { ...op, patch: p };
    }
    return op;
  });

  return { ...patch, ops };
}

function parseCnInt(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);

  const map: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }

  if (map[s] != null) return map[s];
  return null;
}

function normalizeDestination(raw: string): string {
  let s = cleanStatement(raw, 24);
  s = s.replace(/省/g, "").replace(/市/g, "");
  s = s.replace(/^(江苏|浙江|广东|山东|四川|云南|福建|安徽|江西|河北|河南|湖北|湖南|广西|海南|黑龙江|吉林|辽宁|山西|陕西|甘肃|青海|贵州|内蒙古|宁夏|新疆|西藏|北京|上海|天津|重庆)/, "$1");
  s = s.replace(/(旅游|旅行|游玩|出行|度假)$/i, "");
  s = s.trim();
  return s;
}

function isLikelyDestinationCandidate(x: string): boolean {
  const s = normalizeDestination(x);
  if (!s) return false;
  if (s.length < 2 || s.length > 10) return false;
  if (/心脏|母亲|父亲|家人|预算|人数|行程|计划|注意|高强度|旅行时|旅游时|需要|限制|不能|安排/i.test(s)) {
    return false;
  }
  return true;
}

function isHealthConstraintNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (String(node.type || "") !== "constraint") return false;
  return RISK_HEALTH_RE.test(String(node.statement || ""));
}

function scoreHealthNode(node: any): number {
  if (!isHealthConstraintNode(node)) return -1;
  const s = cleanStatement(node?.statement || "", 120);
  let score = Number(node?.confidence) || 0;
  if (/^健康约束[:：]/.test(s)) score += 4;
  if (String(node?.severity || "") === "critical") score += 2;
  if (node?.locked) score += 1;
  if (String(node?.strength || "") === "hard") score += 1;
  return score;
}

function isValidDestinationStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^目的地[:：]\s*(.+)$/);
  if (!m?.[1]) return true;
  return isLikelyDestinationCandidate(m[1]);
}

function isValidPeopleStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^同行人数[:：]\s*([0-9]+)\s*人?$/);
  return !statement.startsWith("同行人数") || !!m;
}

function isValidBudgetStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
  return !/预算/.test(statement) || !!m;
}

function isValidAtomicNode(node: any): boolean {
  const s = cleanStatement(node?.statement || "");
  if (!s) return false;
  if (!isValidDestinationStatement(s)) return false;
  if (!isValidPeopleStatement(s)) return false;
  if (!isValidBudgetStatement(s)) return false;
  return true;
}

type IntentSignals = {
  peopleCount?: number;
  peopleEvidence?: string;
  destination?: string;
  destinationEvidence?: string;
  durationDays?: number;
  durationEvidence?: string;
  durationUnknown?: boolean;
  durationUnknownEvidence?: string;
  budgetCny?: number;
  budgetEvidence?: string;
  healthConstraint?: string;
  healthEvidence?: string;
};

function isTravelIntentText(text: string, signals: IntentSignals) {
  if (signals.destination || signals.durationDays || signals.budgetCny || signals.peopleCount) return true;
  return /旅游|旅行|出行|行程|景点|酒店|攻略|目的地|去|玩/i.test(String(text || ""));
}

function buildTravelIntentStatement(signals: IntentSignals, userText: string): string | null {
  if (!isTravelIntentText(userText, signals)) return null;

  if (signals.destination && signals.durationDays) {
    return `意图：去${signals.destination}旅游${signals.durationDays}天`;
  }
  if (signals.destination) {
    return `意图：去${signals.destination}旅游`;
  }
  if (signals.durationDays) {
    return `意图：制定${signals.durationDays}天旅行计划`;
  }
  return "意图：制定旅行计划";
}

function shouldNormalizeGoalStatement(statement: string, signals: IntentSignals, userText: string) {
  const s = cleanStatement(statement, 240);
  const tooLong = s.length >= 26;
  const mixed = /预算|一家|同行|元|天|计划|制定|一起|人|心脏|健康|限制/i.test(s);
  return isTravelIntentText(userText, signals) && (tooLong || mixed);
}

function pickHealthClause(userText: string): string | undefined {
  const parts = String(userText)
    .split(/[。！？!?；;\n]/)
    .map((x) => cleanStatement(x, 60))
    .filter(Boolean);
  const hit = parts.find((x) => RISK_HEALTH_RE.test(x));
  return hit || undefined;
}

function extractIntentSignals(userText: string): IntentSignals {
  const text = String(userText || "");
  const out: IntentSignals = {};

  const peopleM =
    text.match(/(?:一家|全家|我们|同行)[^\d一二三四五六七八九十两]{0,4}([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)/) ||
    text.match(/([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)(?:同行|一起|出游|旅游|出行)?/);
  if (peopleM?.[1]) {
    const n = parseCnInt(peopleM[1]);
    if (n && n > 0 && n < 30) {
      out.peopleCount = n;
      out.peopleEvidence = cleanStatement(peopleM[0] || peopleM[1], 40);
    }
  }

  const destM =
    text.match(/(?:去|到|在)\s*([^\s，。,；;！!？?\d]{2,16}?)(?:玩|旅游|旅行|度假|出行|住|待|逛|，|。|,|$)/) ||
    text.match(/目的地(?:是|为)?\s*([^\s，。,；;！!？?\d]{2,16})/);
  if (destM?.[1]) {
    const d = normalizeDestination(destM[1]);
    if (d && isLikelyDestinationCandidate(d)) {
      out.destination = d;
      out.destinationEvidence = cleanStatement(destM[1], 32);
    }
  }

  const daysM = text.match(/([0-9一二三四五六七八九十两]{1,3})\s*天/);
  if (daysM?.[1]) {
    const d = parseCnInt(daysM[1]);
    if (d && d > 0 && d <= 60) {
      out.durationDays = d;
      out.durationEvidence = cleanStatement(daysM[0] || daysM[1], 24);
    }
  }
  if (!out.durationDays) {
    const weekM = text.match(/([0-9一二三四五六七八九十两]{1,3})\s*(?:周|星期)/);
    if (weekM?.[1]) {
      const w = parseCnInt(weekM[1]);
      if (w && w > 0 && w <= 8) {
        out.durationDays = w * 7;
        out.durationEvidence = cleanStatement(weekM[0] || weekM[1], 24);
      }
    }
  }
  if (!out.durationDays && /几天|多少天|天数待定|时长待定/i.test(text)) {
    out.durationUnknown = true;
    const du = text.match(/几天|多少天|天数待定|时长待定/i);
    out.durationUnknownEvidence = du?.[0] || "时长待确认";
  }

  const budget = pickBudgetFromText(text);
  if (budget) {
    out.budgetCny = budget.value;
    out.budgetEvidence = budget.evidence;
  }

  const healthClause = pickHealthClause(text);
  if (healthClause) {
    out.healthConstraint = healthClause;
    out.healthEvidence = healthClause;
  }

  return out;
}

function buildHeuristicIntentOps(
  graph: CDG,
  signalText: string,
  latestUserText: string,
  knownStmt: Set<string>,
  seedOps: GraphPatch["ops"]
): GraphPatch["ops"] {
  const ops: GraphPatch["ops"] = [];
  const signals = extractIntentSignals(signalText);
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);

  const edgePairs = new Set<string>();
  for (const e of graph.edges || []) {
    edgePairs.add(`${e.from}|${e.to}|${e.type}`);
  }

  let rootId: string | null = pickRootGoalId(graph);
  const layer2Set = new Set<string>();
  if (rootId) {
    for (const e of graph.edges || []) {
      if (e?.to === rootId && (e.type === "enable" || e.type === "constraint" || e.type === "determine")) {
        layer2Set.add(e.from);
      }
    }
  }

  const pushNode = (node: any): string | null => {
    const statement = cleanStatement(node.statement);
    if (!statement) return null;
    const key = normalizeForMatch(statement);
    if (!key || knownStmt.has(key)) return null;
    knownStmt.add(key);
    const id = makeTempId("n");
    const evidenceIds = mergeEvidence(
      node.evidenceIds,
      inferEvidenceFromStatement(latestUserText, statement) || inferEvidenceFromStatement(signalText, statement)
    );
    const sourceMsgIds = mergeEvidence(node.sourceMsgIds, ["latest_user"]);
    ops.push({
      op: "add_node",
      node: { ...node, id, statement, evidenceIds, sourceMsgIds },
    });
    return id;
  };

  const pushEdge = (from: string, to: string, type: "enable" | "constraint" | "determine") => {
    const k = `${from}|${to}|${type}`;
    if (edgePairs.has(k)) return;
    edgePairs.add(k);
    ops.push({
      op: "add_edge",
      edge: {
        id: makeTempId("e"),
        from,
        to,
        type,
        confidence: 0.75,
      },
    });
  };

  // 无 root 且出现可识别目标信号时，先补一个目标节点。
  if (!rootId && canonicalIntent) {
    rootId = pushNode({
      type: "goal",
      statement: canonicalIntent,
      status: "proposed",
      confidence: 0.9,
      importance: 0.85,
      evidenceIds: [
        signals.destinationEvidence,
        signals.durationEvidence,
        signals.durationUnknownEvidence,
        signals.budgetEvidence,
        signals.peopleEvidence,
      ].filter(Boolean),
    });
  }
  if (rootId && canonicalIntent) {
    const rootNode = (graph.nodes || []).find((n: any) => n.id === rootId);
    if (rootNode?.statement && shouldNormalizeGoalStatement(rootNode.statement, signals, signalText)) {
      ops.push({
        op: "update_node",
        id: rootId,
        patch: {
          statement: canonicalIntent,
          confidence: Math.max(Number(rootNode.confidence) || 0.6, 0.85),
          importance: Math.max(Number(rootNode.importance) || 0, 0.8),
          evidenceIds: mergeEvidence(
            rootNode.evidenceIds,
            [
              signals.destinationEvidence,
              signals.durationEvidence,
              signals.durationUnknownEvidence,
              signals.budgetEvidence,
              signals.peopleEvidence,
            ].filter(Boolean)
          ),
          sourceMsgIds: mergeEvidence(rootNode.sourceMsgIds, ["latest_user"]),
        },
      } as any);
    }
  }

  if (signals.peopleCount) {
    const id = pushNode({
      type: "fact",
      statement: `同行人数：${signals.peopleCount}人`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.72,
      evidenceIds: [signals.peopleEvidence || `${signals.peopleCount}人`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "enable");
  }

  if (signals.destination) {
    const id = pushNode({
      type: "fact",
      statement: `目的地：${signals.destination}`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.8,
      evidenceIds: [signals.destinationEvidence || signals.destination],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "enable");
  }

  if (signals.durationDays) {
    const id = pushNode({
      type: "constraint",
      statement: `行程时长：${signals.durationDays}天`,
      strength: "hard",
      status: "proposed",
      confidence: 0.88,
      importance: 0.78,
      evidenceIds: [signals.durationEvidence || `${signals.durationDays}天`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }
  if (!signals.durationDays && signals.durationUnknown) {
    const id = pushNode({
      type: "question",
      statement: "行程时长：待确认",
      status: "proposed",
      confidence: 0.78,
      importance: 0.62,
      evidenceIds: [signals.durationUnknownEvidence || "几天"],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "determine");
  }

  if (signals.budgetCny) {
    const id = pushNode({
      type: "constraint",
      statement: `预算上限：${signals.budgetCny}元`,
      strength: "hard",
      status: "proposed",
      confidence: 0.92,
      importance: 0.86,
      evidenceIds: [signals.budgetEvidence || `${signals.budgetCny}元`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }

  let healthId: string | null = null;
  const existingHealth = (graph.nodes || []).find(isHealthConstraintNode);
  const existingHealthInSeed = (seedOps || []).find(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any;
  if (existingHealthInSeed?.node?.id) {
    healthId = existingHealthInSeed.node.id;
  } else if (existingHealth?.id) {
    healthId = existingHealth.id;
  }

  if (signals.healthConstraint) {
    const healthStatement = `健康约束：${signals.healthConstraint}`;
    const healthEvidence = mergeEvidence(
      [signals.healthEvidence || signals.healthConstraint],
      inferEvidenceFromStatement(latestUserText, signals.healthConstraint) ||
        inferEvidenceFromStatement(signalText, signals.healthConstraint)
    );

    if (healthId) {
      ops.push({
        op: "update_node",
        id: healthId,
        patch: {
          statement: healthStatement,
          strength: "hard",
          status: "proposed",
          confidence: 0.95,
          severity: "critical",
          importance: 0.98,
          tags: ["health", "safety"],
          locked: true,
          evidenceIds: healthEvidence,
          sourceMsgIds: ["latest_user"],
        },
      } as any);
    } else {
      const id = pushNode({
        type: "constraint",
        statement: healthStatement,
        strength: "hard",
        status: "proposed",
        confidence: 0.95,
        severity: "critical",
        importance: 0.98,
        tags: ["health", "safety"],
        locked: true,
        evidenceIds: healthEvidence,
      });
      if (id) healthId = id;
    }
  }

  if (healthId && rootId) {
    pushEdge(healthId, rootId, "constraint");
  }
  if (healthId) {
    for (const sid of Array.from(layer2Set)) {
      if (!sid || sid === healthId) continue;
      pushEdge(sid, healthId, "determine");
    }
  }

  if (rootId) {
    for (const n of graph.nodes || []) {
      if (!n?.id || n.id === rootId || n.type === "goal") continue;
      const connected = (graph.edges || []).some((e: any) => e?.from === n.id || e?.to === n.id);
      if (!connected) {
        pushEdge(n.id, rootId, n.type === "constraint" ? "constraint" : "enable");
      }
    }
  }

  return ops;
}

function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^用户任务[:：]\s*/g, "")
    .replace(/^任务[:：]\s*/g, "")
    .replace(/[“”"]/g, "")
    .toLowerCase();
}

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n: any) => n?.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((g: any) => g.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((g: any) => g.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals[0].id;
}

function extractBetween(text: string, start: string, end: string): string | null {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0 || e <= s) return null;
  return text.slice(s + start.length, e).trim();
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function makeTempId(prefix: string) {
  return `t_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function fallbackPatch(graph: CDG, userText: string, reason: string): GraphPatch {
  const root = pickRootGoalId(graph);
  const short = cleanStatement(userText, 140);
  const signals = extractIntentSignals(userText);
  const canonicalIntent = buildTravelIntentStatement(signals, userText);

  if (!root) {
    return {
      ops: [
        {
          op: "add_node",
          node: {
            id: makeTempId("n"),
            type: "goal",
            statement: canonicalIntent || short || "未提供任务",
            status: "proposed",
            confidence: canonicalIntent ? 0.85 : 0.55,
            evidenceIds: [signals.destinationEvidence, signals.durationEvidence, signals.budgetEvidence, signals.peopleEvidence].filter(Boolean),
            sourceMsgIds: ["latest_user"],
          },
        },
      ],
      notes: [`fallback_patch:${reason}`],
    };
  }

  const nid = makeTempId("n");
  const nodeType = inferFallbackNodeType(short);
  const risk = inferRiskMeta(short);
  return {
    ops: [
      {
        op: "add_node",
        node: {
          id: nid,
          type: nodeType,
          statement: short || "未提供补充信息",
          status: "proposed",
          confidence: 0.55,
          strength: (nodeType === "constraint" ? "hard" : undefined) as Strength | undefined,
          severity: risk?.severity,
          importance: risk?.importance,
          tags: risk?.tags,
          evidenceIds: [signals.healthEvidence, signals.budgetEvidence, signals.durationEvidence, signals.destinationEvidence, signals.peopleEvidence].filter(Boolean),
          sourceMsgIds: ["latest_user"],
        },
      },
      {
        op: "add_edge",
        edge: {
          id: makeTempId("e"),
          from: nid,
          to: root,
          type: nodeType === "constraint" ? "constraint" : "enable",
          confidence: 0.55,
        },
      },
    ],
    notes: [`fallback_patch:${reason}`],
  };
}

/** 后处理：去重 + 自动补边 + 限制 op 数量 */
function postProcessPatch(
  graph: CDG,
  patch: GraphPatch,
  latestUserText: string,
  recentTurns?: Array<{ role: "user" | "assistant"; content: string }>
): GraphPatch {
  const signalText = mergeTextSegments([
    ...((recentTurns || [])
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .slice(-6)),
    latestUserText,
  ]);
  const enriched = enrichPatchRiskAndText(patch, latestUserText);
  const signals = extractIntentSignals(signalText);
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);
  const existingByStmt = new Map<string, string>();
  for (const n of graph.nodes || []) {
    const key = normalizeForMatch(n.statement);
    if (key) existingByStmt.set(key, n.id);
  }

  const knownStmt = new Set<string>(existingByStmt.keys());
  for (const op of enriched.ops || []) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = normalizeForMatch(op.node.statement);
      if (key) knownStmt.add(key);
    }
  }

  const heuristicOps = buildHeuristicIntentOps(graph, signalText, latestUserText, knownStmt, enriched.ops || []);
  const mergedOps = [...(enriched.ops || []), ...heuristicOps].map((op: any) => {
    if (
      canonicalIntent &&
      op?.op === "add_node" &&
      op?.node?.type === "goal" &&
      typeof op?.node?.statement === "string" &&
      shouldNormalizeGoalStatement(op.node.statement, signals, signalText)
    ) {
      return {
        ...op,
        node: {
          ...op.node,
          statement: canonicalIntent,
          confidence: Math.max(Number(op.node.confidence) || 0.6, 0.85),
          importance: op.node.importance != null ? Math.max(Number(op.node.importance) || 0, 0.8) : 0.8,
        },
      };
    }
    return op;
  });

  const existingHealthId = (graph.nodes || []).find(isHealthConstraintNode)?.id || null;
  const healthAdds = (mergedOps || []).filter(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any[];
  const keepHealthAddId =
    !existingHealthId && healthAdds.length
      ? [...healthAdds].sort((a, b) => scoreHealthNode(b.node) - scoreHealthNode(a.node))[0]?.node?.id || null
      : null;
  const healthMainId = existingHealthId || keepHealthAddId;
  const idRemap = new Map<string, string>();
  if (healthMainId) {
    for (const op of healthAdds) {
      const sid = String(op?.node?.id || "");
      if (!sid || sid === healthMainId) continue;
      idRemap.set(sid, healthMainId);
    }
  }

  const root = pickRootGoalId(graph);
  const newStmt = new Set<string>();
  const newStmtId = new Map<string, string>();
  const newNodes: Array<{ id: string; type: string }> = [];
  const keptAddIds = new Set<string>();
  const edgePairs = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  const prepped = (mergedOps || []).reduce<any[]>((acc, op: any) => {
    if (op?.op === "add_node" && op?.node) {
      if (!isValidAtomicNode(op.node)) return acc;
      const sid = String(op.node.id || "");
      if (sid && idRemap.has(sid)) return acc;
      acc.push(op);
      return acc;
    }
    if (op?.op === "update_node" && op?.patch && typeof op.patch === "object") {
      const patchObj: any = { ...op.patch };
      if (typeof patchObj.statement === "string") {
        const s = cleanStatement(patchObj.statement);
        if (!isValidDestinationStatement(s) || !isValidPeopleStatement(s) || !isValidBudgetStatement(s)) {
          delete patchObj.statement;
        } else {
          patchObj.statement = s;
        }
      }
      if (!Object.keys(patchObj).length) return acc;
      acc.push({
        ...op,
        id: idRemap.get(String(op.id || "")) || op.id,
        patch: patchObj,
      });
      return acc;
    }
    if (op?.op === "add_edge" && op?.edge) {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) return acc;
      const key = `${from}|${to}|${op.edge.type}`;
      if (edgePairs.has(key)) return acc;
      edgePairs.add(key);
      acc.push({
        ...op,
        edge: { ...op.edge, from, to },
      });
      return acc;
    }
    acc.push(op);
    return acc;
  }, []);

  for (const op of prepped) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = normalizeForMatch(op.node.statement);
      if (!key) continue;
      const existedId = existingByStmt.get(key);
      if (existedId) {
        idRemap.set(op.node.id, existedId);
        continue;
      }
      if (newStmt.has(key)) {
        const mapped = newStmtId.get(key);
        if (mapped) idRemap.set(op.node.id, mapped);
        continue;
      }
      newStmt.add(key);
      newStmtId.set(key, op.node.id);
      keptAddIds.add(op.node.id);
      newNodes.push({ id: op.node.id, type: op.node.type });
      continue;
    }
  }

  const kept: any[] = [];
  const addedEdgeKeys = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  for (const op of prepped) {
    if (op?.op === "add_node") {
      if (keptAddIds.has(op.node.id)) kept.push(op);
      continue;
    }
    if (op?.op === "update_node") {
      const mappedId = idRemap.get(String(op.id || "")) || op.id;
      if (!mappedId) continue;
      kept.push({ ...op, id: mappedId });
      continue;
    }
    if (op?.op === "add_edge") {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) continue;
      const key = `${from}|${to}|${op.edge.type}`;
      if (addedEdgeKeys.has(key)) continue;
      addedEdgeKeys.add(key);
      kept.push({ ...op, edge: { ...op.edge, from, to } });
      continue;
    }
    kept.push(op);
  }

  const rootForEdge =
    root ||
    (kept.find((x: any) => x?.op === "add_node" && x?.node?.type === "goal" && typeof x?.node?.id === "string")
      ?.node?.id as string | undefined) ||
    null;

  if (rootForEdge) {
    const hasEdge = (from: string, to: string) =>
      kept.some((x) => x?.op === "add_edge" && x?.edge?.from === from && x?.edge?.to === to);

    let k = 1;
    for (const n of newNodes) {
      if (!["constraint", "preference", "fact", "belief"].includes(n.type)) continue;
      if (hasEdge(n.id, rootForEdge)) continue;
      kept.push({
        op: "add_edge",
        edge: {
          id: makeTempId(`e_auto${k++}`),
          from: n.id,
          to: rootForEdge,
          type: n.type === "constraint" ? "constraint" : "enable",
          confidence: 0.65,
        },
      });
    }
  }

  return { ops: kept.slice(0, 24), notes: (enriched.notes || []).slice(0, 16) };
}

const GRAPH_SYSTEM_PROMPT = `
你是“用户意图图（CDG）更新器”。你不与用户对话，只输出用于更新图的增量 patch。

输出协议（必须严格遵守）：
<<<PATCH_JSON>>>
{ "ops": [ ... ], "notes": [ ... ] }
<<<END_PATCH_JSON>>>
不要输出任何其他文字，不要 Markdown，不要解释。

规则：
- 默认只使用 add_node / update_node / add_edge 三种操作。
- 禁止 remove_node/remove_edge（除非用户明确要求删除且你非常确定）。
- 节点类型：goal / constraint / preference / belief / fact / question
- constraint 可带 strength: hard|soft
- 若信息包含健康/安全/法律等高风险因素，务必设置 severity（high 或 critical），并可补 tags（如 ["health"]）。
- 若信息表达“不能/必须/禁忌”等限制，优先用 constraint，且 strength 优先 hard。
- statement 保持简洁，不要加“用户补充：/用户任务：”前缀。
- 旅行类请求优先拆分成原子节点：人数、目的地、时长、预算、健康限制，不要把所有信息塞进一个节点。
- 意图（goal）作为根节点，子节点尽量与根节点连通，避免孤立节点。
- 若有健康/安全硬约束，可作为第三层约束节点，第二层关键节点可用 determine 指向它。
- 节点尽量附 evidenceIds（来自用户原句的短片段），用于前端高亮证据文本。
- 边类型：enable / constraint / determine / conflicts_with
- 去重：已有等价节点优先 update_node
- 连边克制：有 root_goal_id 时，constraint/preference/fact/belief 可以连到 root_goal_id
- 每轮 op 建议 1~6 个，少而准。
`.trim();

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const rootGoalId = pickRootGoalId(params.graph);

  const modelInput = {
    root_goal_id: rootGoalId,
    current_graph: params.graph,
    recent_dialogue: params.recentTurns,
    latest_turn: { user: params.userText, assistant: params.assistantText },
  };

  const resp = await openai.chat.completions.create({
    model: GRAPH_MODEL,
    messages: [
      { role: "system", content: GRAPH_SYSTEM_PROMPT },
      ...(params.systemPrompt
        ? [{ role: "system" as const, content: `任务补充（可参考）：\n${String(params.systemPrompt).trim()}` }]
        : []),
      {
        role: "user",
        content:
          `输入如下（JSON）。只输出分隔符包裹的 patch JSON：\n` + JSON.stringify(modelInput),
      },
    ],
    max_tokens: 900,
    temperature: 0.1,
  });

  const raw = String(resp.choices?.[0]?.message?.content ?? "");
  dlog("raw_len=", raw.length, "finish=", resp.choices?.[0]?.finish_reason);

  let basePatch: GraphPatch;
  const jsonText = extractBetween(raw, PATCH_START, PATCH_END);
  if (!jsonText) {
    dlog("missing markers -> fallback");
    basePatch = fallbackPatch(params.graph, params.userText, "missing_markers");
  } else {
    const parsed = safeJsonParse(jsonText);
    if (!parsed) {
      dlog("invalid json -> fallback");
      basePatch = fallbackPatch(params.graph, params.userText, "invalid_json");
    } else {
      // ✅ 核心：严格白名单清洗（默认禁止 remove）
      const strict = sanitizeGraphPatchStrict(parsed);
      if (!strict.ops.length) {
        dlog("empty strict ops -> fallback");
        basePatch = fallbackPatch(params.graph, params.userText, "empty_ops");
      } else {
        basePatch = strict;
      }
    }
  }

  const post = postProcessPatch(params.graph, basePatch, params.userText, params.recentTurns);
  if (!post.ops.length) {
    return fallbackPatch(params.graph, params.userText, "post_empty_ops");
  }

  // 打印 op 概览，定位“为什么图被清空”
  if (DEBUG) {
    const counts: Record<string, number> = {};
    for (const op of post.ops) counts[op.op] = (counts[op.op] || 0) + 1;
    dlog("ops_counts=", counts, "notes=", post.notes);
  }

  return post;
}
