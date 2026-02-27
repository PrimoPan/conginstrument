import type { CDG } from "../core/graph.js";
import type { ConceptItem } from "./concepts.js";
import type { ConceptMotif, MotifLifecycleStatus } from "./motif/conceptMotifs.js";

export type ContextStatus = "active" | "uncertain" | "conflicted" | "disabled";

export type ContextItem = {
  id: string;
  key: string;
  title: string;
  summary: string;
  status: ContextStatus;
  confidence: number;
  conceptIds: string[];
  motifIds: string[];
  nodeIds: string[];
  tags: string[];
  openQuestions: string[];
  locked: boolean;
  paused: boolean;
  updatedAt: string;
};

function cleanText(input: any, max = 220): string {
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

function uniq(arr: string[], max = 120): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const x = cleanText(item, 160);
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
    .replace(/[^a-z0-9_\-:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `ctx_${safe.slice(0, 120) || "context"}`;
}

function motifStatusRank(s: MotifLifecycleStatus): number {
  if (s === "deprecated") return 4;
  if (s === "uncertain") return 3;
  if (s === "disabled") return 2;
  if (s === "active") return 1;
  return 0;
}

function contextStatusFromMotifs(motifs: ConceptMotif[], paused: boolean): ContextStatus {
  if (paused) return "disabled";
  if (!motifs.length) return "active";
  const statuses = motifs.map((m) => m.status);
  if (statuses.some((s) => s === "deprecated")) return "conflicted";
  if (statuses.some((s) => s === "uncertain")) return "uncertain";
  const activeCount = statuses.filter((s) => s === "active").length;
  const disabledCount = statuses.filter((s) => s === "disabled").length;
  if (!activeCount && disabledCount > 0) return "disabled";
  return "active";
}

function contextConfidence(motifs: ConceptMotif[]): number {
  if (!motifs.length) return 0.68;
  const scored = motifs
    .filter((m) => m.status !== "cancelled")
    .map((m) => clamp01(m.confidence, 0.72) * (m.status === "active" ? 1 : m.status === "uncertain" ? 0.82 : 0.62));
  if (!scored.length) return 0.62;
  return clamp01(scored.reduce((a, b) => a + b, 0) / scored.length, 0.7);
}

function buildOpenQuestions(motifs: ConceptMotif[], max = 4): string[] {
  const questions: string[] = [];
  for (const m of motifs) {
    if (m.status === "uncertain") {
      questions.push(`请确认：${cleanText(m.title, 68)}`);
    } else if (m.status === "deprecated") {
      questions.push(`冲突待解：${cleanText(m.title, 68)}`);
    }
    if (questions.length >= max) break;
  }
  return uniq(questions, max);
}

function normalizeContexts(input: any): ContextItem[] {
  const arr = Array.isArray(input) ? input : [];
  const out: ContextItem[] = [];
  const seen = new Set<string>();

  for (const raw of arr) {
    const key = cleanText((raw as any)?.key, 120);
    const id = cleanText((raw as any)?.id, 120) || stableId(key || "context");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const statusRaw = cleanText((raw as any)?.status, 40).toLowerCase();
    const status: ContextStatus =
      statusRaw === "uncertain" || statusRaw === "conflicted" || statusRaw === "disabled" ? (statusRaw as ContextStatus) : "active";

    out.push({
      id,
      key: key || id,
      title: cleanText((raw as any)?.title, 80) || "Context",
      summary: cleanText((raw as any)?.summary, 220),
      status,
      confidence: clamp01((raw as any)?.confidence, 0.7),
      conceptIds: uniq(
        (Array.isArray((raw as any)?.conceptIds) ? (raw as any).conceptIds : []).map((x: any) => cleanText(x, 80)),
        80
      ),
      motifIds: uniq(
        (Array.isArray((raw as any)?.motifIds) ? (raw as any).motifIds : []).map((x: any) => cleanText(x, 80)),
        120
      ),
      nodeIds: uniq(
        (Array.isArray((raw as any)?.nodeIds) ? (raw as any).nodeIds : []).map((x: any) => cleanText(x, 80)),
        160
      ),
      tags: uniq((Array.isArray((raw as any)?.tags) ? (raw as any).tags : []).map((x: any) => cleanText(x, 40)), 32),
      openQuestions: uniq(
        (Array.isArray((raw as any)?.openQuestions) ? (raw as any).openQuestions : []).map((x: any) => cleanText(x, 120)),
        8
      ),
      locked: !!(raw as any)?.locked,
      paused: !!(raw as any)?.paused,
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

function conceptNodeIds(concepts: ConceptItem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of concepts || []) {
    map.set(c.id, uniq(c.nodeIds || [], 36));
  }
  return map;
}

function destinationContexts(params: {
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  nodeIdsByConcept: Map<string, string[]>;
}): ContextItem[] {
  const now = new Date().toISOString();
  const out: ContextItem[] = [];
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const destinations = (params.concepts || []).filter((c) => c.family === "destination").slice(0, 8);

  for (const d of destinations) {
    const motifPool = (params.motifs || []).filter((m) => (m.conceptIds || []).includes(d.id) && m.status !== "cancelled");
    const motifPoolSorted = motifPool
      .slice()
      .sort((a, b) => motifStatusRank(b.status) - motifStatusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id));
    const motifIds = motifPoolSorted.map((m) => m.id).slice(0, 40);
    const conceptIds = uniq([d.id, ...motifPoolSorted.flatMap((m) => m.conceptIds || [])], 60);
    const nodeIds = uniq(conceptIds.flatMap((cid) => params.nodeIdsByConcept.get(cid) || []), 120);
    const status = contextStatusFromMotifs(motifPoolSorted, false);
    const confidence = contextConfidence(motifPoolSorted);
    const openQuestions = buildOpenQuestions(motifPoolSorted, 4);

    const destinationTitle = cleanText(d.title, 80).replace(/^目的地[:：]\s*/i, "") || d.title;
    const coreConcepts = conceptIds
      .map((cid) => conceptById.get(cid))
      .filter(Boolean)
      .slice(0, 5)
      .map((x) => cleanText(x!.title, 24));

    out.push({
      id: stableId(`destination:${d.semanticKey}`),
      key: `destination:${d.semanticKey}`,
      title: `Context：${destinationTitle}`,
      summary: cleanText(
        `${destinationTitle} 情境下的认知结构，包含 ${motifIds.length} 个 motif；核心概念：${coreConcepts.join("、") || "待补充"}`,
        220
      ),
      status,
      confidence,
      conceptIds,
      motifIds,
      nodeIds,
      tags: uniq(["destination", destinationTitle, ...coreConcepts], 18),
      openQuestions,
      locked: false,
      paused: false,
      updatedAt: now,
    });
  }

  return out;
}

function globalContext(params: {
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  nodeIdsByConcept: Map<string, string[]>;
  graph: CDG;
}): ContextItem {
  const now = new Date().toISOString();
  const concepts = params.concepts || [];
  const motifs = (params.motifs || [])
    .filter((m) => m.status !== "cancelled")
    .slice()
    .sort((a, b) => motifStatusRank(b.status) - motifStatusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id));

  const coreConcepts = concepts
    .slice()
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 18);
  const conceptIds = coreConcepts.map((c) => c.id);
  const motifIds = motifs.map((m) => m.id).slice(0, 80);
  const nodeIds = uniq(conceptIds.flatMap((cid) => params.nodeIdsByConcept.get(cid) || []), 200);
  const status = contextStatusFromMotifs(motifs, false);
  const confidence = contextConfidence(motifs);
  const openQuestions = buildOpenQuestions(motifs, 6);
  const beliefs = concepts
    .filter((c) => c.family === "goal" || c.kind === "belief")
    .map((c) => cleanText(c.title, 28))
    .slice(0, 3);
  const constraints = concepts.filter((c) => c.kind === "constraint").length;
  const preferences = concepts.filter((c) => c.kind === "preference").length;
  const factual = concepts.filter((c) => c.kind === "factual_assertion").length;

  return {
    id: stableId("global_planning"),
    key: "global_planning",
    title: "Context：全局任务情境",
    summary: cleanText(
      `当前任务图包含 ${params.graph.nodes?.length || 0} 个节点、${params.graph.edges?.length || 0} 条边；核心信念：${
        beliefs.join("、") || "待确认"
      }；Constraint ${constraints} 项，Preference ${preferences} 项，Factual ${factual} 项。`,
      220
    ),
    status,
    confidence,
    conceptIds,
    motifIds,
    nodeIds,
    tags: uniq(["global", "planning", ...beliefs], 20),
    openQuestions,
    locked: false,
    paused: false,
    updatedAt: now,
  };
}

export function reconcileContextsWithGraph(params: {
  graph: CDG;
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  baseContexts?: any;
}): ContextItem[] {
  const base = normalizeContexts(params.baseContexts);
  const baseByKey = new Map(base.map((c) => [c.key, c]));
  const nodeIdsByConcept = conceptNodeIds(params.concepts || []);

  const derived: ContextItem[] = [
    globalContext({
      graph: params.graph,
      concepts: params.concepts,
      motifs: params.motifs,
      nodeIdsByConcept,
    }),
    ...destinationContexts({
      concepts: params.concepts,
      motifs: params.motifs,
      nodeIdsByConcept,
    }),
  ];

  const now = new Date().toISOString();
  const merged = derived.map((d) => {
    const prev = baseByKey.get(d.key);
    if (!prev) return d;
    const paused = !!prev.paused;
    const locked = !!prev.locked;
    const status = paused ? "disabled" : d.status;
    return {
      ...d,
      title: cleanText(prev.title, 80) || d.title,
      summary: cleanText(prev.summary, 220) || d.summary,
      paused,
      locked,
      status,
      openQuestions: d.openQuestions.length ? d.openQuestions : prev.openQuestions,
      updatedAt: now,
    };
  });

  return merged
    .slice()
    .sort((a, b) => {
      const statusRank = (x: ContextStatus) => (x === "conflicted" ? 4 : x === "uncertain" ? 3 : x === "active" ? 2 : 1);
      return statusRank(b.status) - statusRank(a.status) || b.confidence - a.confidence || a.title.localeCompare(b.title);
    })
    .slice(0, 80);
}
