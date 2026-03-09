import assert from "node:assert/strict";

import { normalizeGraphSnapshot } from "../../core/graph.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function nodeFixture(params: {
  id: string;
  type: "belief" | "constraint" | "preference" | "factual_assertion";
  statement: string;
  key?: string;
  layer?: "intent" | "requirement" | "preference" | "risk";
  severity?: "low" | "medium" | "high" | "critical";
}) {
  return {
    id: params.id,
    type: params.type,
    layer: params.layer,
    key: params.key,
    statement: params.statement,
    status: "confirmed",
    confidence: 0.9,
    importance: 0.8,
    severity: params.severity,
  } as any;
}

run("normalizeGraphSnapshot attaches presentation metadata for structured slot nodes", () => {
  const graph = normalizeGraphSnapshot({
    id: "g_presentation",
    version: 1,
    nodes: [
      nodeFixture({
        id: "n_goal",
        type: "belief",
        layer: "intent",
        key: "slot:goal",
        statement: "意图：制定旅行计划",
      }),
      nodeFixture({
        id: "n_dest",
        type: "factual_assertion",
        key: "slot:destination:kyoto",
        statement: "目的地：京都",
      }),
      nodeFixture({
        id: "n_duration",
        type: "constraint",
        key: "slot:duration_total",
        statement: "总行程时长：6天",
      }),
      nodeFixture({
        id: "n_budget",
        type: "constraint",
        key: "slot:budget",
        statement: "预算上限：20000元",
      }),
      nodeFixture({
        id: "n_health",
        type: "constraint",
        key: "slot:health",
        statement: "老人腿脚一般，不能久走",
        severity: "high",
      }),
      nodeFixture({
        id: "n_meeting",
        type: "constraint",
        key: "slot:meeting_critical:presentation",
        statement: "关键日：第3天要参加汇报",
      }),
      nodeFixture({
        id: "n_lodging",
        type: "preference",
        key: "slot:lodging",
        statement: "住宿偏好：安静一点",
        layer: "preference",
      }),
      nodeFixture({
        id: "n_activity",
        type: "preference",
        key: "slot:activity_preference",
        statement: "活动偏好：多一点文化体验",
      }),
      nodeFixture({
        id: "n_constraint",
        type: "constraint",
        key: "slot:constraint:pace:not_rushed",
        statement: "关键约束：不要太赶",
      }),
    ],
    edges: [],
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, (node.value as any)?.presentation || {}]));

  assert.deepEqual(byId.get("n_goal"), {
    slot_family: "goal",
    semantic_lane: "goal",
    semantic_level: 0,
    priority_score: 99,
    is_primary_slot: false,
    tone_key: "goal",
  });
  assert.equal(byId.get("n_dest")?.slot_family, "destination");
  assert.equal(byId.get("n_dest")?.semantic_lane, "destination");
  assert.equal(byId.get("n_dest")?.semantic_level, 1);
  assert.equal(byId.get("n_dest")?.is_primary_slot, true);
  assert.equal(byId.get("n_duration")?.semantic_lane, "duration");
  assert.equal(byId.get("n_duration")?.semantic_level, 1);
  assert.equal(byId.get("n_budget")?.semantic_lane, "budget");
  assert.equal(byId.get("n_budget")?.semantic_level, 1);
  assert.equal(byId.get("n_health")?.semantic_lane, "health");
  assert.equal(byId.get("n_health")?.semantic_level, 2);
  assert.equal(byId.get("n_health")?.tone_key, "risk");
  assert.equal(byId.get("n_meeting")?.semantic_lane, "meeting_critical");
  assert.equal(byId.get("n_meeting")?.semantic_level, 2);
  assert.equal(byId.get("n_lodging")?.semantic_lane, "lodging");
  assert.equal(byId.get("n_activity")?.semantic_lane, "preference_slot");
  assert.equal(byId.get("n_constraint")?.semantic_lane, "constraint_high");
});

run("normalizeGraphSnapshot keeps old statement-only graphs renderable via presentation metadata", () => {
  const graph = normalizeGraphSnapshot({
    id: "g_statement_fallback",
    version: 1,
    nodes: [
      nodeFixture({
        id: "n_goal",
        type: "belief",
        layer: "intent",
        statement: "意图：去京都旅游",
      }),
      nodeFixture({
        id: "n_dest",
        type: "factual_assertion",
        statement: "目的地：京都",
      }),
      nodeFixture({
        id: "n_budget",
        type: "constraint",
        statement: "预算上限：12000元",
      }),
    ],
    edges: [],
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, (node.value as any)?.presentation || {}]));
  assert.equal(byId.get("n_goal")?.semantic_lane, "goal");
  assert.equal(byId.get("n_goal")?.semantic_level, 0);
  assert.equal(byId.get("n_dest")?.semantic_lane, "destination");
  assert.equal(byId.get("n_budget")?.semantic_lane, "budget");
});
