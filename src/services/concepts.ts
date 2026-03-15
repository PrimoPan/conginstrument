import type { CDG, ConceptNode } from "../core/graph.js";
import {
  conceptTypeMigration,
  normalizeConceptType,
  normalizeExtractionStage,
  normalizeValidationStatus,
  type ConceptValidationStatus,
  type ConceptExtractionStage,
} from "../core/graph/schemaAdapters.js";
import { distance as levenshteinDistance } from "fastest-levenshtein";

export type ConceptKind =
  | "belief"
  | "constraint"
  | "preference"
  | "factual_assertion";

export type { ConceptExtractionStage, ConceptValidationStatus };

export const CONCEPT_EXTRACTION_STAGES: ConceptExtractionStage[] = ["identification", "disambiguation"];

export type ConceptFamily =
  | "goal"
  | "destination"
  | "duration_total"
  | "duration_city"
  | "budget"
  | "people"
  | "lodging"
  | "activity_preference"
  | "meeting_critical"
  | "limiting_factor"
  | "scenic_preference"
  | "generic_constraint"
  | "sub_location"
  | "other";

export type ConceptItem = {
  id: string;
  kind: ConceptKind;
  validationStatus: ConceptValidationStatus;
  extractionStage: ConceptExtractionStage;
  polarity: "positive" | "negative";
  scope: string;
  family: ConceptFamily;
  semanticKey: string;
  title: string;
  description: string;
  score: number;
  nodeIds: string[];
  primaryNodeId?: string;
  evidenceTerms: string[];
  sourceMsgIds: string[];
  motifIds?: string[];
  migrationHistory?: string[];
  locked: boolean;
  paused: boolean;
  updatedAt: string;
  posterior?: number;
  entropy?: number;
  alias_group_id?: string;
  support_sources?: string[];
};

function cleanText(input: any, max = 200): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clamp01(v: any, fallback = 0.7): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function isAlgoV3Enabled(): boolean {
  const raw = String(process.env.CI_ALGO_V3 || "").trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x > 18) return 0.99999999;
  if (x < -18) return 0.00000001;
  return 1 / (1 + Math.exp(-x));
}

function binaryEntropy(prob: number): number {
  const p = clamp01(prob, 0.5);
  if (p <= 0 || p >= 1) return 0;
  const h = -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
  return Number.isFinite(h) ? h : 0;
}

function uniq(arr: string[], max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const s = cleanText(x, 120);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function slug(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[省市县区州郡]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 40);
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (const ch of String(input || "")) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableIdFromKey(key: string): string {
  const raw = String(key || "").trim().toLowerCase();
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9_\-:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = stableHash(raw || "other");
  const base = safe.slice(0, 72) || "other";
  return `c_${base}_${hash}`;
}

function statementScore(n: ConceptNode): number {
  const imp = clamp01((n as any).importance, 0.65);
  const conf = clamp01((n as any).confidence, 0.65);
  const statusBoost = n.status === "confirmed" ? 0.04 : 0;
  const lockBoost = n.locked ? 0.03 : 0;
  return clamp01(imp * 0.52 + conf * 0.42 + statusBoost + lockBoost, 0.7);
}

function slotFamily(key: string): ConceptFamily {
  if (!key) return "other";
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:constraint:limiting:")) return "limiting_factor";
  if (key.startsWith("slot:constraint:")) return "generic_constraint";
  if (key.startsWith("slot:sub_location:")) return "sub_location";
  if (key === "slot:goal" || key.startsWith("slot:goal:")) return "goal";
  if (key === "slot:duration" || key === "slot:duration_total" || key.startsWith("slot:duration_total:")) return "duration_total";
  if (
    key === "slot:budget" ||
    key === "slot:budget_spent" ||
    key === "slot:budget_remaining" ||
    key === "slot:budget_pending"
  ) {
    return "budget";
  }
  if (key === "slot:people") return "people";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:health" || key === "slot:language") return "limiting_factor";
  if (key === "slot:scenic_preference" || key.startsWith("slot:scenic_preference:")) return "scenic_preference";
  if (key === "slot:activity_preference" || key.startsWith("slot:activity_preference:")) return "activity_preference";
  return "other";
}

function semanticKeyFromLongTermNode(node: ConceptNode): string {
  const rawKey = cleanText((node as any).key, 180).toLowerCase();
  if (!rawKey.startsWith("lt:")) return "";

  const goal = rawKey.match(/^lt:goal:(fitness|study)$/);
  if (goal?.[1]) return `slot:goal:${goal[1]}`;

  const cadence = rawKey.match(/^lt:(fitness|study):cadence$/);
  if (cadence?.[1]) return `slot:duration_total:${cadence[1]}`;

  const constraint = rawKey.match(/^lt:(fitness|study):constraint:(.+)$/);
  if (constraint?.[2]) return `slot:constraint:limiting:${constraint[1]}:${slug(constraint[2]) || "constraint"}`;

  const adjustment = rawKey.match(/^lt:(fitness|study):adjustment:(.+)$/);
  if (adjustment?.[2]) return `slot:constraint:limiting:${adjustment[1]}:adjustment_${slug(adjustment[2]) || "adjustment"}`;

  const method = rawKey.match(/^lt:(fitness|study):method:(.+)$/);
  if (method?.[2]) return `slot:activity_preference:${method[1]}:${slug(method[2]) || "method"}`;

  const strategy = rawKey.match(/^lt:(fitness|study):strategy:(.+)$/);
  if (strategy?.[2]) return `slot:activity_preference:${strategy[1]}:strategy_${slug(strategy[2]) || "strategy"}`;

  const fallback = rawKey.match(/^lt:(fitness|study):fallback:(.+)$/);
  if (fallback?.[2]) return `slot:activity_preference:${fallback[1]}:fallback_${slug(fallback[2]) || "fallback"}`;

  const transfer = rawKey.match(/^lt:study:transfer:(.+)$/);
  if (transfer?.[1]) return `slot:activity_preference:study:transfer_${slug(transfer[1]) || "transfer"}`;

  return "";
}

function normalizeDestination(raw: string): string {
  return cleanText(raw || "", 80)
    .replace(/[.,，。;；!?！？]+$/g, "")
    .replace(/\s+/g, " ");
}

function normalizeConstraintDetail(raw: string): string {
  const text = cleanText(raw || "", 160).toLowerCase();
  if (!text) return "factor";
  const reduced = text
    .replace(
      /(所以|因此|就是|然后|这个|那个|尽量|需要|必须|最好|希望|我要|我们|我|请|一下|有点|比较|更|特别|都要|都得|that|this|need|must|please|just|really|kind of|sort of|a little|more)/g,
      " "
    )
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = reduced.split(" ").filter(Boolean).slice(0, 8);
  if (!tokens.length) return "factor";
  return slug(tokens.join("_")) || "factor";
}

function inferLimitingKindFromText(raw: string): string {
  const s = cleanText(raw || "", 180);
  if (/心脏|心肺|慢性病|过敏|糖尿病|哮喘|医疗|病史|health|medical|cardiac|allergy/i.test(s)) return "health";
  if (/英语|语言|翻译|沟通|外语|english|language|translate|communication/i.test(s)) return "language";
  if (/饮食|忌口|清真|素食|过敏原|halal|kosher|vegetarian|vegan|diet/i.test(s)) return "diet";
  if (/宗教|礼拜|祷告|斋月|安息日|religion|prayer|ramadan|sabbath/i.test(s)) return "religion";
  if (/签证|护照|入境|海关|法律|visa|passport|immigration|permit|legal/i.test(s)) return "legal";
  if (/轮椅|无障碍|体力|行动不便|不能久走|mobility|wheelchair|accessibility/i.test(s)) return "mobility";
  if (/治安|安全|安全感|危险|夜间|夜里|夜晚|抢劫|诈骗|security|safety|danger|risk|night/i.test(s)) return "safety";
  if (/转机|换乘|托运|航班|火车|机场|时差|logistics|layover|flight|train/i.test(s)) return "logistics";
  return "other";
}

function semanticFreeformSignature(raw: string): string {
  const text = cleanText(raw, 240).toLowerCase();
  if (!text) return "node";
  const reduced = text
    .replace(
      /(用户|补充|说明|我想|我要|需要|希望|可以|please|need|want|would like|could|should|just|about)/g,
      " "
    )
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chunks = reduced.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,20}/g) || [];
  const uniqChunks = Array.from(new Set(chunks)).slice(0, 10);
  return slug(uniqChunks.join("_")) || "node";
}

function parseSemanticKeyFromStatement(node: ConceptNode): string {
  const s = cleanText(node.statement || "", 180);
  if (!s) return "";
  if (!cleanText((node as any).key, 180).toLowerCase().startsWith("lt:") && ((node as any).layer === "intent" || /^intent[:：]/i.test(s) || /^意图[:：]/.test(s))) return "slot:goal";

  let m = s.match(/^(?:目的地|destination)[:：]\s*(.+)$/i);
  if (m?.[1]) return `slot:destination:${slug(normalizeDestination(m[1])) || "unknown"}`;

  m = s.match(/^(?:城市时长|停留时长|city duration|stay duration)[:：]\s*(.+?)\s+[0-9]{1,3}\s*(?:天|days?)$/i);
  if (m?.[1]) return `slot:duration_city:${slug(normalizeDestination(m[1])) || "unknown"}`;

  if (/^(?:总行程时长|总时长|trip length|total duration)[:：]\s*[0-9]{1,3}\s*(?:天|days?)$/i.test(s))
    return "slot:duration_total";
  if (/^(?:预算(?:上限)?|budget(?: cap| limit)?)[:：]/i.test(s)) return "slot:budget";
  if (/^(?:已花预算|spent budget)[:：]/i.test(s)) return "slot:budget_spent";
  if (/^(?:剩余预算|可用预算|remaining budget|available budget)[:：]/i.test(s)) return "slot:budget_remaining";
  if (/^(?:待确认预算|待确认支出|pending budget|pending expense)[:：]/i.test(s)) return "slot:budget_pending";
  if (/^(?:同行人数|人数|party size)[:：]/i.test(s)) return "slot:people";
  if (/^(?:住宿偏好|酒店偏好|住宿标准|酒店标准|lodging preference|hotel preference|lodging standard|hotel standard)[:：]/i.test(s))
    return "slot:lodging";
  if (/^(?:景点偏好|scenic preference)[:：]/i.test(s)) return "slot:scenic_preference";
  if (/^(?:活动偏好|activity preference)[:：]/i.test(s)) return "slot:activity_preference";
  if (/^(?:会议关键日|关键会议日|论文汇报日|关键日|critical day|critical meeting day)[:：]/i.test(s)) {
    const x = s.split(/[:：]/)[1] || "critical";
    return `slot:meeting_critical:${slug(x) || "critical"}`;
  }

  if (
    /^(?:限制因素|constraint factor|limiting factor)[:：]/i.test(s) ||
    /心脏|心肺|慢性病|过敏|宗教|饮食|清真|素食|语言|安全|签证|法律|禁忌/i.test(s)
  ) {
    const x = s.split(/[:：]/)[1] || s;
    const kind = inferLimitingKindFromText(x);
    if (kind !== "other") return `slot:constraint:limiting:${kind}`;
    return `slot:constraint:limiting:other:${normalizeConstraintDetail(x)}`;
  }

  return "";
}

function canonicalSlotKey(key: string): string {
  const k = cleanText(key, 180).toLowerCase();
  if (!k.startsWith("slot:")) return "";

  if (k.startsWith("slot:destination:")) {
    return `slot:destination:${slug(k.slice("slot:destination:".length)) || "unknown"}`;
  }
  if (k.startsWith("slot:duration_city:")) {
    return `slot:duration_city:${slug(k.slice("slot:duration_city:".length)) || "unknown"}`;
  }
  if (k.startsWith("slot:meeting_critical:")) {
    return `slot:meeting_critical:${slug(k.slice("slot:meeting_critical:".length)) || "critical"}`;
  }
  if (k.startsWith("slot:sub_location:")) {
    const rest = k.slice("slot:sub_location:".length);
    const parts = rest.split(":");
    const p1 = slug(parts[0] || "root") || "root";
    const p2 = slug(parts.slice(1).join(":") || "loc") || "loc";
    return `slot:sub_location:${p1}:${p2}`;
  }
  if (k.startsWith("slot:constraint:limiting:")) {
    const rest = k.slice("slot:constraint:limiting:".length);
    const parts = rest.split(":");
    const kind = slug(parts[0] || "other") || "other";
    const semanticKinds = new Set([
      "health",
      "language",
      "diet",
      "religion",
      "legal",
      "mobility",
      "safety",
      "logistics",
    ]);
    if (semanticKinds.has(kind)) return `slot:constraint:limiting:${kind}`;
    const detail = normalizeConstraintDetail(parts.slice(1).join(":") || "factor");
    return `slot:constraint:limiting:${kind}:${detail}`;
  }
  if (k.startsWith("slot:constraint:")) {
    const rest = k.slice("slot:constraint:".length);
    return `slot:constraint:${slug(rest) || "other"}`;
  }

  if (k === "slot:duration") return "slot:duration_total";
  if (k === "slot:goal") return "slot:goal";
  if (k.startsWith("slot:goal:")) {
    return `slot:goal:${slug(k.slice("slot:goal:".length)) || "goal"}`;
  }
  if (k === "slot:duration_total") return "slot:duration_total";
  if (k.startsWith("slot:duration_total:")) {
    return `slot:duration_total:${slug(k.slice("slot:duration_total:".length)) || "duration"}`;
  }
  if (k === "slot:budget") return "slot:budget";
  if (k === "slot:budget_spent") return "slot:budget_spent";
  if (k === "slot:budget_remaining") return "slot:budget_remaining";
  if (k === "slot:budget_pending") return "slot:budget_pending";
  if (k === "slot:people") return "slot:people";
  if (k === "slot:lodging") return "slot:lodging";
  if (k === "slot:health") return "slot:constraint:limiting:health:health";
  if (k === "slot:language") return "slot:constraint:limiting:language:language";
  if (k === "slot:scenic_preference") return "slot:scenic_preference";
  if (k.startsWith("slot:scenic_preference:")) {
    return `slot:scenic_preference:${slug(k.slice("slot:scenic_preference:".length)) || "preference"}`;
  }
  if (k === "slot:activity_preference") return "slot:activity_preference";
  if (k.startsWith("slot:activity_preference:")) {
    return `slot:activity_preference:${slug(k.slice("slot:activity_preference:".length)) || "preference"}`;
  }

  return k;
}

export function semanticKeyForNode(n: ConceptNode): string {
  const key = canonicalSlotKey(cleanText((n as any).key, 180));
  if (key) return key;
  const longTermKey = canonicalSlotKey(semanticKeyFromLongTermNode(n));
  if (longTermKey) return longTermKey;
  const parsed = canonicalSlotKey(parseSemanticKeyFromStatement(n));
  if (parsed) return parsed;

  const type = normalizeConceptType(cleanText((n as any).type, 20), "factual_assertion");
  const signature = semanticFreeformSignature(cleanText(n.statement, 140) || cleanText(n.id, 40) || "node");
  return `slot:freeform:${type}:${signature || "node"}`;
}

export function semanticFamilyFromKey(key: string): ConceptFamily {
  return slotFamily(canonicalSlotKey(key));
}

export function stableConceptIdFromSemanticKey(semanticKey: string): string {
  return stableIdFromKey(`semantic:${canonicalSlotKey(semanticKey) || semanticKey || "other"}`);
}

function conceptKindForNode(n: ConceptNode, family: ConceptFamily): ConceptKind {
  const type = normalizeConceptType((n as any)?.type, "factual_assertion");
  const statement = cleanText(n.statement, 180);
  if (type === "preference" || (n as any).layer === "preference") return "preference";
  if (type === "belief" || (n as any).layer === "intent") return "belief";
  if (
    type === "constraint" ||
    family === "limiting_factor" ||
    family === "generic_constraint" ||
    family === "meeting_critical" ||
    /\b(must|cannot|forbidden|hard constraint|risk|critical)\b/i.test(statement) ||
    /必须|不能|禁止|硬约束|风险|危险|关键日|禁忌/.test(statement)
  ) {
    return "constraint";
  }
  if (family === "scenic_preference" || family === "activity_preference" || family === "lodging") return "preference";
  return "factual_assertion";
}

function keywordTerms(input: string): string[] {
  const text = cleanText(input, 200);
  if (!text) return [];
  const cn = text.match(/[\u4e00-\u9fa5]{2,12}/g) || [];
  const en = text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,24}/g) || [];
  return uniq([...cn, ...en], 10);
}

function shouldKeepNode(n: ConceptNode): boolean {
  if (!n || !cleanText(n.statement, 4)) return false;
  if (n.status === "rejected" && !n.locked && clamp01((n as any).importance, 0.25) < 0.4) return false;
  return true;
}

function rankKind(kind: ConceptKind): number {
  if (kind === "constraint") return 0;
  if (kind === "belief") return 1;
  if (kind === "preference") return 2;
  return 3;
}

function readNodePaused(n: ConceptNode): boolean {
  const paused = (n as any)?.value?.conceptState?.paused;
  return paused === true;
}

function conceptTitleFromNode(n: ConceptNode): string {
  const s = cleanText(n.statement, 80);
  if (s) return s;
  return `${normalizeConceptType((n as any)?.type, "factual_assertion")}:${cleanText(n.id, 24)}`;
}

function conceptDescriptionFromNode(n: ConceptNode, kind: ConceptKind): string {
  const meta: string[] = [];
  if (kind) meta.push(kind);
  if (n.layer) meta.push(n.layer);
  if (n.strength) meta.push(n.strength);
  const confidence = clamp01((n as any).confidence, 0.65);
  const label = meta.length ? `${meta.join(" · ")} · c=${confidence.toFixed(2)}` : `c=${confidence.toFixed(2)}`;
  return cleanText(label, 120);
}

function normalizeConceptKind(raw: string, fallback: ConceptKind): {
  kind: ConceptKind;
  validationStatus?: ConceptValidationStatus;
  migrationNote?: string;
} {
  const k = cleanText(raw, 40).toLowerCase();
  if (k === "intent") {
    return { kind: "belief", migrationNote: "legacy_intent_migrated_to_belief" };
  }
  if (k === "requirement" || k === "risk") {
    return { kind: "constraint", migrationNote: `legacy_${k}_migrated_to_constraint` };
  }

  const migrated = conceptTypeMigration(k || fallback);
  return {
    kind: migrated.type,
    validationStatus: migrated.validationStatus,
    migrationNote: migrated.note,
  };
}

function conceptPolarityFromNode(n: ConceptNode): "positive" | "negative" {
  const statement = cleanText(n.statement, 220);
  const hasChineseNegative = /(不|不能|不要|禁止|避免|别|勿|无须|不必|不建议)/.test(statement);
  const hasEnglishNegative = /\b(must not|cannot|can't|do not|don't|avoid|never|no need to|shouldn't|should not)\b/i.test(
    statement
  );
  return hasChineseNegative || hasEnglishNegative ? "negative" : "positive";
}

function conceptScopeFromNode(n: ConceptNode): string {
  const rawScope =
    cleanText((n as any)?.value?.scope, 64) ||
    cleanText((n as any)?.scope, 64) ||
    cleanText((n as any)?.value?.context, 64);
  if (rawScope) return rawScope.toLowerCase();
  const slot = semanticKeyForNode(n);
  if (slot.startsWith("slot:duration_city:")) return "city";
  if (slot.startsWith("slot:destination:")) return "destination";
  if (slot.startsWith("slot:constraint:")) return "constraint";
  return "global";
}

function conceptValidationStatusFromNode(n: ConceptNode): ConceptValidationStatus {
  const fromMeta = normalizeValidationStatus(
    (n as any)?.validation_status || (n as any)?.value?.validation_status || (n as any)?.value?.conceptState?.validation_status,
    "unasked"
  );
  if (fromMeta !== "unasked") return fromMeta;
  const statement = cleanText(n.statement, 200);
  if (/[?？]$/.test(statement) || /^待确认[:：]/.test(statement)) return "pending";
  return "unasked";
}

function dedupBucketKey(params: {
  semanticKey: string;
  kind: ConceptKind;
  polarity: "positive" | "negative";
  scope: string;
}): string {
  return `${params.semanticKey}|${params.kind}|${params.polarity}|${params.scope || "global"}`;
}

function betterNode(a: ConceptNode, b: ConceptNode): ConceptNode {
  const aLocked = a.locked ? 1 : 0;
  const bLocked = b.locked ? 1 : 0;
  if (aLocked !== bLocked) return aLocked > bLocked ? a : b;

  const aConfirmed = a.status === "confirmed" ? 1 : 0;
  const bConfirmed = b.status === "confirmed" ? 1 : 0;
  if (aConfirmed !== bConfirmed) return aConfirmed > bConfirmed ? a : b;

  const sa = statementScore(a);
  const sb = statementScore(b);
  if (sa !== sb) return sa > sb ? a : b;

  return cleanText(a.id, 64) <= cleanText(b.id, 64) ? a : b;
}

function sortNodeIds(nodeIds: string[], primaryNodeId?: string): string[] {
  const uniqIds = uniq(nodeIds, 160);
  if (!primaryNodeId) return uniqIds;
  const rest = uniqIds.filter((id) => id !== primaryNodeId);
  if (!uniqIds.includes(primaryNodeId)) return uniqIds;
  return [primaryNodeId, ...rest];
}

function normalizeSimilarityText(input: string): string {
  return cleanText(input, 260)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function similarityTokens(input: string): Set<string> {
  const text = cleanText(input, 320).toLowerCase();
  const chunks = text.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || [];
  return new Set(chunks.filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  if (!union) return 0;
  return inter / union;
}

function normalizedLevenshtein(a: string, b: string): number {
  const left = normalizeSimilarityText(a);
  const right = normalizeSimilarityText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const dist = levenshteinDistance(left, right);
  const denom = Math.max(left.length, right.length, 1);
  return clamp01(1 - dist / denom, 0);
}

function conceptPriorityScore(c: ConceptItem): number {
  const nonFreeformBoost = c.semanticKey.startsWith("slot:freeform:") ? 0 : 0.04;
  const lockBoost = c.locked ? 0.08 : 0;
  const nodeBoost = Math.min((c.nodeIds || []).length, 8) * 0.004;
  return c.score + nonFreeformBoost + lockBoost + nodeBoost;
}

function sourceRoleFromToken(raw: string): "user" | "assistant" | "function_call" | "system" | "unknown" {
  const token = cleanText(raw, 80).toLowerCase();
  if (!token) return "unknown";
  if (
    token.includes("function") ||
    token.includes("tool") ||
    token.includes("slot_call") ||
    token.includes("slot_function") ||
    token.startsWith("fn_")
  ) {
    return "function_call";
  }
  if (
    token.includes("latest_user") ||
    token.includes("user") ||
    token.startsWith("u_") ||
    token.startsWith("msg_u") ||
    token.startsWith("turn_u") ||
    token.startsWith("turn_") ||
    token.startsWith("manual_")
  ) {
    return "user";
  }
  if (
    token.includes("assistant") ||
    token.includes("latest_assistant") ||
    token.startsWith("a_") ||
    token.startsWith("msg_a")
  ) {
    return "assistant";
  }
  if (token.includes("system") || token.startsWith("sys_")) return "system";
  return "unknown";
}

function supportSourcesFromMsgIds(sourceMsgIds: string[]): string[] {
  const out = new Set<string>();
  for (const token of sourceMsgIds || []) {
    out.add(sourceRoleFromToken(token));
  }
  return Array.from(out).sort();
}

function hasOnlyAssistantSource(sourceMsgIds: string[]): boolean {
  const roles = supportSourcesFromMsgIds(sourceMsgIds);
  if (!roles.length) return false;
  return roles.every((x) => x === "assistant" || x === "unknown");
}

function hasFunctionSignal(node: ConceptNode): boolean {
  const key = cleanText((node as any)?.key, 180).toLowerCase();
  const valueText = cleanText(JSON.stringify((node as any)?.value || {}), 220).toLowerCase();
  const src = Array.isArray((node as any)?.sourceMsgIds) ? ((node as any).sourceMsgIds as string[]) : [];
  if (src.some((x) => sourceRoleFromToken(x) === "function_call")) return true;
  return (
    key.includes("slot:") &&
    (valueText.includes("function") || valueText.includes("tool") || valueText.includes("slot"))
  );
}

function lexicalSpecificityScore(parts: string[]): number {
  const text = cleanText(parts.join(" "), 320);
  if (!text) return 0.35;
  const tokens = text.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || [];
  const uniqTokens = new Set(tokens.map((x) => cleanText(x, 24).toLowerCase()).filter(Boolean));
  const numericBoost = /[0-9]/.test(text) ? 0.08 : 0;
  const contentRatio = Math.min(1, uniqTokens.size / Math.max(6, tokens.length || 1));
  return clamp01(0.34 + contentRatio * 0.56 + numericBoost, 0.5);
}

function statementTokens(text: string): Set<string> {
  const chunks = cleanText(text, 320).toLowerCase().match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || [];
  return new Set(chunks.filter(Boolean));
}

function jaccardSet(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter += 1;
  }
  const union = a.size + b.size - inter;
  if (!union) return 0;
  return inter / union;
}

export function historyConsistencyScore(nodes: ConceptNode[]): number {
  const filtered = (nodes || []).filter((n) => cleanText(n?.statement, 6));
  if (filtered.length <= 1) return 0.68;
  const sets = filtered.map((n) => statementTokens(cleanText(n.statement, 200)));
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      sum += jaccardSet(sets[i], sets[j]);
      cnt += 1;
    }
  }
  if (!cnt) return 0.68;
  return clamp01(0.36 + (sum / cnt) * 0.64, 0.68);
}

function topologySupportScore(nodeIds: string[], degreeByNode: Map<string, number>): number {
  if (!nodeIds.length) return 0.42;
  const degreeScore =
    nodeIds.reduce((sum, id) => sum + Math.min(1, Number(degreeByNode.get(id) || 0) / 3), 0) /
    Math.max(1, nodeIds.length);
  return clamp01(0.35 + degreeScore * 0.65, 0.52);
}

type ConceptPosteriorFeatures = {
  rule: number;
  functionCall: number;
  historyConsistency: number;
  lexicalSpecificity: number;
  topologySupport: number;
  assistantOnlyPenalty: number;
};

export function computeConceptPosterior(features: ConceptPosteriorFeatures): number {
  const raw =
    0.34 * clamp01(features.rule, 0.6) +
    0.24 * clamp01(features.functionCall, 0.55) +
    0.18 * clamp01(features.historyConsistency, 0.6) +
    0.14 * clamp01(features.lexicalSpecificity, 0.6) +
    0.1 * clamp01(features.topologySupport, 0.55) -
    clamp01(features.assistantOnlyPenalty, 0) -
    0.5;
  return clamp01(sigmoid(raw * 3.4), 0.5);
}

const STRUCTURED_SIMILARITY_MERGE_FAMILIES = new Set<ConceptFamily>([
  "meeting_critical",
  "duration_city",
  "generic_constraint",
  "limiting_factor",
  "activity_preference",
  "scenic_preference",
  "sub_location",
  "other",
]);

function criticalDaySignature(c: ConceptItem): string {
  if (c.family !== "meeting_critical") return "";
  const text = cleanText(`${c.title} ${c.semanticKey}`, 260).toLowerCase();
  const action =
    /离开|返程|回程|departure|leave|return/.test(text)
      ? "leave"
      : /到达|出发|arrive|arrival|depart/.test(text)
      ? "arrive"
      : "";
  const day = text.match(/(\d{1,2})\s*(?:天|day|days)/)?.[1] || "";
  if (!action && !day) return "";
  return `${action}:${day}`;
}

function shouldCollapseHighlySimilarConcept(a: ConceptItem, b: ConceptItem): boolean {
  if (a.id === b.id) return false;
  if (a.kind !== b.kind || a.polarity !== b.polarity) return false;
  if (a.scope !== b.scope || a.family !== b.family) return false;
  if (normalizeSimilarityText(a.semanticKey) === normalizeSimilarityText(b.semanticKey)) return true;

  const freeformA = a.semanticKey.startsWith("slot:freeform:");
  const freeformB = b.semanticKey.startsWith("slot:freeform:");
  const structuredMergeFamily = STRUCTURED_SIMILARITY_MERGE_FAMILIES.has(a.family);
  if (!freeformA && !freeformB && !structuredMergeFamily) return false;

  const criticalA = criticalDaySignature(a);
  const criticalB = criticalDaySignature(b);
  if (criticalA && criticalA === criticalB) return true;

  const titleA = normalizeSimilarityText(a.title);
  const titleB = normalizeSimilarityText(b.title);
  if (!!titleA && titleA === titleB) return true;
  if (!!titleA && !!titleB && (titleA.includes(titleB) || titleB.includes(titleA))) {
    return true;
  }

  const textA = `${a.title} ${a.description} ${(a.evidenceTerms || []).join(" ")}`;
  const textB = `${b.title} ${b.description} ${(b.evidenceTerms || []).join(" ")}`;
  const sim = jaccardSimilarity(similarityTokens(textA), similarityTokens(textB));
  const lev = normalizedLevenshtein(textA, textB);
  const minSim = structuredMergeFamily && !freeformA && !freeformB ? 0.88 : 0.84;
  return sim >= minSim || lev >= 0.9;
}

function mergeConceptPair(a: ConceptItem, b: ConceptItem, now: string): ConceptItem {
  const keepA = conceptPriorityScore(a) >= conceptPriorityScore(b);
  const winner = keepA ? a : b;
  const loser = keepA ? b : a;
  const primaryNodeId = winner.primaryNodeId || loser.primaryNodeId;
  const posterior = Math.max(Number(winner.posterior || winner.score || 0.7), Number(loser.posterior || loser.score || 0.7));
  return {
    ...winner,
    score: clamp01(Math.max(winner.score, loser.score), winner.score),
    posterior: clamp01(posterior, winner.score),
    entropy: binaryEntropy(posterior),
    alias_group_id: cleanText(winner.alias_group_id || loser.alias_group_id || winner.id, 120) || winner.id,
    nodeIds: sortNodeIds([...(winner.nodeIds || []), ...(loser.nodeIds || [])], primaryNodeId),
    primaryNodeId,
    evidenceTerms: uniq([...(winner.evidenceTerms || []), ...(loser.evidenceTerms || [])], 24),
    sourceMsgIds: uniq([...(winner.sourceMsgIds || []), ...(loser.sourceMsgIds || [])], 80),
    support_sources: uniq([...(winner.support_sources || []), ...(loser.support_sources || [])], 6),
    motifIds: uniq([...(winner.motifIds || []), ...(loser.motifIds || [])], 48),
    migrationHistory: uniq(
      [
        ...(winner.migrationHistory || []),
        ...(loser.migrationHistory || []),
        `high_similarity_merged:${loser.id}`,
      ],
      24
    ),
    paused: winner.paused || loser.paused,
    locked: winner.locked || loser.locked,
    updatedAt: now,
  };
}

export function aliasClusterMerge(concepts: ConceptItem[]): ConceptItem[] {
  if (!concepts.length) return concepts;
  const now = new Date().toISOString();
  const grouped = new Map<string, ConceptItem[]>();
  for (const c of concepts) {
    const k = `${c.kind}|${c.polarity}|${c.scope || "global"}|${c.family || "other"}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(c);
  }

  const out: ConceptItem[] = [];
  for (const list of grouped.values()) {
    const bins: ConceptItem[] = [];
    const sorted = list
      .slice()
      .sort((a, b) => conceptPriorityScore(b) - conceptPriorityScore(a) || a.id.localeCompare(b.id));
    for (const cur of sorted) {
      let merged = false;
      for (let i = 0; i < bins.length; i += 1) {
        if (!shouldCollapseHighlySimilarConcept(bins[i], cur)) continue;
        bins[i] = mergeConceptPair(bins[i], cur, now);
        merged = true;
        break;
      }
      if (!merged) bins.push(cur);
    }
    out.push(...bins);
  }

  return out
    .slice()
    .sort(
      (a, b) =>
        rankKind(a.kind) - rankKind(b.kind) ||
        b.score - a.score ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
    );
}

type SemanticNodeBucket = {
  semanticKey: string;
  kind: ConceptKind;
  polarity: "positive" | "negative";
  scope: string;
  nodes: ConceptNode[];
};

function buildSemanticNodeIndex(graph: CDG): Map<string, SemanticNodeBucket> {
  const out = new Map<string, SemanticNodeBucket>();
  for (const n of graph.nodes || []) {
    if (!shouldKeepNode(n)) continue;
    const semanticKey = semanticKeyForNode(n);
    if (!semanticKey) continue;
    const family = semanticFamilyFromKey(semanticKey);
    const kind = conceptKindForNode(n, family);
    const polarity = conceptPolarityFromNode(n);
    const scope = conceptScopeFromNode(n);
    const key = dedupBucketKey({ semanticKey, kind, polarity, scope });
    if (!out.has(key)) {
      out.set(key, {
        semanticKey,
        kind,
        polarity,
        scope,
        nodes: [],
      });
    }
    out.get(key)!.nodes.push(n);
  }
  return out;
}

function primaryNodeOf(nodes: ConceptNode[]): ConceptNode | null {
  if (!nodes.length) return null;
  return nodes.slice(1).reduce((best, n) => betterNode(best, n), nodes[0]);
}

function buildNodeDegreeMap(graph: CDG): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of graph.nodes || []) out.set(n.id, 0);
  for (const e of graph.edges || []) {
    out.set(e.from, (out.get(e.from) || 0) + 1);
    out.set(e.to, (out.get(e.to) || 0) + 1);
  }
  return out;
}

export function deriveConceptsFromGraph(graph: CDG): ConceptItem[] {
  const now = new Date().toISOString();
  const semanticIndex = buildSemanticNodeIndex(graph);
  const degreeByNode = buildNodeDegreeMap(graph);
  const algoV3 = isAlgoV3Enabled();
  const concepts: ConceptItem[] = [];

  for (const bucket of semanticIndex.values()) {
    const semanticKey = bucket.semanticKey;
    const nodes = bucket.nodes;
    const primaryNode = primaryNodeOf(nodes);
    if (!primaryNode) continue;

    const family = semanticFamilyFromKey(semanticKey);
    const kind = bucket.kind;
    const polarity = bucket.polarity;
    const scope = bucket.scope;
    const title = conceptTitleFromNode(primaryNode);
    const description = conceptDescriptionFromNode(primaryNode, kind);

    const nodeIds = sortNodeIds(
      nodes
        .slice()
        .sort((a, b) => statementScore(b) - statementScore(a) || a.id.localeCompare(b.id))
        .map((n) => n.id),
      primaryNode.id
    );

    const allEvidenceTerms = uniq(
      nodes.flatMap((n) => [
        ...keywordTerms(cleanText(n.statement, 180)),
        ...keywordTerms(cleanText(n.claim, 120)),
        ...(n.evidenceIds || []).map((x) => cleanText(x, 40)),
      ]),
      20
    );
    const allSourceMsgIds = uniq(nodes.flatMap((n) => (n.sourceMsgIds || []).map((x) => cleanText(x, 40))), 60);

    const score = clamp01(
      nodes.reduce((sum, n) => sum + statementScore(n), 0) / Math.max(1, nodes.length),
      statementScore(primaryNode)
    );
    const paused = nodes.some((n) => readNodePaused(n));
    const locked = nodes.some((n) => !!n.locked);
    const supportSources = supportSourcesFromMsgIds(allSourceMsgIds);
    const posterior = algoV3
      ? computeConceptPosterior({
          rule: score,
          functionCall: nodes.some((n) => hasFunctionSignal(n)) ? 0.92 : 0.55,
          historyConsistency: historyConsistencyScore(nodes),
          lexicalSpecificity: lexicalSpecificityScore([title, description, ...allEvidenceTerms]),
          topologySupport: topologySupportScore(nodeIds, degreeByNode),
          assistantOnlyPenalty: hasOnlyAssistantSource(allSourceMsgIds) ? 0.2 : 0,
        })
      : score;
    if (algoV3 && !locked && posterior < 0.55) {
      continue;
    }
    const validationStatus: ConceptValidationStatus =
      !algoV3
        ? conceptValidationStatusFromNode(primaryNode)
        : posterior >= 0.72
        ? "resolved"
        : posterior >= 0.55
        ? "pending"
        : conceptValidationStatusFromNode(primaryNode);

    concepts.push({
      id: stableConceptIdFromSemanticKey(`${semanticKey}|${kind}|${polarity}|${scope}`),
      kind,
      validationStatus,
      extractionStage: "disambiguation",
      polarity,
      scope,
      family,
      semanticKey,
      title: cleanText(title, 60) || "Concept",
      description: cleanText(description, 120),
      score,
      nodeIds,
      primaryNodeId: primaryNode.id,
      evidenceTerms: allEvidenceTerms,
      sourceMsgIds: allSourceMsgIds,
      motifIds: [],
      migrationHistory: [],
      locked,
      paused,
      updatedAt: now,
      posterior,
      entropy: binaryEntropy(posterior),
      alias_group_id: stableConceptIdFromSemanticKey(`${semanticKey}|${family}|${scope}|${polarity}`),
      support_sources: supportSources,
    });
  }

  concepts.sort(
    (a, b) =>
      rankKind(a.kind) - rankKind(b.kind) ||
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
  );
  return concepts.slice(0, 180);
}

export function normalizeConceptsForGraph(input: any, graph: CDG): ConceptItem[] {
  const nodesById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const semanticIndex = buildSemanticNodeIndex(graph);
  const semanticToPrimary = new Map<string, string>();
  const semanticToNodeIds = new Map<string, string[]>();
  for (const bucket of semanticIndex.values()) {
    const primaryNode = primaryNodeOf(bucket.nodes);
    if (primaryNode && !semanticToPrimary.has(bucket.semanticKey)) {
      semanticToPrimary.set(bucket.semanticKey, primaryNode.id);
    }
    const merged = uniq([...(semanticToNodeIds.get(bucket.semanticKey) || []), ...bucket.nodes.map((n) => n.id)], 320);
    semanticToNodeIds.set(bucket.semanticKey, merged);
  }

  const arr = Array.isArray(input) ? input : [];
  const out: ConceptItem[] = [];
  const usedConceptIds = new Set<string>();

  for (const raw of arr) {
    const rawNodeIds = Array.isArray((raw as any)?.nodeIds)
      ? (raw as any).nodeIds.map((x: any) => cleanText(x, 64)).filter(Boolean)
      : [];
    const firstValidNodeId = rawNodeIds.find((x) => nodesById.has(x)) || "";
    const semanticFromNode = firstValidNodeId ? semanticKeyForNode(nodesById.get(firstValidNodeId) as ConceptNode) : "";
    const semanticFromRaw = canonicalSlotKey(cleanText((raw as any)?.semanticKey, 180));
    const semanticKey = semanticFromNode || semanticFromRaw;
    if (!semanticKey) continue;

    const inferredPrimaryNodeId = semanticToPrimary.get(semanticKey) || "";
    const rawPrimaryNodeId = cleanText((raw as any)?.primaryNodeId, 64);
    const basePrimaryNodeId = [rawPrimaryNodeId, firstValidNodeId, inferredPrimaryNodeId].find(
      (id) => !!id && nodesById.has(id)
    );
    const primaryNode =
      (basePrimaryNodeId && nodesById.get(basePrimaryNodeId)) ||
      (firstValidNodeId && nodesById.get(firstValidNodeId)) ||
      null;

    const family = semanticFamilyFromKey(semanticKey);
    const inferredKind = primaryNode ? conceptKindForNode(primaryNode, family) : "factual_assertion";
    const normalizedKind = normalizeConceptKind(cleanText((raw as any)?.kind, 32), inferredKind);
    const kind: ConceptKind = normalizedKind.kind;
    const polarity: "positive" | "negative" =
      cleanText((raw as any)?.polarity, 24) === "negative"
        ? "negative"
        : primaryNode
        ? conceptPolarityFromNode(primaryNode)
        : "positive";
    const scope = cleanText((raw as any)?.scope, 64) || (primaryNode ? conceptScopeFromNode(primaryNode) : "global");
    const conceptId = stableConceptIdFromSemanticKey(`${semanticKey}|${kind}|${polarity}|${scope}`);
    if (usedConceptIds.has(conceptId)) continue;
    usedConceptIds.add(conceptId);

    const semanticNodeIds = semanticToNodeIds.get(semanticKey) || [];
    const mergedNodeIds = sortNodeIds(
      [...rawNodeIds.filter((id) => nodesById.has(id)), ...semanticNodeIds],
      basePrimaryNodeId || undefined
    );
    if (!mergedNodeIds.length) continue;
    const finalPrimaryNode =
      (basePrimaryNodeId && nodesById.get(basePrimaryNodeId)) ||
      (mergedNodeIds[0] && nodesById.get(mergedNodeIds[0])) ||
      primaryNode ||
      null;
    const validationStatus = normalizeValidationStatus(
      (raw as any)?.validationStatus ||
        (raw as any)?.validation_status ||
        normalizedKind.validationStatus ||
        (finalPrimaryNode ? conceptValidationStatusFromNode(finalPrimaryNode) : "unasked"),
      "unasked"
    );
    const extractionStage = normalizeExtractionStage(
      (raw as any)?.extractionStage || (raw as any)?.extraction_stage || "disambiguation",
      "disambiguation"
    );
    const migrationHistory = uniq(
      [
        ...(Array.isArray((raw as any)?.migrationHistory) ? (raw as any).migrationHistory : []),
        ...(Array.isArray((raw as any)?.migration_history) ? (raw as any).migration_history : []),
        normalizedKind.migrationNote || "",
      ].map((x: any) => cleanText(x, 120)),
      24
    );

    out.push({
      id: conceptId,
      kind,
      validationStatus,
      extractionStage,
      polarity,
      scope,
      family,
      semanticKey,
      title: cleanText((raw as any)?.title, 60) || (finalPrimaryNode ? conceptTitleFromNode(finalPrimaryNode) : "Concept"),
      description:
        cleanText((raw as any)?.description, 180) ||
        (finalPrimaryNode ? conceptDescriptionFromNode(finalPrimaryNode, kind) : ""),
      score: clamp01((raw as any)?.score, finalPrimaryNode ? statementScore(finalPrimaryNode) : 0.7),
      nodeIds: mergedNodeIds,
      primaryNodeId: mergedNodeIds[0] || undefined,
      evidenceTerms: uniq(
        (Array.isArray((raw as any)?.evidenceTerms) ? (raw as any).evidenceTerms : []).map((x: any) =>
          cleanText(x, 40)
        ),
        20
      ),
      sourceMsgIds: uniq(
        (Array.isArray((raw as any)?.sourceMsgIds) ? (raw as any).sourceMsgIds : []).map((x: any) =>
          cleanText(x, 40)
        ),
        60
      ),
      motifIds: uniq(
        (Array.isArray((raw as any)?.motifIds) ? (raw as any).motifIds : []).map((x: any) => cleanText(x, 64)),
        48
      ),
      migrationHistory,
      locked: !!(raw as any)?.locked,
      paused: !!(raw as any)?.paused,
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
      posterior: clamp01((raw as any)?.posterior, 0.7),
      entropy: clamp01((raw as any)?.entropy, 0.5),
      alias_group_id:
        cleanText((raw as any)?.alias_group_id, 120) ||
        stableConceptIdFromSemanticKey(`${semanticKey}|${family}|${scope}|${polarity}`),
      support_sources: uniq(
        (Array.isArray((raw as any)?.support_sources) ? (raw as any).support_sources : []).map((x: any) =>
          cleanText(x, 24)
        ),
        6
      ),
    });
  }

  return out.slice(0, 180);
}

export function reconcileConceptsWithGraph(params: { graph: CDG; baseConcepts?: any }): ConceptItem[] {
  const derived = deriveConceptsFromGraph(params.graph);
  const existing = normalizeConceptsForGraph(params.baseConcepts, params.graph);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const bySemantic = new Map(existing.map((c) => [c.semanticKey, c]));
  const now = new Date().toISOString();

  const merged = derived.map((d) => {
    const ex = byId.get(d.id) || bySemantic.get(d.semanticKey);
    if (!ex) return d;
    const posterior = clamp01(
      Number(d.posterior == null ? d.score : d.posterior) * 0.72 +
        Number(ex.posterior == null ? ex.score : ex.posterior) * 0.28,
      d.score
    );
    return {
      ...d,
      // Concept semantics come from the current graph; keep control-state from
      // history, but refresh human-readable text whenever graph evidence changes.
      title: d.title,
      description: d.description,
      score: d.score,
      validationStatus: normalizeValidationStatus(ex.validationStatus || d.validationStatus, d.validationStatus),
      extractionStage: normalizeExtractionStage(ex.extractionStage || d.extractionStage, d.extractionStage),
      polarity: ex.polarity || d.polarity,
      scope: ex.scope || d.scope,
      paused: !!ex.paused,
      locked: !!ex.locked,
      nodeIds: d.nodeIds.length ? d.nodeIds : ex.nodeIds,
      primaryNodeId: d.primaryNodeId || ex.primaryNodeId,
      evidenceTerms: uniq([...d.evidenceTerms, ...ex.evidenceTerms], 24),
      sourceMsgIds: uniq([...d.sourceMsgIds, ...ex.sourceMsgIds], 80),
      motifIds: uniq([...(d.motifIds || []), ...(ex.motifIds || [])], 48),
      migrationHistory: uniq([...(d.migrationHistory || []), ...(ex.migrationHistory || [])], 24),
      posterior,
      entropy: binaryEntropy(posterior),
      alias_group_id: cleanText(ex.alias_group_id || d.alias_group_id || d.id, 120) || d.id,
      support_sources: uniq([...(d.support_sources || []), ...(ex.support_sources || [])], 6),
      updatedAt: now,
    };
  });

  return (isAlgoV3Enabled() ? aliasClusterMerge(merged) : merged).slice(0, 180);
}

function setNodeConceptMeta(node: ConceptNode, paused: boolean, validationStatus: ConceptValidationStatus): ConceptNode {
  const baseValue =
    node.value && typeof node.value === "object" && !Array.isArray(node.value)
      ? ({ ...(node.value as Record<string, any>) } as Record<string, any>)
      : {};
  const prevMeta =
    baseValue.conceptState && typeof baseValue.conceptState === "object" && !Array.isArray(baseValue.conceptState)
      ? (baseValue.conceptState as Record<string, any>)
      : {};
  return {
    ...node,
    value: {
      ...baseValue,
      conceptState: {
        ...prevMeta,
        paused,
        validation_status: validationStatus,
      },
    },
    validation_status: validationStatus as any,
  };
}

export function applyConceptStateToGraph(params: {
  graph: CDG;
  prevConcepts?: any;
  nextConcepts: ConceptItem[];
}): CDG {
  const prev = normalizeConceptsForGraph(params.prevConcepts, params.graph);
  const prevLocked = new Set(prev.filter((c) => c.locked).flatMap((c) => c.nodeIds || []));
  const nextLocked = new Set(params.nextConcepts.filter((c) => c.locked).flatMap((c) => c.nodeIds || []));
  const nextPaused = new Set(params.nextConcepts.filter((c) => c.paused).flatMap((c) => c.nodeIds || []));
  const validationByNodeId = new Map<string, ConceptValidationStatus>();
  for (const c of params.nextConcepts || []) {
    for (const nodeId of c.nodeIds || []) {
      const current = validationByNodeId.get(nodeId);
      const next = normalizeValidationStatus(c.validationStatus, "unasked");
      if (current === "pending") continue;
      if (current === "resolved" && next === "unasked") continue;
      validationByNodeId.set(nodeId, next);
    }
  }

  const nodes = (params.graph.nodes || []).map((n) => {
    let locked = !!n.locked;
    if (nextLocked.has(n.id)) locked = true;
    else if (prevLocked.has(n.id) && !nextLocked.has(n.id)) locked = false;
    const validationStatus = validationByNodeId.get(n.id) || conceptValidationStatusFromNode(n);
    const withMeta = setNodeConceptMeta(n, nextPaused.has(n.id), validationStatus);
    return {
      ...withMeta,
      locked,
    };
  });

  return {
    ...params.graph,
    nodes,
  };
}
