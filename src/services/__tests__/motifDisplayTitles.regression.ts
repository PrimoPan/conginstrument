import assert from "node:assert/strict";

import { config } from "../../server/config.js";
import { openai } from "../llmClient.js";
import type { ConceptItem } from "../concepts.js";
import { reconcileMotifsWithGraph } from "../motif/conceptMotifs.js";
import {
  enrichMotifDisplayTitles,
  fallbackMotifDisplayTitle,
  pickMotifDisplayTitle,
  pickMotifPatternTitle,
} from "../motif/displayTitles.js";

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

run("pickMotifDisplayTitle should reject generated titles that omit source or target concept names", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_family",
      title: "携家出游",
      semanticKey: "slot:people",
      family: "people",
      nodeId: "n_people",
    }),
    makeConcept({
      id: "c_target",
      title: "儿童友好选项",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_target",
    }),
  ];
  const displayTitle = pickMotifDisplayTitle({
    locale: "zh-CN",
    concepts,
    generatedTitle: "家庭旅行的限制因素",
    motif: {
      id: "m_reject_generated",
      motif_id: "m_reject_generated",
      motif_type: "enable",
      templateKey: "pair",
      motifType: "pair",
      relation: "enable",
      dependencyClass: "enable",
      roles: { sources: ["c_family"], target: "c_target" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_family", "c_target"],
      conceptIds: ["c_family", "c_target"],
      anchorConceptId: "c_target",
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

  assert.equal(displayTitle, "携家出游会推动儿童友好选项");
});

run("pickMotifDisplayTitle should keep generated titles that preserve source and target concept names", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_family",
      title: "携家出游",
      semanticKey: "slot:people",
      family: "people",
      nodeId: "n_people",
    }),
    makeConcept({
      id: "c_target",
      title: "儿童友好选项",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_target",
    }),
  ];
  const displayTitle = pickMotifDisplayTitle({
    locale: "zh-CN",
    concepts,
    generatedTitle: "携家出游会优先考虑儿童友好选项",
    motif: {
      id: "m_keep_generated",
      motif_id: "m_keep_generated",
      motif_type: "enable",
      templateKey: "pair",
      motifType: "pair",
      relation: "enable",
      dependencyClass: "enable",
      roles: { sources: ["c_family"], target: "c_target" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_family", "c_target"],
      conceptIds: ["c_family", "c_target"],
      anchorConceptId: "c_target",
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

  assert.equal(displayTitle, "携家出游会优先考虑儿童友好选项");
});

run("pickMotifPatternTitle should reject code-like generated pattern names", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_lodging",
      title: "住宿档位",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_lodging",
    }),
  ];
  const patternTitle = pickMotifPatternTitle({
    locale: "zh-CN",
    concepts,
    generatedTitle: "Budget + Lodging constraint motif",
    motif: {
      id: "m_pattern_fallback",
      motif_id: "m_pattern_fallback",
      motif_type: "constraint",
      templateKey: "pair",
      motifType: "pair",
      relation: "constraint",
      dependencyClass: "constraint",
      roles: { sources: ["c_budget"], target: "c_lodging" },
      scope: "global",
      aliases: [],
      concept_bindings: ["c_budget", "c_lodging"],
      conceptIds: ["c_budget", "c_lodging"],
      anchorConceptId: "c_lodging",
      title: "预算 constraints 住宿档位",
      description: "",
      confidence: 0.84,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: "2026-03-08T00:00:00.000Z",
    },
  });

  assert.equal(patternTitle, "先按现实约束过滤选项");
});

run("pickMotifPatternTitle should reject instance-specific generated pattern names", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算上限12000元",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_goal",
      title: "去台北旅游3天",
      semanticKey: "slot:goal",
      family: "goal",
      nodeId: "n_goal",
    }),
  ];
  const patternTitle = pickMotifPatternTitle({
    locale: "zh-CN",
    concepts,
    generatedTitle: "预算上限12000元先过滤去台北旅游3天",
    motif: {
      id: "m_pattern_instance_reject",
      motif_id: "m_pattern_instance_reject",
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
      title: "预算上限12000元 constraints 去台北旅游3天",
      description: "",
      confidence: 0.84,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: "2026-03-08T00:00:00.000Z",
    },
  });

  assert.equal(patternTitle, "先按现实约束收紧范围");
});

run("fallback title should prefer resolvable conceptIds over broken role source refs", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_semantic:slot:constraint:limiting:other:otherpos_constraintnegativeconst_1r6zma5",
      title: "也不想一直打卡景点",
      semanticKey: "slot:constraint:limiting:other",
      family: "generic_constraint",
      nodeId: "n_source",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_goal",
      title: "去京都旅游7天",
      semanticKey: "slot:goal",
      family: "goal",
      nodeId: "n_goal",
    }),
  ];
  const displayTitle = fallbackMotifDisplayTitle({
    locale: "zh-CN",
    concepts,
    motif: {
      id: "m1",
      motif_id: "m1",
      motif_type: "constraint",
      templateKey: "pair",
      motifType: "pair",
      relation: "constraint",
      dependencyClass: "constraint",
      roles: {
        sources: ["slot:constraint:limiting:other:otherpos_constraintnegativeconst_1r6zm"],
        target: "c_goal",
      },
      scope: "global",
      aliases: [],
      concept_bindings: [
        "c_semantic:slot:constraint:limiting:other:otherpos_constraintnegativeconst_1r6zma5",
        "c_goal",
      ],
      conceptIds: [
        "c_semantic:slot:constraint:limiting:other:otherpos_constraintnegativeconst_1r6zma5",
        "c_goal",
      ],
      anchorConceptId: "c_goal",
      title: "结构化标题",
      description: "",
      confidence: 0.82,
      supportEdgeIds: [],
      supportNodeIds: [],
      status: "active",
      novelty: "new",
      updatedAt: "2026-03-07T00:00:00.000Z",
    },
  });

  assert.equal(displayTitle, "也不想一直打卡景点会限制去京都旅游7天");
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

run("budget and remaining budget motifs should not collapse into the same consumer title", async () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算上限: 12000元",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_budget_remaining",
      title: "剩余预算: 12000元",
      semanticKey: "slot:budget_remaining",
      family: "budget",
      nodeId: "n_budget_remaining",
      kind: "constraint",
    }),
    makeConcept({
      id: "c_goal",
      title: "意图：去台北旅游3天",
      semanticKey: "slot:goal",
      family: "goal",
      nodeId: "n_goal",
    }),
  ];

  const motifs = await enrichMotifDisplayTitles({
    locale: "zh-CN",
    concepts,
    motifs: [
      {
        id: "m_budget",
        motif_id: "m_budget",
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
        title: "预算上限: 12000元 限制 意图：去台北旅游3天",
        description: "",
        confidence: 0.92,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "new",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
      {
        id: "m_budget_remaining",
        motif_id: "m_budget_remaining",
        motif_type: "constraint",
        templateKey: "pair",
        motifType: "pair",
        relation: "constraint",
        dependencyClass: "constraint",
        roles: { sources: ["c_budget_remaining"], target: "c_goal" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c_budget_remaining", "c_goal"],
        conceptIds: ["c_budget_remaining", "c_goal"],
        anchorConceptId: "c_goal",
        title: "剩余预算: 12000元 限制 意图：去台北旅游3天",
        description: "",
        confidence: 0.9,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "new",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ] as any,
  });

  const budget = motifs.find((motif) => motif.id === "m_budget");
  const remaining = motifs.find((motif) => motif.id === "m_budget_remaining");
  assert.equal(budget?.display_title, "预算上限12000元会限制去台北旅游3天");
  assert.equal(remaining?.display_title, "剩余预算12000元会限制去台北旅游3天");
  assert.notEqual(budget?.display_title, remaining?.display_title);
});

run("enrichMotifDisplayTitles should apply function-call naming to both pattern and display titles", async () => {
  const originalKey = config.openaiKey;
  const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);
  (config as any).openaiKey = "test-key";
  (openai.chat.completions as any).create = async () => ({
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "rewrite_motif_titles",
                arguments: JSON.stringify({
                  items: [
                    {
                      id: "m_fn",
                      display_title: "携家出游会优先考虑儿童友好选项",
                      pattern_type: "家庭出游优先儿童友好筛选",
                    },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
  });

  try {
    const concepts: ConceptItem[] = [
      makeConcept({
        id: "c_people",
        title: "携家出游",
        semanticKey: "slot:people",
        family: "people",
        nodeId: "n_people",
      }),
      makeConcept({
        id: "c_target",
        title: "儿童友好选项",
        semanticKey: "slot:lodging",
        family: "lodging",
        nodeId: "n_target",
      }),
    ];

    const motifs = await enrichMotifDisplayTitles({
      locale: "zh-CN",
      model: "gpt-4o",
      concepts,
      motifs: [
        {
          id: "m_fn",
          motif_id: "m_fn",
          motif_type: "enable",
          templateKey: "pair",
          motifType: "pair",
          relation: "enable",
          dependencyClass: "enable",
          roles: { sources: ["c_people"], target: "c_target" },
          scope: "global",
          aliases: [],
          concept_bindings: ["c_people", "c_target"],
          conceptIds: ["c_people", "c_target"],
          anchorConceptId: "c_target",
          title: "人数 enables 住宿",
          description: "",
          confidence: 0.9,
          supportEdgeIds: [],
          supportNodeIds: [],
          status: "active",
          novelty: "new",
          updatedAt: "2026-03-08T00:00:00.000Z",
        },
      ] as any,
    });

    assert.equal(motifs[0]?.display_title, "携家出游会优先考虑儿童友好选项");
    assert.equal((motifs[0] as any)?.pattern_type, "家庭出游优先儿童友好筛选");
    assert.equal((motifs[0] as any)?.motif_type_title, "家庭出游优先儿童友好筛选");
  } finally {
    (config as any).openaiKey = originalKey;
    (openai.chat.completions as any).create = originalCreate;
  }
});
