import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "./conceptMotifs.js";
import type { MotifLink, MotifLinkType } from "./motifLinks.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

export type MotifReasoningNode = {
  id: string;
  motifId: string;
  title: string;
  relation: ConceptMotif["relation"];
  dependencyClass: ConceptMotif["dependencyClass"];
  causalOperator: ConceptMotif["causalOperator"];
  causalFormula: string;
  motifType: ConceptMotif["motifType"];
  status: ConceptMotif["status"];
  confidence: number;
  pattern: string;
  conceptIds: string[];
  conceptTitles: string[];
  sourceRefs: string[];
};

export type MotifReasoningEdge = {
  id: string;
  from: string;
  to: string;
  type: MotifLinkType;
  confidence: number;
};

export type MotifReasoningView = {
  nodes: MotifReasoningNode[];
  edges: MotifReasoningEdge[];
};

function cleanText(input: any, max = 140): string {
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
  for (const item of arr || []) {
    const x = cleanText(item, 96);
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

function sourceRefToken(sourceMsgId: string): string {
  const s = cleanText(sourceMsgId, 64).toLowerCase();
  if (!s || s === "latest_user" || s === "latest_assistant") return "";
  const m = s.match(/(\d{1,4})/);
  if (m?.[1]) return `#${m[1]}`;
  return s.slice(0, 18);
}

function motifPattern(m: ConceptMotif, conceptTitles: string[]): string {
  if (!Array.isArray(m.conceptIds) || !m.conceptIds.length) return "concept_a -> concept_b";
  const anchorId = cleanText(m.anchorConceptId, 96);
  const ids = m.conceptIds.slice();
  const sources = ids.filter((x) => x !== anchorId);
  const target = ids.find((x) => x === anchorId) || ids[ids.length - 1];
  if (!sources.length) return "concept_a -> concept_b";

  const titleById = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 1) {
    const title = cleanText(conceptTitles[i], 48);
    if (title) titleById.set(ids[i], title);
  }
  const sourceTerms = sources.map((sid) => `${sid}:${titleById.get(sid) || "source"}`);
  const targetTerm = `${target}:${titleById.get(target) || "target"}`;
  return `${sourceTerms.join(" + ")} -> ${targetTerm}`;
}

function statusRank(s: ConceptMotif["status"]): number {
  if (s === "deprecated") return 5;
  if (s === "uncertain") return 4;
  if (s === "active") return 3;
  if (s === "disabled") return 2;
  return 1;
}

export function buildMotifReasoningView(params: {
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  motifLinks: MotifLink[];
  locale?: AppLocale;
}): MotifReasoningView {
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const motifs = (params.motifs || []).filter((m) => m.status !== "cancelled");
  const motifById = new Map(motifs.map((m) => [m.id, m]));

  const nodes: MotifReasoningNode[] = motifs
    .map((m) => {
      const conceptIds = uniq(m.conceptIds || [], 8);
      const conceptTitles = conceptIds.map((cid) => cleanText(conceptById.get(cid)?.title, 72) || cid);
      const sourceRefs = uniq(
        conceptIds.flatMap((cid) => {
          const c = conceptById.get(cid);
          if (!c) return [];
          return (c.sourceMsgIds || []).map(sourceRefToken).filter(Boolean);
        }),
        8
      );
      return {
        id: `rm_${cleanText(m.id, 120)}`,
        motifId: m.id,
        title: cleanText(m.title, 160) || cleanText(m.templateKey, 120) || (isEnglishLocale(params.locale) ? "motif" : "母题"),
        relation: m.relation,
        dependencyClass: m.dependencyClass || m.relation,
        causalOperator: m.causalOperator,
        causalFormula: cleanText(m.causalFormula, 120) || motifPattern(m, conceptTitles),
        motifType: m.motifType,
        status: m.status,
        confidence: clamp01(m.confidence, 0.72),
        pattern: motifPattern(m, conceptTitles),
        conceptIds,
        conceptTitles,
        sourceRefs,
      };
    })
    .sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 320);

  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const motifIdToNodeId = new Map(nodes.map((n) => [n.motifId, n.id]));
  const edges: MotifReasoningEdge[] = uniq(
    (params.motifLinks || [])
      .filter((x) => motifById.has(x.fromMotifId) && motifById.has(x.toMotifId))
      .map((x) => {
        const from = motifIdToNodeId.get(x.fromMotifId) || "";
        const to = motifIdToNodeId.get(x.toMotifId) || "";
        return `${cleanText(x.id, 120)}::${from}::${to}::${x.type}`;
      }),
    420
  )
    .map((packed) => {
      const [idRaw, from, to, typeRaw] = packed.split("::");
      return {
        id: cleanText(idRaw, 120),
        from,
        to,
        type:
          typeRaw === "depends_on" || typeRaw === "conflicts" || typeRaw === "refines"
            ? typeRaw
            : "supports",
        confidence: 0.72,
      } as MotifReasoningEdge;
    })
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to);

  return { nodes, edges };
}
