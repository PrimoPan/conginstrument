import assert from "node:assert/strict";

import { buildCognitiveState, buildPortfolioDocumentState } from "../planningState.js";
import { renderPortfolioTravelPlanPdf } from "../travelPlan/pdf.js";
import { buildTravelPlanState } from "../travelPlan/state.js";

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
