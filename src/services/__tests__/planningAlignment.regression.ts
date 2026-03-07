import assert from "node:assert/strict";

import { buildCognitiveState, buildPortfolioDocumentState } from "../planningState.js";
import type { MotifLibraryEntryPayload } from "../motifTransfer/types.js";
import { renderPortfolioTravelPlanPdf } from "../travelPlan/pdf.js";
import { buildTravelPlanSourceMapKey, buildTravelPlanState } from "../travelPlan/state.js";

async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err?.message || err);
    throw err;
  }
}

function graphWithDestination(destination: string, id = "g_test"): any {
  return {
    id,
    version: 1,
    nodes: [
      {
        id: "n_goal",
        type: "belief",
        layer: "intent",
        key: "slot:goal",
        statement: "意图：制定旅行计划",
        status: "confirmed",
        confidence: 0.92,
        importance: 0.9,
      },
      {
        id: `n_dest_${destination}`,
        type: "factual_assertion",
        key: `slot:destination:${destination}`,
        statement: `目的地：${destination}`,
        status: "confirmed",
        confidence: 0.9,
        importance: 0.85,
      },
    ],
    edges: [],
  };
}

function conceptFixture(params: {
  id: string;
  title: string;
  description?: string;
  validationStatus?: "unasked" | "pending" | "resolved";
  sourceMsgIds?: string[];
  evidenceTerms?: string[];
}) {
  return {
    id: params.id,
    kind: "belief",
    validationStatus: params.validationStatus || "resolved",
    extractionStage: "disambiguation",
    polarity: "positive",
    scope: "global",
    family: "other",
    semanticKey: `semantic:${params.id}`,
    title: params.title,
    description: params.description || params.title,
    score: 0.88,
    nodeIds: [`n_${params.id}`],
    evidenceTerms: params.evidenceTerms || [],
    sourceMsgIds: params.sourceMsgIds || [],
    locked: false,
    paused: false,
    updatedAt: new Date().toISOString(),
  } as any;
}

function turnsFixture() {
  return [
    {
      createdAt: new Date().toISOString(),
      userText: "帮我做个旅行计划，别太赶。",
      assistantText: "第1天：抵达后轻松步行。第2天：核心景点。第3天：返程前收尾。",
    },
  ];
}

function englishTurnsFixture() {
  return [
    {
      createdAt: new Date().toISOString(),
      userText: "Plan a Milan trip for March 10-12. Keep it safe and low-hassle.",
      assistantText:
        "Day 1: Arrive and settle in.\n- Hotel check-in near the center\nDay 2: Central Milan highlights.\n- Duomo and nearby walk\nDay 3: Departure day.\n- Airport transfer buffer",
    },
  ];
}

function motifLibraryEntryFixture(params: {
  motifTypeId: string;
  title: string;
  reusableDescription: string;
  dependency?: string;
  sourceTaskId: string;
  sourceConversationId: string;
}): MotifLibraryEntryPayload {
  const now = new Date().toISOString();
  return {
    motif_type_id: params.motifTypeId,
    motif_type_title: params.title,
    dependency: params.dependency || "constraint",
    abstraction_levels: ["L1", "L2"],
    status: "active",
    current_version_id: `${params.motifTypeId}_v1`,
    versions: [
      {
        version_id: `${params.motifTypeId}_v1`,
        version: 1,
        title: params.title,
        dependency: params.dependency || "constraint",
        reusable_description: params.reusableDescription,
        abstraction_levels: {
          L1: params.title,
          L2: params.reusableDescription,
        },
        status: "active",
        source_task_id: params.sourceTaskId,
        source_conversation_id: params.sourceConversationId,
        created_at: now,
        updated_at: now,
      },
    ],
    reusable_description: params.reusableDescription,
    usage_count: 1,
    source_task_ids: [params.sourceTaskId],
    usage_stats: {
      adopted_count: 1,
      ignored_count: 0,
      feedback_negative_count: 0,
      transfer_confidence: 0.8,
    },
  };
}

async function main() {
  await run("source_map defaults to assistant_proposed and upgrades on user confirmation", () => {
    const graph = graphWithDestination("米兰", "conv_alpha");
    const base = buildTravelPlanState({
      locale: "zh-CN",
      graph,
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_alpha",
      previous: null,
    });
    assert.equal(base.source_map?.destination_scope?.source_label, "assistant_proposed");

    const confirmedConcept = conceptFixture({
      id: "c_dest_milan",
      title: "米兰",
      description: "用户确认目的地是米兰",
      validationStatus: "resolved",
      sourceMsgIds: ["msg_u_1"],
      evidenceTerms: ["米兰"],
    });
    const upgraded = buildTravelPlanState({
      locale: "zh-CN",
      graph,
      turns: turnsFixture(),
      concepts: [confirmedConcept],
      motifs: [],
      taskId: "conv_alpha",
      previous: base,
    });
    assert.equal(upgraded.source_map?.destination_scope?.source_label, "user_confirmed");
  });

  await run("source_map array keys stay Mongo-safe for empty bootstrap plans", () => {
    const plan = buildTravelPlanState({
      locale: "zh-CN",
      graph: { id: "conv_safe", version: 0, nodes: [], edges: [] },
      turns: [],
      concepts: [],
      motifs: [],
      taskId: "conv_safe",
      previous: null,
    });
    const keys = Object.keys(plan.source_map || {});
    assert.equal(keys.some((key) => key.includes(".")), false);
    assert.ok(keys.includes(buildTravelPlanSourceMapKey("open_questions", 1)));
  });

  await run("concepts_from_user excludes assistant-only and unknown evidence concepts", () => {
    const travelPlan = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("京都", "conv_beta"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_beta",
      previous: null,
    });

    const model = {
      concepts: [
        conceptFixture({
          id: "c_user_only",
          title: "不要太累",
          sourceMsgIds: ["msg_u_4"],
          evidenceTerms: ["不要太累"],
        }),
        conceptFixture({
          id: "c_assistant_only",
          title: "建议住三晚",
          sourceMsgIds: ["msg_a_2"],
          evidenceTerms: ["住三晚"],
        }),
        conceptFixture({
          id: "c_unknown",
          title: "未知来源偏好",
          sourceMsgIds: [],
          evidenceTerms: ["未知来源"],
        }),
      ],
      motifs: [],
    } as any;

    const cognitive = buildCognitiveState({
      conversationId: "conv_beta",
      locale: "zh-CN",
      model,
      travelPlanState: travelPlan,
    });
    const currentTask = cognitive.tasks.find((t) => t.task_id === cognitive.current_task_id);
    assert.ok(currentTask);
    assert.deepEqual(
      (currentTask?.concepts_from_user || []).map((c) => c.concept_id),
      ["c_user_only"]
    );
  });

  await run("motif_library no longer derives current-task motifs into historical suggestions", () => {
    const travelPlan = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("首尔", "conv_scope"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "task_scope_current",
      previous: null,
    });

    const cognitive = buildCognitiveState({
      conversationId: "conv_scope",
      locale: "zh-CN",
      model: {
        concepts: [],
        motifs: [
          {
            id: "m_current",
            motif_id: "m_current",
            title: "慢节奏 + 少换酒店",
            relation: "constraint",
            dependencyClass: "constraint",
            status: "active",
            confidence: 0.9,
            conceptIds: ["c1", "c2"],
            anchorConceptId: "c2",
          },
        ],
      } as any,
      travelPlanState: travelPlan,
      persistentMotifLibrary: [],
    });

    assert.deepEqual(cognitive.motif_library, []);
  });

  await run("motif_library scope only keeps the direct previous task and excludes current-task entries", () => {
    const travelPlan = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("首尔", "conv_scope_prev"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "task_scope_current",
      previous: null,
    });

    const cognitive = buildCognitiveState({
      conversationId: "conv_scope_prev",
      locale: "zh-CN",
      model: {
        concepts: [],
        motifs: [],
      } as any,
      travelPlanState: travelPlan,
      persistentMotifLibrary: [
        motifLibraryEntryFixture({
          motifTypeId: "motif_current_shadow",
          title: "当前任务影子规则",
          reusableDescription: "不应该出现在历史思路库里",
          sourceTaskId: "task_scope_current",
          sourceConversationId: "conv_scope_prev",
        }),
        motifLibraryEntryFixture({
          motifTypeId: "motif_prev_only",
          title: "上一任务的慢节奏规则",
          reusableDescription: "上一任务确认过，适合继续沿用",
          sourceTaskId: "task_scope_prev_1",
          sourceConversationId: "conv_prev_1",
        }),
        motifLibraryEntryFixture({
          motifTypeId: "motif_older_other",
          title: "更早任务的跨城规则",
          reusableDescription: "这条不是直接上一任务，不应出现在 task2 默认继承里",
          sourceTaskId: "task_older_1",
          sourceConversationId: "conv_older_1",
        }),
      ],
      motifLibraryScope: {
        sourceTaskId: "task_scope_prev_1",
        sourceConversationId: "conv_prev_1",
      },
    });

    assert.deepEqual(
      (cognitive.motif_library || []).map((item) => item.motif_type_id),
      ["motif_prev_only"]
    );
  });

  await run("task switch archives previous trip section and resets current task track", () => {
    const first = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("东京", "conv_gamma"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_gamma",
      previous: null,
    });

    const second = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("大阪", "conv_gamma"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_gamma",
      previous: first,
    });

    assert.notEqual(second.task_id, first.task_id);
    assert.equal(second.plan_version, 1);
    assert.ok(Array.isArray(second.task_history));
    assert.ok((second.task_history || []).some((x) => x.task_id === first.task_id));
  });

  await run("forceTaskSwitch false should preserve current task track for coarse-to-fine refinements", () => {
    const first = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("关西", "conv_refine"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_refine",
      previous: null,
    });

    const refinedGraph = {
      id: "conv_refine",
      version: 2,
      nodes: [
        {
          id: "n_goal",
          type: "belief",
          layer: "intent",
          key: "slot:goal",
          statement: "意图：去京都和大阪旅游7天",
          status: "confirmed",
          confidence: 0.92,
          importance: 0.9,
        },
        {
          id: "n_total",
          type: "constraint",
          layer: "requirement",
          key: "slot:duration_total",
          statement: "总行程时长: 7天",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.84,
        },
        {
          id: "n_dest_kyoto",
          type: "factual_assertion",
          key: "slot:destination:京都",
          statement: "目的地：京都",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.85,
        },
        {
          id: "n_dest_osaka",
          type: "factual_assertion",
          key: "slot:destination:大阪",
          statement: "目的地：大阪",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.85,
        },
        {
          id: "n_city_kyoto",
          type: "factual_assertion",
          key: "slot:duration_city:京都",
          statement: "城市时长: 京都 6天",
          status: "confirmed",
          confidence: 0.84,
          importance: 0.72,
        },
        {
          id: "n_city_osaka",
          type: "factual_assertion",
          key: "slot:duration_city:大阪",
          statement: "城市时长: 大阪 1天",
          status: "confirmed",
          confidence: 0.84,
          importance: 0.72,
        },
      ],
      edges: [],
    } as any;

    const second = buildTravelPlanState({
      locale: "zh-CN",
      graph: refinedGraph,
      turns: [
        ...turnsFixture(),
        {
          createdAt: new Date().toISOString(),
          userText: "可以，那就按京都为主住6晚，大阪最后1晚，整体还是7天。",
          assistantText: "收到",
        },
      ],
      concepts: [],
      motifs: [],
      taskId: "conv_refine",
      previous: first,
      forceTaskSwitch: false,
    });

    assert.equal(second.task_id, first.task_id);
    assert.equal(second.plan_version, first.plan_version + 1);
    assert.equal((second.task_history || []).length || 0, 0);
  });

  await run("en-US travel plan text stays pure English with English date anchors", () => {
    const graph = {
      id: "conv_en",
      version: 1,
      nodes: [
        {
          id: "n_goal",
          type: "belief",
          layer: "intent",
          key: "slot:goal",
          statement: "Intent: travel to Milan for 3 days",
          status: "confirmed",
          confidence: 0.92,
          importance: 0.9,
        },
        {
          id: "n_dest_milan",
          type: "factual_assertion",
          key: "slot:destination:milan",
          statement: "Destination: Milan",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.85,
        },
        {
          id: "n_duration",
          type: "constraint",
          key: "slot:duration_total",
          statement: "Total duration: 3 days",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.84,
        },
        {
          id: "n_budget",
          type: "constraint",
          key: "slot:budget",
          statement: "Budget cap: 10000 CNY",
          status: "confirmed",
          confidence: 0.88,
          importance: 0.82,
        },
      ],
      edges: [],
    } as any;

    const plan = buildTravelPlanState({
      locale: "en-US",
      graph,
      turns: englishTurnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_en",
      previous: null,
    });

    const joined = [
      plan.summary,
      plan.trip_goal_summary,
      plan.travel_dates_or_duration,
      plan.export_ready_text,
      plan.day_by_day_plan.map((d) => `${d.dateLabel || ""} ${d.title} ${(d.items || []).join(" ")}`).join(" "),
    ]
      .filter(Boolean)
      .join("\n");

    assert.equal(plan.travel_dates_or_duration, "3/10 - 3/12 (3d)");
    assert.equal(plan.day_by_day_plan[0]?.dateLabel, "3/10");
    assert.match(plan.summary, /Destinations: Milan/);
    assert.match(plan.export_ready_text, /Duration: 3\/10 - 3\/12 \(3d\)/);
    assert.equal(/[\u4e00-\u9fff]/.test(joined), false);
  });

  await run("portfolio PDF renders multi-trip sections", async () => {
    const first = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("香港", "conv_delta"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_delta",
      previous: null,
    });
    const second = buildTravelPlanState({
      locale: "zh-CN",
      graph: graphWithDestination("大阪", "conv_delta"),
      turns: turnsFixture(),
      concepts: [],
      motifs: [],
      taskId: "conv_delta",
      previous: first,
    });
    const portfolio = buildPortfolioDocumentState({
      userId: "user_alignment_test",
      locale: "zh-CN",
      conversations: [
        {
          conversationId: "conv_delta",
          title: "多行程测试",
          travelPlanState: second,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const pdf = await renderPortfolioTravelPlanPdf({
      portfolio,
      conversationId: "conv_delta",
      locale: "zh-CN",
      fallbackPlan: second,
    });
    const pdfRaw = pdf.toString("latin1");
    const pageCount = (pdfRaw.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 1000);
    assert.ok(pageCount >= 3);
  });

  console.log("All planning alignment checks passed.");
}

main().catch((err) => {
  console.error("planning alignment regression failed");
  console.error(err);
  process.exit(1);
});
