import assert from "node:assert/strict";

import {
  extractIntentSignals,
  extractIntentSignalsWithRecency,
  mergeIntentSignals,
} from "../intentSignals.js";
import { analyzeConstraintConflicts } from "../conflictAnalyzer.js";
import { buildBudgetLedgerFromUserTurns } from "../../travelPlan/budgetLedger.js";
import { buildTravelPlanState } from "../../travelPlan/state.js";
import { buildSlotStateMachine } from "../slotStateMachine.js";
import { compileSlotStateToPatch } from "../slotGraphCompiler.js";
import { planUncertaintyQuestion } from "../../uncertainty/questionPlanner.js";
import { reconcileConceptsWithGraph } from "../../concepts.js";
import { reconcileMotifsWithGraph } from "../../motif/conceptMotifs.js";

type Case = {
  name: string;
  run: () => void;
};

const cases: Case[] = [
  {
    name: "budget colloquial: 1万5",
    run: () => {
      const s = extractIntentSignals("预算大概1万5人民币");
      assert.equal(s.budgetCny, 15000);
    },
  },
  {
    name: "budget colloquial CN digits: 三千五百",
    run: () => {
      const s = extractIntentSignals("总预算三千五百元");
      assert.equal(s.budgetCny, 3500);
    },
  },
  {
    name: "budget colloquial CN digits: 三千五",
    run: () => {
      const s = extractIntentSignals("预算三千五人民币");
      assert.equal(s.budgetCny, 3500);
    },
  },
  {
    name: "budget range with colloquial upper bound",
    run: () => {
      const s = extractIntentSignals("预算在1万到1万5之间");
      assert.equal(s.budgetCny, 15000);
    },
  },
  {
    name: "budget delta merge: 10000 + 5000 => 15000",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我预算10000元",
        "我父亲给我再增加5000元预算"
      );
      assert.equal(merged.budgetCny, 15000);
    },
  },
  {
    name: "budget delta colloquial giver phrase: 给了我5000预算",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我预算5000元",
        "我父亲又给了我5000预算"
      );
      assert.equal(merged.budgetCny, 10000);
    },
  },
  {
    name: "budget delta colloquial phrase: 增添了5000预算",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我预算5000元",
        "我父亲又跟我增添了5000预算"
      );
      assert.equal(merged.budgetCny, 10000);
    },
  },
  {
    name: "budget spent absolute should be parsed",
    run: () => {
      const s = extractIntentSignals("我酒店已经花了3000元");
      assert.equal(s.budgetSpentCny, 3000);
    },
  },
  {
    name: "budget total should not be overwritten by spent amount in same sentence",
    run: () => {
      const s = extractIntentSignals("总预算10000元，酒店花了3000元");
      assert.equal(s.budgetCny, 10000);
      assert.equal(s.budgetSpentCny, 3000);
      assert.equal(s.budgetRemainingCny, 7000);
      assert.equal(s.lodgingPreference, undefined);
    },
  },
  {
    name: "budget remaining from total - spent",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "总预算10000元",
        "酒店订在市中心花了3000元"
      );
      assert.equal(merged.budgetCny, 10000);
      assert.equal(merged.budgetSpentCny, 3000);
      assert.equal(merged.budgetRemainingCny, 7000);
    },
  },
  {
    name: "budget spent incremental update",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "总预算10000元，酒店花了3000元",
        "我又花了500元打车"
      );
      assert.equal(merged.budgetSpentCny, 3500);
      assert.equal(merged.budgetRemainingCny, 6500);
    },
  },
  {
    name: "foreign currency purchase should update spent and remaining budget",
    run: () => {
      const prevRate = process.env.CI_FX_EUR_TO_CNY;
      process.env.CI_FX_EUR_TO_CNY = "8";
      try {
        const merged = extractIntentSignalsWithRecency(
          "总预算10000元",
          "那买80欧元的吧"
        );
        assert.equal(merged.budgetCny, 10000);
        assert.equal(merged.budgetSpentCny, 640);
        assert.equal(merged.budgetRemainingCny, 9360);
      } finally {
        if (prevRate == null) delete process.env.CI_FX_EUR_TO_CNY;
        else process.env.CI_FX_EUR_TO_CNY = prevRate;
      }
    },
  },
  {
    name: "question-like foreign price should not be treated as spent commitment",
    run: () => {
      const prevRate = process.env.CI_FX_EUR_TO_CNY;
      process.env.CI_FX_EUR_TO_CNY = "8";
      try {
        const merged = extractIntentSignalsWithRecency(
          "总预算10000元",
          "球票80欧元可以吗？"
        );
        assert.equal(merged.budgetCny, 10000);
        assert.equal(merged.budgetSpentCny, undefined);
        assert.equal(merged.budgetRemainingCny, undefined);
      } finally {
        if (prevRate == null) delete process.env.CI_FX_EUR_TO_CNY;
        else process.env.CI_FX_EUR_TO_CNY = prevRate;
      }
    },
  },
  {
    name: "category committed budget should be deducted from remaining",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "总预算10000元",
        "酒店预算就按3000元定在市中心"
      );
      assert.equal(merged.budgetCny, 10000);
      assert.equal(merged.budgetSpentCny, 3000);
      assert.equal(merged.budgetRemainingCny, 7000);
    },
  },
  {
    name: "historical budget delta should not be re-applied on later non-budget turn",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        [
          "我想去意大利米兰旅行3天，预算在10000元人民币，机票已经买了",
          "我的父亲突然给我增加了5000的预算",
        ].join("\n"),
        "我4月10日到4月12日在米兰玩，4月13日离开米兰"
      );
      assert.equal(merged.budgetCny, 15000);
    },
  },
  {
    name: "meeting date range in auto mode prefers exclusive boundary",
    run: () => {
      const s = extractIntentSignals("我4月13日到4月18日在巴塞罗那参加CHI学术会议");
      assert.equal(s.durationDays, 5);
    },
  },
  {
    name: "travel date range in auto mode defaults to inclusive boundary",
    run: () => {
      const s = extractIntentSignals("我4月13日到4月18日去巴塞罗那旅游");
      assert.equal(s.durationDays, 6);
    },
  },
  {
    name: "date boundary mode: exclusive",
    run: () => {
      const prev = process.env.CI_DATE_RANGE_BOUNDARY_MODE;
      process.env.CI_DATE_RANGE_BOUNDARY_MODE = "exclusive";
      try {
        const s = extractIntentSignals("我4月13日到4月18日去巴塞罗那旅游");
        assert.equal(s.durationDays, 5);
      } finally {
        if (prev == null) delete process.env.CI_DATE_RANGE_BOUNDARY_MODE;
        else process.env.CI_DATE_RANGE_BOUNDARY_MODE = prev;
      }
    },
  },
  {
    name: "date boundary mode: inclusive",
    run: () => {
      const prev = process.env.CI_DATE_RANGE_BOUNDARY_MODE;
      process.env.CI_DATE_RANGE_BOUNDARY_MODE = "inclusive";
      try {
        const s = extractIntentSignals("我4月13日到4月18日去巴塞罗那旅游");
        assert.equal(s.durationDays, 6);
      } finally {
        if (prev == null) delete process.env.CI_DATE_RANGE_BOUNDARY_MODE;
        else process.env.CI_DATE_RANGE_BOUNDARY_MODE = prev;
      }
    },
  },
  {
    name: "date boundary ambiguity should generate clarification hint in auto mode",
    run: () => {
      const prev = process.env.CI_DATE_RANGE_BOUNDARY_MODE;
      process.env.CI_DATE_RANGE_BOUNDARY_MODE = "auto";
      try {
        const s = extractIntentSignals("我4月13日到4月18日去巴塞罗那旅游");
        assert.equal(s.durationBoundaryAmbiguous, true);
        assert.match(String(s.durationBoundaryQuestion || ""), /含首尾|净停留/);
      } finally {
        if (prev == null) delete process.env.CI_DATE_RANGE_BOUNDARY_MODE;
        else process.env.CI_DATE_RANGE_BOUNDARY_MODE = prev;
      }
    },
  },
  {
    name: "explicit total overrides nearby range ambiguity",
    run: () => {
      const s = extractIntentSignals("我4月13日到4月18日参加会议，一共5天");
      assert.equal(s.durationDays, 5);
    },
  },
  {
    name: "cross-year date span is computed correctly",
    run: () => {
      const s = extractIntentSignals("我12月30日到1月2日旅行");
      assert.equal(s.durationDays, 4);
    },
  },
  {
    name: "ordinal day markers are not treated as duration",
    run: () => {
      const s = extractIntentSignals("第1天休息，第2天去博物馆");
      assert.equal(s.durationDays, undefined);
    },
  },
  {
    name: "single sentence numeric fields should not inflate duration",
    run: () => {
      const s = extractIntentSignals(
        "我想去米兰玩3天，和父母一起，预算10000元，机票已经买了，不需要考虑机票钱"
      );
      assert.equal(s.durationDays, 3);
      assert.equal(s.budgetCny, 10000);
    },
  },
  {
    name: "non-place phrase '现场观看' should not be parsed as destination",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我想去米兰旅行3天",
        "4月12日晚上有AC米兰和乌迪内斯的比赛，作为米兰球迷，我一定要去现场观看"
      );
      assert.deepEqual(merged.destinations || [], ["米兰"]);
      assert.equal((merged.destinations || []).includes("现场观看"), false);
      assert.equal(merged.destination, "米兰");
    },
  },
  {
    name: "spoken phrase '一个人去米兰' should normalize to destination 米兰 only",
    run: () => {
      const s = extractIntentSignals(
        "我想一个人去米兰玩三天，已经买了机票。4月10日到4月12日，4月13日离开，预算大概5000元人民币，酒店也订好了"
      );
      assert.deepEqual(s.destinations || [], ["米兰"]);
      assert.equal(s.durationDays, 3);
      const segCities = (s.cityDurations || []).map((x) => x.city);
      assert.deepEqual(segCities, ["米兰"]);
    },
  },
  {
    name: "single destination should not trigger duration-destination density conflict",
    run: () => {
      const s = extractIntentSignals(
        "我想一个人去米兰玩三天，已经买了机票。4月10日到4月12日，4月13日离开，预算大概5000元人民币"
      );
      const conflicts = analyzeConstraintConflicts({
        totalDays: s.durationDays,
        destinations: s.destinations,
      });
      assert.equal(conflicts.some((x) => x.key === "duration_destination_density"), false);
    },
  },
  {
    name: "noise destination phrase should not trigger duration-destination conflict",
    run: () => {
      const conflicts = analyzeConstraintConflicts({
        totalDays: 3,
        destinations: ["米兰", "一个人去米兰"],
      });
      assert.equal(conflicts.some((x) => x.key === "duration_destination_density"), false);
    },
  },
  {
    name: "history budget delta should not be re-applied when merged with function-slot budget",
    run: () => {
      const textSignals = extractIntentSignalsWithRecency(
        [
          "我想去米兰旅行3天，预算10000元",
          "我父亲又给了我5000预算",
        ].join("\n"),
        "那我买一张150欧元的票吧"
      );
      const merged = mergeIntentSignals(
        { budgetCny: 15000, budgetEvidence: "function-slot" },
        textSignals
      );
      assert.equal(merged.budgetCny, 15000);
    },
  },
  {
    name: "duration should stay 3 days when later sentence has no new duration",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我想去米兰玩3天，和父母一起，预算10000元",
        "机票已经买了，不需要考虑机票钱"
      );
      assert.equal(merged.durationDays, 3);
    },
  },
  {
    name: "budget ledger replay: set + adjust + commit should produce stable total/spent/remaining",
    run: () => {
      const ledger = buildBudgetLedgerFromUserTurns([
        { text: "预算5000元" },
        { text: "我父亲又给了我5000预算" },
        { text: "那我买一张150欧元的票吧" },
      ]);
      assert.equal(ledger.summary.totalCny, 10000);
      assert.equal(ledger.summary.spentCny, 1185);
      assert.equal(ledger.summary.remainingCny, 8815);
      assert.equal(ledger.summary.pendingCny, 0);
    },
  },
  {
    name: "budget ledger pending should not enter spent before user confirmation",
    run: () => {
      const ledger = buildBudgetLedgerFromUserTurns([
        { text: "预算10000元" },
        { text: "酒店先帮我扣掉预算，金额后面确认" },
      ]);
      assert.equal(ledger.summary.totalCny, 10000);
      assert.equal(ledger.summary.spentCny, 0);
      assert.equal(ledger.summary.remainingCny, 10000);
      const hasPending = ledger.events.some((x) => x.type === "expense_pending");
      assert.equal(hasPending, true);
    },
  },
  {
    name: "budget ledger should capture pending event for unresolved hotel deduction request",
    run: () => {
      const ledger = buildBudgetLedgerFromUserTurns([
        { text: "预算10000元" },
        { text: "那就预订Hotel Spadari al Duomo吧，按均价扣掉三晚住宿预算" },
      ]);
      const pending = ledger.events.filter((x) => x.type === "expense_pending");
      assert.equal(pending.length >= 1, true);
      assert.equal(ledger.summary.spentCny, 0);
      assert.equal(ledger.summary.remainingCny, 10000);
    },
  },
  {
    name: "destination conflict guard should ignore near-duplicate destination noise",
    run: () => {
      const conflicts = analyzeConstraintConflicts({
        totalDays: 3,
        destinations: ["米兰", "一个人去米兰", "安全一点的地方吧"],
      });
      assert.equal(conflicts.some((x) => x.key === "duration_destination_density"), false);
    },
  },
  {
    name: "slot compiler should clean duplicate slot nodes",
    run: () => {
      const signals = extractIntentSignals("我想一个人去米兰玩三天，预算5000元");
      const state = buildSlotStateMachine({
        userText: "我想一个人去米兰玩三天，预算5000元",
        recentTurns: [{ role: "user", content: "我想一个人去米兰玩三天，预算5000元" }],
        signals,
      });
      const patch = compileSlotStateToPatch({
        graph: {
          id: "g1",
          version: 1,
          nodes: [
            {
              id: "n_old_1",
              type: "fact",
              layer: "requirement",
              statement: "目的地: 一个人去米兰",
              status: "confirmed",
              confidence: 0.7,
              importance: 0.7,
              key: "slot:destination:一个人去米兰",
            } as any,
            {
              id: "n_old_2",
              type: "fact",
              layer: "requirement",
              statement: "目的地: 米兰",
              status: "confirmed",
              confidence: 0.8,
              importance: 0.8,
              key: "slot:destination:米兰",
            } as any,
          ],
          edges: [],
        },
        state,
      });
      const removeOps = patch.ops.filter((x) => x.op === "remove_node");
      assert.equal(removeOps.length >= 1, true);
    },
  },
  {
    name: "resolved hard/soft question should not be re-asked immediately",
    run: () => {
      const plan = planUncertaintyQuestion({
        graph: {
          id: "g2",
          version: 1,
          nodes: [
            {
              id: "n_limiting",
              type: "constraint",
              layer: "requirement",
              statement: "限制因素: 需要安全一点的酒店",
              status: "proposed",
              confidence: 0.42,
              importance: 0.8,
              key: "slot:constraint:limiting:safety_hotel",
            } as any,
          ],
          edges: [],
        },
        recentTurns: [
          { role: "assistant", content: "请确认限制因素“需要安全一点的酒店”是硬约束，还是可协商偏好？" },
          { role: "user", content: "限制因素“需要安全一点的酒店”是硬约束" },
        ],
      });
      assert.equal(/限制因素.*硬约束/.test(String(plan.question || "")), false);
    },
  },
  {
    name: "travel plan state should prefer ledger budget over stale graph budget slot",
    run: () => {
      const state = buildTravelPlanState({
        graph: {
          id: "g3",
          version: 1,
          nodes: [
            {
              id: "n_goal",
              type: "goal",
              layer: "intent",
              statement: "意图：去米兰旅游3天",
              status: "confirmed",
              confidence: 0.86,
              importance: 0.84,
              key: "slot:goal",
            } as any,
            {
              id: "n_budget_stale",
              type: "constraint",
              layer: "requirement",
              statement: "预算上限: 5000元",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.78,
              key: "slot:budget",
            } as any,
            {
              id: "n_dest",
              type: "fact",
              layer: "requirement",
              statement: "目的地: 米兰",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:米兰",
            } as any,
            {
              id: "n_duration",
              type: "constraint",
              layer: "requirement",
              statement: "总行程时长: 3天",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:duration_total",
            } as any,
          ],
          edges: [],
        },
        turns: [
          {
            createdAt: "2026-02-25T10:00:00.000Z",
            userText: "预算5000元，去米兰玩3天",
            assistantText: "收到",
          },
          {
            createdAt: "2026-02-25T10:10:00.000Z",
            userText: "我父亲又给了我5000预算",
            assistantText: "收到",
          },
        ],
        previous: null,
      });
      assert.equal(state.budget?.totalCny, 10000);
      assert.equal(state.budget?.remainingCny, 10000);
    },
  },
  {
    name: "motif dedupe should suppress bookkeeping-budget motifs and cap active motifs per anchor",
    run: () => {
      const graph = {
        id: "g_motif_dedupe",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "goal",
            layer: "intent",
            statement: "意图: 去米兰旅游3天",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.84,
            key: "slot:goal",
          },
          {
            id: "n_budget",
            type: "constraint",
            layer: "requirement",
            statement: "预算上限: 10000元",
            status: "confirmed",
            confidence: 0.92,
            importance: 0.8,
            key: "slot:budget",
          },
          {
            id: "n_budget_remain",
            type: "constraint",
            layer: "requirement",
            statement: "剩余预算: 10000元",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.78,
            key: "slot:budget_remaining",
          },
          {
            id: "n_duration",
            type: "constraint",
            layer: "requirement",
            statement: "总行程时长: 3天",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.8,
            key: "slot:duration_total",
          },
          {
            id: "n_dest",
            type: "fact",
            layer: "requirement",
            statement: "目的地: 米兰",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.8,
            key: "slot:destination:米兰",
          },
          {
            id: "n_limit",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 需要安全感强（治安、夜间出行）",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.79,
            key: "slot:constraint:limiting:other:safety",
          },
        ] as any,
        edges: [
          { id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.92 },
          { id: "e2", from: "n_budget_remain", to: "n_goal", type: "constraint", confidence: 0.9 },
          { id: "e3", from: "n_duration", to: "n_goal", type: "constraint", confidence: 0.9 },
          { id: "e4", from: "n_dest", to: "n_duration", type: "constraint", confidence: 0.84 },
          { id: "e5", from: "n_limit", to: "n_goal", type: "constraint", confidence: 0.9 },
          { id: "e6", from: "n_budget", to: "n_budget_remain", type: "determine", confidence: 0.9 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
      const active = motifs.filter((m) => m.status === "active");

      const budgetRemainConcept = concepts.find((c) => c.semanticKey === "slot:budget_remaining");
      assert.ok(budgetRemainConcept);
      assert.equal(active.some((m) => m.conceptIds.includes(budgetRemainConcept!.id)), false);

      const byAnchor = new Map<string, number>();
      for (const m of active) {
        const k = String(m.anchorConceptId || "");
        byAnchor.set(k, (byAnchor.get(k) || 0) + 1);
      }
      for (const count of byAnchor.values()) {
        assert.equal(count <= 4, true);
      }
    },
  },
];

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`PASS: ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${c.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  console.error(`\n${failed} regression case(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} regression cases passed.`);
