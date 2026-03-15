import assert from "node:assert/strict";

import { ObjectId } from "mongodb";

import { collections } from "../../db/mongo.js";
import type { CDG } from "../../core/graph.js";
import {
  buildTurnRuntimeBase,
  buildLongTermRuntimeBase,
  computeTravelPlanState,
  emptyManualGraphOverrides,
} from "../../routes/conversations.js";
import { defaultLongTermScenarioState } from "../longTermPlan/state.js";

type FakeTurnDoc = {
  conversationId: ObjectId;
  userId: ObjectId;
  taskId?: string;
  createdAt: Date;
  userText: string;
  assistantText: string;
  graphPatch?: any;
  graphVersion?: number;
};

function makeGraph(id: string, destination: string): CDG {
  return {
    id,
    version: 1,
    nodes: [
      {
        id: `n_${destination}`,
        type: "belief",
        layer: "intent",
        statement: `目的地: ${destination}`,
        status: "active",
        confidence: 0.92,
        key: `slot:destination:${destination}`,
      } as any,
    ],
    edges: [],
  };
}

function makeTurnsCollection(docs: FakeTurnDoc[]) {
  function matches(doc: FakeTurnDoc, filter: any) {
    if (filter?.conversationId && String(doc.conversationId) !== String(filter.conversationId)) return false;
    if (filter?.userId && String(doc.userId) !== String(filter.userId)) return false;
    if (filter?.taskId && String(doc.taskId || "") !== String(filter.taskId || "")) return false;
    if (filter?.createdAt?.$gt) {
      const threshold = new Date(filter.createdAt.$gt).getTime();
      if (!(doc.createdAt.getTime() > threshold)) return false;
    }
    return true;
  }

  return {
    find(filter: any) {
      let rows = docs.filter((doc) => matches(doc, filter));
      return {
        sort(sortSpec: Record<string, 1 | -1>) {
          const direction = Number(sortSpec?.createdAt || 1) >= 0 ? 1 : -1;
          rows = rows
            .slice()
            .sort((a, b) =>
              direction > 0
                ? a.createdAt.getTime() - b.createdAt.getTime()
                : b.createdAt.getTime() - a.createdAt.getTime()
            );
          return {
            limit(n: number) {
              return {
                async toArray() {
                  return rows.slice(0, n);
                },
              };
            },
          };
        },
      };
    },
  } as any;
}

async function main() {
  const conversationId = new ObjectId("65f100000000000000000001");
  const userId = new ObjectId("65f100000000000000000002");
  const originalTurns = (collections as any).turns;

  const previousPlan = {
    task_id: `${String(conversationId)}:task_2`,
    plan_version: 1,
    destination_scope: ["京都"],
    destinations: ["京都"],
    source: { turnCount: 2 },
    task_history: [
      {
        task_id: String(conversationId),
        closed_at: "2026-03-08T01:30:00.000Z",
      },
    ],
  } as any;

  try {
    const taggedTurns: FakeTurnDoc[] = [
      {
        conversationId,
        userId,
        taskId: String(conversationId),
        createdAt: new Date("2026-03-08T01:00:00.000Z"),
        userText: "先规划一个苏州任务，想带父母去4天，节奏慢一点。",
        assistantText: "好的，先按苏州来。",
      },
      {
        conversationId,
        userId,
        taskId: String(conversationId),
        createdAt: new Date("2026-03-08T01:10:00.000Z"),
        userText: "酒店靠地铁，有电梯。",
        assistantText: "记下了。",
      },
      {
        conversationId,
        userId,
        taskId: `${String(conversationId)}:task_2`,
        createdAt: new Date("2026-03-08T02:00:00.000Z"),
        userText: "重新规划一个新任务，这次只保留京都。",
        assistantText: "好的，切到京都。",
      },
      {
        conversationId,
        userId,
        taskId: `${String(conversationId)}:task_2`,
        createdAt: new Date("2026-03-08T02:10:00.000Z"),
        userText: "不要高星酒店，交通方便更重要。",
        assistantText: "收到。",
      },
    ];
    (collections as any).turns = makeTurnsCollection(taggedTurns);

    const runtime = await buildTurnRuntimeBase({
      conversationId,
      userId,
      conv: {
        graph: makeGraph(String(conversationId), "京都"),
        concepts: [],
        motifs: [],
        motifLinks: [],
        contexts: [],
        manualGraphOverrides: emptyManualGraphOverrides(),
        travelPlanState: previousPlan,
      },
      locale: "zh-CN",
      userText: "继续补一下晚饭和午休安排。",
      taskLifecycle: null,
    });

    assert.equal(runtime.forceTaskSwitch, false);
    assert.equal(runtime.activeTaskId, `${String(conversationId)}:task_2`);
    assert.equal(runtime.predictedTaskId, `${String(conversationId)}:task_2`);
    assert.deepEqual(
      runtime.stateContextUserTurns,
      ["重新规划一个新任务，这次只保留京都。", "不要高星酒店，交通方便更重要。"]
    );
    assert.equal(runtime.recentDocs.every((doc) => String((doc as any).taskId || "").endsWith(":task_2")), true);

    const legacyTurns: FakeTurnDoc[] = [
      {
        conversationId,
        userId,
        createdAt: new Date("2026-03-08T01:00:00.000Z"),
        userText: "先规划一个苏州任务，想带父母去4天，节奏慢一点。",
        assistantText: "好的，先按苏州来。",
      },
      {
        conversationId,
        userId,
        createdAt: new Date("2026-03-08T01:10:00.000Z"),
        userText: "酒店靠地铁，有电梯。",
        assistantText: "记下了。",
      },
      {
        conversationId,
        userId,
        createdAt: new Date("2026-03-08T02:00:00.000Z"),
        userText: "重新规划一个新任务，这次只保留京都。",
        assistantText: "好的，切到京都。",
      },
      {
        conversationId,
        userId,
        createdAt: new Date("2026-03-08T02:10:00.000Z"),
        userText: "不要高星酒店，交通方便更重要。",
        assistantText: "收到。",
      },
    ];
    (collections as any).turns = makeTurnsCollection(legacyTurns);

    const scopedPlan = await computeTravelPlanState({
      conversationId,
      userId,
      graph: makeGraph(String(conversationId), "京都"),
      concepts: [],
      motifs: [],
      previous: previousPlan,
      locale: "zh-CN",
      queryTaskId: `${String(conversationId)}:task_2`,
      since: "2026-03-08T01:30:00.000Z",
    });

    assert.deepEqual(scopedPlan.destination_scope, ["京都"]);
    assert.equal(scopedPlan.source?.turnCount, 2);
    assert.equal(
      (scopedPlan.evidenceAppendix || []).some((item: any) => /苏州/.test(String(item?.content || ""))),
      false
    );

    const longTermScenario = defaultLongTermScenarioState({
      conversationId: String(conversationId),
      locale: "zh-CN",
      nowIso: "2026-03-08T03:00:00.000Z",
    });
    longTermScenario.segments.fitness.status = "completed";
    longTermScenario.segments.study.status = "active";
    longTermScenario.active_segment = "study";
    const longTermTurns: FakeTurnDoc[] = [
      {
        conversationId,
        userId,
        taskId: longTermScenario.segments.fitness.task_id,
        createdAt: new Date("2026-03-08T03:05:00.000Z"),
        userText: "我想每周锻炼两三次，每次十五到三十分钟。",
        assistantText: "我们先按轻量健身计划来。",
      },
    ];
    (collections as any).turns = makeTurnsCollection(longTermTurns);

    const longTermRuntime = await buildLongTermRuntimeBase({
      conversationId,
      userId,
      conv: {
        longTermScenarioState: longTermScenario,
      },
      locale: "zh-CN",
    });

    assert.equal(longTermRuntime.taskId, longTermScenario.segments.study.task_id);
    assert.equal(longTermRuntime.recentDocs.length, 0);
    assert.deepEqual(longTermRuntime.recentTurns, []);
    assert.deepEqual(longTermRuntime.stateContextUserTurns, []);
    assert.equal(longTermRuntime.hasTaskDialogue, false);

    console.log("PASS turn task scoping keeps current-task runtime and long-term task boundaries isolated");
  } finally {
    (collections as any).turns = originalTurns;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
