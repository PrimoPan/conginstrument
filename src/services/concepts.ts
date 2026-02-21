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

export type ConceptItem = {
  id: string;
  kind: ConceptKind;
  title: string;
  description: string;
  score: number;
  nodeIds: [string];
  evidenceTerms: string[];
  sourceMsgIds: string[];
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

function stableIdFromKey(key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9_\-:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `c_${safe.slice(0, 80) || "other"}`;
}

function stableConceptIdFromNodeId(nodeId: string): string {
  return stableIdFromKey(`node:${cleanText(nodeId, 80) || "unknown"}`);
}

function statementScore(n: ConceptNode): number {
  const imp = clamp01((n as any).importance, 0.65);
  const conf = clamp01((n as any).confidence, 0.65);
  return imp * 0.55 + conf * 0.45;
}

function slotFamily(key: string): string {
  if (!key) return "";
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:constraint:")) return "constraint";
  if (key === "slot:goal") return "goal";
  if (key === "slot:duration" || key === "slot:duration_total") return "duration";
  if (key === "slot:budget") return "budget";
  if (key === "slot:people") return "people";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:health" || key === "slot:language") return "limiting";
  if (key === "slot:scenic_preference") return "preference";
  return "";
}

function conceptKindForNode(n: ConceptNode): ConceptKind {
  const key = cleanText((n as any).key, 120);
  const family = slotFamily(key);

  if (family === "goal" || n.type === "goal" || (n as any).layer === "intent") {
    return "intent";
  }
  if (
    family === "destination" ||
    family === "duration_city" ||
    family === "budget" ||
    family === "duration" ||
    family === "people" ||
    family === "lodging"
  ) {
    return "requirement";
  }
  if (family === "meeting_critical") return "risk";

  // Unify hard limiting factors as one class: health / language / religion / diet / safety.
  if (
    family === "limiting" ||
    family === "constraint" ||
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

export function deriveConceptsFromGraph(graph: CDG): ConceptItem[] {
  const now = new Date().toISOString();
  const concepts: ConceptItem[] = [];
  for (const n of graph.nodes || []) {
    if (!shouldKeepNode(n)) continue;
    const kind = conceptKindForNode(n);
    const title = conceptTitleFromNode(n);
    const description = conceptDescriptionFromNode(n, kind);
    const evidenceTerms = uniq(
      [
        ...keywordTerms(title),
        ...keywordTerms(cleanText(n.statement, 180)),
        ...(n.evidenceIds || []).map((x) => cleanText(x, 40)),
      ],
      12
    );
    const sourceMsgIds = uniq((n.sourceMsgIds || []).map((x) => cleanText(x, 40)), 20);

    concepts.push({
      id: stableConceptIdFromNodeId(n.id),
      kind,
      title: cleanText(title, 60) || "Concept",
      description: cleanText(description, 120),
      score: clamp01(statementScore(n), 0.72),
      nodeIds: [n.id],
      evidenceTerms,
      sourceMsgIds,
      locked: !!n.locked,
      paused: readNodePaused(n),
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
  return concepts.slice(0, 120);
}

export function normalizeConceptsForGraph(input: any, graph: CDG): ConceptItem[] {
  const validNodeIds = new Set((graph.nodes || []).map((n) => n.id));
  const out: ConceptItem[] = [];
  const arr = Array.isArray(input) ? input : [];
  const usedStableIds = new Set<string>();
  const usedNodeIds = new Set<string>();

  for (const raw of arr) {
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
        : "other";

    const nodeIdsAll = uniq(
      (Array.isArray((raw as any)?.nodeIds) ? (raw as any).nodeIds : [])
        .map((x: any) => cleanText(x, 64))
        .filter((x: string) => validNodeIds.has(x)),
      80
    );
    const firstNodeId = nodeIdsAll[0] || "";
    if (!firstNodeId) continue;
    if (usedNodeIds.has(firstNodeId)) continue;
    usedNodeIds.add(firstNodeId);
    const stableId = stableConceptIdFromNodeId(firstNodeId);
    if (usedStableIds.has(stableId)) continue;
    usedStableIds.add(stableId);
    const nodeIds = [firstNodeId] as [string];

    out.push({
      id: stableId,
      kind,
      title: cleanText((raw as any)?.title, 60) || "Concept",
      description: cleanText((raw as any)?.description, 180) || "",
      score: clamp01((raw as any)?.score, 0.7),
      nodeIds,
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
        40
      ),
      locked: !!(raw as any)?.locked,
      paused: !!(raw as any)?.paused,
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
    });
  }

  return out.slice(0, 30);
}

export function reconcileConceptsWithGraph(params: {
  graph: CDG;
  baseConcepts?: any;
}): ConceptItem[] {
  const derived = deriveConceptsFromGraph(params.graph);
  const existing = normalizeConceptsForGraph(params.baseConcepts, params.graph);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byNodeId = new Map(existing.map((c) => [c.nodeIds[0], c]));
  const now = new Date().toISOString();

  const merged = derived.map((d) => {
    const ex = byId.get(d.id) || byNodeId.get(d.nodeIds[0]);
    if (!ex) return d;
    return {
      ...d,
      title: ex.title || d.title,
      description: ex.description || d.description,
      score: d.score,
      paused: !!ex.paused,
      locked: !!ex.locked,
      evidenceTerms: uniq([...d.evidenceTerms, ...ex.evidenceTerms], 18),
      sourceMsgIds: uniq([...d.sourceMsgIds, ...ex.sourceMsgIds], 30),
      updatedAt: now,
    };
  });

  return merged.slice(0, 120);
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
  const prevLocked = new Set(prev.filter((c) => c.locked).flatMap((c) => c.nodeIds));
  const nextLocked = new Set(params.nextConcepts.filter((c) => c.locked).flatMap((c) => c.nodeIds));
  const nextPaused = new Set(params.nextConcepts.filter((c) => c.paused).flatMap((c) => c.nodeIds));

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
