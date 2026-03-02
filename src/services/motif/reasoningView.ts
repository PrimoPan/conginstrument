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

export type MotifReasoningStepRole = "premise" | "bridge" | "decision" | "isolated";

export type MotifReasoningStep = {
  id: string;
  order: number;
  motifId: string;
  motifNodeId: string;
  role: MotifReasoningStepRole;
  status: ConceptMotif["status"];
  dependencyClass: ConceptMotif["dependencyClass"];
  causalOperator: ConceptMotif["causalOperator"];
  dependsOnMotifIds: string[];
  usedConceptIds: string[];
  usedConceptTitles: string[];
  explanation: string;
};

export type MotifReasoningView = {
  nodes: MotifReasoningNode[];
  edges: MotifReasoningEdge[];
  steps: MotifReasoningStep[];
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

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function normalizeLinkType(input: string): MotifLinkType {
  const raw = cleanText(input, 32).toLowerCase();
  if (raw === "enable" || raw === "constraint" || raw === "determine" || raw === "conflicts_with") {
    return raw as MotifLinkType;
  }
  // Backward compatibility with old persisted values.
  if (raw === "conflicts") return "conflicts_with";
  if (raw === "depends_on" || raw === "refines") return "determine";
  return "enable";
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
  if (s === "active") return 5;
  if (s === "uncertain") return 4;
  if (s === "disabled") return 3;
  if (s === "deprecated") return 2;
  return 1;
}

function dependencyLabel(dep: ConceptMotif["dependencyClass"], locale?: AppLocale): string {
  if (dep === "constraint") return t(locale, "约束依赖", "constraint dependency");
  if (dep === "determine") return t(locale, "决定依赖", "determine dependency");
  if (dep === "conflicts_with") return t(locale, "冲突依赖", "conflict dependency");
  return t(locale, "使能依赖", "enable dependency");
}

function operatorLabel(op: ConceptMotif["causalOperator"], locale?: AppLocale): string {
  if (op === "direct_causation") return t(locale, "直接因果", "direct causation");
  if (op === "mediated_causation") return t(locale, "中介因果", "mediated causation");
  if (op === "confounding") return t(locale, "混杂", "confounding");
  if (op === "intervention") return t(locale, "干预", "intervention");
  if (op === "contradiction") return t(locale, "矛盾", "contradiction");
  return t(locale, "未指定", "unspecified");
}

function stepRole(indeg: number, outdeg: number): MotifReasoningStepRole {
  if (indeg <= 0 && outdeg <= 0) return "isolated";
  if (indeg <= 0 && outdeg > 0) return "premise";
  if (indeg > 0 && outdeg > 0) return "bridge";
  return "decision";
}

function roleLabel(role: MotifReasoningStepRole, locale?: AppLocale): string {
  if (role === "premise") return t(locale, "前提", "premise");
  if (role === "bridge") return t(locale, "桥接", "bridge");
  if (role === "decision") return t(locale, "决策", "decision");
  return t(locale, "独立", "isolated");
}

function buildReasoningSteps(params: {
  nodes: MotifReasoningNode[];
  edges: MotifReasoningEdge[];
  locale?: AppLocale;
}): MotifReasoningStep[] {
  const nodeById = new Map((params.nodes || []).map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of params.nodes || []) {
    indeg.set(n.id, 0);
    outdeg.set(n.id, 0);
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of params.edges || []) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to) || e.from === e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    outdeg.set(e.from, (outdeg.get(e.from) || 0) + 1);
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
  }

  const remainingIndeg = new Map(indeg);
  const queue = (params.nodes || [])
    .filter((n) => (remainingIndeg.get(n.id) || 0) <= 0)
    .sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .map((n) => n.id);

  const orderedIds: string[] = [];
  const visited = new Set<string>();
  while (queue.length) {
    const cur = queue.shift() as string;
    if (visited.has(cur)) continue;
    visited.add(cur);
    orderedIds.push(cur);
    for (const nxt of outgoing.get(cur) || []) {
      remainingIndeg.set(nxt, (remainingIndeg.get(nxt) || 0) - 1);
      if ((remainingIndeg.get(nxt) || 0) <= 0) queue.push(nxt);
    }
    queue.sort((a, b) => {
      const na = nodeById.get(a)!;
      const nb = nodeById.get(b)!;
      return statusRank(nb.status) - statusRank(na.status) || nb.confidence - na.confidence || a.localeCompare(b);
    });
  }

  for (const n of params.nodes || []) {
    if (visited.has(n.id)) continue;
    orderedIds.push(n.id);
  }

  return orderedIds
    .map((nodeId, idx) => {
      const n = nodeById.get(nodeId);
      if (!n) return null;
      const role = stepRole(indeg.get(nodeId) || 0, outdeg.get(nodeId) || 0);
      const deps = (incoming.get(nodeId) || [])
        .map((pid) => nodeById.get(pid))
        .filter(Boolean)
        .map((x) => x!.motifId);
      const depText =
        deps.length > 0
          ? t(params.locale, `依赖 ${deps.length} 个前置 motif`, `depends on ${deps.length} prior motif(s)`)
          : t(params.locale, "无前置依赖", "no prior dependency");
      const explanation = cleanText(
        `${t(params.locale, "第", "Step ")}${idx + 1}${t(params.locale, "步", "")} · ${roleLabel(role, params.locale)} · ${dependencyLabel(
          n.dependencyClass || n.relation,
          params.locale
        )} / ${operatorLabel(n.causalOperator, params.locale)}；${depText}。`,
        220
      );
      return {
        id: `step_${cleanText(n.motifId, 64) || idx + 1}`,
        order: idx + 1,
        motifId: n.motifId,
        motifNodeId: n.id,
        role,
        status: n.status,
        dependencyClass: n.dependencyClass || n.relation,
        causalOperator: n.causalOperator,
        dependsOnMotifIds: deps,
        usedConceptIds: (n.conceptIds || []).slice(0, 8),
        usedConceptTitles: (n.conceptTitles || []).slice(0, 8),
        explanation,
      } as MotifReasoningStep;
    })
    .filter(Boolean) as MotifReasoningStep[];
}

export function buildMotifReasoningView(params: {
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  motifLinks: MotifLink[];
  locale?: AppLocale;
}): MotifReasoningView {
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const motifs = (params.motifs || []).slice();
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
        type: normalizeLinkType(typeRaw),
        confidence: 0.72,
      } as MotifReasoningEdge;
    })
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to);

  const steps = buildReasoningSteps({
    nodes,
    edges,
    locale: params.locale,
  });

  return { nodes, edges, steps };
}
