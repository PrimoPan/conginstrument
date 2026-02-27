import type { CDG, ConceptNode } from "../core/graph.js";

export type ConceptKind = "belief" | "constraint" | "preference" | "factual_assertion";

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
  | "conflict"
  | "other";

export type ConceptItem = {
  id: string;
  kind: ConceptKind;
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
  locked: boolean;
  paused: boolean;
  updatedAt: string;
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

function stableIdFromKey(key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9_\-:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `c_${safe.slice(0, 90) || "other"}`;
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
  if (key.startsWith("slot:conflict:")) return "conflict";
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:constraint:limiting:")) return "limiting_factor";
  if (key.startsWith("slot:constraint:")) return "generic_constraint";
  if (key.startsWith("slot:sub_location:")) return "sub_location";
  if (key === "slot:goal") return "goal";
  if (key === "slot:duration" || key === "slot:duration_total") return "duration_total";
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
  if (key === "slot:scenic_preference") return "scenic_preference";
  if (key === "slot:activity_preference") return "activity_preference";
  return "other";
}

function normalizeDestination(raw: string): string {
  return cleanText(raw || "", 80)
    .replace(/[.,，。;；!?！？]+$/g, "")
    .replace(/\s+/g, " ");
}

function inferLimitingKindFromText(text: string): string {
  const s = cleanText(text || "", 180);
  if (/心脏|心肺|慢性病|过敏|医疗|health|medical|cardiac|allergy/i.test(s)) return "health";
  if (/英语|语言|翻译|沟通|english|language|translate|communication/i.test(s)) return "language";
  if (/饮食|忌口|清真|素食|halal|kosher|vegetarian|vegan|diet/i.test(s)) return "diet";
  if (/宗教|礼拜|祷告|religion|prayer|ramadan|sabbath/i.test(s)) return "religion";
  if (/签证|护照|入境|海关|法律|visa|passport|immigration|permit|legal/i.test(s)) return "legal";
  if (/轮椅|无障碍|体力|行动不便|不能久走|mobility|wheelchair|accessibility/i.test(s)) return "mobility";
  if (/治安|安全|安全感|危险|夜间|夜里|夜晚|security|safety|danger|risk|night/i.test(s)) return "safety";
  if (/转机|换乘|托运|航班|火车|机场|时差|logistics|layover|flight|train/i.test(s)) return "logistics";
  return "other";
}

function canonicalLimitingDetail(kind: string, detail: string): string {
  const d = cleanText(detail || "", 140).toLowerCase();
  if (!d) return "factor";
  if (kind === "safety") {
    const hasSecurity = /治安|安全|安全感|security|safety|danger|risk/.test(d);
    const hasNight = /夜间|夜里|夜晚|night|late/.test(d);
    const hasTransit = /出行|步行|打车|交通|transit|travel|walk|taxi/.test(d);
    const hasLodging = /酒店|住宿|住在|区域|片区|地段|hotel|lodging|accommodation|area/.test(d);
    if (hasSecurity && hasNight) return "security_night";
    if (hasSecurity && hasTransit) return "security_transit";
    if (hasSecurity && hasLodging) return "security_lodging";
    if (hasSecurity) return "security";
    return "safety";
  }
  if (kind === "language") return "language";
  if (kind === "health") return "health";
  if (kind === "diet") return "diet";
  if (kind === "religion") return "religion";
  if (kind === "legal") return "legal";
  if (kind === "mobility") return "mobility";
  if (kind === "logistics") return "logistics";
  return slug(d) || "factor";
}

function parseSemanticKeyFromStatement(node: ConceptNode): string {
  const s = cleanText(node.statement || "", 180);
  if (!s) return "";
  if (node.type === "goal" || (node as any).layer === "intent") return "slot:goal";

  let m = s.match(/^目的地[:：]\s*(.+)$/);
  if (m?.[1]) return `slot:destination:${slug(normalizeDestination(m[1])) || "unknown"}`;

  m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/);
  if (m?.[1]) return `slot:duration_city:${slug(normalizeDestination(m[1])) || "unknown"}`;

  if (/^总行程时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_total";
  if (/^(冲突提示|conflict warning)[:：]/i.test(s)) {
    const x = s.split(/[:：]/)[1] || "conflict";
    return `slot:conflict:${slug(x) || "default"}`;
  }
  if (/^预算(?:上限)?[:：]/.test(s)) return "slot:budget";
  if (/^已花预算[:：]/.test(s)) return "slot:budget_spent";
  if (/^(?:剩余预算|可用预算)[:：]/.test(s)) return "slot:budget_remaining";
  if (/^(?:待确认预算|待确认支出)[:：]/.test(s)) return "slot:budget_pending";
  if (/^同行人数[:：]/.test(s)) return "slot:people";
  if (/^(住宿偏好|酒店偏好|住宿标准|酒店标准)[:：]/.test(s)) return "slot:lodging";
  if (/^景点偏好[:：]/.test(s)) return "slot:scenic_preference";
  if (/^活动偏好[:：]/.test(s)) return "slot:activity_preference";
  if (/^(?:会议关键日|关键会议日|论文汇报日|关键日)[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "critical";
    return `slot:meeting_critical:${slug(x) || "critical"}`;
  }

  if (
    /^限制因素[:：]/.test(s) ||
    /心脏|心肺|慢性病|过敏|宗教|饮食|清真|素食|语言|安全|签证|法律|禁忌/i.test(s)
  ) {
    const x = s.split(/[:：]/)[1] || s;
    const kind = inferLimitingKindFromText(x);
    return `slot:constraint:limiting:${kind}:${canonicalLimitingDetail(kind, x)}`;
  }

  return "";
}

function canonicalSlotKey(key: string): string {
  const k = cleanText(key, 180).toLowerCase();
  if (!k.startsWith("slot:")) return "";
  if (k.startsWith("slot:conflict:")) {
    const rest = k.slice("slot:conflict:".length);
    return `slot:conflict:${slug(rest) || "default"}`;
  }

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
    const detail = canonicalLimitingDetail(kind, parts.slice(1).join(":") || "factor");
    return `slot:constraint:limiting:${kind}:${detail}`;
  }
  if (k.startsWith("slot:constraint:")) {
    const rest = k.slice("slot:constraint:".length);
    return `slot:constraint:${slug(rest) || "other"}`;
  }

  if (k === "slot:duration") return "slot:duration_total";
  if (k === "slot:goal") return "slot:goal";
  if (k === "slot:duration_total") return "slot:duration_total";
  if (k === "slot:budget") return "slot:budget";
  if (k === "slot:budget_spent") return "slot:budget_spent";
  if (k === "slot:budget_remaining") return "slot:budget_remaining";
  if (k === "slot:budget_pending") return "slot:budget_pending";
  if (k === "slot:people") return "slot:people";
  if (k === "slot:lodging") return "slot:lodging";
  if (k === "slot:health") return "slot:constraint:limiting:health:health";
  if (k === "slot:language") return "slot:constraint:limiting:language:language";
  if (k === "slot:scenic_preference") return "slot:scenic_preference";
  if (k === "slot:activity_preference") return "slot:activity_preference";

  return k;
}

export function semanticKeyForNode(n: ConceptNode): string {
  const key = canonicalSlotKey(cleanText((n as any).key, 180));
  if (key) return key;
  const parsed = canonicalSlotKey(parseSemanticKeyFromStatement(n));
  if (parsed) return parsed;

  const type = cleanText((n as any).type, 20) || "other";
  const signature = slug(cleanText(n.statement, 80) || cleanText(n.id, 40) || "node");
  return `slot:freeform:${type}:${signature || "node"}`;
}

export function semanticFamilyFromKey(key: string): ConceptFamily {
  return slotFamily(canonicalSlotKey(key));
}

export function stableConceptIdFromSemanticKey(semanticKey: string): string {
  return stableIdFromKey(`semantic:${canonicalSlotKey(semanticKey) || semanticKey || "other"}`);
}

function conceptKindForNode(n: ConceptNode, family: ConceptFamily): ConceptKind {
  if ((n as any).layer === "preference" || n.type === "preference") return "preference";
  if (family === "scenic_preference" || family === "activity_preference") return "preference";
  if (n.type === "belief") return "belief";
  if (family === "goal" || n.type === "goal" || (n as any).layer === "intent") return "belief";

  if (
    family === "duration_total" ||
    family === "budget" ||
    family === "people" ||
    family === "lodging" ||
    family === "limiting_factor" ||
    family === "generic_constraint" ||
    family === "conflict" ||
    family === "meeting_critical"
  ) {
    return "constraint";
  }

  if (
    /不能|不要|避免|必须|务必|硬约束|限制|约束|constraint|must|avoid|cannot|critical|high risk/i.test(
      cleanText(n.statement, 180)
    )
  ) {
    return "constraint";
  }

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
  return `${n.type}:${cleanText(n.id, 24)}`;
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

function normalizeConceptMergeText(input: string): string {
  return cleanText(input, 220)
    .toLowerCase()
    .replace(/[“”"'"`]/g, "")
    .replace(/^限制因素[:：]?\s*/g, "")
    .replace(/^limiting factor[:：]?\s*/g, "")
    .replace(/^目的地[:：]?\s*/g, "")
    .replace(/^destination[:：]?\s*/g, "")
    .replace(/^总行程时长[:：]?\s*/g, "")
    .replace(/^total duration[:：]?\s*/g, "")
    .replace(/^预算(?:上限)?[:：]?\s*/g, "")
    .replace(/^budget(?: cap)?[:：]?\s*/g, "")
    .replace(/^子地点[:：]?\s*/g, "")
    .replace(/^sub-location[:：]?\s*/g, "")
    .replace(/^冲突提示[:：]?\s*/g, "")
    .replace(/^conflict warning[:：]?\s*/g, "")
    .replace(/^(需要|尽量|希望|想要|请|please)\s*/g, "")
    .replace(/\b(要|去|在|和|与|的|了|吧|一下|一个)\b/g, " ")
    .replace(/[（(][^)）]{0,40}[)）]/g, " ")
    .replace(/[，。,；;！!？?\-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeTokens(text: string): string[] {
  const normalized = normalizeConceptMergeText(text);
  if (!normalized) return [];
  const zh = normalized.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  const en = normalized.match(/[a-z][a-z0-9]{2,24}/g) || [];
  return uniq([...zh, ...en], 16);
}

function jaccardTokens(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

function budgetSlotCategory(key: string): "total" | "spent" | "remaining" | "pending" | "other" {
  const k = canonicalSlotKey(key);
  if (k === "slot:budget") return "total";
  if (k === "slot:budget_spent") return "spent";
  if (k === "slot:budget_remaining") return "remaining";
  if (k === "slot:budget_pending") return "pending";
  return "other";
}

function charNgrams(text: string, n = 2): string[] {
  const x = normalizeConceptMergeText(text).replace(/\s+/g, "");
  if (!x) return [];
  if (x.length <= n) return [x];
  const grams: string[] = [];
  for (let i = 0; i <= x.length - n; i += 1) grams.push(x.slice(i, i + n));
  return uniq(grams, 64);
}

function hasNegationSignal(text: string): boolean {
  return /(不|不能|不要|避免|别|禁止|must not|cannot|don't|avoid|no\b|without)/i.test(cleanText(text, 220));
}

function mergeFamilyCompatible(a: ConceptItem, b: ConceptItem): boolean {
  if (a.family === b.family) {
    if (a.family === "budget") {
      return budgetSlotCategory(a.semanticKey) === budgetSlotCategory(b.semanticKey);
    }
    return true;
  }
  const pair = new Set([a.family, b.family]);
  if (pair.has("limiting_factor") && pair.has("generic_constraint")) return true;
  return false;
}

function limitingKindFromSemanticKey(key: string): string {
  const k = canonicalSlotKey(key);
  const m = k.match(/^slot:constraint:limiting:([^:]+):/);
  return m?.[1] || "";
}

function conceptSimilarity(a: ConceptItem, b: ConceptItem): number {
  const rawA = cleanText(`${a.title} ${a.description}`, 220);
  const rawB = cleanText(`${b.title} ${b.description}`, 220);
  const ta = normalizeConceptMergeText(rawA);
  const tb = normalizeConceptMergeText(rawB);
  if (!ta || !tb) return 0;
  if ((a.family === "limiting_factor" || b.family === "limiting_factor") && hasNegationSignal(rawA) !== hasNegationSignal(rawB)) {
    return 0;
  }
  if (ta === tb) return 1;
  const include = ta.includes(tb) || tb.includes(ta);
  const tokenJ = jaccardTokens(mergeTokens(ta), mergeTokens(tb));
  const gramJ = jaccardTokens(charNgrams(ta), charNgrams(tb));
  const j = Math.max(tokenJ, gramJ * 0.92);
  const sameLimitingKind =
    a.family === "limiting_factor" &&
    b.family === "limiting_factor" &&
    limitingKindFromSemanticKey(a.semanticKey) &&
    limitingKindFromSemanticKey(a.semanticKey) === limitingKindFromSemanticKey(b.semanticKey);
  if (sameLimitingKind && j >= 0.36) return Math.max(j, 0.82);
  if (include && Math.min(ta.length, tb.length) >= 6) return Math.max(j, 0.86);
  return j;
}

function mergeConceptItems(primary: ConceptItem, secondary: ConceptItem): ConceptItem {
  const primaryIsBetter = primary.score >= secondary.score;
  const keep = primaryIsBetter ? primary : secondary;
  const add = primaryIsBetter ? secondary : primary;
  const mergedNodeIds = uniq([...(keep.nodeIds || []), ...(add.nodeIds || [])], 180);
  const mergedPrimary = mergedNodeIds.includes(keep.primaryNodeId || "") ? keep.primaryNodeId : mergedNodeIds[0];
  return {
    ...keep,
    title: keep.title || add.title,
    description: keep.description || add.description,
    score: Math.max(keep.score, add.score),
    nodeIds: mergedNodeIds,
    primaryNodeId: mergedPrimary || undefined,
    evidenceTerms: uniq([...(keep.evidenceTerms || []), ...(add.evidenceTerms || [])], 28),
    sourceMsgIds: uniq([...(keep.sourceMsgIds || []), ...(add.sourceMsgIds || [])], 96),
    motifIds: uniq([...(keep.motifIds || []), ...(add.motifIds || [])], 64),
    locked: !!keep.locked || !!add.locked,
    paused: !!keep.paused && !!add.paused,
  };
}

function mergeSimilarConcepts(input: ConceptItem[]): ConceptItem[] {
  const ordered = input.slice().sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const out: ConceptItem[] = [];
  for (const cur of ordered) {
    const idx = out.findIndex((x) => {
      if (x.kind !== cur.kind) return false;
      if (!mergeFamilyCompatible(x, cur)) return false;
      const sim = conceptSimilarity(x, cur);
      const sameLimitingKind =
        x.family === "limiting_factor" &&
        cur.family === "limiting_factor" &&
        limitingKindFromSemanticKey(x.semanticKey) &&
        limitingKindFromSemanticKey(x.semanticKey) === limitingKindFromSemanticKey(cur.semanticKey);
      const threshold = sameLimitingKind
        ? 0.4
        : x.family === "limiting_factor" || cur.family === "limiting_factor"
        ? 0.56
        : 0.72;
      return sim >= threshold;
    });
    if (idx < 0) {
      out.push(cur);
      continue;
    }
    out[idx] = mergeConceptItems(out[idx], cur);
  }
  return out;
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

function buildSemanticNodeIndex(graph: CDG): Map<string, ConceptNode[]> {
  const out = new Map<string, ConceptNode[]>();
  for (const n of graph.nodes || []) {
    if (!shouldKeepNode(n)) continue;
    const semanticKey = semanticKeyForNode(n);
    if (!semanticKey) continue;
    if (!out.has(semanticKey)) out.set(semanticKey, []);
    out.get(semanticKey)!.push(n);
  }
  return out;
}

function primaryNodeOf(nodes: ConceptNode[]): ConceptNode | null {
  if (!nodes.length) return null;
  return nodes.slice(1).reduce((best, n) => betterNode(best, n), nodes[0]);
}

export function deriveConceptsFromGraph(graph: CDG): ConceptItem[] {
  const now = new Date().toISOString();
  const semanticIndex = buildSemanticNodeIndex(graph);
  const concepts: ConceptItem[] = [];

  for (const [semanticKey, nodes] of semanticIndex.entries()) {
    const primaryNode = primaryNodeOf(nodes);
    if (!primaryNode) continue;

    const family = semanticFamilyFromKey(semanticKey);
    const kind = conceptKindForNode(primaryNode, family);
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

    concepts.push({
      id: stableConceptIdFromSemanticKey(semanticKey),
      kind,
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
      locked,
      paused,
      updatedAt: now,
    });
  }

  const merged = mergeSimilarConcepts(concepts);

  merged.sort(
    (a, b) =>
      rankKind(a.kind) - rankKind(b.kind) ||
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
  );
  return merged.slice(0, 180);
}

export function normalizeConceptsForGraph(input: any, graph: CDG): ConceptItem[] {
  const nodesById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const semanticIndex = buildSemanticNodeIndex(graph);
  const semanticToPrimary = new Map<string, string>();
  for (const [semanticKey, nodes] of semanticIndex.entries()) {
    const primaryNode = primaryNodeOf(nodes);
    if (primaryNode) semanticToPrimary.set(semanticKey, primaryNode.id);
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

    const conceptId = stableConceptIdFromSemanticKey(semanticKey);
    if (usedConceptIds.has(conceptId)) continue;
    usedConceptIds.add(conceptId);

    const semanticNodes = semanticIndex.get(semanticKey) || [];
    const inferredPrimaryNodeId = semanticToPrimary.get(semanticKey) || "";
    const rawPrimaryNodeId = cleanText((raw as any)?.primaryNodeId, 64);
    const basePrimaryNodeId = [rawPrimaryNodeId, firstValidNodeId, inferredPrimaryNodeId].find(
      (id) => !!id && nodesById.has(id)
    );

    const semanticNodeIds = semanticNodes.map((n) => n.id);
    const mergedNodeIds = sortNodeIds(
      [...rawNodeIds.filter((id) => nodesById.has(id)), ...semanticNodeIds],
      basePrimaryNodeId || undefined
    );

    const primaryNode =
      (basePrimaryNodeId && nodesById.get(basePrimaryNodeId)) ||
      (mergedNodeIds[0] && nodesById.get(mergedNodeIds[0])) ||
      null;
    const family = semanticFamilyFromKey(semanticKey);
    const inferredKind: ConceptKind = primaryNode ? conceptKindForNode(primaryNode, family) : "factual_assertion";
    const rawKind = cleanText((raw as any)?.kind, 20).toLowerCase();
    const kind: ConceptKind =
      rawKind === "belief"
        ? "belief"
        : rawKind === "preference"
          ? "preference"
          : rawKind === "constraint" || rawKind === "intent" || rawKind === "requirement" || rawKind === "risk"
            ? "constraint"
            : rawKind === "factual_assertion" || rawKind === "fact" || rawKind === "question" || rawKind === "other"
              ? "factual_assertion"
              : inferredKind;

    out.push({
      id: conceptId,
      kind,
      family,
      semanticKey,
      title: cleanText((raw as any)?.title, 60) || (primaryNode ? conceptTitleFromNode(primaryNode) : "Concept"),
      description:
        cleanText((raw as any)?.description, 180) ||
        (primaryNode ? conceptDescriptionFromNode(primaryNode, kind) : ""),
      score: clamp01((raw as any)?.score, primaryNode ? statementScore(primaryNode) : 0.7),
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
      locked: !!(raw as any)?.locked,
      paused: !!(raw as any)?.paused,
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
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
    return {
      ...d,
      title: ex.title || d.title,
      description: ex.description || d.description,
      score: d.score,
      paused: !!ex.paused,
      locked: !!ex.locked,
      nodeIds: d.nodeIds.length ? d.nodeIds : ex.nodeIds,
      primaryNodeId: d.primaryNodeId || ex.primaryNodeId,
      evidenceTerms: uniq([...d.evidenceTerms, ...ex.evidenceTerms], 24),
      sourceMsgIds: uniq([...d.sourceMsgIds, ...ex.sourceMsgIds], 80),
      motifIds: uniq([...(d.motifIds || []), ...(ex.motifIds || [])], 48),
      updatedAt: now,
    };
  });

  return merged.slice(0, 180);
}

function setNodeConceptMeta(node: ConceptNode, paused: boolean): ConceptNode {
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
      },
    },
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

  const nodes = (params.graph.nodes || []).map((n) => {
    let locked = !!n.locked;
    if (nextLocked.has(n.id)) locked = true;
    else if (prevLocked.has(n.id) && !nextLocked.has(n.id)) locked = false;
    const withMeta = setNodeConceptMeta(n, nextPaused.has(n.id));
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
