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
      id: "c_activity",
      title: "活动偏好：看球",
      semanticKey: "slot:activity_preference",
      family: "activity_preference",
      nodeId: "n1",
      score: 0.86,
    }),
    makeConcept({
      id: "c_mid",
      title: "去米兰",
      semanticKey: "slot:destination:milan",
      family: "destination",
      nodeId: "n2",
      score: 0.64,
    }),
    makeConcept({
      id: "c_plan",
      title: "米兰行程",
      semanticKey: "slot:freeform:belief:milan_trip",
      family: "other",
      nodeId: "n3",
      score: 0.84,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_chain",
      version: 1,
      nodes: [
        { id: "n1", type: "belief", statement: "活动偏好：看球", status: "confirmed", confidence: 0.86, importance: 0.8 },
        { id: "n2", type: "belief", statement: "去米兰", status: "confirmed", confidence: 0.78, importance: 0.7 },
        { id: "n3", type: "belief", statement: "米兰行程", status: "confirmed", confidence: 0.82, importance: 0.78 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", type: "determine", confidence: 0.86 },
        { id: "e2", from: "n2", to: "n3", type: "determine", confidence: 0.84 },
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
    ["c_activity", "c_mid", "c_plan"].every((id) => (chainComposite?.conceptIds || []).includes(id)),
    "composite motif should contain A/B/C concepts"
  );

  const compressedPairs = motifs.filter((m) => (m.statusReason || "").startsWith("chain_compressed_by:"));
  assert.equal(compressedPairs.length, 2);
  assert.ok(compressedPairs.every((m) => m.status === "cancelled" && !!m.resolved));
});

run("cross-anchor semantic dedup should cancel duplicated path motifs", () => {
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
      id: "c_dest_exact",
      title: "米兰",
      semanticKey: "slot:destination:milan",
      family: "destination",
      nodeId: "n_dest_1",
      score: 0.86,
    }),
    makeConcept({
      id: "c_dest_variant",
      title: "去米兰行程",
      semanticKey: "slot:freeform:belief:destination_milan",
      family: "other",
      nodeId: "n_dest_2",
      score: 0.8,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_cross_anchor",
      version: 1,
      nodes: [
        { id: "n_budget", type: "constraint", statement: "预算上限", status: "confirmed", confidence: 0.9, importance: 0.92 },
        { id: "n_dest_1", type: "belief", statement: "米兰", status: "confirmed", confidence: 0.84, importance: 0.82 },
        { id: "n_dest_2", type: "belief", statement: "去米兰行程", status: "confirmed", confidence: 0.82, importance: 0.8 },
      ],
      edges: [
        { id: "e1", from: "n_budget", to: "n_dest_1", type: "constraint", confidence: 0.86 },
        { id: "e2", from: "n_budget", to: "n_dest_2", type: "constraint", confidence: 0.83 },
      ],
    } as any,
    concepts,
    baseMotifs: [],
  });

  const crossDedup = motifs.filter((m) => (m.statusReason || "").startsWith("cross_anchor_duplicate_of:"));
  assert.equal(crossDedup.length, 1);
  assert.equal(crossDedup[0].status, "cancelled");
});

run("cross-anchor semantic dedup should keep different destination intents", () => {
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
      id: "c_milan",
      title: "米兰",
      semanticKey: "slot:destination:milan",
      family: "destination",
      nodeId: "n_dest_milan",
      score: 0.86,
    }),
    makeConcept({
      id: "c_rome_variant",
      title: "去罗马行程",
      semanticKey: "slot:freeform:belief:destination_rome",
      family: "other",
      nodeId: "n_dest_rome",
      score: 0.8,
    }),
  ];

  const motifs = reconcileMotifsWithGraph({
    graph: {
      id: "g_cross_anchor_keep",
      version: 1,
      nodes: [
        { id: "n_budget", type: "constraint", statement: "预算上限", status: "confirmed", confidence: 0.9, importance: 0.92 },
        { id: "n_dest_milan", type: "belief", statement: "米兰", status: "confirmed", confidence: 0.84, importance: 0.82 },
        { id: "n_dest_rome", type: "belief", statement: "去罗马行程", status: "confirmed", confidence: 0.82, importance: 0.8 },
      ],
      edges: [
        { id: "e1", from: "n_budget", to: "n_dest_milan", type: "constraint", confidence: 0.86 },
        { id: "e2", from: "n_budget", to: "n_dest_rome", type: "constraint", confidence: 0.83 },
      ],
    } as any,
    concepts,
    baseMotifs: [],
  });

  const crossDedup = motifs.filter((m) => (m.statusReason || "").startsWith("cross_anchor_duplicate_of:"));
  assert.equal(crossDedup.length, 0);
});

console.log("All motif compression checks passed.");
