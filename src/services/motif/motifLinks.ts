import type { ConceptMotif } from "./conceptMotifs.js";

export type MotifLinkType = "supports" | "depends_on" | "conflicts" | "refines";

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

    const typeRaw = cleanText((raw as any)?.type, 24).toLowerCase();
    const type: MotifLinkType =
      typeRaw === "depends_on" || typeRaw === "conflicts" || typeRaw === "refines"
        ? (typeRaw as MotifLinkType)
        : "supports";
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

function sourceConceptIds(m: ConceptMotif): string[] {
  const ids = Array.isArray(m?.conceptIds) ? m.conceptIds : [];
  const anchor = cleanText(m?.anchorConceptId, 100);
  if (!anchor) return ids.slice();
  return ids.filter((id) => id && id !== anchor);
}

function relationIsConflict(a: ConceptMotif, b: ConceptMotif): boolean {
  if (a.status === "deprecated" || b.status === "deprecated") return true;
  if (a.relation === "conflicts_with" || b.relation === "conflicts_with") return true;
  const pair = new Set([a.relation, b.relation]);
  return (
    (pair.has("constraint") && pair.has("determine")) ||
    (pair.has("constraint") && pair.has("enable"))
  );
}

function directedCandidate(
  from: ConceptMotif,
  to: ConceptMotif
): { type: MotifLinkType; score: number } | null {
  if (!from?.id || !to?.id || from.id === to.id) return null;

  const fromConcepts = Array.isArray(from.conceptIds) ? from.conceptIds : [];
  const toConcepts = Array.isArray(to.conceptIds) ? to.conceptIds : [];
  const overlap = intersectCount(fromConcepts, toConcepts);

  const fromAnchor = cleanText(from.anchorConceptId, 100);
  const toAnchor = cleanText(to.anchorConceptId, 100);
  const toSources = sourceConceptIds(to);
  const fromSources = sourceConceptIds(from);

  const fromFeedsTo = !!fromAnchor && toSources.includes(fromAnchor);
  const toFeedsFrom = !!toAnchor && fromSources.includes(toAnchor);
  const sameAnchor = !!fromAnchor && !!toAnchor && fromAnchor === toAnchor;

  if (relationIsConflict(from, to) && (sameAnchor || overlap > 0)) {
    return { type: "conflicts", score: 0.7 + Math.min(0.2, overlap * 0.05) };
  }

  if (fromFeedsTo) {
    return { type: "depends_on", score: 0.9 + Math.min(0.08, overlap * 0.03) };
  }
  if (toFeedsFrom) {
    return null;
  }

  if (sameAnchor && from.relation === to.relation) {
    const score = 0.62 + Math.min(0.18, overlap * 0.04);
    return { type: "refines", score };
  }

  if (overlap > 0) {
    const score = 0.58 + Math.min(0.2, overlap * 0.05);
    return { type: "supports", score };
  }

  return null;
}

function buildAutoLinks(motifs: ConceptMotif[]): MotifLink[] {
  const now = new Date().toISOString();
  const out: MotifLink[] = [];
  const seen = new Set<string>();
  const reverseSeen = new Set<string>();
  const candidates = (motifs || [])
    .filter((m) => m.status !== "cancelled")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 140);

  const outDegree = new Map<string, number>();
  const scored: Array<{ from: ConceptMotif; to: ConceptMotif; type: MotifLinkType; score: number }> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = 0; j < candidates.length; j += 1) {
      if (i === j) continue;
      const from = candidates[i];
      const to = candidates[j];
      const inferred = directedCandidate(from, to);
      if (!inferred) continue;
      scored.push({
        from,
        to,
        type: inferred.type,
        score:
          inferred.score *
          ((from.confidence + to.confidence) / 2) *
          motifStatePenalty(from.status) *
          motifStatePenalty(to.status),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id));
  for (const item of scored) {
    const from = item.from;
    const to = item.to;
    const type = item.type;
    const k = linkKey(from.id, to.id);
    if (seen.has(k)) continue;

    const reverse = linkKey(to.id, from.id);
    if (reverseSeen.has(k) || (seen.has(reverse) && type !== "conflicts")) continue;

    const fromCnt = outDegree.get(from.id) || 0;
    if (fromCnt >= 4) continue;

    seen.add(k);
    reverseSeen.add(reverse);
    outDegree.set(from.id, fromCnt + 1);
    out.push({
      id: stableId(`${from.id}:${to.id}:${type}`),
      fromMotifId: from.id,
      toMotifId: to.id,
      type,
      confidence: clamp01(item.score, 0.72),
      source: "system",
      updatedAt: now,
    });

    if (out.length >= 220) break;
  }

  // Keep the motif graph connected enough for reasoning visualization.
  if (out.length === 0 && candidates.length >= 2) {
    for (let i = 0; i < candidates.length - 1; i += 1) {
      const from = candidates[i];
      const to = candidates[i + 1];
      out.push({
        id: stableId(`${from.id}:${to.id}:supports`),
        fromMotifId: from.id,
        toMotifId: to.id,
        type: "supports",
        confidence: clamp01(
          ((from.confidence + to.confidence) / 2) *
            motifStatePenalty(from.status) *
            motifStatePenalty(to.status),
          0.68
        ),
        source: "system",
        updatedAt: now,
      });
      if (out.length >= 12) break;
    }
  }
  return out;
}

export function reconcileMotifLinks(params: {
  motifs: ConceptMotif[];
  baseLinks?: any;
}): MotifLink[] {
  const now = new Date().toISOString();
  const motifIds = new Set((params.motifs || []).map((m) => m.id));
  const auto = buildAutoLinks(params.motifs || []);
  const base = normalizeLinks(params.baseLinks).filter(
    (x) => motifIds.has(x.fromMotifId) && motifIds.has(x.toMotifId)
  );

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

  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        (a.source === "user" ? 1 : 0) - (b.source === "user" ? 1 : 0) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 220);
}
