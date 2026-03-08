import type { ConceptMotif } from "./conceptMotifs.js";
import { normalizeMotifLinkType } from "../../core/graph/schemaAdapters.js";

export type MotifLinkType = "precedes" | "supports" | "conflicts_with" | "refines";

export type MotifLink = {
  id: string;
  fromMotifId: string;
  toMotifId: string;
  type: MotifLinkType;
  confidence: number;
  source: "system" | "user";
  updatedAt: string;
};

function cleanText(input: any, max = 120): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clamp01(x: any, fallback = 0.72): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function stableId(input: string): string {
  const safe = cleanText(input, 240)
    .toLowerCase()
    .replace(/[^a-z0-9_\-:>]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `ml_${safe.slice(0, 120) || "link"}`;
}

function cleanMotifId(input: any): string {
  return cleanText(input, 240);
}

function linkKey(fromMotifId: string, toMotifId: string): string {
  return `${cleanMotifId(fromMotifId)}=>${cleanMotifId(toMotifId)}`;
}

function dependencyClassOf(m: ConceptMotif): "enable" | "constraint" | "determine" {
  const raw = cleanText((m as any)?.dependencyClass || m.relation, 40);
  if (raw === "constraint") return "constraint";
  if (raw === "determine") return "determine";
  return "enable";
}

function dependencyRank(dep: "enable" | "constraint" | "determine"): number {
  if (dep === "constraint") return 0;
  if (dep === "determine") return 1;
  return 2;
}

function isBlockingConflictReason(reason: string): boolean {
  const r = cleanText(reason, 180).toLowerCase();
  if (!r) return false;
  if (r.startsWith("relation_conflict_with:")) return true;
  if (r === "relation_conflicts_with") return true;
  if (r.startsWith("explicit_negation")) return true;
  return false;
}

function isConflictMotif(m: ConceptMotif): boolean {
  if (cleanText((m as any)?.relation, 40) === "conflicts_with") return true;
  if (cleanText((m as any)?.dependencyClass, 40) === "conflicts_with") return true;
  return isBlockingConflictReason(String((m as any)?.statusReason || (m as any)?.state_transition_reason || ""));
}

function motifStatePenalty(status: ConceptMotif["status"]): number {
  if (status === "active") return 1;
  if (status === "uncertain") return 0.84;
  if (status === "disabled") return 0.66;
  if (status === "deprecated") return 0.6;
  return 0.48;
}

function motifTargetConceptId(m: ConceptMotif): string {
  return (
    cleanText((m as any)?.target_concept_id, 100) ||
    cleanText(m.anchorConceptId, 100) ||
    cleanText(m.roles?.target, 100)
  );
}

function motifSourceConceptIds(m: ConceptMotif): string[] {
  return Array.from(
    new Set(
      (
        Array.isArray((m as any)?.source_concept_ids) && (m as any).source_concept_ids.length
          ? (m as any).source_concept_ids
          : Array.isArray(m.roles?.sources) && m.roles.sources.length
          ? m.roles.sources
          : (m.conceptIds || []).filter((id) => cleanText(id, 100) !== motifTargetConceptId(m))
      )
        .map((id: any) => cleanText(id, 100))
        .filter(Boolean)
    )
  ).slice(0, 8);
}

function explicitConflictTargetMotifId(m: ConceptMotif): string {
  const reason = cleanText((m as any)?.statusReason || (m as any)?.state_transition_reason, 180);
  const match = reason.match(/^relation_conflict_with:([A-Za-z0-9_\-:>+.]+)$/);
  return cleanMotifId(match?.[1]);
}

function structuralLinkConfidence(a: ConceptMotif, b: ConceptMotif, multiplier = 1): number {
  return clamp01(
    ((a.confidence + b.confidence) / 2) * motifStatePenalty(a.status) * motifStatePenalty(b.status) * multiplier,
    0.72
  );
}

function properSubset(a: string[], b: string[]): boolean {
  if (!a.length || a.length >= b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function inferStructuralLinks(a: ConceptMotif, b: ConceptMotif): Array<{ from: ConceptMotif; to: ConceptMotif; type: MotifLinkType; confidence: number }> {
  const out: Array<{ from: ConceptMotif; to: ConceptMotif; type: MotifLinkType; confidence: number }> = [];
  const aConflictTarget = explicitConflictTargetMotifId(a);
  const bConflictTarget = explicitConflictTargetMotifId(b);
  if (aConflictTarget && aConflictTarget === cleanMotifId(b.id)) {
    out.push({
      from: a,
      to: b,
      type: "conflicts_with",
      confidence: structuralLinkConfidence(a, b, 0.82),
    });
  }
  if (bConflictTarget && bConflictTarget === cleanMotifId(a.id)) {
    out.push({
      from: b,
      to: a,
      type: "conflicts_with",
      confidence: structuralLinkConfidence(a, b, 0.82),
    });
  }

  const aTarget = motifTargetConceptId(a);
  const bTarget = motifTargetConceptId(b);
  const aSources = motifSourceConceptIds(a);
  const bSources = motifSourceConceptIds(b);

  const aFeedsB = !!aTarget && aTarget !== bTarget && bSources.includes(aTarget);
  const bFeedsA = !!bTarget && bTarget !== aTarget && aSources.includes(bTarget);
  if (aFeedsB && !bFeedsA) {
    out.push({
      from: a,
      to: b,
      type: "precedes",
      confidence: structuralLinkConfidence(a, b),
    });
  }
  if (bFeedsA && !aFeedsB) {
    out.push({
      from: b,
      to: a,
      type: "precedes",
      confidence: structuralLinkConfidence(a, b),
    });
  }

  const depA = dependencyClassOf(a);
  const depB = dependencyClassOf(b);
  if (!!aTarget && aTarget === bTarget && depA === depB) {
    if (properSubset(aSources, bSources)) {
      out.push({
        from: b,
        to: a,
        type: "refines",
        confidence: structuralLinkConfidence(a, b, 0.92),
      });
    } else if (properSubset(bSources, aSources)) {
      out.push({
        from: a,
        to: b,
        type: "refines",
        confidence: structuralLinkConfidence(a, b, 0.92),
      });
    }
  }

  return out;
}

function normalizeLinks(input: any): MotifLink[] {
  const arr = Array.isArray(input) ? input : [];
  const out: MotifLink[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const fromMotifId = cleanMotifId((raw as any)?.fromMotifId);
    const toMotifId = cleanMotifId((raw as any)?.toMotifId);
    if (!fromMotifId || !toMotifId || fromMotifId === toMotifId) continue;
    const k = linkKey(fromMotifId, toMotifId);
    if (seen.has(k)) continue;
    seen.add(k);

    const type: MotifLinkType = normalizeMotifLinkType((raw as any)?.type, "supports");
    const sourceRaw = cleanText((raw as any)?.source, 24).toLowerCase();
    const source: "system" | "user" = sourceRaw === "user" ? "user" : "system";
    out.push({
      id: cleanText((raw as any)?.id, 120) || stableId(`${fromMotifId}:${toMotifId}:${type}`),
      fromMotifId,
      toMotifId,
      type,
      confidence: clamp01((raw as any)?.confidence, 0.72),
      source,
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

function intersectCount(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  let cnt = 0;
  for (const x of b) if (setA.has(x)) cnt += 1;
  return cnt;
}

function sharedConceptIds(a: string[], b: string[]): string[] {
  if (!a.length || !b.length) return [];
  const setB = new Set(b);
  const out: string[] = [];
  for (const x of a) {
    if (setB.has(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

function isSameAnchorTopologyCandidate(m: ConceptMotif): boolean {
  return !!m.anchorConceptId && (m.status === "active" || m.status === "uncertain");
}

function motifParallelRiskClass(m: ConceptMotif): string | null {
  const text = cleanText(
    [
      (m as any)?.motif_type_id,
      m.templateKey,
      (m as any)?.motif_type_title,
      m.title,
      m.description,
    ]
      .filter(Boolean)
      .join(" "),
    320
  ).toLowerCase();
  if (!text) return null;
  if (
    /slot:constraint:limiting:health|冠心|冠脉|心脏|心血管|支架|慢性病|糖尿病|哮喘|medical|cardiac|heart|health/.test(
      text
    )
  ) {
    return "health";
  }
  if (/睡眠|失眠|安眠药|起不来|太晚|太早|sleep|insomnia|rest|nap|late night|too late|too early/.test(text)) {
    return "sleep";
  }
  if (/行动不便|不能久走|不能爬|轮椅|mobility|walking|stairs|fatigue|体力/.test(text)) {
    return "mobility";
  }
  if (/低盐|低脂|高纤维|饮食|忌口|过敏|diet|allergy/.test(text)) {
    return "diet";
  }
  return null;
}

function shouldKeepPeerLevelSameAnchorMotifs(a: ConceptMotif, b: ConceptMotif): boolean {
  if (!a.anchorConceptId || a.anchorConceptId !== b.anchorConceptId) return false;
  if (a.motifType !== "pair" || b.motifType !== "pair") return false;
  if (dependencyClassOf(a) !== dependencyClassOf(b)) return false;
  const classA = motifParallelRiskClass(a);
  const classB = motifParallelRiskClass(b);
  return !!classA && !!classB;
}

function motifSpecificity(m: ConceptMotif): number {
  return Math.max(0, Array.isArray(m.conceptIds) ? m.conceptIds.length : 0);
}

function sameAnchorSort(a: ConceptMotif, b: ConceptMotif): number {
  const depDiff = dependencyRank(dependencyClassOf(a)) - dependencyRank(dependencyClassOf(b));
  if (depDiff) return depDiff;

  const activeDiff = (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1);
  if (activeDiff) return activeDiff;

  const specificityDiff = motifSpecificity(a) - motifSpecificity(b);
  if (specificityDiff) return specificityDiff;

  const motifTypeDiff = (a.motifType === "pair" ? 0 : 1) - (b.motifType === "pair" ? 0 : 1);
  if (motifTypeDiff) return motifTypeDiff;

  return b.confidence - a.confidence || a.id.localeCompare(b.id);
}

function hasLinkEitherWay(seen: Set<string>, aMotifId: string, bMotifId: string): boolean {
  return seen.has(linkKey(aMotifId, bMotifId)) || seen.has(linkKey(bMotifId, aMotifId));
}

function sameAnchorLinkConfidence(a: ConceptMotif, b: ConceptMotif): number {
  return clamp01(
    ((a.confidence + b.confidence) / 2) *
      motifStatePenalty(a.status) *
      motifStatePenalty(b.status) *
      0.9,
    0.68
  );
}

function autoType(a: ConceptMotif, b: ConceptMotif): MotifLinkType {
  if (isConflictMotif(a) || isConflictMotif(b)) return "conflicts_with";
  const anchorA = a.anchorConceptId;
  const anchorB = b.anchorConceptId;
  const aUsesB = !!anchorB && (a.conceptIds || []).includes(anchorB);
  const bUsesA = !!anchorA && (b.conceptIds || []).includes(anchorA);
  const depA = dependencyClassOf(a);
  const depB = dependencyClassOf(b);

  if (aUsesB && !bUsesA) return "precedes";
  if (bUsesA && !aUsesB) return "precedes";

  const conceptsA = new Set(a.conceptIds || []);
  const conceptsB = new Set(b.conceptIds || []);
  const aInB = Array.from(conceptsA).every((x) => conceptsB.has(x));
  const bInA = Array.from(conceptsB).every((x) => conceptsA.has(x));
  if (a.anchorConceptId && a.anchorConceptId === b.anchorConceptId && (aInB || bInA)) {
    return "refines";
  }

  return "supports";
}

function buildAutoLinks(motifs: ConceptMotif[]): MotifLink[] {
  const now = new Date().toISOString();
  const out: MotifLink[] = [];
  const seen = new Set<string>();
  const candidates = (motifs || [])
    .filter((m) => {
      if ((m.reuseClass || "reusable") !== "reusable") return false;
      if (m.status === "active" || m.status === "uncertain") return true;
      return isConflictMotif(m);
    })
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 140);

  const outDegree = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      const structuralLinks = inferStructuralLinks(a, b);
      for (const link of structuralLinks) {
        if (link.from.id === link.to.id) continue;
        const fromCnt = outDegree.get(link.from.id) || 0;
        if (fromCnt >= 3) continue;
        const k = linkKey(link.from.id, link.to.id);
        if (seen.has(k)) continue;
        seen.add(k);
        outDegree.set(link.from.id, fromCnt + 1);
        out.push({
          id: stableId(`${link.from.id}:${link.to.id}:${link.type}`),
          fromMotifId: link.from.id,
          toMotifId: link.to.id,
          type: link.type,
          confidence: link.confidence,
          source: "system",
          updatedAt: now,
        });
        if (out.length >= 220) break;
      }
      if (out.length >= 220) break;
    }
    if (out.length >= 220) break;
  }
  return out;
}

function canParticipateInTransitivePath(link: MotifLink): boolean {
  if (link.type === "conflicts_with") return false;
  if (link.fromMotifId === link.toMotifId) return false;
  return true;
}

function buildAdjacency(links: MotifLink[]): Map<string, Array<{ to: string; key: string; confidence: number }>> {
  const out = new Map<string, Array<{ to: string; key: string; confidence: number }>>();
  for (const l of links || []) {
    if (!canParticipateInTransitivePath(l)) continue;
    const from = cleanMotifId(l.fromMotifId);
    const to = cleanMotifId(l.toMotifId);
    if (!from || !to || from === to) continue;
    if (!out.has(from)) out.set(from, []);
    out.get(from)!.push({
      to,
      key: linkKey(from, to),
      confidence: clamp01(l.confidence, 0.72),
    });
  }
  return out;
}

function findAlternatePathStrength(params: {
  from: string;
  to: string;
  ignoreKey: string;
  adjacency: Map<string, Array<{ to: string; key: string; confidence: number }>>;
  maxDepth?: number;
}): number {
  const maxDepth = Math.max(2, Math.min(params.maxDepth || 6, 10));
  const queue: Array<{ node: string; depth: number; minConfidence: number }> = [
    { node: params.from, depth: 0, minConfidence: 1 },
  ];
  const bestSeen = new Map<string, number>();
  bestSeen.set(params.from, 1);
  let bestTo = 0;

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const outs = params.adjacency.get(cur.node) || [];
    for (const edge of outs) {
      if (edge.key === params.ignoreKey) continue;
      const nextDepth = cur.depth + 1;
      const nextMin = Math.min(cur.minConfidence, edge.confidence);
      if (edge.to === params.to) {
        if (nextDepth >= 2 && nextMin > bestTo) bestTo = nextMin;
        continue;
      }
      const seen = bestSeen.get(edge.to) || 0;
      if (nextMin <= seen) continue;
      bestSeen.set(edge.to, nextMin);
      queue.push({ node: edge.to, depth: nextDepth, minConfidence: nextMin });
    }
  }
  return bestTo;
}

function transitiveReduceSystemLinks(links: MotifLink[]): MotifLink[] {
  const all = (links || []).slice();
  if (all.length < 3) return all;
  const adjacency = buildAdjacency(all);
  const removable = new Set<string>();

  const sorted = all
    .slice()
    .sort((a, b) => clamp01(a.confidence, 0.72) - clamp01(b.confidence, 0.72) || a.id.localeCompare(b.id));

  for (const edge of sorted) {
    if (edge.source === "user") continue;
    if (!canParticipateInTransitivePath(edge)) continue;
    const from = cleanMotifId(edge.fromMotifId);
    const to = cleanMotifId(edge.toMotifId);
    const key = linkKey(from, to);
    const alt = findAlternatePathStrength({
      from,
      to,
      ignoreKey: key,
      adjacency,
      maxDepth: 6,
    });
    const selfConfidence = clamp01(edge.confidence, 0.72);
    if (alt >= selfConfidence - 0.02) removable.add(edge.id);
  }

  if (!removable.size) return all;
  return all.filter((l) => !removable.has(l.id));
}

export function reconcileMotifLinks(params: {
  motifs: ConceptMotif[];
  baseLinks?: any;
}): MotifLink[] {
  const now = new Date().toISOString();
  const effectiveMotifs = (params.motifs || []).filter((m) => (m.reuseClass || "reusable") === "reusable");
  const aliasToCanonical = new Map<string, string>();
  for (const m of effectiveMotifs || []) {
    const canonicalId = cleanMotifId(m.id);
    if (!canonicalId) continue;
    aliasToCanonical.set(canonicalId, canonicalId);
    const motifId = cleanMotifId((m as any)?.motif_id);
    if (motifId) aliasToCanonical.set(motifId, canonicalId);
    for (const alias of Array.isArray((m as any)?.aliases) ? (m as any).aliases : []) {
      const aid = cleanMotifId(alias);
      if (aid) aliasToCanonical.set(aid, canonicalId);
    }
  }
  const remapMotifId = (id: string) => aliasToCanonical.get(cleanMotifId(id)) || cleanMotifId(id);
  const motifIds = new Set((effectiveMotifs || []).map((m) => m.id));
  const auto = buildAutoLinks(effectiveMotifs || []);
  const base = normalizeLinks(params.baseLinks)
    .map((x) => ({
      ...x,
      fromMotifId: remapMotifId(x.fromMotifId),
      toMotifId: remapMotifId(x.toMotifId),
    }))
    .filter((x) => motifIds.has(x.fromMotifId) && motifIds.has(x.toMotifId) && x.fromMotifId !== x.toMotifId);

  const byKey = new Map<string, MotifLink>();
  for (const x of auto) byKey.set(linkKey(x.fromMotifId, x.toMotifId), x);

  for (const x of base) {
    const k = linkKey(x.fromMotifId, x.toMotifId);
    const prev = byKey.get(k);
    if (!prev) {
      if (x.source === "user") byKey.set(k, { ...x, updatedAt: now });
      continue;
    }
    if (x.source === "user") {
      byKey.set(k, {
        ...prev,
        type: x.type,
        confidence: clamp01(x.confidence, prev.confidence),
        source: "user",
        updatedAt: now,
      });
      continue;
    }
    byKey.set(k, {
      ...prev,
      confidence: Math.max(prev.confidence, clamp01(x.confidence, prev.confidence)),
      updatedAt: now,
    });
  }

  const mergedLinks = Array.from(byKey.values())
    .sort(
      (a, b) =>
        (a.source === "user" ? 1 : 0) - (b.source === "user" ? 1 : 0) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 220);

  return transitiveReduceSystemLinks(mergedLinks)
    .sort(
      (a, b) =>
        (a.source === "user" ? 1 : 0) - (b.source === "user" ? 1 : 0) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 220);
}
