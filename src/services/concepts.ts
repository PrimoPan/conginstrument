import type { CDG, ConceptNode } from "../core/graph.js";

export type ConceptKind =
  | "intent"
  | "requirement"
  | "preference"
  | "risk"
  | "belief"
  | "fact"
  | "question"
  | "other";

export type ConceptFamily =
  | "goal"
  | "destination"
  | "duration_total"
  | "duration_city"
  | "budget"
  | "people"
  | "lodging"
  | "meeting_critical"
  | "limiting_factor"
  | "scenic_preference"
  | "generic_constraint"
  | "sub_location"
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
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:constraint:limiting:")) return "limiting_factor";
  if (key.startsWith("slot:constraint:")) return "generic_constraint";
  if (key.startsWith("slot:sub_location:")) return "sub_location";
  if (key === "slot:goal") return "goal";
  if (key === "slot:duration" || key === "slot:duration_total") return "duration_total";
  if (key === "slot:budget") return "budget";
  if (key === "slot:people") return "people";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:health" || key === "slot:language") return "limiting_factor";
  if (key === "slot:scenic_preference") return "scenic_preference";
  return "other";
}

function normalizeDestination(raw: string): string {
  return cleanText(raw || "", 80)
    .replace(/[.,，。;；!?！？]+$/g, "")
    .replace(/\s+/g, " ");
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
  if (/^预算(?:上限)?[:：]/.test(s)) return "slot:budget";
  if (/^同行人数[:：]/.test(s)) return "slot:people";
  if (/^(住宿偏好|酒店偏好|住宿标准|酒店标准)[:：]/.test(s)) return "slot:lodging";
  if (/^景点偏好[:：]/.test(s)) return "slot:scenic_preference";
  if (/^(?:会议关键日|关键会议日|论文汇报日|关键日)[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "critical";
    return `slot:meeting_critical:${slug(x) || "critical"}`;
  }

  if (
    /^限制因素[:：]/.test(s) ||
    /心脏|心肺|慢性病|过敏|宗教|饮食|清真|素食|语言|安全|签证|法律|禁忌/i.test(s)
  ) {
    const x = s.split(/[:：]/)[1] || s;
    return `slot:constraint:limiting:other:${slug(x) || "factor"}`;
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
    const detail = slug(parts.slice(1).join(":") || "factor") || "factor";
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
  if (k === "slot:people") return "slot:people";
  if (k === "slot:lodging") return "slot:lodging";
  if (k === "slot:health") return "slot:constraint:limiting:health:health";
  if (k === "slot:language") return "slot:constraint:limiting:language:language";
  if (k === "slot:scenic_preference") return "slot:scenic_preference";

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
  if (family === "goal" || n.type === "goal" || (n as any).layer === "intent") return "intent";

  if (
    family === "destination" ||
    family === "duration_city" ||
    family === "duration_total" ||
    family === "budget" ||
    family === "people" ||
    family === "lodging"
  ) {
    return "requirement";
  }
  if (family === "meeting_critical") return "risk";

  if (
    family === "limiting_factor" ||
    family === "generic_constraint" ||
    (n as any).layer === "risk" ||
    /心脏|心肺|慢性病|过敏|宗教|饮食|清真|素食|语言|不会英语|安全|法律|签证|风险|禁忌|hard/i.test(
      cleanText(n.statement, 180)
    )
  ) {
    return "risk";
  }

  if ((n as any).layer === "preference" || n.type === "preference") return "preference";
  if (n.type === "belief") return "belief";
  if (n.type === "question") return "question";
  if (n.type === "fact") return "fact";
  return "other";
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
  if (kind === "intent") return 0;
  if (kind === "requirement") return 1;
  if (kind === "risk") return 2;
  if (kind === "preference") return 3;
  if (kind === "belief") return 4;
  if (kind === "fact") return 5;
  if (kind === "question") return 6;
  return 7;
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
    const inferredKind = primaryNode ? conceptKindForNode(primaryNode, family) : "other";
    const rawKind = cleanText((raw as any)?.kind, 20).toLowerCase();
    const kind: ConceptKind =
      rawKind === "intent" ||
      rawKind === "requirement" ||
      rawKind === "preference" ||
      rawKind === "risk" ||
      rawKind === "belief" ||
      rawKind === "fact" ||
      rawKind === "question"
        ? (rawKind as ConceptKind)
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

