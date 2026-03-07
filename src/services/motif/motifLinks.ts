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

function linkKey(fromMotifId: string, toMotifId: string): string {
  return `${cleanText(fromMotifId, 100)}=>${cleanText(toMotifId, 100)}`;
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

function normalizeLinks(input: any): MotifLink[] {
  const arr = Array.isArray(input) ? input : [];
  const out: MotifLink[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const fromMotifId = cleanText((raw as any)?.fromMotifId, 100);
    const toMotifId = cleanText((raw as any)?.toMotifId, 100);
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
      const overlap = intersectCount(a.conceptIds || [], b.conceptIds || []);
      if (overlap <= 0) continue;
      const sharedIds = sharedConceptIds(a.conceptIds || [], b.conceptIds || []);
      const type = autoType(a, b);
      const aDependsOnB = !!b.anchorConceptId && (a.conceptIds || []).includes(b.anchorConceptId);
      const bDependsOnA = !!a.anchorConceptId && (b.conceptIds || []).includes(a.anchorConceptId);
      const sameAnchor = !!a.anchorConceptId && a.anchorConceptId === b.anchorConceptId;
      const sharedOnlyAnchor =
        sameAnchor && sharedIds.length === 1 && sharedIds[0] === cleanText(a.anchorConceptId, 120);
      const depA = dependencyClassOf(a);
      const depB = dependencyClassOf(b);
      const sourceSetA = new Set((a.conceptIds || []).filter((id) => id !== a.anchorConceptId));
      const sourceSetB = new Set((b.conceptIds || []).filter((id) => id !== b.anchorConceptId));
      const sharedSourceDriver = sharedIds.some((id) => sourceSetA.has(id) && sourceSetB.has(id));

      // Avoid artificial chains for parallel motifs that only share the same anchor.
      if (type === "supports") {
        const strongOverlap = sharedIds.length >= 2;
        const mixedDependencySameAnchor = sameAnchor && depA !== depB;
        const structuralBridge = aDependsOnB || bDependsOnA;
        const sharedDriverDifferentTargets = sharedSourceDriver && !sameAnchor && depA !== depB;
        if (sharedOnlyAnchor) continue;
        if (!strongOverlap && !mixedDependencySameAnchor && !structuralBridge && !sharedDriverDifferentTargets) continue;
      }

      const from =
        type === "refines"
          ? (a.conceptIds || []).length >= (b.conceptIds || []).length
            ? a
            : b
          : aDependsOnB && !bDependsOnA
          ? b
          : bDependsOnA && !aDependsOnB
          ? a
          : a.confidence >= b.confidence
          ? a
          : b;
      const to = from.id === a.id ? b : a;

      const fromCnt = outDegree.get(from.id) || 0;
      if (fromCnt >= 3) continue;

      const k = linkKey(from.id, to.id);
      if (seen.has(k)) continue;
      seen.add(k);
      outDegree.set(from.id, fromCnt + 1);

      out.push({
        id: stableId(`${from.id}:${to.id}:${type}`),
        fromMotifId: from.id,
        toMotifId: to.id,
        type,
        confidence: clamp01(
          ((from.confidence + to.confidence) / 2) *
            motifStatePenalty(from.status) *
            motifStatePenalty(to.status),
          0.72
        ),
        source: "system",
        updatedAt: now,
      });

      if (out.length >= 220) break;
    }
    if (out.length >= 220) break;
  }

  const anchorGroups = new Map<string, ConceptMotif[]>();
  for (const motif of candidates) {
    if (!isSameAnchorTopologyCandidate(motif)) continue;
    const anchor = cleanText(motif.anchorConceptId, 120);
    if (!anchor) continue;
    if (!anchorGroups.has(anchor)) anchorGroups.set(anchor, []);
    anchorGroups.get(anchor)!.push(motif);
  }

  for (const group of anchorGroups.values()) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort(sameAnchorSort);
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      if (from.id === to.id) continue;
      if (hasLinkEitherWay(seen, from.id, to.id)) continue;

      const fromCnt = outDegree.get(from.id) || 0;
      if (fromCnt >= 3) continue;

      const k = linkKey(from.id, to.id);
      seen.add(k);
      outDegree.set(from.id, fromCnt + 1);
      out.push({
        id: stableId(`${from.id}:${to.id}:supports:anchor_chain`),
        fromMotifId: from.id,
        toMotifId: to.id,
        type: "supports",
        confidence: sameAnchorLinkConfidence(from, to),
        source: "system",
        updatedAt: now,
      });

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
    const from = cleanText(l.fromMotifId, 120);
    const to = cleanText(l.toMotifId, 120);
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
    const from = cleanText(edge.fromMotifId, 120);
    const to = cleanText(edge.toMotifId, 120);
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
    const canonicalId = cleanText(m.id, 120);
    if (!canonicalId) continue;
    aliasToCanonical.set(canonicalId, canonicalId);
    const motifId = cleanText((m as any)?.motif_id, 120);
    if (motifId) aliasToCanonical.set(motifId, canonicalId);
    for (const alias of Array.isArray((m as any)?.aliases) ? (m as any).aliases : []) {
      const aid = cleanText(alias, 120);
      if (aid) aliasToCanonical.set(aid, canonicalId);
    }
  }
  const remapMotifId = (id: string) => aliasToCanonical.get(cleanText(id, 120)) || cleanText(id, 120);
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
