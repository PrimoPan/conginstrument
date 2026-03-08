import assert from "node:assert/strict";

import { reconcileMotifLinks, type MotifLink } from "../motif/motifLinks.js";
import { buildMotifReasoningView } from "../motif/reasoningView.js";
import type { CDG } from "../../core/graph.js";
import type { ConceptItem } from "../concepts.js";
import { buildCognitiveModel } from "../cognitiveModel.js";
import {
  enforceCausalEdgeCoverage,
  reconcileMotifsWithGraph,
  type ConceptMotif,
} from "../motif/conceptMotifs.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function makeConcept(
  id: string,
  title: string,
  patch?: Partial<Pick<ConceptItem, "kind" | "family" | "semanticKey" | "score" | "nodeIds">>
): ConceptItem {
  return {
    id,
    kind: patch?.kind || "belief",
    validationStatus: "resolved",
    extractionStage: "disambiguation",
    polarity: "positive",
    scope: "global",
    family: patch?.family || "other",
    semanticKey: patch?.semanticKey || `manual:${id}`,
    title,
    description: title,
    score: patch?.score == null ? 0.8 : patch.score,
    nodeIds: patch?.nodeIds || [id],
    primaryNodeId: id,
    evidenceTerms: [title],
    sourceMsgIds: ["manual_test"],
    motifIds: [],
    migrationHistory: [],
    locked: false,
    paused: false,
    updatedAt: new Date().toISOString(),
  };
}

function makeMotif(params: {
  id: string;
  conceptIds: string[];
  anchorConceptId: string;
  confidence: number;
  dependencyClass?: "enable" | "constraint" | "determine";
  motifType?: "pair" | "triad";
  status?: "active" | "uncertain" | "deprecated" | "disabled" | "cancelled";
  statusReason?: string;
}): ConceptMotif {
  const dependencyClass = params.dependencyClass || "enable";
  return {
    id: params.id,
    motif_id: params.id,
    motif_type: dependencyClass,
    templateKey: `manual:${params.id}`,
    motifType: params.motifType || "pair",
    relation: dependencyClass,
    roles: {
      sources: params.conceptIds.filter((x) => x !== params.anchorConceptId),
      target: params.anchorConceptId,
    },
    scope: "global",
    aliases: [params.id],
    concept_bindings: params.conceptIds,
    conceptIds: params.conceptIds,
    anchorConceptId: params.anchorConceptId,
    title: params.id,
    description: params.id,
    confidence: params.confidence,
    supportEdgeIds: [],
    supportNodeIds: [],
    status: params.status || "active",
    statusReason: params.statusReason,
    resolved: false,
    novelty: "new",
    updatedAt: new Date().toISOString(),
    dependencyClass,
    reuseClass: "reusable",
  } as ConceptMotif;
}

run("motif link transitive reduction removes weak redundant system edge", () => {
  const motifs: ConceptMotif[] = [
    makeMotif({ id: "m1", conceptIds: ["c1", "c2"], anchorConceptId: "c2", confidence: 0.9 }),
    makeMotif({ id: "m2", conceptIds: ["c2", "c3"], anchorConceptId: "c3", confidence: 0.88 }),
    makeMotif({ id: "m3", conceptIds: ["c3", "c4"], anchorConceptId: "c4", confidence: 0.86 }),
  ];

  const links = reconcileMotifLinks({
    motifs,
    baseLinks: [
      {
        id: "l12",
        fromMotifId: "m1",
        toMotifId: "m2",
        type: "precedes",
        confidence: 0.92,
        source: "system",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "l23",
        fromMotifId: "m2",
        toMotifId: "m3",
        type: "precedes",
        confidence: 0.91,
        source: "system",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "l13",
        fromMotifId: "m1",
        toMotifId: "m3",
        type: "precedes",
        confidence: 0.7,
        source: "system",
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const has13 = links.some((l) => l.fromMotifId === "m1" && l.toMotifId === "m3");
  assert.equal(has13, false);
  assert.equal(links.some((l) => l.fromMotifId === "m1" && l.toMotifId === "m2"), true);
  assert.equal(links.some((l) => l.fromMotifId === "m2" && l.toMotifId === "m3"), true);
});

run("motif link transitive reduction keeps user edge", () => {
  const motifs: ConceptMotif[] = [
    makeMotif({ id: "m1", conceptIds: ["c1", "c2"], anchorConceptId: "c2", confidence: 0.9 }),
    makeMotif({ id: "m2", conceptIds: ["c2", "c3"], anchorConceptId: "c3", confidence: 0.88 }),
    makeMotif({ id: "m3", conceptIds: ["c3", "c4"], anchorConceptId: "c4", confidence: 0.86 }),
  ];

  const links = reconcileMotifLinks({
    motifs,
    baseLinks: [
      {
        id: "l12",
        fromMotifId: "m1",
        toMotifId: "m2",
        type: "precedes",
        confidence: 0.92,
        source: "system",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "l23",
        fromMotifId: "m2",
        toMotifId: "m3",
        type: "precedes",
        confidence: 0.91,
        source: "system",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "l13_user",
        fromMotifId: "m1",
        toMotifId: "m3",
        type: "precedes",
        confidence: 0.7,
        source: "user",
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const userEdge = links.find((l) => l.fromMotifId === "m1" && l.toMotifId === "m3");
  assert.ok(userEdge, "expected user edge to remain after reduction");
  assert.equal(userEdge?.source, "user");
});

run("soft-pruned deprecated motifs should not create fake conflict topology", () => {
  const motifs: ConceptMotif[] = [
    makeMotif({
      id: "m_budget",
      conceptIds: ["c_budget", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.91,
      dependencyClass: "constraint",
      status: "active",
    }),
    makeMotif({
      id: "m_pace",
      conceptIds: ["c_pace", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.82,
      dependencyClass: "constraint",
      status: "deprecated",
      statusReason: "evidence_stable;objective_pruned",
    }),
    makeMotif({
      id: "m_real_conflict",
      conceptIds: ["c_conflict", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.8,
      dependencyClass: "constraint",
      status: "deprecated",
      statusReason: "relation_conflict_with:m_budget",
    }),
  ];

  const links = reconcileMotifLinks({ motifs, baseLinks: [] });
  assert.equal(
    links.some((l) => l.fromMotifId === "m_pace" || l.toMotifId === "m_pace"),
    false,
    "objective-pruned motif should not emit auto topology"
  );
  assert.equal(
    links.some(
      (l) =>
        (l.fromMotifId === "m_real_conflict" || l.toMotifId === "m_real_conflict") && l.type === "conflicts_with"
    ),
    true,
    "true conflict motif should still emit conflict topology"
  );
});

run("same-anchor motifs should form a topology chain instead of remaining isolated", () => {
  const concepts = [
    makeConcept("c_budget", "预算上限: 每人1万元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget",
    }),
    makeConcept("c_pace", "节奏偏好: 不要太赶", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:pace:not_rushed",
    }),
    makeConcept("c_lodging", "住宿偏好: 不想频繁换酒店", {
      kind: "preference",
      family: "lodging",
      semanticKey: "slot:lodging",
    }),
    makeConcept("c_goal", "意图: 完成关西7天家庭行程", {
      kind: "belief",
      family: "goal",
      semanticKey: "slot:goal",
    }),
  ];
  const motifs: ConceptMotif[] = [
    makeMotif({
      id: "m_budget_goal",
      conceptIds: ["c_budget", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.92,
      dependencyClass: "constraint",
    }),
    makeMotif({
      id: "m_pace_goal",
      conceptIds: ["c_pace", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.9,
      dependencyClass: "enable",
    }),
    makeMotif({
      id: "m_lodging_goal",
      conceptIds: ["c_lodging", "c_goal"],
      anchorConceptId: "c_goal",
      confidence: 0.88,
      dependencyClass: "enable",
    }),
  ];

  const links = reconcileMotifLinks({ motifs, baseLinks: [] });
  assert.equal(links.length >= 2, true);

  const participation = new Map<string, number>();
  for (const motif of motifs) participation.set(motif.id, 0);
  for (const link of links) {
    participation.set(link.fromMotifId, (participation.get(link.fromMotifId) || 0) + 1);
    participation.set(link.toMotifId, (participation.get(link.toMotifId) || 0) + 1);
  }
  assert.equal(
    motifs.every((motif) => (participation.get(motif.id) || 0) > 0),
    true
  );

  const view = buildMotifReasoningView({
    concepts,
    motifs,
    motifLinks: links,
    locale: "zh-CN",
  });
  assert.equal(view.steps.some((step) => step.role === "isolated"), false);
  assert.equal(
    view.steps.some((step) => step.dependsOnMotifIds.length > 0 || step.role === "premise"),
    true
  );
});

run("same-anchor health-related constraints should stay peer-level instead of chaining", () => {
  const motifs: ConceptMotif[] = [
    {
      ...makeMotif({
        id: "m_cardiac_goal",
        conceptIds: ["c_cardiac", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.94,
        dependencyClass: "constraint",
      }),
      title: "限制因素: 我还有冠心病 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:coronary->goal",
    },
    {
      ...makeMotif({
        id: "m_sleep_goal",
        conceptIds: ["c_sleep", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.91,
        dependencyClass: "constraint",
      }),
      title: "睡眠问题：早上起不来，晚上需要吃安眠药 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:sleep->goal",
    },
  ];

  const links = reconcileMotifLinks({ motifs, baseLinks: [] });
  assert.equal(
    links.some(
      (link) =>
        (link.fromMotifId === "m_cardiac_goal" && link.toMotifId === "m_sleep_goal") ||
        (link.fromMotifId === "m_sleep_goal" && link.toMotifId === "m_cardiac_goal")
    ),
    false
  );
});

run("reasoning view should fan out parallel health constraints and merge back downstream", () => {
  const concepts = [
    makeConcept("c_budget", "预算上限: 12000元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget",
    }),
    makeConcept("c_cardiac", "限制因素: 我还有冠心病", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:coronary",
    }),
    makeConcept("c_sleep", "睡眠问题: 早上起不来，晚上需要安眠药", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:sleep",
    }),
    makeConcept("c_lodging", "住宿偏好: 酒店靠车站", {
      kind: "preference",
      family: "lodging",
      semanticKey: "slot:lodging",
    }),
    makeConcept("c_goal", "意图: 去台北旅游3天", {
      kind: "belief",
      family: "goal",
      semanticKey: "slot:goal",
    }),
  ];
  const motifs: ConceptMotif[] = [
    {
      ...makeMotif({
        id: "m_budget_goal",
        conceptIds: ["c_budget", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.93,
        dependencyClass: "constraint",
      }),
      title: "预算上限: 12000元 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_budget->goal",
    },
    {
      ...makeMotif({
        id: "m_cardiac_goal",
        conceptIds: ["c_cardiac", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.95,
        dependencyClass: "constraint",
      }),
      title: "限制因素: 我还有冠心病 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:coronary->goal",
    },
    {
      ...makeMotif({
        id: "m_sleep_goal",
        conceptIds: ["c_sleep", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.94,
        dependencyClass: "constraint",
      }),
      title: "睡眠问题: 早上起不来，晚上需要安眠药 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:sleep->goal",
    },
    {
      ...makeMotif({
        id: "m_lodging_goal",
        conceptIds: ["c_lodging", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.87,
        dependencyClass: "enable",
      }),
      title: "住宿偏好: 酒店靠车站 支持 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_enable_lodging->goal",
    },
  ];

  const view = buildMotifReasoningView({
    concepts,
    motifs,
    motifLinks: [],
    locale: "zh-CN",
  });
  const nodeIdByMotifId = new Map(view.nodes.map((node) => [node.motifId, node.id]));
  const budgetNode = nodeIdByMotifId.get("m_budget_goal")!;
  const cardiacNode = nodeIdByMotifId.get("m_cardiac_goal")!;
  const sleepNode = nodeIdByMotifId.get("m_sleep_goal")!;
  const lodgingNode = nodeIdByMotifId.get("m_lodging_goal")!;

  const hasEdge = (from: string, to: string) =>
    view.edges.some((edge) => edge.from === from && edge.to === to && edge.synthetic === "parallel_branch");

  assert.equal(hasEdge(budgetNode, cardiacNode), true);
  assert.equal(hasEdge(budgetNode, sleepNode), true);
  assert.equal(hasEdge(cardiacNode, lodgingNode), true);
  assert.equal(hasEdge(sleepNode, lodgingNode), true);
  assert.equal(view.edges.some((edge) => edge.from === cardiacNode && edge.to === sleepNode), false);
  assert.equal(view.edges.some((edge) => edge.from === sleepNode && edge.to === cardiacNode), false);
});

run("reasoning view should keep health fan-out between budget cap and remaining-budget follow-up", () => {
  const concepts = [
    makeConcept("c_budget", "预算上限: 12000元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget",
    }),
    makeConcept("c_budget_remaining", "剩余预算: 12000元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget_remaining",
    }),
    makeConcept("c_cardiac", "限制因素: 爸爸有冠心病", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:coronary",
    }),
    makeConcept("c_sleep", "限制因素: 妈妈睡眠很浅，晚上要早点回酒店", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:sleep",
    }),
    makeConcept("c_goal", "意图: 去台北旅游3天", {
      kind: "belief",
      family: "goal",
      semanticKey: "slot:goal",
    }),
  ];
  const motifs: ConceptMotif[] = [
    {
      ...makeMotif({
        id: "m_budget_goal",
        conceptIds: ["c_budget", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.93,
        dependencyClass: "constraint",
      }),
      title: "预算上限: 12000元 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_budget->goal",
    },
    {
      ...makeMotif({
        id: "m_cardiac_goal",
        conceptIds: ["c_cardiac", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.95,
        dependencyClass: "constraint",
      }),
      title: "限制因素: 爸爸有冠心病 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:coronary->goal",
    },
    {
      ...makeMotif({
        id: "m_sleep_goal",
        conceptIds: ["c_sleep", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.94,
        dependencyClass: "constraint",
      }),
      title: "限制因素: 妈妈睡眠很浅，晚上要早点回酒店 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_slot:constraint:limiting:health:sleep->goal",
    },
    {
      ...makeMotif({
        id: "m_budget_remaining_goal",
        conceptIds: ["c_budget_remaining", "c_goal"],
        anchorConceptId: "c_goal",
        confidence: 0.92,
        dependencyClass: "constraint",
      }),
      title: "剩余预算: 12000元 限制 意图: 去台北旅游3天",
      motif_type_id: "mt_pattern:pair_constraint_budget_remaining->goal",
    },
  ];

  const view = buildMotifReasoningView({
    concepts,
    motifs,
    motifLinks: [],
    locale: "zh-CN",
  });
  const nodeIdByMotifId = new Map(view.nodes.map((node) => [node.motifId, node.id]));
  const budgetNode = nodeIdByMotifId.get("m_budget_goal")!;
  const cardiacNode = nodeIdByMotifId.get("m_cardiac_goal")!;
  const sleepNode = nodeIdByMotifId.get("m_sleep_goal")!;
  const remainingNode = nodeIdByMotifId.get("m_budget_remaining_goal")!;
  const hasSyntheticEdge = (from: string, to: string) =>
    view.edges.some((edge) => edge.from === from && edge.to === to && edge.synthetic === "parallel_branch");

  assert.equal(hasSyntheticEdge(budgetNode, cardiacNode), true);
  assert.equal(hasSyntheticEdge(budgetNode, sleepNode), true);
  assert.equal(hasSyntheticEdge(cardiacNode, remainingNode), true);
  assert.equal(hasSyntheticEdge(sleepNode, remainingNode), true);
});

run("reasoning view should produce complete ordered steps under cycle", () => {
  const concepts = [
    makeConcept("c1", "Concept A"),
    makeConcept("c2", "Concept B"),
    makeConcept("c3", "Concept C"),
    makeConcept("c4", "Concept D"),
  ];
  const motifs: ConceptMotif[] = [
    makeMotif({ id: "m1", conceptIds: ["c1", "c2"], anchorConceptId: "c2", confidence: 0.82 }),
    makeMotif({ id: "m2", conceptIds: ["c2", "c3"], anchorConceptId: "c3", confidence: 0.91 }),
    makeMotif({ id: "m3", conceptIds: ["c3", "c4"], anchorConceptId: "c4", confidence: 0.78 }),
  ];
  const motifLinks: MotifLink[] = [
    {
      id: "e12",
      fromMotifId: "m1",
      toMotifId: "m2",
      type: "supports",
      confidence: 0.9,
      source: "system",
      updatedAt: new Date().toISOString(),
    },
    {
      id: "e21",
      fromMotifId: "m2",
      toMotifId: "m1",
      type: "supports",
      confidence: 0.86,
      source: "system",
      updatedAt: new Date().toISOString(),
    },
    {
      id: "e23",
      fromMotifId: "m2",
      toMotifId: "m3",
      type: "precedes",
      confidence: 0.88,
      source: "system",
      updatedAt: new Date().toISOString(),
    },
  ];

  const view = buildMotifReasoningView({
    concepts,
    motifs,
    motifLinks,
    locale: "zh-CN",
  });

  assert.equal(view.steps.length, 3);
  const orderedMotifs = view.steps.map((s) => s.motifId);
  assert.equal(new Set(orderedMotifs).size, 3);
  assert.equal(orderedMotifs.includes("m1"), true);
  assert.equal(orderedMotifs.includes("m2"), true);
  assert.equal(orderedMotifs.includes("m3"), true);
});

run("causal edge coverage repair should cover all required edges and keep isolated concepts optional", () => {
  const graph: CDG = {
    id: "g_coverage",
    version: 1,
    nodes: [
      { id: "n1", type: "constraint", statement: "预算上限10000元", status: "confirmed", confidence: 0.9, importance: 0.9 },
      { id: "n2", type: "belief", statement: "总行程3天", status: "confirmed", confidence: 0.9, importance: 0.86 },
      { id: "n3", type: "constraint", statement: "恐高不能登顶", status: "confirmed", confidence: 0.9, importance: 0.9 },
      { id: "n4", type: "belief", statement: "地面活动为主", status: "confirmed", confidence: 0.88, importance: 0.82 },
      { id: "n5", type: "factual_assertion", statement: "孤立事实", status: "confirmed", confidence: 0.7, importance: 0.4 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", type: "constraint", confidence: 0.92 },
      { id: "e2", from: "n3", to: "n4", type: "constraint", confidence: 0.9 },
    ],
  };

  const concepts: ConceptItem[] = [
    makeConcept("c1", "预算上限: 10000元", { kind: "constraint", family: "budget", semanticKey: "slot:budget", nodeIds: ["n1"] }),
    makeConcept("c2", "总行程时长: 3天", {
      kind: "constraint",
      family: "duration_total",
      semanticKey: "slot:duration_total",
      nodeIds: ["n2"],
    }),
    makeConcept("c3", "限制因素: 不能去很高的建筑", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:acrophobia",
      nodeIds: ["n3"],
    }),
    makeConcept("c4", "活动偏好: 地面活动", {
      kind: "preference",
      family: "activity_preference",
      semanticKey: "slot:activity_preference",
      nodeIds: ["n4"],
    }),
    makeConcept("c5", "备注: 孤立事实", {
      kind: "factual_assertion",
      family: "other",
      semanticKey: "manual:isolated",
      nodeIds: ["n5"],
    }),
  ];

  const covered = enforceCausalEdgeCoverage({
    graph,
    concepts,
    motifs: [],
    locale: "zh-CN",
    maxRounds: 2,
  });

  assert.equal(covered.report.requiredCausalEdges, 2);
  assert.equal(covered.report.coveredCausalEdges, 2);
  assert.equal(covered.report.uncoveredCausalEdges, 0);
  assert.equal(covered.report.repairedMotifCount, 2);
  assert.equal(covered.report.componentCount, 2);
  assert.equal(covered.motifs.every((m) => m.coverage_origin === "edge_repair"), true);
  assert.equal(covered.motifs.every((m) => m.subgraph_verified === true), true);
});

run("coverage repair should skip destination-to-duration metadata edges", () => {
  const graph: CDG = {
    id: "g_coverage_skip_meta",
    version: 1,
    nodes: [
      { id: "n_dest", type: "factual_assertion", statement: "目的地: 米兰", status: "confirmed", confidence: 0.9, importance: 0.82 },
      { id: "n_dur", type: "constraint", statement: "总行程时长: 3天", status: "confirmed", confidence: 0.9, importance: 0.86 },
    ],
    edges: [{ id: "e_meta", from: "n_dest", to: "n_dur", type: "constraint", confidence: 0.9 }],
  };

  const concepts: ConceptItem[] = [
    makeConcept("c_dest", "目的地: 米兰", {
      kind: "factual_assertion",
      family: "destination",
      semanticKey: "slot:destination:米兰",
      nodeIds: ["n_dest"],
    }),
    makeConcept("c_dur", "总行程时长: 3天", {
      kind: "constraint",
      family: "duration_total",
      semanticKey: "slot:duration_total",
      nodeIds: ["n_dur"],
    }),
  ];

  const covered = enforceCausalEdgeCoverage({
    graph,
    concepts,
    motifs: [],
    locale: "zh-CN",
    maxRounds: 2,
  });

  assert.equal(covered.report.requiredCausalEdges, 0);
  assert.equal(covered.report.coveredCausalEdges, 0);
  assert.equal(covered.report.uncoveredCausalEdges, 0);
  assert.equal(covered.report.repairedMotifCount, 0);
  assert.equal((covered.report.excludedNonReasoningEdges || 0) >= 1, true);
  assert.equal((covered.report.excludedByReason?.metadata_destination_duration || 0) >= 1, true);
  assert.equal(covered.motifs.length, 0);
});

run("milan limiting constraints should stay visible in motif titles", () => {
  const graph: CDG = {
    id: "g_milan",
    version: 1,
    nodes: [
      { id: "n_goal", type: "belief", statement: "意图: 去米兰旅游3天", status: "confirmed", confidence: 0.9, importance: 0.9 },
      { id: "n_budget", type: "constraint", statement: "预算上限: 10000元", status: "confirmed", confidence: 0.9, importance: 0.88 },
      { id: "n_duration", type: "constraint", statement: "总行程时长: 3天", status: "confirmed", confidence: 0.9, importance: 0.86 },
      { id: "n_people", type: "factual_assertion", statement: "同行人数: 2人", status: "confirmed", confidence: 0.88, importance: 0.84 },
      { id: "n_acro", type: "constraint", statement: "限制因素: 我有恐高症，不能去很高的建筑", status: "confirmed", confidence: 0.9, importance: 0.9 },
      { id: "n_cardiac", type: "constraint", statement: "限制因素: 父亲有冠心病，避免高强度活动", status: "confirmed", confidence: 0.9, importance: 0.9 },
    ],
    edges: [
      { id: "e_budget", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.93 },
      { id: "e_duration", from: "n_duration", to: "n_goal", type: "constraint", confidence: 0.9 },
      { id: "e_people", from: "n_people", to: "n_goal", type: "constraint", confidence: 0.88 },
      { id: "e_acro", from: "n_acro", to: "n_goal", type: "constraint", confidence: 0.92 },
      { id: "e_cardiac", from: "n_cardiac", to: "n_goal", type: "constraint", confidence: 0.92 },
    ],
  };

  const concepts: ConceptItem[] = [
    makeConcept("c_goal", "意图: 去米兰旅游3天", { kind: "belief", family: "goal", semanticKey: "slot:goal", nodeIds: ["n_goal"] }),
    makeConcept("c_budget", "预算上限: 10000元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget",
      nodeIds: ["n_budget"],
      score: 0.85,
    }),
    makeConcept("c_duration", "总行程时长: 3天", {
      kind: "constraint",
      family: "duration_total",
      semanticKey: "slot:duration_total",
      nodeIds: ["n_duration"],
      score: 0.84,
    }),
    makeConcept("c_people", "同行人数: 2人", {
      kind: "factual_assertion",
      family: "people",
      semanticKey: "slot:people",
      nodeIds: ["n_people"],
      score: 0.84,
    }),
    makeConcept("c_acro", "限制因素: 我有恐高症，不能去很高的建筑", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:acrophobia",
      nodeIds: ["n_acro"],
      score: 0.86,
    }),
    makeConcept("c_cardiac", "限制因素: 父亲有冠心病，避免高强度活动", {
      kind: "constraint",
      family: "limiting_factor",
      semanticKey: "slot:constraint:limiting:health:coronary",
      nodeIds: ["n_cardiac"],
      score: 0.86,
    }),
  ];

  const model = buildCognitiveModel({
    graph,
    prevConcepts: concepts,
    baseConcepts: concepts,
    baseMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
    locale: "zh-CN",
  });
  const titles = (model.motifs || []).map((m) => m.title).join(" | ");

  assert.equal(/恐高/.test(titles), true);
  assert.equal(/冠心病/.test(titles), true);
  assert.equal(/同行人数|2人/.test(titles), true);
});

run("tautological duration-to-goal motif should not be exposed when goal already encodes the same duration", () => {
  const graph: CDG = {
    id: "g_taipei_duration_tautology",
    version: 1,
    nodes: [
      { id: "n_goal", type: "belief", statement: "意图: 去台北旅游3天", status: "confirmed", confidence: 0.9, importance: 0.9 },
      { id: "n_duration", type: "constraint", statement: "总行程时长: 3天", status: "confirmed", confidence: 0.9, importance: 0.86 },
      { id: "n_budget", type: "constraint", statement: "预算上限: 12000元", status: "confirmed", confidence: 0.9, importance: 0.88 },
    ],
    edges: [
      { id: "e_duration", from: "n_duration", to: "n_goal", type: "constraint", confidence: 0.92 },
      { id: "e_budget", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.92 },
    ],
  };

  const concepts: ConceptItem[] = [
    makeConcept("c_goal", "意图: 去台北旅游3天", {
      kind: "belief",
      family: "goal",
      semanticKey: "slot:goal",
      nodeIds: ["n_goal"],
    }),
    makeConcept("c_duration", "总行程时长: 3天", {
      kind: "constraint",
      family: "duration_total",
      semanticKey: "slot:duration_total",
      nodeIds: ["n_duration"],
    }),
    makeConcept("c_budget", "预算上限: 12000元", {
      kind: "constraint",
      family: "budget",
      semanticKey: "slot:budget",
      nodeIds: ["n_budget"],
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph,
    concepts,
    baseMotifs: [],
    locale: "zh-CN",
  });

  const tautological = motifs.find((motif) => {
    const ids = motif.conceptIds || [];
    return ids.includes("c_duration") && ids.includes("c_goal");
  });
  assert.equal(!!tautological, false);
  assert.equal(
    motifs.some((motif) => {
      if (motif.motifType !== "pair") return false;
      const ids = motif.conceptIds || [];
      return ids.includes("c_budget") && ids.includes("c_goal");
    }),
    true
  );
});

console.log("All motif pipeline checks passed.");
