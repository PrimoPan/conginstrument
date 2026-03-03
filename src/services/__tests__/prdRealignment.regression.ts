import assert from "node:assert/strict";

import { normalizeConceptType, normalizeExtractionStage, normalizeMotifLinkType } from "../../core/graph/schemaAdapters.js";
import { deriveConceptsFromGraph, CONCEPT_EXTRACTION_STAGES } from "../concepts.js";
import { buildCognitiveModel } from "../cognitiveModel.js";
import { reconcileMotifLinks } from "../motif/motifLinks.js";
import { buildMotifReasoningView } from "../motif/reasoningView.js";

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

console.log("All PRD re-alignment checks passed.");
