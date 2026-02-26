import type { CDG, EdgeType } from "../../core/graph.js";
import type { ConceptItem } from "../concepts.js";

export type ConceptMotifType = "pair" | "triad";
export type MotifLifecycleStatus = "active" | "uncertain" | "deprecated" | "disabled" | "cancelled";
export type MotifChangeState = "new" | "updated" | "unchanged";

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
  status: MotifLifecycleStatus;
  statusReason?: string;
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: "user" | "system";
  novelty: MotifChangeState;
  updatedAt: string;
};

const MAX_ACTIVE_MOTIFS_PER_ANCHOR = 4;

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
  if (family === "scenic_preference") return "景点偏好";
  if (family === "activity_preference") return "活动偏好";
  if (family === "generic_constraint") return "通用约束";
  if (family === "sub_location") return "子地点";
  return "概念";
}

function conceptScore(c: ConceptItem): number {
  return clamp01(c.score, 0.72);
}

function conceptSemanticKey(c: ConceptItem | undefined): string {
  return cleanText(c?.semanticKey, 180).toLowerCase();
}

function canonicalConceptFamily(c: ConceptItem | undefined): string {
  const key = conceptSemanticKey(c);
  if (key === "slot:budget" || key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending") {
    return "budget";
  }
  if (key === "slot:duration_total" || key === "slot:duration") return "duration_total";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:constraint:limiting:")) return "limiting_factor";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:sub_location:")) return "sub_location";
  if (key === "slot:activity_preference") return "activity_preference";
  if (key === "slot:scenic_preference") return "scenic_preference";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:people") return "people";
  if (key === "slot:goal") return "goal";
  return cleanText(c?.family, 40) || "other";
}

function sourceSignatureToken(c: ConceptItem | undefined): string {
  const key = conceptSemanticKey(c);
  if (key === "slot:budget" || key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending") {
    return "slot:budget";
  }
  if (
    key.startsWith("slot:destination:") ||
    key.startsWith("slot:duration_city:") ||
    key.startsWith("slot:meeting_critical:") ||
    key.startsWith("slot:constraint:limiting:") ||
    key.startsWith("slot:sub_location:")
  ) {
    return key;
  }
  if (key === "slot:goal") return "slot:goal";
  if (key === "slot:duration_total" || key === "slot:duration") return "slot:duration_total";
  if (key === "slot:people") return "slot:people";
  if (key === "slot:lodging") return "slot:lodging";
  if (key === "slot:activity_preference") return "slot:activity_preference";
  if (key === "slot:scenic_preference") return "slot:scenic_preference";
  return canonicalConceptFamily(c);
}

function isBudgetBookkeepingConcept(c: ConceptItem | undefined): boolean {
  const key = conceptSemanticKey(c);
  return key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending";
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
        if (isBudgetBookkeepingConcept(fromConcept) || isBudgetBookkeepingConcept(toConcept)) continue;

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
      status: "active",
      novelty: "new",
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
      const sourceFamilyCount = new Set(sourceConcepts.map((c) => canonicalConceptFamily(c))).size;
      if (sourceFamilyCount < 2) continue;

      const orderedSourceIds = sortConceptIdsForTriad(sourceIds, byId);
      const familySig = sourceConcepts
        .map((c) => canonicalConceptFamily(c))
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
        status: "active",
        novelty: "new",
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
    const statusRaw = cleanText((raw as any)?.status, 24).toLowerCase();
    const noveltyRaw = cleanText((raw as any)?.novelty, 24).toLowerCase();
    const resolved = !!(raw as any)?.resolved;
    const resolvedByRaw = cleanText((raw as any)?.resolvedBy, 24).toLowerCase();
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
      status:
        statusRaw === "uncertain" ||
        statusRaw === "deprecated" ||
        statusRaw === "disabled" ||
        statusRaw === "cancelled"
          ? (statusRaw as MotifLifecycleStatus)
          : "active",
      statusReason: cleanText((raw as any)?.statusReason, 180),
      resolved,
      resolvedAt: resolved ? cleanText((raw as any)?.resolvedAt, 40) || undefined : undefined,
      resolvedBy: resolved ? (resolvedByRaw === "user" ? "user" : "system") : undefined,
      novelty: noveltyRaw === "updated" || noveltyRaw === "unchanged" ? (noveltyRaw as MotifChangeState) : "new",
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

function isSupportChanged(prev: ConceptMotif, next: ConceptMotif): boolean {
  const prevSupport = `${prev.supportEdgeIds.slice().sort().join("|")}::${prev.supportNodeIds.slice().sort().join("|")}`;
  const nextSupport = `${next.supportEdgeIds.slice().sort().join("|")}::${next.supportNodeIds.slice().sort().join("|")}`;
  return prevSupport !== nextSupport;
}

function sourceFamilySignature(m: ConceptMotif, conceptById: Map<string, ConceptItem>): string {
  const ids = (m.conceptIds || []).slice();
  if (m.anchorConceptId) {
    const idx = ids.indexOf(m.anchorConceptId);
    if (idx >= 0) ids.splice(idx, 1);
  }
  const families = ids
    .map((id) => sourceSignatureToken(conceptById.get(id)))
    .sort();
  return families.join("+") || "none";
}

function statusRank(s: MotifLifecycleStatus): number {
  if (s === "deprecated") return 5;
  if (s === "uncertain") return 4;
  if (s === "active") return 3;
  if (s === "disabled") return 2;
  return 1;
}

function inferBaseStatus(m: ConceptMotif, prev: ConceptMotif | undefined, conceptById: Map<string, ConceptItem>) {
  if (prev?.resolved && (prev.status === "active" || prev.status === "disabled" || prev.status === "cancelled")) {
    return { status: prev.status as MotifLifecycleStatus, reason: prev.statusReason || "user_resolved" };
  }
  if (m.relation === "conflicts_with") return { status: "deprecated" as MotifLifecycleStatus, reason: "relation_conflicts_with" };

  const hasConcepts = (m.conceptIds || []).length > 0;
  const allPaused =
    hasConcepts &&
    (m.conceptIds || []).every((cid) => {
      const c = conceptById.get(cid);
      return !!c?.paused;
    });
  if (allPaused) return { status: "disabled" as MotifLifecycleStatus, reason: "all_related_concepts_paused" };

  if (prev?.status === "disabled" && !allPaused) {
    return { status: "disabled" as MotifLifecycleStatus, reason: prev.statusReason || "user_disabled" };
  }
  if (m.confidence < 0.7) return { status: "uncertain" as MotifLifecycleStatus, reason: "low_confidence" };
  return { status: "active" as MotifLifecycleStatus, reason: "" };
}

function motifPriorityScore(m: ConceptMotif): number {
  const relationBoost =
    m.relation === "constraint"
      ? 0.03
      : m.relation === "determine"
      ? 0.02
      : m.relation === "enable"
      ? 0.01
      : 0;
  const typeBoost = m.motifType === "pair" ? 0.015 : 0;
  return m.confidence + relationBoost + typeBoost;
}

function applyRedundancyDeprecation(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  const groups = new Map<string, ConceptMotif[]>();
  for (const m of motifs) {
    if (m.resolved) continue;
    if (m.status === "cancelled" || m.status === "disabled") continue;
    if (!m.anchorConceptId) continue;
    const signature = `${m.relation}|${m.anchorConceptId}|${sourceFamilySignature(m, conceptById)}`;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature)!.push(m);
  }

  const patch = new Map<string, { status: MotifLifecycleStatus; reason: string }>();
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const sorted = list
      .slice()
      .sort((a, b) => motifPriorityScore(b) - motifPriorityScore(a) || a.id.localeCompare(b.id));
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      patch.set(loser.id, {
        status: "deprecated",
        reason: `redundant_with:${winner.id}`,
      });
    }
  }

  return motifs.map((m) => {
    const p = patch.get(m.id);
    if (!p) return m;
    return {
      ...m,
      status: p.status,
      statusReason: p.reason,
    };
  });
}

function capActiveMotifsPerAnchor(motifs: ConceptMotif[]): ConceptMotif[] {
  const groups = new Map<string, ConceptMotif[]>();
  for (const m of motifs) {
    if (!m.anchorConceptId || m.status !== "active" || m.resolved) continue;
    if (!groups.has(m.anchorConceptId)) groups.set(m.anchorConceptId, []);
    groups.get(m.anchorConceptId)!.push(m);
  }

  const patch = new Map<string, string>();
  for (const list of groups.values()) {
    if (list.length <= MAX_ACTIVE_MOTIFS_PER_ANCHOR) continue;
    const sorted = list
      .slice()
      .sort((a, b) => motifPriorityScore(b) - motifPriorityScore(a) || a.id.localeCompare(b.id));
    for (const m of sorted.slice(MAX_ACTIVE_MOTIFS_PER_ANCHOR)) {
      patch.set(m.id, `density_pruned:max_${MAX_ACTIVE_MOTIFS_PER_ANCHOR}`);
    }
  }

  if (!patch.size) return motifs;
  return motifs.map((m) =>
    patch.has(m.id)
      ? {
          ...m,
          status: "deprecated",
          statusReason: patch.get(m.id),
          novelty: m.novelty === "new" ? "new" : "updated",
        }
      : m
  );
}

export function reconcileMotifsWithGraph(params: {
  graph: CDG;
  concepts: ConceptItem[];
  baseMotifs?: any;
}): ConceptMotif[] {
  const now = new Date().toISOString();
  const pair = buildPairMotifs(params.graph, params.concepts);
  const triads = buildTriadMotifs(pair, params.concepts);
  const derived = [...pair, ...triads];
  const base = normalizeMotifs(params.baseMotifs);
  const baseById = new Map(base.map((m) => [m.id, m]));
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));

  const mergedDerived = derived.map((m) => {
    const prev = baseById.get(m.id);
    const inferred = inferBaseStatus(m, prev, conceptById);
    const status = inferred.status;
    const changed =
      !!prev &&
      (Math.abs((prev.confidence || 0) - (m.confidence || 0)) >= 0.04 ||
        prev.status !== status ||
        isSupportChanged(prev, m));
    return {
      ...m,
      title: prev?.title || m.title,
      description: prev?.description || m.description,
      status,
      statusReason: inferred.reason || prev?.statusReason,
      resolved: !!prev?.resolved && status !== "deprecated",
      resolvedAt: prev?.resolvedAt,
      resolvedBy: prev?.resolvedBy,
      novelty: prev ? (changed ? "updated" : "unchanged") : "new",
      updatedAt: now,
    };
  });

  const deprecationApplied = applyRedundancyDeprecation(mergedDerived, conceptById);
  const densityCapped = capActiveMotifsPerAnchor(deprecationApplied).map((m) => {
    if (m.status !== "deprecated") return m;
    if (m.novelty === "new") return m;
    return { ...m, novelty: "updated" as MotifChangeState, resolved: false, resolvedAt: undefined, resolvedBy: undefined };
  });

  const derivedIds = new Set(densityCapped.map((m) => m.id));
  const cancelledFromHistory: ConceptMotif[] = base
    .filter((old) => !derivedIds.has(old.id))
    .map((old) => ({
      ...old,
      status: "cancelled",
      statusReason: "not_supported_by_current_graph",
      novelty: "updated",
      updatedAt: now,
    }));

  const all = [...densityCapped, ...cancelledFromHistory];
  return all
    .slice()
    .sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 320);
}

export function attachMotifIdsToConcepts(concepts: ConceptItem[], motifs: ConceptMotif[]): ConceptItem[] {
  const motifIdsByConcept = new Map<string, string[]>();
  for (const m of motifs || []) {
    if (m.status === "cancelled") continue;
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
