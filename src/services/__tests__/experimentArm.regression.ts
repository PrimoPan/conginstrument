import assert from "node:assert/strict";

import {
  DEFAULT_EXPERIMENT_ARM,
  emptyMotifReasoningView,
  isPureChatControlArm,
  isMotifEnabledForArm,
  normalizeExperimentArm,
  sanitizeMotifPayloadForArm,
} from "../../server/experimentArm.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

run("normalizeExperimentArm defaults legacy traffic to main", () => {
  assert.equal(normalizeExperimentArm(undefined), DEFAULT_EXPERIMENT_ARM);
  assert.equal(normalizeExperimentArm(""), DEFAULT_EXPERIMENT_ARM);
  assert.equal(normalizeExperimentArm("main"), "main");
});

run("normalizeExperimentArm accepts compare aliases", () => {
  assert.equal(normalizeExperimentArm("compare"), "compare_concept_only");
  assert.equal(normalizeExperimentArm("compare_concept_only"), "compare_concept_only");
  assert.equal(normalizeExperimentArm("concept_only"), "compare_concept_only");
  assert.equal(normalizeExperimentArm("control"), "compare_concept_only");
  assert.equal(normalizeExperimentArm("llm_only"), "compare_concept_only");
  assert.equal(isMotifEnabledForArm("main"), true);
  assert.equal(isMotifEnabledForArm("compare_concept_only"), false);
  assert.equal(isPureChatControlArm("main"), false);
  assert.equal(isPureChatControlArm("compare_concept_only"), true);
});

run("sanitizeMotifPayloadForArm strips motif state for compare arm without mutating concept data", () => {
  const payload = {
    title: "compare-task",
    concepts: [{ id: "c1", text: "预算有限" }],
    motifs: [{ id: "m1" }],
    motifLinks: [{ id: "l1" }],
    contexts: [{ id: "ctx1" }],
    motifReasoningView: { nodes: [{ id: "n1" }], edges: [{ id: "e1" }], steps: [{ id: "s1" }] },
    motifGraph: { motifs: [{ id: "m1" }], motifLinks: [{ id: "l1" }] },
    motifInvariantReport: [{ id: "inv1" }],
    motifTransferState: { recommendations: [{ candidate_id: "cand1" }] },
    motifClarificationState: { pending: [{ id: "q1" }] },
    transferRecommendationsEnabled: true,
  };

  const sanitized = sanitizeMotifPayloadForArm(payload, "compare_concept_only");

  assert.equal(sanitized.title, "compare-task");
  assert.deepEqual(sanitized.concepts, payload.concepts);
  assert.deepEqual(sanitized.motifs, []);
  assert.deepEqual(sanitized.motifLinks, []);
  assert.deepEqual(sanitized.contexts, []);
  assert.deepEqual(sanitized.motifReasoningView, emptyMotifReasoningView());
  assert.deepEqual(sanitized.motifGraph, { motifs: [], motifLinks: [] });
  assert.equal(sanitized.motifInvariantReport, undefined);
  assert.equal(sanitized.motifTransferState, null);
  assert.equal(sanitized.motifClarificationState, null);
  assert.equal(sanitized.transferRecommendationsEnabled, false);

  assert.equal(payload.motifs.length, 1);
  assert.equal(payload.motifLinks.length, 1);
  assert.equal((payload.motifReasoningView.nodes || []).length, 1);
});

run("sanitizeMotifPayloadForArm keeps main arm payload intact", () => {
  const payload = {
    motifs: [{ id: "m1" }],
    motifLinks: [{ id: "l1" }],
    motifReasoningView: { nodes: [{ id: "n1" }], edges: [], steps: [] },
    transferRecommendationsEnabled: true,
  };

  const sanitized = sanitizeMotifPayloadForArm(payload, "main");
  assert.equal(sanitized, payload);
});
