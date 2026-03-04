import assert from "node:assert/strict";

import { reconcileMotifLinks, type MotifLink } from "../motif/motifLinks.js";
import { buildMotifReasoningView } from "../motif/reasoningView.js";
import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "../motif/conceptMotifs.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function makeConcept(id: string, title: string): ConceptItem {
  return {
    id,
    kind: "belief",
    validationStatus: "resolved",
    extractionStage: "disambiguation",
    polarity: "positive",
    scope: "global",
    family: "other",
    semanticKey: `manual:${id}`,
    title,
    description: title,
    score: 0.8,
    nodeIds: [id],
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
}): ConceptMotif {
  return {
    id: params.id,
    motif_id: params.id,
    motif_type: "enable",
    templateKey: `manual:${params.id}`,
    motifType: "pair",
    relation: "enable",
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
    status: "active",
    resolved: false,
    novelty: "new",
    updatedAt: new Date().toISOString(),
    dependencyClass: "enable",
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

console.log("All motif pipeline checks passed.");
