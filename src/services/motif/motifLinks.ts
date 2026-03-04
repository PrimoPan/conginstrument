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

function autoType(a: ConceptMotif, b: ConceptMotif): MotifLinkType {
  if (a.status === "deprecated" || b.status === "deprecated") return "conflicts_with";
  if (a.status === "cancelled" || b.status === "cancelled") return "conflicts_with";
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
    .filter((m) => m.status !== "cancelled" && (m.reuseClass || "reusable") === "reusable")
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
      const type = autoType(a, b);
      const aDependsOnB = !!b.anchorConceptId && (a.conceptIds || []).includes(b.anchorConceptId);
      const bDependsOnA = !!a.anchorConceptId && (b.conceptIds || []).includes(a.anchorConceptId);
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
  return out;
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

  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        (a.source === "user" ? 1 : 0) - (b.source === "user" ? 1 : 0) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    )
    .slice(0, 220);
}
