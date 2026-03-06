import assert from "node:assert/strict";
import fc from "fast-check";

import type { ConceptItem } from "../concepts.js";
import {
  aliasClusterMerge,
  computeConceptPosterior,
  historyConsistencyScore,
} from "../concepts.js";
import {
  motifLifecycleTransition,
  selectMotifSetGreedy,
  type ConceptMotif,
  type MotifLifecycleStatus,
} from "../motif/conceptMotifs.js";
import { validateBoundaryReasoningEdge } from "../motif/relationValidator.js";

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
  family: ConceptItem["family"];
  semanticKey: string;
  title: string;
  score?: number;
}): ConceptItem {
  const score = Number(params.score ?? 0.8);
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
    score,
    nodeIds: [params.id],
    primaryNodeId: params.id,
    evidenceTerms: [params.title],
    sourceMsgIds: ["latest_user"],
    motifIds: [],
    migrationHistory: [],
    locked: false,
    paused: false,
    updatedAt: new Date().toISOString(),
    posterior: score,
    entropy: 0.5,
    alias_group_id: params.id,
    support_sources: ["user"],
  };
}

function makeMotif(params: {
  id: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  anchorStatus?: MotifLifecycleStatus;
}): ConceptMotif {
  return {
    id: params.id,
    motif_id: params.id,
    motif_type: "enable",
    templateKey: `k:${params.id}`,
    motifType: "pair",
    relation: "enable",
    roles: {
      sources: [params.sourceId],
      target: params.targetId,
    },
    scope: "global",
    aliases: [params.id],
    concept_bindings: [params.sourceId, params.targetId],
    conceptIds: [params.sourceId, params.targetId],
    anchorConceptId: params.targetId,
    title: params.id,
    description: params.id,
    confidence: params.confidence,
    supportEdgeIds: [`e_${params.id}`],
    supportNodeIds: [params.sourceId, params.targetId],
    status: params.anchorStatus || "active",
    novelty: "new",
    updatedAt: new Date().toISOString(),
    dependencyClass: "enable",
    reuseClass: "reusable",
  } as ConceptMotif;
}

run("concept posterior thresholds should map to resolved/pending/drop zones", () => {
  const high = computeConceptPosterior({
    rule: 0.95,
    functionCall: 0.92,
    historyConsistency: 0.9,
    lexicalSpecificity: 0.88,
    topologySupport: 0.86,
    assistantOnlyPenalty: 0,
  });
  const mid = computeConceptPosterior({
    rule: 0.72,
    functionCall: 0.68,
    historyConsistency: 0.65,
    lexicalSpecificity: 0.62,
    topologySupport: 0.6,
    assistantOnlyPenalty: 0.04,
  });
  const low = computeConceptPosterior({
    rule: 0.35,
    functionCall: 0.3,
    historyConsistency: 0.32,
    lexicalSpecificity: 0.36,
    topologySupport: 0.28,
    assistantOnlyPenalty: 0.22,
  });
  assert.ok(high >= 0.72);
  assert.ok(mid >= 0.55 && mid < 0.72);
  assert.ok(low < 0.55);
});

run("alias clustering should merge near-duplicates but keep distinct intents", () => {
  const concepts = [
    makeConcept({
      id: "c1",
      family: "lodging",
      semanticKey: "slot:freeform:belief:local_lodging_preference",
      title: "偏好本地住宿",
    }),
    makeConcept({
      id: "c2",
      family: "lodging",
      semanticKey: "slot:freeform:belief:local_lodging_preference",
      title: "偏好本地化住宿",
      score: 0.78,
    }),
    makeConcept({
      id: "c3",
      family: "lodging",
      semanticKey: "slot:freeform:belief:luxury_hotel",
      title: "偏好豪华酒店",
      score: 0.77,
    }),
  ];
  const merged = aliasClusterMerge(concepts);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((x) => /本地/.test(x.title)));
  assert.ok(merged.some((x) => /豪华/.test(x.title)));
});

run("high-impact boundary edges should allow optional llm adjudication path", () => {
  const out = validateBoundaryReasoningEdge({
    relation: "constraint",
    sourceFamily: "limiting_factor",
    targetFamily: "goal",
    sourceText: "限制因素：体力有限",
    targetText: "目标：低强度活动为主",
    score: 0.61,
    edgeConfidence: 0.77,
    highImpact: true,
    historyAgreement: 0.74,
    enableLlmBoundary: true,
  });
  assert.ok(out.validator === "rule" || out.validator === "llm");
});

run("motif greedy selection should keep at most 3 active motifs per anchor", () => {
  const concepts = [
    makeConcept({ id: "c_src_1", family: "budget", semanticKey: "slot:budget", title: "预算上限" }),
    makeConcept({ id: "c_src_2", family: "people", semanticKey: "slot:people", title: "同行人数" }),
    makeConcept({ id: "c_src_3", family: "limiting_factor", semanticKey: "slot:constraint:limiting:health", title: "体力限制" }),
    makeConcept({ id: "c_src_4", family: "activity_preference", semanticKey: "slot:activity_preference", title: "活动偏好" }),
    makeConcept({ id: "c_tgt", family: "goal", semanticKey: "slot:goal", title: "旅行目标" }),
  ];
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const motifs = [
    makeMotif({ id: "m1", sourceId: "c_src_1", targetId: "c_tgt", confidence: 0.92 }),
    makeMotif({ id: "m2", sourceId: "c_src_2", targetId: "c_tgt", confidence: 0.86 }),
    makeMotif({ id: "m3", sourceId: "c_src_3", targetId: "c_tgt", confidence: 0.82 }),
    makeMotif({ id: "m4", sourceId: "c_src_4", targetId: "c_tgt", confidence: 0.8 }),
  ];
  const selected = selectMotifSetGreedy(motifs, conceptById);
  const active = selected.filter((x) => x.status === "active");
  assert.ok(active.length <= 3);
});

run("lifecycle automaton should always return a valid status", () => {
  const states: MotifLifecycleStatus[] = ["active", "uncertain", "deprecated", "cancelled"];
  const events = [
    "evidence_up",
    "evidence_down",
    "explicit_negation",
    "conflict_resolved",
    "transfer_failure",
    "manual_disable",
  ] as const;
  for (const state of states) {
    for (const event of events) {
      const out = motifLifecycleTransition({ current: state, event, fallbackReason: "test" });
      assert.ok(states.includes(out.status));
      assert.ok(typeof out.reason === "string");
    }
  }
});

run("property: history consistency score should stay in [0,1]", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 12 }),
          statement: fc.string({ minLength: 0, maxLength: 120 }),
          type: fc.constant("belief"),
          status: fc.constant("confirmed"),
          confidence: fc.float({ min: 0.5, max: 1 }),
        }),
        { minLength: 1, maxLength: 6 }
      ),
      (rawNodes) => {
        const nodes = rawNodes.map((n, idx) => ({
          id: `${n.id}_${idx}`,
          statement: n.statement || "fallback",
          type: n.type,
          status: n.status,
          confidence: n.confidence,
        })) as any;
        const v = historyConsistencyScore(nodes);
        return Number.isFinite(v) && v >= 0 && v <= 1;
      }
    ),
    { numRuns: 64 }
  );
});

console.log("All algorithm v3 regression checks passed.");
