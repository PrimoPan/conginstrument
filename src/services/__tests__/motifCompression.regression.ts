import assert from "node:assert/strict";

import { reconcileMotifsWithGraph } from "../motif/conceptMotifs.js";
import type { ConceptItem } from "../concepts.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function makeConcept(params: {
  id: string;
  title: string;
  semanticKey: string;
  family: ConceptItem["family"];
  nodeId: string;
  score?: number;
}): ConceptItem {
  return {
    id: params.id,
    kind: "belief",
    validationStatus: "resolved",
    extractionStage: "disambiguation",
    polarity: "positive",
    scope: "global",
    family: params.family,
    semanticKey: params.semanticKey,
    title: params.title,
    description: params.title,
    score: params.score ?? 0.78,
    nodeIds: [params.nodeId],
    primaryNodeId: params.nodeId,
    evidenceTerms: [params.title],
    sourceMsgIds: ["manual_test"],
    motifIds: [],
    migrationHistory: [],
    locked: false,
    paused: false,
    updatedAt: new Date().toISOString(),
  };
}

run("relay chain compression should merge A->B->C into composite motif", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_lodging_src",
      title: "住宿偏好",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n1",
      score: 0.78,
    }),
    makeConcept({
      id: "c_lodging_mid",
      title: "住宿",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n2",
      score: 0.72,
    }),
    makeConcept({
      id: "c_goal",
      title: "旅行目标：舒适优先",
      semanticKey: "slot:goal",
      family: "goal",
      nodeId: "n3",
      score: 0.84,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_chain",
      version: 1,
      nodes: [
        { id: "n1", type: "preference", statement: "住宿偏好：安静优先", status: "confirmed", confidence: 0.84, importance: 0.78 },
        { id: "n2", type: "preference", statement: "住宿偏好：安静优先", status: "confirmed", confidence: 0.8, importance: 0.72 },
        { id: "n3", type: "belief", statement: "旅行目标：舒适优先", status: "confirmed", confidence: 0.84, importance: 0.8 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", type: "enable", confidence: 0.86 },
        { id: "e2", from: "n2", to: "n3", type: "enable", confidence: 0.84 },
      ],
    } as any,
    concepts,
    baseMotifs: [],
  });

  const chainComposite = motifs.find(
    (m) => m.status === "active" && m.motifType === "triad" && (m.statusReason || "").startsWith("chain_composite:")
  );
  assert.ok(chainComposite, "expected one active chain composite motif");
  assert.ok(
    ["c_lodging_src", "c_lodging_mid", "c_goal"].every((id) => (chainComposite?.conceptIds || []).includes(id)),
    "composite motif should contain A/B/C concepts"
  );

  const compressedPairs = motifs.filter((m) => (m.statusReason || "").startsWith("chain_compressed_by:"));
  assert.equal(compressedPairs.length, 2);
  assert.ok(compressedPairs.every((m) => m.status === "cancelled" && !!m.resolved));
});

run("aggregated constraint motifs with sibling lodging anchors should be downgraded as non-reusable", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算上限",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      score: 0.92,
    }),
    makeConcept({
      id: "c_lodging_a",
      title: "住宿偏好：安全区域",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_lodging_1",
      score: 0.86,
    }),
    makeConcept({
      id: "c_lodging_b",
      title: "住宿偏好：安全区域优先",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_lodging_2",
      score: 0.8,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_cross_anchor",
      version: 1,
      nodes: [
        { id: "n_budget", type: "constraint", statement: "预算上限", status: "confirmed", confidence: 0.9, importance: 0.92 },
        {
          id: "n_lodging_1",
          type: "preference",
          statement: "住宿偏好：安全区域",
          status: "confirmed",
          confidence: 0.84,
          importance: 0.82,
        },
        {
          id: "n_lodging_2",
          type: "preference",
          statement: "住宿偏好：安全区域优先",
          status: "confirmed",
          confidence: 0.82,
          importance: 0.8,
        },
      ],
      edges: [
        { id: "e1", from: "n_budget", to: "n_lodging_1", type: "constraint", confidence: 0.86 },
        { id: "e2", from: "n_budget", to: "n_lodging_2", type: "constraint", confidence: 0.83 },
      ],
    } as any,
    concepts,
    baseMotifs: [],
  });

  assert.equal(motifs.length, 1);
  assert.equal(motifs[0].reuseClass, "context_specific");
  assert.equal(motifs[0].status, "cancelled");
  assert.ok((motifs[0].statusReason || "").includes("non_reusable_context_specific:source_not_allowed:constraint:lodging"));
});

run("aggregated enable motifs with sibling lodging anchors should stay reusable", () => {
  const concepts: ConceptItem[] = [
    makeConcept({
      id: "c_budget",
      title: "预算上限",
      semanticKey: "slot:budget",
      family: "budget",
      nodeId: "n_budget",
      score: 0.92,
    }),
    makeConcept({
      id: "c_lodging_safe",
      title: "住宿偏好：安全区域",
      semanticKey: "slot:lodging",
      family: "lodging",
      nodeId: "n_lodging_safe",
      score: 0.86,
    }),
    makeConcept({
      id: "c_lodging_luxury",
      title: "住宿偏好：豪华舒适",
      semanticKey: "slot:freeform:preference:lodging_luxury",
      family: "lodging",
      nodeId: "n_lodging_luxury",
      score: 0.8,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_cross_anchor_keep",
      version: 1,
      nodes: [
        { id: "n_budget", type: "constraint", statement: "预算上限", status: "confirmed", confidence: 0.9, importance: 0.92 },
        {
          id: "n_lodging_safe",
          type: "preference",
          statement: "住宿偏好：安全区域",
          status: "confirmed",
          confidence: 0.84,
          importance: 0.82,
        },
        {
          id: "n_lodging_luxury",
          type: "preference",
          statement: "住宿偏好：豪华舒适",
          status: "confirmed",
          confidence: 0.82,
          importance: 0.8,
        },
      ],
      edges: [
        { id: "e1", from: "n_budget", to: "n_lodging_safe", type: "enable", confidence: 0.86 },
        { id: "e2", from: "n_budget", to: "n_lodging_luxury", type: "enable", confidence: 0.83 },
      ],
    } as any,
    concepts,
    baseMotifs: [],
  });

  assert.equal(motifs.length, 1);
  assert.equal(motifs[0].reuseClass, "reusable");
  assert.equal(motifs[0].status, "active");
});

console.log("All motif compression checks passed.");
