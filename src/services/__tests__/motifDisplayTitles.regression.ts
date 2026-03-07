import assert from "node:assert/strict";

import type { ConceptItem } from "../concepts.js";
import { reconcileMotifsWithGraph } from "../motif/conceptMotifs.js";
import { enrichMotifDisplayTitles, fallbackMotifDisplayTitle } from "../motif/displayTitles.js";

function run(name: string, fn: () => Promise<void> | void) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((err: any) => {
      console.error(`FAIL ${name}:`, err?.message || err);
      process.exitCode = 1;
    });
}

function makeConcept(params: {
  id: string;
  title: string;
  semanticKey: string;
  family: ConceptItem["family"];
  nodeId: string;
  kind?: ConceptItem["kind"];
}) {
  return {
    id: params.id,
    kind: params.kind || "belief",
    validationStatus: "resolved",
    extractionStage: "disambiguation",
    polarity: "positive",
    scope: "global",
    family: params.family,
    semanticKey: params.semanticKey,
    title: params.title,
    description: params.title,
    score: 0.86,
    nodeIds: [params.nodeId],
    primaryNodeId: params.nodeId,
    evidenceTerms: [params.title],
    sourceMsgIds: ["test"],
    motifIds: [],
    migrationHistory: [],
    locked: false,
    paused: false,
    updatedAt: "2026-03-07T00:00:00.000Z",
  } satisfies ConceptItem;
}

run("fallback title should stay readable for consumer UI", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_family",
      title: "携家出游",
      semanticKey: "slot:people",
      family: "people",
      nodeId: "n_people",
    }),
    makeConcept({
      id: "c_child_friendly",
      title: "儿童友好选项",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_target",
    }),
  ];
  const title = fallbackMotifDisplayTitle({
    locale: "zh-CN",
    concepts,
    motif: {
      id: "m1",
      motif_id: "m1",
      motif_type: "enable",
      templateKey: "pair",
      motifType: "pair",
      relation: "enable",
      dependencyClass: "enable",
      roles: { sources: ["c_family"], target: "c_child_friendly" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_family", "c_child_friendly"],
      conceptIds: ["c_family", "c_child_friendly"],
      anchorConceptId: "c_child_friendly",
      title: "携家出游 supports 儿童友好选项",
      description: "",
      confidence: 0.82,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: "2026-03-07T00:00:00.000Z",
    },
  });
  assert.equal(title, "携家出游会推动儿童友好选项");
});

run("display title helper should reuse prior display title when motif structure is unchanged", async () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c1",
      title: "携家出游",
      semanticKey: "slot:people",
      family: "people",
      nodeId: "n1",
    }),
    makeConcept({
      id: "c2",
      title: "儿童友好选项",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n2",
    }),
  ];
  const motifs = await enrichMotifDisplayTitles({
    locale: "zh-CN",
    concepts,
    previousConcepts: concepts,
    previousMotifs: [
      {
        id: "m1",
        motif_id: "m1",
        motif_type: "enable",
        templateKey: "pair",
        motifType: "pair",
        relation: "enable",
        dependencyClass: "enable",
        roles: { sources: ["c1"], target: "c2" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c1", "c2"],
        conceptIds: ["c1", "c2"],
        anchorConceptId: "c2",
        title: "旧规则标题",
        display_title: "携家出游会优先考虑儿童友好选项",
        description: "",
        confidence: 0.82,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "unchanged",
        updatedAt: "2026-03-07T00:00:00.000Z",
      },
    ],
    motifs: [
      {
        id: "m1",
        motif_id: "m1",
        motif_type: "enable",
        templateKey: "pair",
        motifType: "pair",
        relation: "enable",
        dependencyClass: "enable",
        roles: { sources: ["c1"], target: "c2" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c1", "c2"],
        conceptIds: ["c1", "c2"],
        anchorConceptId: "c2",
        title: "结构化标题",
        description: "",
        confidence: 0.82,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "unchanged",
        updatedAt: "2026-03-07T00:00:00.000Z",
      },
    ] as any,
  });

  assert.equal(motifs[0]?.display_title, "携家出游会优先考虑儿童友好选项");
});

run("reconcileMotifsWithGraph should preserve stored display titles for unchanged motifs", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算上限",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_goal",
      title: "旅行目标",
      semanticKey: "slot:goal",
      family: "goal",
      nodeId: "n_goal",
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g1",
      version: 1,
      nodes: [
        { id: "n_budget", type: "constraint", statement: "预算上限：6000 元", status: "confirmed", confidence: 0.92, importance: 0.9 },
        { id: "n_goal", type: "belief", statement: "意图：去台北旅行 3 天", status: "confirmed", confidence: 0.91, importance: 0.9 },
      ],
      edges: [{ id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.88 }],
    } as any,
    concepts,
    baseMotifs: [
      {
        id: "m_pattern:pair_constraint_budget->goal",
        motif_id: "m_pattern:pair_constraint_budget->goal",
        motif_type: "constraint",
        templateKey: "pair",
        motifType: "pair",
        relation: "constraint",
        dependencyClass: "constraint",
        roles: { sources: ["c_budget"], target: "c_goal" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c_budget", "c_goal"],
        conceptIds: ["c_budget", "c_goal"],
        anchorConceptId: "c_goal",
        title: "预算限制目标",
        display_title: "预算会卡住整体安排",
        description: "",
        confidence: 0.88,
        supportEdgeIds: ["e1"],
        supportNodeIds: ["n_budget", "n_goal"],
        status: "active",
        novelty: "unchanged",
        updatedAt: "2026-03-07T00:00:00.000Z",
      },
    ],
    locale: "zh-CN",
  });

  const active = motifs.find((motif) => motif.id === "m_pattern:pair_constraint_budget->goal");
  assert.equal(active?.display_title, "预算会卡住整体安排");
});
