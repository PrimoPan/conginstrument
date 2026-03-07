import assert from "node:assert/strict";

import type { TravelPlanState } from "../travelPlan/state.js";
import { buildTransferRecommendations } from "../motifTransfer/retrieval.js";
import {
  applyTransferDecision,
  confirmTransferInjection,
} from "../motifTransfer/decision.js";
import { applyTransferFeedback } from "../motifTransfer/feedback.js";
import {
  appendFollowupQuestion,
  registerRevisionRequestFromUtterance,
  resolveRevisionRequest,
} from "../motifTransfer/revision.js";
import { buildTransferredConstraintPrompt, applyTransferStateToMotifs } from "../motifTransfer/application.js";
import type { MotifLibraryEntryPayload, MotifTransferState } from "../motifTransfer/types.js";

function run(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((err: any) => {
      console.error(`FAIL ${name}:`, err?.message || err);
      throw err;
    });
}

function makeTravelPlanState(): TravelPlanState {
  return {
    version: 1,
    plan_version: 2,
    task_id: "task_paris_2",
    updatedAt: new Date().toISOString(),
    summary: "帮我规划巴黎七天旅行，偏好本地体验和地面活动。",
    trip_goal_summary: "巴黎七天旅行，偏好真实本地体验、低强度行程",
    destinations: ["巴黎"],
    destination_scope: ["巴黎"],
    constraints: ["不要太赶", "优先公共交通便利"],
    travelers: ["两人"],
    travel_dates_or_duration: "7天",
    dayPlans: [],
    source: { turnCount: 1 },
  } as any;
}

function makeMotifLibrary(): MotifLibraryEntryPayload[] {
  const now = new Date().toISOString();
  return [
    {
      motif_type_id: "mt_local_lodging",
      motif_type_title: "偏好目的地本地住宿",
      dependency: "determine",
      abstraction_levels: ["L1", "L2", "L3"],
      status: "active",
      current_version_id: "mv_local_2",
      versions: [
        {
          version_id: "mv_local_1",
          version: 1,
          title: "偏好香港 Airbnb",
          dependency: "determine",
          reusable_description: "遇到城市旅行优先筛选本地住宿",
          abstraction_levels: {
            L1: "偏好香港 Airbnb",
            L2: "偏好目的地本地住宿",
            L3: "偏好真实本地体验",
          },
          status: "active",
          source_task_id: "task_hk_1",
          source_conversation_id: "conv_hk",
          created_at: now,
          updated_at: now,
        },
        {
          version_id: "mv_local_2",
          version: 2,
          title: "偏好目的地本地住宿",
          dependency: "determine",
          reusable_description: "优先本地住宿与公共交通平衡",
          abstraction_levels: {
            L1: "偏好目的地本地住宿",
            L2: "偏好真实本地体验",
            L3: "减少标准酒店依赖",
          },
          status: "active",
          source_task_id: "task_hk_1",
          source_conversation_id: "conv_hk",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_hk_1"],
      usage_stats: {
        adopted_count: 6,
        ignored_count: 1,
        feedback_negative_count: 0,
        transfer_confidence: 0.9,
      },
    },
    {
      motif_type_id: "mt_low_intensity",
      motif_type_title: "低强度节奏优先",
      dependency: "constraint",
      abstraction_levels: ["L1", "L2"],
      status: "active",
      current_version_id: "mv_pace_1",
      versions: [
        {
          version_id: "mv_pace_1",
          version: 1,
          title: "低强度节奏优先",
          dependency: "constraint",
          reusable_description: "安排中午休整，减少跨城高强度活动",
          abstraction_levels: {
            L1: "不要太赶",
            L2: "低强度节奏优先",
          },
          status: "active",
          source_task_id: "task_sz_1",
          source_conversation_id: "conv_sz",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_sz_1"],
      usage_stats: {
        adopted_count: 4,
        ignored_count: 2,
        feedback_negative_count: 1,
        transfer_confidence: 0.78,
      },
    },
    {
      motif_type_id: "mt_check_context_first",
      motif_type_title: "先做情境匹配再选点",
      dependency: "enable",
      abstraction_levels: ["L1", "L2"],
      status: "uncertain",
      current_version_id: "mv_context_1",
      versions: [
        {
          version_id: "mv_context_1",
          version: 1,
          title: "先做情境匹配再选点",
          dependency: "enable",
          reusable_description: "先评估活动场景适配再锁定地点",
          abstraction_levels: {
            L1: "先做情境匹配再选点",
            L2: "避免直接复用旧地点",
          },
          status: "uncertain",
          source_task_id: "task_sz_1",
          source_conversation_id: "conv_sz",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_sz_1"],
      usage_stats: {
        adopted_count: 1,
        ignored_count: 1,
        feedback_negative_count: 0,
        transfer_confidence: 0.66,
      },
    },
    {
      motif_type_id: "mt_local_transit_balance",
      motif_type_title: "在地体验与交通便利平衡",
      dependency: "determine",
      abstraction_levels: ["L1", "L2"],
      status: "active",
      current_version_id: "mv_balance_1",
      versions: [
        {
          version_id: "mv_balance_1",
          version: 1,
          title: "在地体验与交通便利平衡",
          dependency: "determine",
          reusable_description: "优先本地体验，同时保持公共交通便利和慢节奏。",
          abstraction_levels: {
            L1: "本地体验 + 交通便利",
            L2: "在地体验与交通便利平衡",
          },
          status: "active",
          source_task_id: "task_sz_1",
          source_conversation_id: "conv_sz",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_sz_1"],
      usage_stats: {
        adopted_count: 5,
        ignored_count: 1,
        feedback_negative_count: 0,
        transfer_confidence: 0.83,
      },
    },
    {
      motif_type_id: "mt_current_task_shadow",
      motif_type_title: "当前任务影子规则",
      dependency: "constraint",
      abstraction_levels: ["L1", "L2"],
      status: "active",
      current_version_id: "mv_current_1",
      versions: [
        {
          version_id: "mv_current_1",
          version: 1,
          title: "当前任务影子规则",
          dependency: "constraint",
          reusable_description: "巴黎七天旅行优先本地体验和低强度节奏",
          abstraction_levels: {
            L1: "巴黎当前任务规则",
            L2: "巴黎七天低强度",
          },
          status: "active",
          source_task_id: "task_paris_2",
          source_conversation_id: "conv_paris",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_paris_2"],
      usage_stats: {
        adopted_count: 9,
        ignored_count: 0,
        feedback_negative_count: 0,
        transfer_confidence: 0.95,
      },
    },
    {
      motif_type_id: "mt_destination_specific_hk",
      motif_type_title: "仅香港地铁晚归线路",
      dependency: "determine",
      abstraction_levels: ["L1"],
      status: "cancelled",
      current_version_id: "mv_hk_1",
      versions: [
        {
          version_id: "mv_hk_1",
          version: 1,
          title: "仅香港地铁晚归线路",
          dependency: "determine",
          reusable_description: "这个规则高度香港特定，不建议迁移",
          abstraction_levels: {
            L1: "仅香港地铁晚归线路",
          },
          status: "cancelled",
          source_task_id: "task_hk_1",
          source_conversation_id: "conv_hk",
          created_at: now,
          updated_at: now,
        },
      ],
      source_task_ids: ["task_hk_1"],
      usage_stats: {
        adopted_count: 0,
        ignored_count: 4,
        feedback_negative_count: 2,
        transfer_confidence: 0.25,
      },
    },
  ];
}

function recommendationFromEntry(entry: MotifLibraryEntryPayload, matchScore: number) {
  const version =
    entry.versions.find((v) => v.version_id === entry.current_version_id) ||
    entry.versions[entry.versions.length - 1];
  return {
    candidate_id: `${entry.motif_type_id}::${entry.current_version_id}`,
    motif_type_id: entry.motif_type_id,
    motif_type_title: entry.motif_type_title,
    dependency: entry.dependency,
    reusable_description: version?.reusable_description || entry.reusable_description || entry.motif_type_title,
    status: entry.status,
    reason: "manual_test_seed",
    match_score: matchScore,
    recommended_mode: "A" as const,
    decision_status: "pending" as const,
    source_task_id: version?.source_task_id,
    source_conversation_id: version?.source_conversation_id,
    created_at: new Date().toISOString(),
  };
}

async function main() {
  const locale = "zh-CN" as const;
  const travelPlanState = makeTravelPlanState();
  const motifLibrary = makeMotifLibrary();
  let transferState: MotifTransferState = {
    recommendations: [],
    decisions: [],
    activeInjections: [],
    feedbackEvents: [],
    revisionRequests: [],
  };

  await run("Task1 存储后 Task2 首轮召回 1-4 条高相关建议并按匹配度排序", () => {
    const recs = buildTransferRecommendations({
      locale,
      conversationId: "conv_paris",
      currentTaskId: "task_paris_2",
      travelPlanState,
      retrievalHints: {
        sourceTaskId: "task_sz_1",
        sourceConversationId: "conv_sz",
      },
      motifLibrary,
      existingState: transferState,
      maxCount: 4,
    });
    transferState = { ...transferState, recommendations: recs, lastEvaluatedAt: new Date().toISOString() };

    assert.ok(recs.length >= 1 && recs.length <= 4, `unexpected recommendation count: ${recs.length}`);
    for (let i = 1; i < recs.length; i += 1) {
      assert.ok(recs[i - 1].match_score >= recs[i].match_score, "recommendations not sorted by match_score desc");
    }
  });

  await run("仅允许从上一 task 召回，并跳过当前 task 影子规则", () => {
    const recs = buildTransferRecommendations({
      locale,
      conversationId: "conv_paris",
      currentTaskId: "task_paris_2",
      travelPlanState,
      retrievalHints: {
        sourceTaskId: "task_sz_1",
        sourceConversationId: "conv_sz",
      },
      motifLibrary,
      existingState: transferState,
      maxCount: 4,
    });

    assert.ok(recs.length >= 1, "expected scoped recommendations from the previous task");
    assert.equal(recs.some((x) => x.motif_type_id === "mt_current_task_shadow"), false);
    assert.equal(recs.every((x) => x.source_task_id === "task_sz_1"), true);
  });

  await run("adopt / modify / ignore 三选一决策会先进入待确认，再由用户最终确认", () => {
    if (transferState.recommendations.length < 3) {
      transferState = {
        ...transferState,
        recommendations: [
          ...transferState.recommendations,
          ...motifLibrary
            .filter((entry) => entry.source_task_ids?.includes("task_sz_1"))
            .slice(0, 3)
            .map((entry, index) => recommendationFromEntry(entry, 0.72 - index * 0.08)),
        ]
          .filter((entry, index, arr) => arr.findIndex((x) => x.candidate_id === entry.candidate_id) === index)
          .slice(0, 3),
      };
    }

    assert.ok(transferState.recommendations.length >= 3, "need at least 3 recommendations");
    const adoptRec = transferState.recommendations[0];
    const modifyRec = transferState.recommendations[1];
    const ignoreRec = transferState.recommendations[2];

    const adoptOut = applyTransferDecision({
      locale,
      currentState: transferState,
      recommendation: adoptRec,
      action: "adopt",
    });
    transferState = adoptOut.state;

    const modifyOut = applyTransferDecision({
      locale,
      currentState: transferState,
      recommendation: modifyRec,
      action: "modify",
      revisedText: "这次仍优先本地体验，但酒店可放宽为交通便利优先",
    });
    transferState = modifyOut.state;
    assert.ok(!!modifyOut.followupQuestion);

    const ignoreOut = applyTransferDecision({
      locale,
      currentState: transferState,
      recommendation: ignoreRec,
      action: "ignore",
    });
    transferState = ignoreOut.state;

    assert.equal(transferState.decisions.length, 3);
    assert.ok(
      transferState.activeInjections.some(
        (x) => x.candidate_id === adoptRec.candidate_id && x.injection_state === "pending_confirmation"
      )
    );
    assert.ok(
      transferState.activeInjections.some(
        (x) => x.candidate_id === modifyRec.candidate_id && x.injection_state === "pending_confirmation"
      )
    );
    assert.equal(
      transferState.activeInjections.some((x) => x.candidate_id === ignoreRec.candidate_id),
      false
    );
  });

  await run("pending confirmation 经用户确认后可正式注入", () => {
    const pending = transferState.activeInjections.find(
      (x) => x.injection_state === "pending_confirmation" && x.mode === "B"
    );
    assert.ok(pending, "missing pending confirmation injection");
    transferState = confirmTransferInjection({
      currentState: transferState,
      candidateId: pending!.candidate_id,
    }).state;
    const updated = transferState.activeInjections.find((x) => x.candidate_id === pending!.candidate_id);
    assert.ok(updated && updated.injection_state === "injected");
    assert.equal(updated?.mode, "B");
  });

  await run("迁移失败反馈会降权并触发修订请求", () => {
    const adopted = transferState.activeInjections.find((x) => x.injection_state === "injected");
    assert.ok(adopted, "missing injected rule for feedback");
    for (let i = 0; i < 3; i += 1) {
      const out = applyTransferFeedback({
        locale,
        currentState: transferState,
        signal: "explicit_not_applicable",
        signalText: "这次不要沿用上次规则",
        candidateId: adopted!.candidate_id,
        motifTypeId: adopted!.motif_type_id,
      });
      transferState = out.state;
    }
    const degraded = transferState.activeInjections.find((x) => x.candidate_id === adopted!.candidate_id);
    assert.ok(degraded, "injection missing after feedback");
    assert.ok(Number(degraded!.transfer_confidence) < 0.52, "confidence not degraded enough");
    assert.equal(degraded!.injection_state, "disabled");
    assert.ok(
      transferState.revisionRequests.some(
        (x) => x.motif_type_id === adopted!.motif_type_id && x.status === "pending_user_choice"
      ),
      "revision request not created"
    );
  });

  await run("显式否定触发 IS3 修订协商，并支持 new_version / overwrite 决策", () => {
    const neg = registerRevisionRequestFromUtterance({
      locale,
      currentState: transferState,
      userText: "这次不要沿用上次那个规则，跟上次不同",
    });
    transferState = neg.state;

    const req = transferState.revisionRequests.find((x) => x.status === "pending_user_choice");
    assert.ok(req, "expected pending revision request");

    transferState = resolveRevisionRequest({
      currentState: transferState,
      requestId: req?.request_id,
      motifTypeId: req?.motif_type_id,
      choice: "new_version",
    });
    const resolved = transferState.revisionRequests.find((x) => x.request_id === req!.request_id);
    assert.ok(resolved && resolved.status === "resolved");
    assert.equal(resolved?.suggested_action, "new_version");
  });

  await run("相同的修订追问不应被重复追加到 assistant 回复里", () => {
    const assistantText =
      "为了确保规则准确，请确认限制因素“膝盖也不太好，别太赶”是硬约束，还是可协商偏好？";
    const followupQuestion =
      "请确认限制因素“膝盖也不太好，别太赶”是硬约束，还是可协商偏好？";
    const appended = appendFollowupQuestion(assistantText, followupQuestion);
    assert.equal(appended, assistantText);
  });

  await run("注入约束提示仅包含 injected 规则，并可映射到 motif 字段", () => {
    const remainingPending = transferState.activeInjections.find((x) => x.injection_state === "pending_confirmation");
    if (remainingPending) {
      transferState = confirmTransferInjection({
        currentState: transferState,
        candidateId: remainingPending.candidate_id,
      }).state;
    }
    const prompt = buildTransferredConstraintPrompt({
      locale,
      state: transferState,
    });
    assert.ok(prompt.includes("Transferred Motif Constraints") || prompt.includes("迁移约束"));

    const motifs = [
      {
        id: "m1",
        motif_id: "m1",
        motif_type: "enable",
        templateKey: "k1",
        motifType: "pair",
        relation: "enable",
        roles: { sources: ["c1"], target: "c2" },
        scope: "global",
        aliases: [],
        concept_bindings: ["c1", "c2"],
        conceptIds: ["c1", "c2"],
        anchorConceptId: "c2",
        title: "示例",
        description: "示例",
        confidence: 0.8,
        supportEdgeIds: [],
        supportNodeIds: [],
        status: "active",
        novelty: "new",
        updatedAt: new Date().toISOString(),
        motif_type_id: transferState.activeInjections[0]?.motif_type_id,
      },
    ] as any;
    const mapped = applyTransferStateToMotifs({
      motifs,
      state: transferState,
    });
    assert.ok(mapped[0].transfer_confidence !== undefined);
    assert.ok(mapped[0].injection_state !== undefined);
  });

  console.log("All motif transfer e2e checks passed.");
}

main().catch((err) => {
  console.error("motif transfer e2e regression failed");
  console.error(err);
  process.exit(1);
});
