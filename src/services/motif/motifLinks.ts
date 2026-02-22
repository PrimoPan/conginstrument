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

function autoType(a: ConceptMotif, b: ConceptMotif): MotifLinkType {
  if (a.status === "deprecated" || b.status === "deprecated") return "conflicts";
  const anchorA = a.anchorConceptId;
  const anchorB = b.anchorConceptId;
  const aUsesB = !!anchorB && (a.conceptIds || []).includes(anchorB);
  const bUsesA = !!anchorA && (b.conceptIds || []).includes(anchorA);
  if (aUsesB && !bUsesA) return "depends_on";
  if (bUsesA && !aUsesB) return "refines";
  return "supports";
}

function buildAutoLinks(motifs: ConceptMotif[]): MotifLink[] {
  const now = new Date().toISOString();
  const out: MotifLink[] = [];
  const seen = new Set<string>();
  const candidates = (motifs || [])
    .filter((m) => m.status !== "cancelled")
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
      const from = a.confidence >= b.confidence ? a : b;
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

