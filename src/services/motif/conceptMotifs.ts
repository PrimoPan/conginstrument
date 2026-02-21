import type { CDG, EdgeType } from "../../core/graph.js";
import type { ConceptItem } from "../concepts.js";

export type ConceptMotifType = "pair" | "triad";

export type ConceptMotif = {
  id: string;
  templateKey: string;
  motifType: ConceptMotifType;
  relation: EdgeType;
  conceptIds: string[];
  anchorConceptId: string;
  title: string;
  description: string;
  confidence: number;
  supportEdgeIds: string[];
  supportNodeIds: string[];
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

function uniq(arr: string[], max = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const x = cleanText(item, 96);
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

function stableId(input: string): string {
  const safe = cleanText(input, 240)
    .toLowerCase()
    .replace(/[^a-z0-9_\-:>+]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `m_${safe.slice(0, 120) || "motif"}`;
}

function relationLabel(type: EdgeType): string {
  if (type === "constraint") return "限制";
  if (type === "enable") return "支持";
  if (type === "determine") return "决定";
  if (type === "conflicts_with") return "冲突";
  return type;
}

function familyLabel(family: ConceptItem["family"]): string {
  if (family === "goal") return "目标";
  if (family === "destination") return "目的地";
  if (family === "duration_total") return "总时长";
  if (family === "duration_city") return "城市时长";
  if (family === "budget") return "预算";
  if (family === "people") return "人数";
  if (family === "lodging") return "住宿";
  if (family === "meeting_critical") return "关键日程";
  if (family === "limiting_factor") return "限制因素";
  if (family === "scenic_preference") return "偏好";
  if (family === "generic_constraint") return "约束";
  if (family === "sub_location") return "子地点";
  return "概念";
}

function conceptScore(c: ConceptItem): number {
  return clamp01(c.score, 0.72);
}

function sortConceptIdsForTriad(ids: string[], byId: Map<string, ConceptItem>): string[] {
  return ids
    .slice()
    .sort((a, b) => {
      const ca = byId.get(a);
      const cb = byId.get(b);
      if (!ca || !cb) return a.localeCompare(b);
      return conceptScore(cb) - conceptScore(ca) || a.localeCompare(b);
    });
}

type PairAccum = {
  fromId: string;
  toId: string;
  relation: EdgeType;
  templateKey: string;
  confidenceSum: number;
  count: number;
  supportEdgeIds: string[];
  supportNodeIds: string[];
};

function buildNodeToConcepts(concepts: ConceptItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of concepts || []) {
    const ids = Array.isArray(c.nodeIds) ? c.nodeIds : [];
    for (const nodeId of ids) {
      const nid = cleanText(nodeId, 64);
      if (!nid) continue;
      if (!out.has(nid)) out.set(nid, []);
      out.get(nid)!.push(c.id);
    }
  }
  for (const [k, v] of out.entries()) out.set(k, uniq(v, 12));
  return out;
}

function buildPairMotifs(graph: CDG, concepts: ConceptItem[]): ConceptMotif[] {
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const nodeToConcepts = buildNodeToConcepts(concepts);
  const bucket = new Map<string, PairAccum>();
  const now = new Date().toISOString();

  for (const e of graph.edges || []) {
    const fromConceptIds = nodeToConcepts.get(e.from) || [];
    const toConceptIds = nodeToConcepts.get(e.to) || [];
    if (!fromConceptIds.length || !toConceptIds.length) continue;

    for (const fromId of fromConceptIds) {
      for (const toId of toConceptIds) {
        if (!fromId || !toId || fromId === toId) continue;
        const fromConcept = byId.get(fromId);
        const toConcept = byId.get(toId);
        if (!fromConcept || !toConcept) continue;

        const templateKey = `${e.type}:${fromConcept.family}->${toConcept.family}`;
        const key = `${templateKey}:${fromId}->${toId}`;
        const cur = bucket.get(key) || {
          fromId,
          toId,
          relation: e.type,
          templateKey,
          confidenceSum: 0,
          count: 0,
          supportEdgeIds: [],
          supportNodeIds: [],
        };
        cur.confidenceSum += clamp01(e.confidence, 0.72);
        cur.count += 1;
        cur.supportEdgeIds.push(e.id);
        cur.supportNodeIds.push(e.from, e.to);
        bucket.set(key, cur);
      }
    }
  }

  const out: ConceptMotif[] = [];
  for (const pair of bucket.values()) {
    const fromConcept = byId.get(pair.fromId);
    const toConcept = byId.get(pair.toId);
    if (!fromConcept || !toConcept) continue;

    const avgEdgeConfidence = pair.confidenceSum / Math.max(1, pair.count);
    const confidence = clamp01(
      avgEdgeConfidence * 0.58 + conceptScore(fromConcept) * 0.2 + conceptScore(toConcept) * 0.22,
      0.68
    );

    out.push({
      id: stableId(`${pair.templateKey}:${pair.fromId}->${pair.toId}`),
      templateKey: pair.templateKey,
      motifType: "pair",
      relation: pair.relation,
      conceptIds: [pair.fromId, pair.toId],
      anchorConceptId: pair.toId,
      title: `${fromConcept.title} ${relationLabel(pair.relation)} ${toConcept.title}`,
      description: `${familyLabel(fromConcept.family)} ${relationLabel(pair.relation)} ${familyLabel(toConcept.family)}`,
      confidence,
      supportEdgeIds: uniq(pair.supportEdgeIds, 32),
      supportNodeIds: uniq(pair.supportNodeIds, 32),
      updatedAt: now,
    });
  }
  return out;
}

function buildTriadMotifs(pairMotifs: ConceptMotif[], concepts: ConceptItem[]): ConceptMotif[] {
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const incoming = new Map<string, ConceptMotif[]>();
  const now = new Date().toISOString();

  for (const m of pairMotifs) {
    const target = m.conceptIds[1];
    if (!target) continue;
    if (!incoming.has(target)) incoming.set(target, []);
    incoming.get(target)!.push(m);
  }

  const out: ConceptMotif[] = [];
  for (const [targetId, list] of incoming.entries()) {
    const target = byId.get(targetId);
    if (!target || list.length < 2) continue;

    const byRelation = new Map<EdgeType, ConceptMotif[]>();
    for (const m of list) {
      if (!byRelation.has(m.relation)) byRelation.set(m.relation, []);
      byRelation.get(m.relation)!.push(m);
    }

    for (const [relation, relList] of byRelation.entries()) {
      if (relList.length < 2) continue;
      const sorted = relList
        .slice()
        .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
      const top = sorted.slice(0, 2);
      const sourceIds = uniq(
        top.map((m) => cleanText(m.conceptIds[0], 80)).filter(Boolean),
        2
      );
      if (sourceIds.length < 2) continue;

      const sourceConcepts = sourceIds.map((id) => byId.get(id)).filter(Boolean) as ConceptItem[];
      if (sourceConcepts.length < 2) continue;

      const orderedSourceIds = sortConceptIdsForTriad(sourceIds, byId);
      const familySig = sourceConcepts
        .map((c) => c.family)
        .sort()
        .join("+");
      const templateKey = `triad:${relation}:${familySig}->${target.family}`;
      const motifId = stableId(`${templateKey}:${orderedSourceIds.join("+")}->${target.id}`);
      const confidence = clamp01(
        (top[0].confidence + top[1].confidence + conceptScore(target)) / 3,
        0.7
      );

      out.push({
        id: motifId,
        templateKey,
        motifType: "triad",
        relation,
        conceptIds: [...orderedSourceIds, target.id],
        anchorConceptId: target.id,
        title: `${sourceConcepts[0].title} + ${sourceConcepts[1].title} ${relationLabel(relation)} ${target.title}`,
        description: `复合结构：${familyLabel(sourceConcepts[0].family)} + ${familyLabel(
          sourceConcepts[1].family
        )} ${relationLabel(relation)} ${familyLabel(target.family)}`,
        confidence,
        supportEdgeIds: uniq(top.flatMap((m) => m.supportEdgeIds), 36),
        supportNodeIds: uniq(top.flatMap((m) => m.supportNodeIds), 36),
        updatedAt: now,
      });
    }
  }

  return out;
}

function normalizeMotifs(input: any): ConceptMotif[] {
  const arr = Array.isArray(input) ? input : [];
  const out: ConceptMotif[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const id = cleanText((raw as any)?.id, 140);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const relation = cleanText((raw as any)?.relation, 40) as EdgeType;
    const motifType = cleanText((raw as any)?.motifType, 20) as ConceptMotifType;
    out.push({
      id,
      templateKey: cleanText((raw as any)?.templateKey, 180),
      motifType: motifType === "triad" ? "triad" : "pair",
      relation:
        relation === "constraint" || relation === "enable" || relation === "determine" || relation === "conflicts_with"
          ? relation
          : "enable",
      conceptIds: uniq(
        (Array.isArray((raw as any)?.conceptIds) ? (raw as any).conceptIds : []).map((x: any) => cleanText(x, 100)),
        8
      ),
      anchorConceptId: cleanText((raw as any)?.anchorConceptId, 100),
      title: cleanText((raw as any)?.title, 160),
      description: cleanText((raw as any)?.description, 240),
      confidence: clamp01((raw as any)?.confidence, 0.7),
      supportEdgeIds: uniq(
        (Array.isArray((raw as any)?.supportEdgeIds) ? (raw as any).supportEdgeIds : []).map((x: any) =>
          cleanText(x, 80)
        ),
        48
      ),
      supportNodeIds: uniq(
        (Array.isArray((raw as any)?.supportNodeIds) ? (raw as any).supportNodeIds : []).map((x: any) =>
          cleanText(x, 80)
        ),
        48
      ),
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

export function reconcileMotifsWithGraph(params: {
  graph: CDG;
  concepts: ConceptItem[];
  baseMotifs?: any;
}): ConceptMotif[] {
  const pair = buildPairMotifs(params.graph, params.concepts);
  const triads = buildTriadMotifs(pair, params.concepts);
  const derived = [...pair, ...triads];
  const baseById = new Map(normalizeMotifs(params.baseMotifs).map((m) => [m.id, m]));

  const merged = derived.map((m) => {
    const prev = baseById.get(m.id);
    if (!prev) return m;
    return {
      ...m,
      title: prev.title || m.title,
      description: prev.description || m.description,
      confidence: m.confidence,
      updatedAt: new Date().toISOString(),
    };
  });

  return merged
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 240);
}

export function attachMotifIdsToConcepts(concepts: ConceptItem[], motifs: ConceptMotif[]): ConceptItem[] {
  const motifIdsByConcept = new Map<string, string[]>();
  for (const m of motifs || []) {
    for (const cid of m.conceptIds || []) {
      if (!motifIdsByConcept.has(cid)) motifIdsByConcept.set(cid, []);
      motifIdsByConcept.get(cid)!.push(m.id);
    }
  }

  return (concepts || []).map((c) => ({
    ...c,
    motifIds: uniq(motifIdsByConcept.get(c.id) || [], 48),
  }));
}

