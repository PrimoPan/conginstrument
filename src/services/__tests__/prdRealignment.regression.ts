import assert from "node:assert/strict";

import { normalizeConceptType, normalizeExtractionStage, normalizeMotifLinkType } from "../../core/graph/schemaAdapters.js";
import { deriveConceptsFromGraph, CONCEPT_EXTRACTION_STAGES } from "../concepts.js";
import { buildCognitiveModel } from "../cognitiveModel.js";
import { reconcileMotifsWithGraph } from "../motif/conceptMotifs.js";
import { reconcileMotifLinks } from "../motif/motifLinks.js";
import { buildMotifReasoningView } from "../motif/reasoningView.js";
import { buildConflictGatePayload } from "../motif/conflictGate.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

run("concept type strictness + legacy adapter", () => {
  assert.equal(normalizeConceptType("belief"), "belief");
  assert.equal(normalizeConceptType("constraint"), "constraint");
  assert.equal(normalizeConceptType("preference"), "preference");
  assert.equal(normalizeConceptType("factual_assertion"), "factual_assertion");
  assert.equal(normalizeConceptType("goal"), "belief");
  assert.equal(normalizeConceptType("fact"), "factual_assertion");
  assert.equal(normalizeConceptType("question"), "belief");
  assert.equal(normalizeConceptType("unknown_kind"), "constraint");
});

run("extraction stage strictness", () => {
  assert.deepEqual(CONCEPT_EXTRACTION_STAGES, ["identification", "disambiguation"]);
  assert.equal(normalizeExtractionStage("identification"), "identification");
  assert.equal(normalizeExtractionStage("disambiguation"), "disambiguation");
  assert.equal(normalizeExtractionStage("validation"), "disambiguation");
});

run("concept dedup: merge same + keep opposite polarity split", () => {
  const graph = {
    id: "g1",
    version: 1,
    nodes: [
      {
        id: "n1",
        type: "factual_assertion",
        statement: "预算上限：10000元",
        status: "confirmed",
        confidence: 0.92,
        key: "slot:budget",
      },
      {
        id: "n2",
        type: "factual_assertion",
        statement: "预算上限：10000元",
        status: "proposed",
        confidence: 0.75,
        key: "slot:budget",
      },
      {
        id: "n3",
        type: "belief",
        statement: "不要住市中心",
        status: "proposed",
        confidence: 0.74,
        key: "slot:freeform:belief:lodging_center",
      },
      {
        id: "n4",
        type: "belief",
        statement: "住市中心",
        status: "proposed",
        confidence: 0.76,
        key: "slot:freeform:belief:lodging_center",
      },
    ],
    edges: [],
  } as any;

  const concepts = deriveConceptsFromGraph(graph);
  const budgetConcepts = concepts.filter((c) => c.semanticKey === "slot:budget");
  assert.equal(budgetConcepts.length, 1);
  assert.ok((budgetConcepts[0].nodeIds || []).length >= 2);

  const lodgingCenter = concepts.filter((c) => c.semanticKey === "slot:freeform:belief:lodging_center");
  assert.equal(lodgingCenter.length, 2);
  const polarities = new Set(lodgingCenter.map((c) => c.polarity));
  assert.deepEqual(Array.from(polarities).sort(), ["negative", "positive"]);
});

run("motif graph produced before concept projection payload", () => {
  const model = buildCognitiveModel({
    graph: {
      id: "g2",
      version: 1,
      nodes: [
        {
          id: "n_root",
          type: "belief",
          layer: "intent",
          key: "slot:goal",
          statement: "意图：制定旅行计划",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.9,
        },
        {
          id: "n_budget",
          type: "constraint",
          key: "slot:budget",
          statement: "预算上限：10000元",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.85,
        },
      ],
      edges: [
        {
          id: "e1",
          from: "n_budget",
          to: "n_root",
          type: "constraint",
          confidence: 0.86,
        },
      ],
    } as any,
    baseConcepts: [],
    baseMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
  });

  assert.ok(Array.isArray(model.motifGraph.motifs));
  assert.ok(Array.isArray(model.motifGraph.motifLinks));
  assert.ok(Array.isArray(model.concepts));
  assert.ok(model.conceptGraph && Array.isArray(model.conceptGraph.nodes));
});

run("motif topology link normalization and alias redirection", () => {
  const motifs = [
    {
      id: "m_new",
      motif_id: "m_new",
      motif_type: "enable",
      motifType: "pair",
      relation: "enable",
      roles: { sources: ["c1"], target: "c2" },
      scope: "global",
      aliases: ["m_old"],
      concept_bindings: ["c1", "c2"],
      templateKey: "k",
      conceptIds: ["c1", "c2"],
      anchorConceptId: "c2",
      title: "t",
      description: "d",
      confidence: 0.8,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "unchanged",
      updatedAt: new Date().toISOString(),
    },
    {
      id: "m2",
      motif_id: "m2",
      motif_type: "determine",
      motifType: "pair",
      relation: "determine",
      roles: { sources: ["c3"], target: "c4" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c3", "c4"],
      templateKey: "k2",
      conceptIds: ["c3", "c4"],
      anchorConceptId: "c4",
      title: "t2",
      description: "d2",
      confidence: 0.82,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "unchanged",
      updatedAt: new Date().toISOString(),
    },
  ] as any;

  const links = reconcileMotifLinks({
    motifs,
    baseLinks: [
      {
        id: "l1",
        fromMotifId: "m_old",
        toMotifId: "m2",
        type: "depends_on",
        confidence: 0.7,
        source: "user",
      },
      {
        id: "l2",
        fromMotifId: "m2",
        toMotifId: "m_new",
        type: "conflicts",
        confidence: 0.72,
        source: "user",
      },
      {
        id: "l3",
        fromMotifId: "m2",
        toMotifId: "m_new",
        type: "refines",
        confidence: 0.66,
        source: "system",
      },
    ],
  });

  assert.ok(links.some((x) => x.fromMotifId === "m_new" && x.toMotifId === "m2" && x.type === "precedes"));
  assert.ok(links.some((x) => x.type === "conflicts_with" || x.type === "refines"));

  assert.equal(normalizeMotifLinkType("depends_on"), "precedes");
  assert.equal(normalizeMotifLinkType("supports"), "supports");
  assert.equal(normalizeMotifLinkType("conflicts"), "conflicts_with");
  assert.equal(normalizeMotifLinkType("refines"), "refines");
});

run("reasoning-step safe schema fields present", () => {
  const view = buildMotifReasoningView({
    concepts: [
      {
        id: "c1",
        kind: "belief",
        validationStatus: "unasked",
        extractionStage: "disambiguation",
        polarity: "positive",
        scope: "global",
        family: "goal",
        semanticKey: "slot:goal",
        title: "Intent",
        description: "d",
        score: 0.8,
        nodeIds: ["n1"],
        evidenceTerms: [],
        sourceMsgIds: [],
        locked: false,
        paused: false,
        updatedAt: new Date().toISOString(),
      },
    ] as any,
    motifs: [
      {
        id: "m1",
        motif_id: "m1",
        motif_type: "enable",
        motifType: "pair",
        relation: "enable",
        roles: { sources: ["c1"], target: "c1" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c1"],
        conceptIds: ["c1"],
        anchorConceptId: "c1",
        title: "Intent supports itself",
        description: "d",
        confidence: 0.85,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "new",
        updatedAt: new Date().toISOString(),
      },
    ] as any,
    motifLinks: [],
  });

  assert.ok(Array.isArray(view.steps));
  assert.ok(view.steps.length >= 1);
  const first = view.steps[0] as any;
  assert.ok(first.step_id);
  assert.ok(typeof first.summary === "string");
  assert.ok(Array.isArray(first.motif_ids));
  assert.ok(Array.isArray(first.concept_ids));
  assert.ok(Array.isArray(first.depends_on));
});

run("motif reconciliation should expose prd structural fields", () => {
  const graph = {
    id: "g_prd_motif_fields",
    version: 1,
    nodes: [
      {
        id: "n_goal",
        type: "belief",
        layer: "intent",
        statement: "意图：完成旅行计划",
        status: "confirmed",
        confidence: 0.9,
        importance: 0.88,
        key: "slot:goal",
      },
      {
        id: "n_budget",
        type: "constraint",
        layer: "requirement",
        statement: "预算上限：10000元",
        status: "confirmed",
        confidence: 0.88,
        importance: 0.8,
        key: "slot:budget",
      },
    ],
    edges: [{ id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.86 }],
  } as any;

  const concepts = deriveConceptsFromGraph(graph);
  const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
  assert.ok(motifs.length >= 1);
  const motif = motifs[0] as any;
  assert.ok(Array.isArray(motif.source_concept_ids));
  assert.equal(typeof motif.source_concept_id, "string");
  assert.equal(typeof motif.target_concept_id, "string");
  assert.equal(motif.causal_link_type, "constraint");
  assert.equal(typeof motif.pattern_type, "string");
  assert.ok(motif.concept_instances);
  assert.ok(Array.isArray(motif.concept_instances.sources));
  assert.ok(motif.concept_instances.sources.length >= 1);
  assert.equal(motif.concept_instances.sources[0]?.concept_id, motif.source_concept_id);
  assert.equal(motif.concept_instances.target?.concept_id, motif.target_concept_id);
});

run("long motif identifiers should not drop reasoning edges", () => {
  const longA = `m_${"a".repeat(180)}`;
  const longB = `m_${"b".repeat(180)}`;
  const concepts = [
    {
      id: "c_long_1",
      kind: "constraint",
      validationStatus: "resolved",
      extractionStage: "disambiguation",
      polarity: "positive",
      scope: "global",
      family: "budget",
      semanticKey: "slot:budget",
      title: "预算上限",
      description: "d",
      score: 0.88,
      nodeIds: ["n1"],
      sourceMsgIds: ["m1"],
      evidenceTerms: [],
      locked: false,
      paused: false,
      updatedAt: new Date().toISOString(),
    },
    {
      id: "c_long_2",
      kind: "belief",
      validationStatus: "resolved",
      extractionStage: "disambiguation",
      polarity: "positive",
      scope: "global",
      family: "goal",
      semanticKey: "slot:goal",
      title: "旅行意图",
      description: "d",
      score: 0.9,
      nodeIds: ["n2"],
      sourceMsgIds: ["m2"],
      evidenceTerms: [],
      locked: false,
      paused: false,
      updatedAt: new Date().toISOString(),
    },
  ] as any;
  const motifs = [
    {
      id: longA,
      motif_id: longA,
      motif_type: "constraint",
      motifType: "pair",
      relation: "constraint",
      roles: { sources: ["c_long_1"], target: "c_long_2" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_long_1", "c_long_2"],
      conceptIds: ["c_long_1", "c_long_2"],
      anchorConceptId: "c_long_2",
      title: "预算约束目标",
      description: "d",
      confidence: 0.86,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: new Date().toISOString(),
    },
    {
      id: longB,
      motif_id: longB,
      motif_type: "enable",
      motifType: "pair",
      relation: "enable",
      roles: { sources: ["c_long_1"], target: "c_long_2" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_long_1", "c_long_2"],
      conceptIds: ["c_long_1", "c_long_2"],
      anchorConceptId: "c_long_2",
      title: "预算支持目标",
      description: "d",
      confidence: 0.84,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: new Date().toISOString(),
    },
  ] as any;
  const links = reconcileMotifLinks({
    motifs,
    baseLinks: [
      {
        id: `ml_${"x".repeat(220)}`,
        fromMotifId: longA,
        toMotifId: longB,
        type: "supports",
        confidence: 0.91,
        source: "user",
      },
    ],
  });
  const view = buildMotifReasoningView({
    concepts,
    motifs,
    motifLinks: links,
    locale: "zh-CN" as any,
  });
  assert.equal(view.edges.length > 0, true);
  const motifIdToNodeId = new Map(view.nodes.map((n) => [n.motifId, n.id]));
  assert.equal(
    view.edges.some((e) => e.from === motifIdToNodeId.get(longA) && e.to === motifIdToNodeId.get(longB)),
    true
  );
});

run("user-resolved motif edits should persist relation/structure/status", () => {
  const graph = {
    id: "g_motif_user_edit",
    version: 1,
    nodes: [
      {
        id: "n_goal",
        type: "belief",
        layer: "intent",
        statement: "意图：完成旅行计划",
        status: "confirmed",
        confidence: 0.9,
        importance: 0.88,
        key: "slot:goal",
      },
      {
        id: "n_budget",
        type: "constraint",
        layer: "requirement",
        statement: "预算上限：10000元",
        status: "confirmed",
        confidence: 0.88,
        importance: 0.8,
        key: "slot:budget",
      },
    ],
    edges: [{ id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.86 }],
  } as any;
  const concepts = deriveConceptsFromGraph(graph);
  const first = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
  assert.ok(first.length >= 1);
  const baseline = first[0];
  const edited = {
    ...baseline,
    title: "用户改写标题",
    description: "用户自定义结构",
    relation: "determine",
    dependencyClass: "determine",
    causalOperator: "intervention",
    status: "cancelled",
    statusReason: "user_cancelled",
    resolved: true,
    resolvedBy: "user",
    resolvedAt: new Date().toISOString(),
    conceptIds: baseline.conceptIds.slice(0, 2),
    concept_bindings: baseline.conceptIds.slice(0, 2),
    anchorConceptId: baseline.anchorConceptId,
    roles: {
      sources: baseline.conceptIds.filter((x) => x !== baseline.anchorConceptId).slice(0, 1),
      target: baseline.anchorConceptId,
    },
    concept_instances: {
      sources: (baseline as any).concept_instances?.sources?.map((item: any) => JSON.stringify(item)) || [],
      target: JSON.stringify((baseline as any).concept_instances?.target),
    },
  };

  const next = reconcileMotifsWithGraph({
    graph,
    concepts,
    baseMotifs: [edited],
  });
  const persisted = next.find((m) => m.id === baseline.id);
  assert.ok(persisted);
  assert.equal(persisted?.title, "用户改写标题");
  assert.equal(persisted?.relation, "determine");
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.resolvedBy, "user");
  assert.ok((persisted as any)?.concept_instances);
  assert.ok(Array.isArray((persisted as any)?.concept_instances?.sources));
});

run("manual user motif should not be cancelled when still supported by concepts", () => {
  const graph = {
    id: "g_manual_user_motif",
    version: 1,
    nodes: [
      {
        id: "n_goal",
        type: "belief",
        layer: "intent",
        statement: "意图：旅行规划",
        status: "confirmed",
        confidence: 0.9,
        importance: 0.86,
        key: "slot:goal",
      },
      {
        id: "n_budget",
        type: "constraint",
        layer: "requirement",
        statement: "预算上限：8000元",
        status: "confirmed",
        confidence: 0.84,
        importance: 0.78,
        key: "slot:budget",
      },
    ],
    edges: [{ id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.84 }],
  } as any;
  const concepts = deriveConceptsFromGraph(graph);
  const budgetConcept = concepts.find((c) => c.semanticKey === "slot:budget");
  const goalConcept = concepts.find((c) => c.semanticKey === "slot:goal");
  assert.ok(budgetConcept && goalConcept);

  const manualMotif = {
    id: "m_manual_custom",
    motif_id: "m_manual_custom",
    motif_type: "determine",
    motifType: "pair",
    relation: "determine",
    dependencyClass: "determine",
    roles: { sources: [budgetConcept!.id], target: goalConcept!.id },
    scope: "global",
    aliases: ["m_manual_custom"],
    concept_bindings: [budgetConcept!.id, goalConcept!.id],
    conceptIds: [budgetConcept!.id, goalConcept!.id],
    anchorConceptId: goalConcept!.id,
    title: "用户手工 motif",
    description: "manual motif",
    confidence: 0.81,
    supportEdgeIds: [],
    supportNodeIds: [],
    status: "active",
    statusReason: "user_manual_created",
    resolved: true,
    resolvedBy: "user",
    resolvedAt: new Date().toISOString(),
    novelty: "updated",
    updatedAt: new Date().toISOString(),
  } as any;

  const next = reconcileMotifsWithGraph({
    graph,
    concepts,
    baseMotifs: [manualMotif],
  });
  const kept = next.find((m) => m.id === "m_manual_custom");
  assert.ok(kept, "manual motif should be retained");
  assert.equal(kept?.status, "active");
  assert.equal(kept?.statusReason?.startsWith("not_supported_by_current_graph"), false);
});

run("conflict gate payload should block only unresolved hard conflicts", () => {
  const blocked = buildConflictGatePayload(
    [
      {
        id: "m_conflict",
        title: "冲突关系",
        status: "deprecated",
        confidence: 0.82,
        statusReason: "relation_conflict_with:m_x",
        resolved: false,
      },
    ] as any,
    "zh-CN" as any
  );
  assert.ok(blocked?.blocked);
  assert.equal(blocked?.unresolvedMotifs.length, 1);

  const cleared = buildConflictGatePayload(
    [
      {
        id: "m_conflict",
        title: "冲突关系",
        status: "deprecated",
        confidence: 0.82,
        statusReason: "user_resolved",
        resolved: true,
      },
    ] as any,
    "zh-CN" as any
  );
  assert.equal(cleared, null);

  const lowConfidence = buildConflictGatePayload(
    [
      {
        id: "m_low_conf",
        title: "低置信度关系",
        status: "deprecated",
        confidence: 0.74,
        statusReason: "low_confidence:enable:0.75",
        resolved: false,
      },
      {
        id: "m_pruned",
        title: "系统修剪关系",
        status: "deprecated",
        confidence: 0.78,
        statusReason: "evidence_stable;objective_pruned",
        resolved: false,
      },
    ] as any,
    "zh-CN" as any
  );
  assert.equal(lowConfidence, null);
});

console.log("All PRD re-alignment checks passed.");
