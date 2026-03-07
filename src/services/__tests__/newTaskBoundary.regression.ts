import assert from "node:assert/strict";

import {
  buildTaskDetection,
  detectTaskSwitchFromLatestUserTurn,
  type PlanningTaskLifecycle,
} from "../planningState.js";
import { buildTransferRecommendations } from "../motifTransfer/retrieval.js";
import { motifVersionMeaningfullyChanged } from "../motifTransfer/storage.js";
import type { TravelPlanState } from "../travelPlan/state.js";
import type { MotifLibraryEntryPayload } from "../motifTransfer/types.js";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function makePlan(summary: string): TravelPlanState {
  return {
    version: 1,
    plan_version: 1,
    task_id: "task_new",
    updatedAt: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    summary,
    trip_goal_summary: summary,
    destinations: ["巴黎"],
    destination_scope: ["巴黎"],
    constraints: ["不要太赶"],
    travelers: ["两人"],
    travel_dates_or_duration: "7天",
    candidate_options: [],
    itinerary_outline: [],
    day_by_day_plan: [],
    transport_plan: [],
    stay_plan: [],
    food_plan: [],
    risk_notes: [],
    budget_notes: [],
    open_questions: [],
    rationale_refs: [],
    source_map: {},
    export_ready_text: "",
    changelog: [],
    dayPlans: [],
    source: { turnCount: 1 },
  } as any;
}

function makeLibrary(): MotifLibraryEntryPayload[] {
  const now = new Date().toISOString();
  return [
    {
      motif_type_id: "motif_health",
      motif_type_title: "健康限制优先",
      dependency: "constraint",
      abstraction_levels: ["L1", "L2"],
      status: "active",
      current_version_id: "mv_health_1",
      versions: [
        {
          version_id: "mv_health_1",
          version: 1,
          title: "健康限制优先",
          dependency: "constraint",
          reusable_description: "涉及健康与行动限制时，优先降低强度并减少楼梯。",
          abstraction_levels: {
            L1: "健康限制优先",
            L2: "行动限制影响路线强度",
          },
          status: "active",
          source_task_id: "task_prev_1",
          source_conversation_id: "conv_prev_1",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_prev_1"],
      usage_stats: {
        adopted_count: 2,
        ignored_count: 0,
        feedback_negative_count: 0,
        transfer_confidence: 0.84,
      },
    },
    {
      motif_type_id: "motif_local",
      motif_type_title: "在地体验优先",
      dependency: "enable",
      abstraction_levels: ["L1", "L2"],
      status: "active",
      current_version_id: "mv_local_1",
      versions: [
        {
          version_id: "mv_local_1",
          version: 1,
          title: "在地体验优先",
          dependency: "enable",
          reusable_description: "优先社区步行路线和在地体验。",
          abstraction_levels: {
            L1: "在地体验优先",
            L2: "真实体验优先于景点密度",
          },
          status: "active",
          source_task_id: "task_prev_2",
          source_conversation_id: "conv_prev_2",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_prev_2"],
      usage_stats: {
        adopted_count: 3,
        ignored_count: 1,
        feedback_negative_count: 0,
        transfer_confidence: 0.81,
      },
    },
  ];
}

const locale = "zh-CN" as const;

run("closed task detection should override all other signals", () => {
  const taskLifecycle: PlanningTaskLifecycle = { status: "closed", resume_required: true, resumable: true };
  const out = buildTaskDetection({
    conversationId: "conv_1",
    locale,
    currentDestinations: ["巴黎"],
    previousDestinations: ["巴黎"],
    taskLifecycle,
    latestUserText: "再帮我看看",
  });
  assert.equal(out.switch_reason_code, "closed_task");
  assert.equal(out.is_task_switch, true);
  assert.equal(out.confidence, 1);
});

run("explicit restart wording should produce explicit_restart", () => {
  const out = buildTaskDetection({
    conversationId: "conv_2",
    locale,
    currentDestinations: ["巴黎"],
    previousDestinations: ["巴黎"],
    latestUserText: "帮我重新规划一趟新的旅行任务",
  });
  assert.equal(out.switch_reason_code, "explicit_restart");
  assert.equal(out.is_task_switch, true);
});

run("latest-user-text detector should trigger destination switch for a different paired-country trip", () => {
  const prev = makePlan("冰岛七天旅行");
  prev.destinations = ["冰岛"];
  prev.destination_scope = ["冰岛"];
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_2",
    locale,
    previousTravelPlan: prev,
    latestUserText: "我想安排西班牙和葡萄牙10天，爸爸膝盖不好，不要每天换酒店。",
  });
  assert.equal(out.switch_reason_code, "destination_switch");
  assert.equal(out.is_task_switch, true);
});

run("lodging-focus refinement should stay in the same task when it clearly refines the current trip", () => {
  const prev = makePlan("冰岛九天旅行");
  prev.destinations = ["冰岛"];
  prev.destination_scope = ["冰岛"];
  prev.travel_dates_or_duration = "9天";
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_3",
    locale,
    previousTravelPlan: prev,
    latestUserText: "不是必须环岛，南岸多住一点也可以，斯奈山半岛先不去，整体还是9天。",
  });
  assert.equal(out.switch_reason_code, "continuous");
  assert.equal(out.is_task_switch, false);
});

run("fresh trip phrasing should still switch even if the new task mentions longer lodging", () => {
  const prev = makePlan("冰岛九天旅行");
  prev.destinations = ["冰岛"];
  prev.destination_scope = ["冰岛"];
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_4",
    locale,
    previousTravelPlan: prev,
    latestUserText: "我想安排西班牙10天，住久一点也可以，不要太赶。",
  });
  assert.equal(out.switch_reason_code, "destination_switch");
  assert.equal(out.is_task_switch, true);
});

run("coarse region refined into city-night allocation should stay in the same task", () => {
  const prev = makePlan("关西七天旅行");
  prev.destinations = ["关西"];
  prev.destination_scope = ["关西"];
  prev.travel_dates_or_duration = "7天";
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_5",
    locale,
    previousTravelPlan: prev,
    latestUserText: "可以，那就按京都为主住6晚，大阪最后1晚，整体还是7天。",
  });
  assert.equal(out.switch_reason_code, "continuous");
  assert.equal(out.is_task_switch, false);
});

run("country refined into city allocation with transition stop should stay in the same task", () => {
  const prev = makePlan("摩洛哥八天旅行");
  prev.destinations = ["摩洛哥"];
  prev.destination_scope = ["摩洛哥"];
  prev.travel_dates_or_duration = "8天";
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_6",
    locale,
    previousTravelPlan: prev,
    latestUserText: "先按马拉喀什4晚、非斯2晚，卡萨最多半天过渡，整体还是8天。",
  });
  assert.equal(out.switch_reason_code, "continuous");
  assert.equal(out.is_task_switch, false);
});

run("fresh trip phrasing with city allocation should still switch tasks", () => {
  const prev = makePlan("关西七天旅行");
  prev.destinations = ["关西"];
  prev.destination_scope = ["关西"];
  const out = detectTaskSwitchFromLatestUserTurn({
    conversationId: "conv_7",
    locale,
    previousTravelPlan: prev,
    latestUserText: "我想安排西班牙和葡萄牙10天，里斯本4晚、塞维利亚4晚，剩下2天机动。",
  });
  assert.equal(out.switch_reason_code, "destination_switch");
  assert.equal(out.is_task_switch, true);
});

run("retrieval hints should down-rank stable profile motifs when carry is disabled", () => {
  const plan = makePlan("巴黎七天旅行，妈妈膝盖不好，涉及健康与行动限制，还是想慢节奏。");
  plan.trip_goal_summary = "巴黎七天旅行，健康限制优先，少楼梯，慢节奏。";
  plan.constraints = ["健康限制优先", "减少楼梯", "不要太赶"];
  const motifLibrary = makeLibrary();
  const unrestricted = buildTransferRecommendations({
    locale,
    conversationId: "conv_new",
    currentTaskId: "task_new",
    travelPlanState: plan,
    retrievalHints: {
      sourceTaskId: "task_prev_1",
      sourceConversationId: "conv_prev_1",
    },
    motifLibrary,
    maxCount: 2,
  });
  const restricted = buildTransferRecommendations({
    locale,
    conversationId: "conv_new",
    currentTaskId: "task_new",
    travelPlanState: plan,
    retrievalHints: {
      sourceTaskId: "task_prev_1",
      sourceConversationId: "conv_prev_1",
      keepConsistentText: "继续保持在地体验",
      carryStableProfile: false,
      carryHealthReligion: false,
    },
    motifLibrary,
    maxCount: 2,
  });
  const unrestrictedHealth = unrestricted.find((x) => x.motif_type_id === "motif_health");
  const restrictedHealth = restricted.find((x) => x.motif_type_id === "motif_health");
  assert.ok(unrestrictedHealth, "health motif should remain eligible for the direct previous task");
  assert.ok(
    !restrictedHealth || Number(restrictedHealth.match_score) < Number(unrestrictedHealth.match_score),
    "health motif should be penalized or filtered when stable carry is disabled"
  );
});

run("motif version dedupe should skip identical abstraction text", () => {
  const unchanged = motifVersionMeaningfullyChanged({
    existing: {
      title: "在地体验优先",
      dependency: "enable",
      reusable_description: "优先社区步行路线和在地体验。",
      abstraction_levels: {
        L1: "在地体验优先",
        L2: "真实体验优先于景点密度",
      },
    },
    next: {
      title: "在地体验优先",
      dependency: "enable",
      reusable_description: "优先社区步行路线和在地体验。",
      abstraction_levels: {
        L1: "在地体验优先",
        L2: "真实体验优先于景点密度",
      },
    },
  });
  const changed = motifVersionMeaningfullyChanged({
    existing: {
      title: "在地体验优先",
      dependency: "enable",
      reusable_description: "优先社区步行路线和在地体验。",
      abstraction_levels: {
        L1: "在地体验优先",
        L2: "真实体验优先于景点密度",
      },
    },
    next: {
      title: "在地体验优先",
      dependency: "enable",
      reusable_description: "优先社区步行路线和在地体验。",
      abstraction_levels: {
        L1: "在地体验优先",
        L2: "更强调低密度、慢节奏的真实体验",
      },
    },
  });
  assert.equal(unchanged, false);
  assert.equal(changed, true);
});

console.log("All new-task boundary regression checks passed.");
