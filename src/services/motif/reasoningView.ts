import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "./conceptMotifs.js";
import type { MotifLink, MotifLinkType } from "./motifLinks.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import { normalizeMotifLinkType } from "../../core/graph/schemaAdapters.js";

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
  synthetic?: "parallel_branch";
};

export type MotifReasoningStepRole = "premise" | "bridge" | "decision" | "isolated";

export type MotifReasoningStep = {
  step_id: string;
  summary: string;
  motif_ids: string[];
  concept_ids: string[];
  depends_on: string[];
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
  return normalizeMotifLinkType(input, "supports");
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

function dependencyRank(dep: ConceptMotif["dependencyClass"] | ConceptMotif["relation"]): number {
  const raw = cleanText(dep, 40);
  if (raw === "constraint") return 0;
  if (raw === "determine") return 1;
  return 2;
}

function motifSpecificity(m: ConceptMotif): number {
  return Math.max(0, Array.isArray(m.conceptIds) ? m.conceptIds.length : 0);
}

function sameAnchorSort(a: ConceptMotif, b: ConceptMotif): number {
  const depDiff = dependencyRank(a.dependencyClass || a.relation) - dependencyRank(b.dependencyClass || b.relation);
  if (depDiff) return depDiff;
  const activeDiff = (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1);
  if (activeDiff) return activeDiff;
  const specificityDiff = motifSpecificity(a) - motifSpecificity(b);
  if (specificityDiff) return specificityDiff;
  const motifTypeDiff = (a.motifType === "pair" ? 0 : 1) - (b.motifType === "pair" ? 0 : 1);
  if (motifTypeDiff) return motifTypeDiff;
  return clamp01(b.confidence, 0.7) - clamp01(a.confidence, 0.7) || a.id.localeCompare(b.id);
}

function motifParallelRiskClass(m: ConceptMotif): string | null {
  const text = cleanText(
    [m.motif_type_id, m.templateKey, m.motif_type_title, m.title, m.description].filter(Boolean).join(" "),
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

function buildSyntheticParallelBranchEdges(params: {
  motifs: ConceptMotif[];
  motifIdToNodeId: Map<string, string>;
  edgeByKey: Map<string, MotifReasoningEdge>;
}): MotifReasoningEdge[] {
  const motifs = (params.motifs || []).filter((m) => !!cleanText(m.anchorConceptId, 120));
  if (!motifs.length) return [];

  const anchorGroups = new Map<string, ConceptMotif[]>();
  for (const motif of motifs) {
    const anchor = cleanText(motif.anchorConceptId, 120);
    if (!anchor) continue;
    if (!anchorGroups.has(anchor)) anchorGroups.set(anchor, []);
    anchorGroups.get(anchor)!.push(motif);
  }

  const realEdges = Array.from(params.edgeByKey.values()).filter((edge) => !edge.synthetic);
  const incomingByNode = new Map<string, Set<string>>();
  const outgoingByNode = new Map<string, Set<string>>();
  for (const edge of realEdges) {
    if (!incomingByNode.has(edge.to)) incomingByNode.set(edge.to, new Set<string>());
    if (!outgoingByNode.has(edge.from)) outgoingByNode.set(edge.from, new Set<string>());
    incomingByNode.get(edge.to)!.add(edge.from);
    outgoingByNode.get(edge.from)!.add(edge.to);
  }

  const additions: MotifReasoningEdge[] = [];
  for (const group of anchorGroups.values()) {
    const ordered = group.slice().sort(sameAnchorSort);
    let start = -1;
    const flushBlock = (endExclusive: number) => {
      if (start < 0) return;
      const blockStart = start;
      const block = ordered.slice(blockStart, endExclusive);
      start = -1;
      if (block.length < 2) return;
      const predecessor = ordered[blockStart - 1];
      const successor = ordered[endExclusive];
      const blockNodeIds = new Set(
        block.map((motif) => cleanText(params.motifIdToNodeId.get(motif.id), 120)).filter(Boolean)
      );
      const incomingSources = new Set<string>();
      const outgoingTargets = new Set<string>();
      if (predecessor) {
        const predecessorNodeId = cleanText(params.motifIdToNodeId.get(predecessor.id), 120);
        if (predecessorNodeId && !blockNodeIds.has(predecessorNodeId)) incomingSources.add(predecessorNodeId);
      }
      if (successor) {
        const successorNodeId = cleanText(params.motifIdToNodeId.get(successor.id), 120);
        if (successorNodeId && !blockNodeIds.has(successorNodeId)) outgoingTargets.add(successorNodeId);
      }
      for (const motif of block) {
        const nodeId = cleanText(params.motifIdToNodeId.get(motif.id), 120);
        if (!nodeId) continue;
        for (const source of incomingByNode.get(nodeId) || []) {
          if (!blockNodeIds.has(source)) incomingSources.add(source);
        }
        for (const target of outgoingByNode.get(nodeId) || []) {
          if (!blockNodeIds.has(target)) outgoingTargets.add(target);
        }
      }
      for (const motif of block) {
        const nodeId = cleanText(params.motifIdToNodeId.get(motif.id), 120);
        if (!nodeId) continue;
        for (const source of incomingSources) {
          const key = `${source}=>${nodeId}::supports`;
          if (params.edgeByKey.has(key)) continue;
          additions.push({
            id: `me_branch_${cleanText(source, 32)}_${cleanText(nodeId, 32)}_supports`,
            from: source,
            to: nodeId,
            type: "supports",
            confidence: clamp01(motif.confidence, 0.68) * 0.82,
            synthetic: "parallel_branch",
          });
        }
        for (const target of outgoingTargets) {
          const key = `${nodeId}=>${target}::supports`;
          if (params.edgeByKey.has(key)) continue;
          additions.push({
            id: `me_branch_${cleanText(nodeId, 32)}_${cleanText(target, 32)}_supports`,
            from: nodeId,
            to: target,
            type: "supports",
            confidence: clamp01(motif.confidence, 0.68) * 0.82,
            synthetic: "parallel_branch",
          });
        }
      }
    };

    for (let i = 0; i < ordered.length; i += 1) {
      const motif = ordered[i];
      if (motif.motifType === "pair" && dependencyRank(motif.dependencyClass || motif.relation) === 0 && motifParallelRiskClass(motif)) {
        if (start < 0) start = i;
        continue;
      }
      flushBlock(i);
    }
    flushBlock(ordered.length);
  }

  const dedup = new Map<string, MotifReasoningEdge>();
  for (const edge of additions) {
    const key = `${edge.from}=>${edge.to}::${edge.type}`;
    if (!dedup.has(key)) dedup.set(key, edge);
  }
  return Array.from(dedup.values());
}

function roleLabel(role: MotifReasoningStepRole, locale?: AppLocale): string {
  if (role === "premise") return t(locale, "前提", "premise");
  if (role === "bridge") return t(locale, "桥接", "bridge");
  if (role === "decision") return t(locale, "决策", "decision");
  return t(locale, "独立", "isolated");
}

function influenceScore(params: {
  node: MotifReasoningNode;
  indeg: number;
  outdeg: number;
}): number {
  const statusBoost = statusRank(params.node.status) * 0.06;
  const confidenceBoost = clamp01(params.node.confidence, 0.72);
  const topologyBoost = Math.min(0.2, Math.max(0, params.outdeg) * 0.02 + Math.max(0, params.indeg) * 0.01);
  const conceptBoost = Math.min(0.08, (params.node.conceptIds || []).length * 0.01);
  return confidenceBoost + statusBoost + topologyBoost + conceptBoost;
}

function tarjanScc(params: {
  nodeIds: string[];
  adjacency: Map<string, string[]>;
}): { components: string[][]; componentIndexByNodeId: Map<string, number> } {
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let index = 0;

  const strongConnect = (nodeId: string) => {
    indexByNode.set(nodeId, index);
    lowLinkByNode.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const to of params.adjacency.get(nodeId) || []) {
      if (!indexByNode.has(to)) {
        strongConnect(to);
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId) || 0, lowLinkByNode.get(to) || 0)
        );
      } else if (onStack.has(to)) {
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId) || 0, indexByNode.get(to) || 0)
        );
      }
    }

    if ((lowLinkByNode.get(nodeId) || 0) === (indexByNode.get(nodeId) || 0)) {
      const component: string[] = [];
      while (stack.length) {
        const popped = stack.pop() as string;
        onStack.delete(popped);
        component.push(popped);
        if (popped === nodeId) break;
      }
      components.push(component);
    }
  };

  for (const nodeId of params.nodeIds || []) {
    if (!indexByNode.has(nodeId)) strongConnect(nodeId);
  }

  const componentIndexByNodeId = new Map<string, number>();
  components.forEach((component, idx) => {
    component.forEach((nodeId) => componentIndexByNodeId.set(nodeId, idx));
  });

  return { components, componentIndexByNodeId };
}

function orderNodesByCondensedDag(params: {
  nodeIds: string[];
  adjacency: Map<string, string[]>;
  nodePriorityById: Map<string, number>;
}): string[] {
  const scc = tarjanScc({
    nodeIds: params.nodeIds,
    adjacency: params.adjacency,
  });
  if (!scc.components.length) return params.nodeIds.slice();

  const componentOut = new Map<number, Set<number>>();
  const componentIndeg = new Map<number, number>();
  const componentPriority = new Map<number, number>();

  scc.components.forEach((component, cid) => {
    componentOut.set(cid, new Set<number>());
    componentIndeg.set(cid, 0);
    const score =
      component.reduce((sum, nodeId) => sum + (params.nodePriorityById.get(nodeId) || 0), 0) /
      Math.max(1, component.length);
    componentPriority.set(cid, score);
  });

  for (const from of params.nodeIds) {
    const fromCid = scc.componentIndexByNodeId.get(from);
    if (fromCid == null) continue;
    for (const to of params.adjacency.get(from) || []) {
      const toCid = scc.componentIndexByNodeId.get(to);
      if (toCid == null || toCid === fromCid) continue;
      const outs = componentOut.get(fromCid)!;
      if (outs.has(toCid)) continue;
      outs.add(toCid);
      componentIndeg.set(toCid, (componentIndeg.get(toCid) || 0) + 1);
    }
  }

  const queue = Array.from(componentIndeg.entries())
    .filter(([, deg]) => deg <= 0)
    .map(([cid]) => cid)
    .sort((a, b) => {
      const pa = componentPriority.get(a) || 0;
      const pb = componentPriority.get(b) || 0;
      if (pb !== pa) return pb - pa;
      return a - b;
    });

  const orderedComponents: number[] = [];
  const seen = new Set<number>();
  while (queue.length) {
    const cid = queue.shift() as number;
    if (seen.has(cid)) continue;
    seen.add(cid);
    orderedComponents.push(cid);
    for (const toCid of componentOut.get(cid) || []) {
      componentIndeg.set(toCid, (componentIndeg.get(toCid) || 0) - 1);
      if ((componentIndeg.get(toCid) || 0) <= 0) queue.push(toCid);
    }
    queue.sort((a, b) => {
      const pa = componentPriority.get(a) || 0;
      const pb = componentPriority.get(b) || 0;
      if (pb !== pa) return pb - pa;
      return a - b;
    });
  }

  for (let cid = 0; cid < scc.components.length; cid += 1) {
    if (seen.has(cid)) continue;
    orderedComponents.push(cid);
  }

  const ordered: string[] = [];
  for (const cid of orderedComponents) {
    const component = (scc.components[cid] || [])
      .slice()
      .sort((a, b) => (params.nodePriorityById.get(b) || 0) - (params.nodePriorityById.get(a) || 0) || a.localeCompare(b));
    ordered.push(...component);
  }
  return ordered;
}

function buildReasoningSteps(params: {
  nodes: MotifReasoningNode[];
  edges: MotifReasoningEdge[];
  locale?: AppLocale;
}): MotifReasoningStep[] {
  const structuralEdges = (params.edges || []).filter((edge) => edge.synthetic !== "parallel_branch");
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
  for (const e of structuralEdges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to) || e.from === e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    outdeg.set(e.from, (outdeg.get(e.from) || 0) + 1);
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
  }

  const nodePriorityById = new Map<string, number>();
  for (const n of params.nodes || []) {
    nodePriorityById.set(
      n.id,
      influenceScore({
        node: n,
        indeg: indeg.get(n.id) || 0,
        outdeg: outdeg.get(n.id) || 0,
      })
    );
  }
  const orderedIds = orderNodesByCondensedDag({
    nodeIds: (params.nodes || []).map((n) => n.id),
    adjacency: outgoing,
    nodePriorityById,
  });

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
        step_id: `S${idx + 1}`,
        summary: cleanText(`${n.title} · ${dependencyLabel(n.dependencyClass || n.relation, params.locale)}`, 180),
        motif_ids: [n.motifId],
        concept_ids: (n.conceptIds || []).slice(0, 8),
        depends_on: deps,
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
  const motifs = (params.motifs || [])
    .filter((m) => m.status !== "cancelled" && (m.reuseClass || "reusable") === "reusable")
    .slice();
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
  const edgeByKey = new Map<string, MotifReasoningEdge>();
  for (const x of params.motifLinks || []) {
    if (!motifById.has(x.fromMotifId) || !motifById.has(x.toMotifId)) continue;
    const from = motifIdToNodeId.get(x.fromMotifId) || "";
    const to = motifIdToNodeId.get(x.toMotifId) || "";
    if (!nodeIdSet.has(from) || !nodeIdSet.has(to) || from === to) continue;
    const type = normalizeLinkType(String(x.type || ""));
    const confidence = clamp01((x as any)?.confidence, 0.72);
    const key = `${from}=>${to}::${type}`;
    const prev = edgeByKey.get(key);
    if (!prev || confidence > prev.confidence) {
      edgeByKey.set(key, {
        id: cleanText((x as any)?.id, 120) || `me_${cleanText(x.fromMotifId, 40)}_${cleanText(x.toMotifId, 40)}_${type}`,
        from,
        to,
        type,
        confidence,
      });
    }
  }
  for (const edge of buildSyntheticParallelBranchEdges({ motifs, motifIdToNodeId, edgeByKey })) {
    const key = `${edge.from}=>${edge.to}::${edge.type}`;
    if (!edgeByKey.has(key)) edgeByKey.set(key, edge);
  }
  const edges: MotifReasoningEdge[] = Array.from(edgeByKey.values()).sort(
    (a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id)
  );

  const steps = buildReasoningSteps({
    nodes,
    edges,
    locale: params.locale,
  });

  return { nodes, edges, steps };
}
