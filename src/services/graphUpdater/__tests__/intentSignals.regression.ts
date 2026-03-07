import assert from "node:assert/strict";

import {
  buildTravelIntentStatement,
  extractIntentSignals,
  extractIntentSignalsWithRecency,
  mergeIntentSignals,
} from "../intentSignals.js";
import { analyzeConstraintConflicts } from "../conflictAnalyzer.js";
import { buildBudgetLedgerFromUserTurns } from "../../travelPlan/budgetLedger.js";
import { buildTravelPlanState } from "../../travelPlan/state.js";
import { buildSlotStateMachine } from "../slotStateMachine.js";
import { compileSlotStateToPatch } from "../slotGraphCompiler.js";
import { sanitizeIntentSignals } from "../signalSanitizer.js";
import { slotsToSignals } from "../slotFunctionCall.js";
import { generateGraphPatch } from "../../graphUpdater.js";
import { applyPatchWithGuards } from "../../../core/graph/patchApply.js";
import { buildCognitiveModel } from "../../cognitiveModel.js";
import { buildConflictGatePayload } from "../../motif/conflictGate.js";
import { planUncertaintyQuestion } from "../../uncertainty/questionPlanner.js";
import { sanitizeGraphPatchStrict } from "../../patchGuard.js";
import { reconcileConceptsWithGraph, stableConceptIdFromSemanticKey } from "../../concepts.js";
import { rebalanceIntentTopology } from "../../../core/graph/topology.js";
import {
  isMotifLowConfidence,
  motifLowConfidenceThreshold,
  reconcileMotifsWithGraph,
} from "../../motif/conceptMotifs.js";
import { reconcileMotifLinks } from "../../motif/motifLinks.js";
import { buildMotifReasoningView } from "../../motif/reasoningView.js";
import { planMotifQuestion } from "../../motif/questionPlanner.js";
import {
  applyManualGraphOverrides,
  rebuildManualGraphOverrides,
} from "../../../routes/conversations.js";

type Case = {
  name: string;
  run: () => void | Promise<void>;
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
    name: "budget should not be overwritten by later base-count range in another clause",
    run: () => {
      const s = extractIntentSignals("预算每人2万元，最多两到三个基地");
      assert.equal(s.budgetCny, 20000);
      assert.equal(s.budgetEvidence, "2万元");
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
    name: "foreign-currency budget delta should convert to CNY",
    run: () => {
      const prevRate = process.env.CI_FX_EUR_TO_CNY;
      process.env.CI_FX_EUR_TO_CNY = "8";
      try {
        const s = extractIntentSignals("预算减少300欧元");
        assert.equal(s.budgetDeltaCny, -2400);
      } finally {
        if (prevRate == null) delete process.env.CI_FX_EUR_TO_CNY;
        else process.env.CI_FX_EUR_TO_CNY = prevRate;
      }
    },
  },
  {
    name: "foreign-currency budget delta merge should not degrade to raw number",
    run: () => {
      const prevRate = process.env.CI_FX_EUR_TO_CNY;
      process.env.CI_FX_EUR_TO_CNY = "8";
      try {
        const merged = extractIntentSignalsWithRecency("预算10000元", "预算减少300欧元");
        assert.equal(merged.budgetCny, 7600);
      } finally {
        if (prevRate == null) delete process.env.CI_FX_EUR_TO_CNY;
        else process.env.CI_FX_EUR_TO_CNY = prevRate;
      }
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
    name: "parallel motivations should stay as activity/scenic preferences, not chained destinations",
    run: () => {
      const s = extractIntentSignals(
        "我想规划澳大利亚旅行，我想去澳大利亚是因为看袋鼠，我想去海边。"
      );
      assert.deepEqual(s.destinations || [], ["澳大利亚"]);
      assert.equal(s.destination, "澳大利亚");
      assert.match(String(s.activityPreference || ""), /野生动物|wildlife/i);
      assert.match(String(s.scenicPreference || ""), /海边|自然风光|beaches?|outdoor/i);
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
    name: "locality phrase '只含当地' should not be counted as a destination",
    run: () => {
      const conflicts = analyzeConstraintConflicts({
        totalDays: 3,
        destinations: ["米兰", "只含当地"],
      });
      assert.equal(conflicts.some((x) => x.key === "duration_destination_density"), false);
    },
  },
  {
    name: "safety wording should not be parsed as destination",
    run: () => {
      const s = extractIntentSignals(
        "我有惊恐发作史，所以希望行程稳妥到不出事，尽量安全感强"
      );
      assert.equal((s.destinations || []).length, 0);
      assert.equal(s.destination, undefined);
    },
  },
  {
    name: "high-building wording should not be parsed as destination",
    run: () => {
      const s = extractIntentSignals(
        "我有恐高症，不能去很高的建筑，尽量安排地面活动"
      );
      assert.equal((s.destinations || []).length, 0);
      assert.equal(s.destination, undefined);
    },
  },
  {
    name: "comparative phrase like '比较好' should not be parsed as destination",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我4月10日到4月12日在米兰，4月13日离开米兰",
        "我4月12日晚想看AC米兰和都灵队比赛，票价多少线下体验比较好？治安安全吗？"
      );
      assert.deepEqual(merged.destinations || [], ["米兰"]);
      assert.equal((merged.destinations || []).includes("比较好"), false);
      assert.equal((merged.destinations || []).includes("比比较好"), false);
      assert.equal(merged.destination, "米兰");
    },
  },
  {
    name: "comparative destination noise should not trigger duration-destination conflict",
    run: () => {
      const conflicts = analyzeConstraintConflicts({
        totalDays: 3,
        destinations: ["米兰", "比较好"],
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
    name: "multi-city night allocation should produce a stable 7-day city snapshot",
    run: () => {
      const s = extractIntentSignals("可以，就按京都6晚加大阪1晚来。");
      assert.equal(s.durationDays, 7);
      assert.deepEqual(
        (s.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["京都", 6],
          ["大阪", 1],
        ]
      );
      assert.deepEqual(s.destinations, ["京都", "大阪"]);
    },
  },
  {
    name: "latest city-night snapshot should replace coarse historical destination instead of flattening peers",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我们第一次去关西，7天，两个人，预算2万元，不想太赶，酒店别换太频繁。",
        "可以，就按京都6晚加大阪1晚来。"
      );
      assert.equal(merged.durationDays, 7);
      assert.deepEqual(merged.destinations, ["京都", "大阪"]);
      assert.deepEqual(
        (merged.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["京都", 6],
          ["大阪", 1],
        ]
      );
    },
  },
  {
    name: "pace and hotel-switch constraints should stay separate during refinement turns",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我们第一次去日本，准备7天，带爸妈一起，不想太赶，最好少换酒店，预算两个人加父母一共4万人民币左右，妈妈膝盖不太好，饮食想清淡一点。",
        "第二轮先按京都6晚大阪1晚来想，还是不想太赶，最好少换酒店，酒店离地铁近一点，最好有电梯。"
      );
      const generic = merged.genericConstraints || [];
      assert.equal(
        /低强度|体力负担|不想太赶/i.test(String(merged.activityPreference || "")) ||
          generic.some((x) => x.kind === "mobility" && /不想太赶|低强度|少折腾/i.test(String(x.text || ""))),
        true
      );
      assert.equal(
        generic.some((x) => x.kind === "logistics" && /少换酒店|换酒店|hotel changes/i.test(String(x.text || ""))),
        true
      );
    },
  },
  {
    name: "leading destination scaffolding should be stripped from refinement preference clauses",
    run: () => {
      const signals = extractIntentSignals("大阪这次也还是想轻松一点，但希望比上次更偏城市散步。");
      assert.match(String(signals.activityPreference || ""), /低强度|体力负担/i);
      assert.equal(String(signals.activityPreferenceEvidence || "").includes("大阪"), false);
      assert.equal(
        (signals.genericConstraints || []).some((x) => /大阪这次|大阪/.test(String(x.text || ""))),
        false
      );
    },
  },
  {
    name: "graph destination should stay stable during refinement turns without explicit destination change",
    run: async () => {
      const baseGraph = {
        id: "g_osaka_refinement",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图：去大阪旅游",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.88,
            key: "slot:goal",
            locked: false,
          },
          {
            id: "n_dest_osaka",
            type: "factual_assertion",
            layer: "requirement",
            statement: "目的地: 大阪",
            status: "confirmed",
            confidence: 0.92,
            importance: 0.9,
            key: "slot:destination:大阪",
            locked: false,
          },
        ],
        edges: [
          {
            id: "e_dest_goal",
            from: "n_dest_osaka",
            to: "n_goal",
            type: "enable",
            confidence: 0.86,
          },
        ],
      } as any;

      const patch = await generateGraphPatch({
        graph: baseGraph,
        userText: "也还是想轻松一点，但希望比上次更偏城市散步。",
        recentTurns: [
          { role: "user", content: "这次先按大阪来。" },
          { role: "assistant", content: "可以，我们先按大阪来聊。" },
        ],
        assistantText: "",
        locale: "zh-CN",
      });
      const applied = applyPatchWithGuards(baseGraph, patch).newGraph;
      const destinationKeys = (applied.nodes || [])
        .map((node) => String((node as any)?.key || ""))
        .filter((key) => key.startsWith("slot:destination:"));
      assert.deepEqual(destinationKeys, ["slot:destination:大阪"]);
      const goalNode = (applied.nodes || []).find((node) => String((node as any)?.key || "") === "slot:goal");
      assert.match(String(goalNode?.statement || ""), /大阪/);
      assert.equal(
        /轻松一点旅游|城市散步旅游|大阪和也还是想轻松一点|大阪和但希望比上次更偏城市散步/.test(String(goalNode?.statement || "")),
        false
      );
    },
  },
  {
    name: "coherent city-night snapshot should override inflated slot duration",
    run: () => {
      const latest = extractIntentSignals("可以，就按京都6晚加大阪1晚来。");
      const merged = mergeIntentSignals(
        {
          destination: "关西",
          destinations: ["关西", "京都", "大阪"],
          durationDays: 14,
          durationEvidence: "14天",
          durationStrength: 0.95,
          cityDurations: [
            {
              city: "关西",
              days: 7,
              evidence: "关西7天",
              kind: "travel",
            },
          ],
        },
        latest
      );
      assert.equal(merged.durationDays, 7);
      assert.deepEqual(merged.destinations, ["京都", "大阪"]);
      assert.deepEqual(
        (merged.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["京都", 6],
          ["大阪", 1],
        ]
      );
    },
  },
  {
    name: "full city allocation should replace coarse destination even if partial-allocation flag is set",
    run: () => {
      const merged = mergeIntentSignals(
        {
          destination: "关西",
          destinations: ["关西"],
          durationDays: 7,
          durationEvidence: "关西7天",
          cityDurations: [
            {
              city: "关西",
              days: 7,
              evidence: "关西7天",
              kind: "travel",
            },
          ],
        },
        {
          destination: "关西",
          destinations: ["关西", "京都", "大阪"],
          durationDays: 7,
          durationEvidence: "整体还是7天",
          hasExplicitTotalCue: true,
          hasPartialDurationAllocation: true,
          cityDurations: [
            {
              city: "京都",
              days: 6,
              evidence: "京都6晚",
              kind: "travel",
            },
            {
              city: "大阪",
              days: 1,
              evidence: "大阪1晚",
              kind: "travel",
            },
          ],
        }
      );
      assert.equal(merged.durationDays, 7);
      assert.deepEqual(merged.destinations, ["京都", "大阪"]);
      assert.equal(merged.destination, "京都");
    },
  },
  {
    name: "signal sanitizer should collapse mixed country-region-city destinations to stable city snapshot",
    run: () => {
      const sanitized = sanitizeIntentSignals({
        destination: "日本",
        destinations: ["日本", "关西", "京都", "大阪"],
        destinationEvidence: "日本关西",
        cityDurations: [
          {
            city: "京都",
            days: 6,
            evidence: "京都6晚",
            kind: "travel",
          },
          {
            city: "大阪",
            days: 1,
            evidence: "大阪1晚",
            kind: "travel",
          },
        ],
        durationDays: 7,
        durationEvidence: "整体还是7天",
      });
      assert.deepEqual(sanitized.destinations, ["京都", "大阪"]);
      assert.equal(sanitized.destination, "京都");
      assert.equal(sanitized.destinationEvidence, "京都6晚");
    },
  },
  {
    name: "signal sanitizer should keep full city snapshot even if partial-allocation flag leaks in",
    run: () => {
      const sanitized = sanitizeIntentSignals({
        destination: "关西",
        destinations: ["关西", "京都", "大阪"],
        destinationEvidence: "日本关西",
        hasPartialDurationAllocation: true,
        cityDurations: [
          {
            city: "京都",
            days: 6,
            evidence: "京都6晚",
            kind: "travel",
          },
          {
            city: "大阪",
            days: 1,
            evidence: "大阪1晚",
            kind: "travel",
          },
        ],
        durationDays: 7,
        durationEvidence: "整体还是7天",
      });
      assert.deepEqual(sanitized.destinations, ["京都", "大阪"]);
      assert.equal(sanitized.destination, "京都");
      assert.equal(sanitized.durationDays, 7);
    },
  },
  {
    name: "signal sanitizer should drop redundant coarse city-duration envelope when finer cities already cover total",
    run: () => {
      const sanitized = sanitizeIntentSignals({
        destinations: ["京都", "大阪"],
        cityDurations: [
          {
            city: "关西",
            days: 7,
            evidence: "关西7天",
            kind: "travel",
          },
          {
            city: "京都",
            days: 6,
            evidence: "京都6晚",
            kind: "travel",
          },
          {
            city: "大阪",
            days: 1,
            evidence: "大阪1晚",
            kind: "travel",
          },
        ],
        durationDays: 7,
        durationEvidence: "整体还是7天",
      });
      assert.equal(sanitized.durationDays, 7);
      assert.deepEqual(
        (sanitized.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["京都", 6],
          ["大阪", 1],
        ]
      );
      assert.deepEqual(sanitized.destinations, ["京都", "大阪"]);
    },
  },
  {
    name: "slot compiler should remove coarse destination nodes after stable city snapshot refinement",
    run: () => {
      const signals = sanitizeIntentSignals({
        destination: "日本",
        destinations: ["日本", "关西", "京都", "大阪"],
        destinationEvidence: "日本关西",
        cityDurations: [
          {
            city: "京都",
            days: 6,
            evidence: "京都6晚",
            kind: "travel",
          },
          {
            city: "大阪",
            days: 1,
            evidence: "大阪1晚",
            kind: "travel",
          },
        ],
        durationDays: 7,
        durationEvidence: "整体还是7天",
      });
      const state = buildSlotStateMachine({
        userText: "可以，那就按京都为主住6晚，大阪最后1晚，整体还是7天。",
        recentTurns: [{ role: "user", content: "可以，那就按京都为主住6晚，大阪最后1晚，整体还是7天。" }],
        signals,
        locale: "zh-CN",
      });
      const patch = compileSlotStateToPatch({
        graph: {
          id: "g_hierarchy_cleanup",
          version: 1,
          nodes: [
            {
              id: "n_country",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 日本",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:日本",
            } as any,
            {
              id: "n_region",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 关西",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:关西",
            } as any,
            {
              id: "n_city_kyoto",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 京都",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:京都",
            } as any,
            {
              id: "n_city_osaka",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 大阪",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:大阪",
            } as any,
          ],
          edges: [],
        },
        state,
      });
      const removeNodeIds = patch.ops
        .filter((op) => op.op === "remove_node")
        .map((op: any) => op.id)
        .sort();
      assert.deepEqual(removeNodeIds, ["n_country", "n_region"]);
    },
  },
  {
    name: "unicode destination semantic keys should map to distinct stable concept ids",
    run: () => {
      const kansaiId = stableConceptIdFromSemanticKey("slot:destination:关西|factual_assertion|positive|current_task");
      const kyotoId = stableConceptIdFromSemanticKey("slot:destination:京都|factual_assertion|positive|current_task");
      const osakaId = stableConceptIdFromSemanticKey("slot:destination:大阪|factual_assertion|positive|current_task");
      assert.notEqual(kansaiId, kyotoId);
      assert.notEqual(kansaiId, osakaId);
      assert.notEqual(kyotoId, osakaId);
    },
  },
  {
    name: "budget parser should ignore lodging-base count ranges near a real budget",
    run: () => {
      const s = extractIntentSignals(
        "想去冰岛环岛9天，两个人，10月出发但日期还没定，每人预算2万元，想看冰河湖和瀑布，不想每天换酒店，最多两到三个基地。"
      );
      assert.equal(s.budgetCny, 20000);
      assert.equal(s.destination, "冰岛");
      assert.equal((s.destinations || []).includes("冰岛环岛"), false);
      assert.equal((s.destinations || []).includes("三个基地"), false);
    },
  },
  {
    name: "arrange phrasing should still extract paired country destinations",
    run: () => {
      const s = extractIntentSignals("我想安排西班牙和葡萄牙10天，爸爸膝盖不好，不要每天换酒店。");
      assert.deepEqual(s.destinations, ["西班牙", "葡萄牙"]);
      assert.equal(s.destination, "西班牙");
      assert.equal(s.durationDays, 10);
    },
  },
  {
    name: "trailing priority pair should extract preferred cities",
    run: () => {
      const s = extractIntentSignals("我想安排西班牙和葡萄牙10天，里斯本和塞维利亚优先，马德里不是必须。");
      assert.equal((s.destinations || []).includes("里斯本"), true);
      assert.equal((s.destinations || []).includes("塞维利亚"), true);
    },
  },
  {
    name: "pace preference should not leak into paired-country destinations or goal text",
    run: () => {
      const text = "我想安排西班牙和葡萄牙10天，想慢一点，里斯本和塞维利亚优先，马德里不是必须。";
      const s = extractIntentSignals(text);
      assert.deepEqual(s.destinations, ["西班牙", "葡萄牙", "里斯本", "塞维利亚"]);
      assert.equal((s.destinations || []).includes("慢一点"), false);
      assert.equal((s.cityDurations || []).some((x) => x.city === "葡萄牙"), false);
      assert.equal(buildTravelIntentStatement(s, text, "zh-CN"), "意图：去西班牙和葡萄牙旅游10天");
    },
  },
  {
    name: "slot function preference cleanup should keep pace and hotel-switch as separate signals",
    run: () => {
      const signals = slotsToSignals(
        {
          activity_preference: {
            text: "不想太赶，最好少换酒店",
            evidence: "不想太赶，最好少换酒店",
            hard: false,
            importance: 0.82,
          },
          lodging_preference: {
            text: "最好少换酒店，酒店离地铁近一点，最好有电梯",
            evidence: "最好少换酒店，酒店离地铁近一点，最好有电梯",
            hard: false,
            importance: 0.8,
          },
        },
        "zh-CN"
      );
      assert.equal(/低强度|不想太赶|减少体力负担/i.test(String(signals.activityPreference || "")), true);
      assert.equal(
        (signals.genericConstraints || []).some(
          (x) => x.kind === "logistics" && /少换酒店|换酒店|hotel changes/i.test(String(x.text || ""))
        ),
        true
      );
      assert.equal(/地铁|交通便利|电梯|无障碍/i.test(String(signals.lodgingPreference || "")), true);
    },
  },
  {
    name: "paired-country priority phrasing should not generate pace destination or pair-envelope city-duration slots",
    run: async () => {
      const text = "我想安排西班牙和葡萄牙10天，想慢一点，里斯本和塞维利亚优先，马德里不是必须。";
      const patch = await generateGraphPatch({
        graph: { id: "g_iberia_priority_clean", version: 1, nodes: [], edges: [] },
        userText: text,
        recentTurns: [{ role: "user", content: text }],
        stateContextUserTurns: [text],
        assistantText: "收到",
        locale: "zh-CN",
      });
      const nodes = patch.ops
        .filter((op: any) => op.op === "add_node" || op.op === "upsert_node")
        .map((op: any) => op.node);
      const destinationKeys = nodes
        .filter((n: any) => String(n.key || "").startsWith("slot:destination:"))
        .map((n: any) => String(n.key))
        .sort();
      const goalNode = nodes.find((n: any) => String(n.key || "") === "slot:goal");
      assert.equal(destinationKeys.includes("slot:destination:慢一点"), false);
      assert.equal(destinationKeys.includes("slot:destination:西班牙"), true);
      assert.equal(destinationKeys.includes("slot:destination:葡萄牙"), true);
      assert.equal(destinationKeys.includes("slot:destination:里斯本"), true);
      assert.equal(destinationKeys.includes("slot:destination:塞维利亚"), true);
      assert.equal(
        nodes.some((n: any) => String(n.key || "").startsWith("slot:duration_city:葡萄牙")),
        false
      );
      assert.equal(goalNode?.statement, "意图：去西班牙和葡萄牙旅游10天");
    },
  },
  {
    name: "lodging focus region should be extracted as destination hint",
    run: () => {
      const s = extractIntentSignals("不是必须环岛，南岸多住一点也可以，斯奈山半岛先不去，整体还是9天。");
      assert.equal((s.destinations || []).includes("南岸"), true);
      assert.equal(s.destination, undefined);
      assert.equal((s.removedDestinations || []).includes("斯奈山半岛"), true);
      assert.equal(s.durationDays, 9);
    },
  },
  {
    name: "lodging focus refinement should keep country anchor and add focused region in graph patch",
    run: async () => {
      const turn1 = "我想去冰岛环岛9天，预算每人2万元，最多两到三个基地，想看冰河湖和黑沙滩，但不要太赶。";
      const turn2 = "不是必须环岛，南岸多住一点也可以，斯奈山半岛先不去，整体还是9天。";
      let graph: any = { id: "g_iceland_focus", version: 1, nodes: [], edges: [] };
      const patch1 = await generateGraphPatch({
        graph,
        userText: turn1,
        recentTurns: [{ role: "user", content: turn1 }],
        stateContextUserTurns: [turn1],
        assistantText: "收到",
        locale: "zh-CN",
      });
      graph = applyPatchWithGuards(graph, patch1).newGraph;
      const patch2 = await generateGraphPatch({
        graph,
        userText: turn2,
        recentTurns: [
          { role: "user", content: turn1 },
          { role: "assistant", content: "收到" },
          { role: "user", content: turn2 },
        ],
        stateContextUserTurns: [turn1, turn2],
        assistantText: "收到",
        locale: "zh-CN",
      });
      graph = applyPatchWithGuards(graph, patch2).newGraph;
      const destinationKeys = graph.nodes
        .filter((n: any) => String(n.key || "").startsWith("slot:destination:"))
        .map((n: any) => n.key)
        .sort();
      assert.deepEqual(destinationKeys, ["slot:destination:冰岛", "slot:destination:南岸"]);
    },
  },
  {
    name: "lodging focus refinement should preserve existing graph anchor even without prior user-turn replay",
    run: async () => {
      const turn = "不是必须环岛，南岸多住一点也可以，斯奈山半岛先不去，整体还是9天。";
      const graph = {
          id: "g_iceland_existing_anchor",
          version: 2,
          nodes: [
            {
              id: "n_goal",
              type: "belief",
              layer: "intent",
              statement: "意图：去冰岛旅游9天",
              status: "confirmed",
              confidence: 0.86,
              importance: 0.84,
              key: "slot:goal",
            } as any,
            {
              id: "n_dest_iceland",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 冰岛",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.8,
              key: "slot:destination:冰岛",
            } as any,
            {
              id: "n_duration_total",
              type: "constraint",
              layer: "requirement",
              statement: "总行程时长: 9天",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.84,
              key: "slot:duration_total",
            } as any,
          ],
          edges: [],
        } as any;
      const patch = await generateGraphPatch({
        graph,
        userText: turn,
        recentTurns: [{ role: "user", content: turn }],
        stateContextUserTurns: [turn],
        assistantText: "收到",
        locale: "zh-CN",
      });
      const nextGraph = applyPatchWithGuards(graph, patch).newGraph;
      const goalNode = nextGraph.nodes.find((n: any) => String(n.key || "") === "slot:goal");
      const destinationKeys = nextGraph.nodes
        .filter((n: any) => String(n.key || "").startsWith("slot:destination:"))
        .map((n: any) => String(n.key))
        .sort();
      assert.deepEqual(destinationKeys, ["slot:destination:冰岛", "slot:destination:南岸"]);
      assert.equal(goalNode?.statement, "意图：去冰岛旅游9天");
    },
  },
  {
    name: "budget total phrasing should not set explicit duration-total cue",
    run: () => {
      const s = extractIntentSignals("想带妈妈去摩洛哥7到8天，预算总共3万元，语言不太通，希望别太折腾。");
      assert.equal(s.hasExplicitTotalCue, false);
      assert.equal(s.durationDays, 8);
    },
  },
  {
    name: "cross-country pair should split instead of collapsing to a connector-prefixed destination",
    run: () => {
      const s = extractIntentSignals(
        "想和父母去西班牙加葡萄牙10天，总预算3万元，父亲膝盖不好，不想爬太多台阶，也不想频繁换酒店。"
      );
      assert.equal((s.destinations || []).includes("加葡萄牙"), false);
      assert.deepEqual(s.destinations, ["西班牙", "葡萄牙"]);
    },
  },
  {
    name: "bare city-night list should be parsed without explicit travel verb",
    run: () => {
      const s = extractIntentSignals(
        "可以，那就先以马拉喀什4晚、非斯2晚来想，卡萨布兰卡最多留半天过渡；另外妈妈不会法语和阿拉伯语。"
      );
      assert.deepEqual(
        (s.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["马拉喀什", 4],
          ["非斯", 2],
        ]
      );
      assert.deepEqual(s.destinations, ["马拉喀什", "非斯"]);
    },
  },
  {
    name: "lodging-led city duration phrasing should normalize to clean city names",
    run: () => {
      const s = extractIntentSignals("那就按京都为主住6晚，大阪最后1晚，整体还是7天。");
      assert.deepEqual(s.destinations, ["京都", "大阪"]);
      assert.deepEqual(
        (s.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["京都", 6],
          ["大阪", 1],
        ]
      );
      assert.equal(s.durationDays, 7);
    },
  },
  {
    name: "transit city mention should extract city instead of a transit phrase",
    run: () => {
      const s = extractIntentSignals(
        "想带妈妈去摩洛哥7到8天，卡萨可以作为落地中转，法语和阿拉伯语都不会，希望节奏松一点。"
      );
      assert.equal((s.destinations || []).includes("卡萨"), true);
      assert.equal((s.destinations || []).some((x) => /作为|不会/.test(x)), false);
    },
  },
  {
    name: "combined language clause should become concise language constraint instead of a whole-sentence generic limit",
    run: () => {
      const s = extractIntentSignals(
        "想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，想去马拉喀什和非斯，卡萨可以作为落地中转，法语和阿拉伯语都不会，希望别太折腾。"
      );
      assert.equal(s.languageConstraint, "法语和阿拉伯语都不会");
      assert.equal(
        (s.genericConstraints || []).some((x) => /想带妈妈第一次去摩洛哥/.test(x.text)),
        false
      );
      assert.equal(
        (s.genericConstraints || []).some((x) => /法语和阿拉伯语都不会/.test(x.text)),
        false
      );
    },
  },
  {
    name: "removed destination should disappear from merged destinations and city durations",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "想带妈妈第一次去摩洛哥，7到8天，想去马拉喀什和非斯，卡萨布兰卡不确定要不要去。",
        "再纠正一下，卡萨布兰卡先完全去掉，不去卡萨了。"
      );
      assert.equal((merged.destinations || []).some((x) => /卡萨/.test(x)), false);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "卡萨布兰卡"), false);
    },
  },
  {
    name: "removal turn should not turn relaxation wording into a fake destination",
    run: () => {
      const latest = extractIntentSignals("卡萨先完全去掉，剩下时间宁可在马拉喀什放空，也别频繁换城。");
      assert.ok((latest.removedDestinations || []).includes("卡萨"));
      assert.ok(!(latest.destinations || []).includes("马拉喀什放空"));
      assert.notEqual(latest.destination, "马拉喀什放空");
    },
  },
  {
    name: "signal sanitizer should filter removed destinations even if an upstream extractor re-injects them",
    run: () => {
      const sanitized = sanitizeIntentSignals({
        destinations: ["摩洛哥", "马拉喀什", "非斯", "卡萨布兰卡"],
        removedDestinations: ["卡萨"],
        cityDurations: [
          {
            city: "马拉喀什",
            days: 4,
            evidence: "马拉喀什4晚",
            kind: "travel",
          },
          {
            city: "非斯",
            days: 2,
            evidence: "非斯2晚",
            kind: "travel",
          },
          {
            city: "卡萨布兰卡",
            days: 1,
            evidence: "卡萨布兰卡1天",
            kind: "travel",
          },
        ],
        durationDays: 8,
        durationEvidence: "8天",
      });
      assert.ok(!(sanitized.destinations || []).some((x) => /卡萨/.test(x)));
      assert.ok(!(sanitized.cityDurations || []).some((x) => /卡萨/.test(x.city)));
    },
  },
  {
    name: "morocco refinement with language constraint should not trigger conflict gate",
    run: async () => {
      const turn1 =
        "想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，想去马拉喀什和非斯，卡萨可以作为落地中转，法语和阿拉伯语都不会，希望别太折腾。";
      const turn2 = "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡，其他先别塞满。";
      let graph: any = { id: "g_morocco_language", version: 1, nodes: [], edges: [] };

      const patch1 = await generateGraphPatch({
        graph,
        userText: turn1,
        recentTurns: [{ role: "user", content: turn1 }],
        stateContextUserTurns: [turn1],
        assistantText: "收到",
        locale: "zh-CN",
      });
      graph = applyPatchWithGuards(graph, patch1).newGraph;

      const patch2 = await generateGraphPatch({
        graph,
        userText: turn2,
        recentTurns: [
          { role: "user", content: turn1 },
          { role: "assistant", content: "收到" },
          { role: "user", content: turn2 },
        ],
        stateContextUserTurns: [turn1, turn2],
        assistantText: "收到",
        locale: "zh-CN",
      });
      graph = applyPatchWithGuards(graph, patch2).newGraph;

      assert.equal(
        graph.nodes.some(
          (n: any) =>
            Array.isArray(n.tags) &&
            n.tags.includes("language") &&
            /法语和阿拉伯语都不会/.test(String(n.statement || ""))
        ),
        true
      );

      const model = buildCognitiveModel({ graph, locale: "zh-CN" });
      const gate = buildConflictGatePayload(model.motifs, "zh-CN");
      assert.equal(gate, null);
      assert.equal(
        model.motifs.some((m) => m.status === "deprecated" && /法语和阿拉伯语都不会/.test(m.title)),
        false
      );
    },
  },
  {
    name: "taipei lunch-rest refinement should keep orthogonal constraints active and avoid motif conflict prompt",
    run: async () => {
      const turns = [
        "这次想带妈妈去台北4天，预算每人1万，不吃生食，膝盖也不太好。",
        "另外不想太赶，最好少换酒店。",
        "妈妈午饭后要休息。",
      ];
      let graph: any = { id: "g_taipei_lunch_rest", version: 1, nodes: [], edges: [] };
      const recentTurns: Array<{ role: "user" | "assistant"; content: string }> = [];

      for (let i = 0; i < turns.length; i += 1) {
        const userText = turns[i];
        recentTurns.push({ role: "user", content: userText });
        const patch = await generateGraphPatch({
          graph,
          userText,
          recentTurns,
          stateContextUserTurns: turns.slice(0, i + 1),
          assistantText: "收到",
          locale: "zh-CN",
        });
        graph = applyPatchWithGuards(graph, patch).newGraph;
        recentTurns.push({ role: "assistant", content: "收到" });
      }

      const model = buildCognitiveModel({ graph, locale: "zh-CN" });
      const gate = buildConflictGatePayload(model.motifs, "zh-CN");
      const plan = planMotifQuestion({
        motifs: model.motifs,
        concepts: model.concepts,
        recentTurns,
        locale: "zh-CN" as any,
      });

      assert.equal(gate, null);
      assert.equal(plan.question, null);
      for (const label of ["另外不想太赶", "最好少换酒店", "不吃生食"]) {
        assert.equal(
          model.motifs.some((m) => m.status === "active" && m.title.includes(label)),
          true,
          `${label} should stay active after lunch-rest refinement`
        );
        assert.equal(
          model.motifs.some((m) => m.status === "deprecated" && m.title.includes(label)),
          false,
          `${label} should not be objective-pruned`
        );
      }
    },
  },
  {
    name: "partial city allocation should preserve prior overall duration",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，想先看老城和花园，卡萨可以作为落地中转，法语阿拉伯语都不会，希望别太折腾。",
        "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡，其他先别塞满。"
      );
      assert.equal(merged.durationDays, 8);
      assert.deepEqual(
        (merged.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["马拉喀什", 4],
          ["非斯", 2],
        ]
      );
    },
  },
  {
    name: "meta total phrase should not become a destination or city duration",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        [
          "我们一家三口第一次去日本关西，7天，想轻松一点，不要每天暴走，京都和大阪都想去。",
          "那就按京都6晚、大阪1晚来想，关西这个大区不用单独算。",
        ].join("\n"),
        "我们想留半天机动，整体还是7天，不想再加别的城市。"
      );
      assert.equal((merged.destinations || []).includes("整体还是"), false);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "整体还是"), false);
      assert.equal(merged.durationDays, 7);
    },
  },
  {
    name: "remaining buffer should not become a destination and should keep total duration",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我想10天去西班牙和葡萄牙，主要想待里斯本和塞维利亚，马德里不是必须，西语葡语都不会。",
        "那就按里斯本4晚、塞维利亚4晚，剩下2天机动，马德里先不要。"
      );
      assert.equal(merged.durationDays, 10);
      assert.equal((merged.destinations || []).includes("剩下"), false);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "剩下"), false);
      assert.deepEqual(
        (merged.cityDurations || []).map((x) => [x.city, x.days]),
        [
          ["里斯本", 4],
          ["塞维利亚", 4],
        ]
      );
    },
  },
  {
    name: "crowd-avoidance constraint should not overwrite prior destination",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        [
          "我要去台北旅游，预算10000人民币。",
          "3天。",
        ].join("\n"),
        "我有焦虑症，不能去人特别多的地方。"
      );
      assert.equal(merged.destination, "台北");
      assert.deepEqual(merged.destinations, ["台北"]);
      assert.equal(merged.healthConstraint?.includes("焦虑"), true);
      assert.equal(
        (merged.genericConstraints || []).some((x) => String(x.text || "").includes("不能去人特别多的地方")),
        true
      );
      assert.equal((merged.destinations || []).includes("人特别多"), false);
      assert.equal((merged.destinations || []).includes("人特别多的"), false);
    },
  },
  {
    name: "later neutral turn should not collapse preserved total duration to partial city sum",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        [
          "我想10天去西班牙和葡萄牙，主要想待里斯本和塞维利亚，马德里不是必须，西语葡语都不会。",
          "那就按里斯本4晚、塞维利亚4晚，剩下2天机动，马德里先不要。",
        ].join("\n"),
        "语言还是问题，但葡萄牙和西班牙这两个国家都保留。"
      );
      assert.equal(merged.durationDays, 10);
      assert.equal((merged.destinations || []).includes("语言还是问题"), false);
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
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 一个人去米兰",
              status: "confirmed",
              confidence: 0.7,
              importance: 0.7,
              key: "slot:destination:一个人去米兰",
            } as any,
            {
              id: "n_old_2",
              type: "factual_assertion",
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
    name: "slot state should keep 6+1 city snapshot and preserve 7-day total",
    run: () => {
      const signals = extractIntentSignalsWithRecency(
        "我们一家三口第一次去日本关西，7天，想轻松一点，不要每天暴走，京都和大阪都想去。",
        "那就按京都6晚、大阪1晚来想，关西这个大区不用单独算。"
      );
      const state = buildSlotStateMachine({
        userText: "那就按京都6晚、大阪1晚来想，关西这个大区不用单独算。",
        recentTurns: [
          { role: "user", content: "我们一家三口第一次去日本关西，7天，想轻松一点，不要每天暴走，京都和大阪都想去。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "那就按京都6晚、大阪1晚来想，关西这个大区不用单独算。" },
        ],
        signals,
      });
      const totalNode = state.nodes.find((n: any) => n.slotKey === "slot:duration_total");
      const cityStatements = state.nodes
        .filter((n: any) => String(n.slotKey || "").startsWith("slot:duration_city:"))
        .map((n: any) => String(n.statement || ""));
      assert.equal(totalNode?.statement, "总行程时长: 7天");
      assert.equal(cityStatements.some((x) => /京都 6天/.test(x)), true);
      assert.equal(cityStatements.some((x) => /大阪 1天/.test(x)), true);
    },
  },
  {
    name: "slot state should preserve explicit total over partial city allocation",
    run: () => {
      const signals = extractIntentSignalsWithRecency(
        "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，想先看老城和花园，卡萨可以作为落地中转，法语阿拉伯语都不会，希望别太折腾。",
        "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡，其他先别塞满。"
      );
      const state = buildSlotStateMachine({
        userText: "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡，其他先别塞满。",
        recentTurns: [
          { role: "user", content: "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，想先看老城和花园，卡萨可以作为落地中转，法语阿拉伯语都不会，希望别太折腾。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡，其他先别塞满。" },
        ],
        signals,
      });
      const totalNode = state.nodes.find((n: any) => n.slotKey === "slot:duration_total");
      const cityStatements = state.nodes
        .filter((n: any) => String(n.slotKey || "").startsWith("slot:duration_city:"))
        .map((n: any) => String(n.statement || ""));
      assert.equal(totalNode?.statement, "总行程时长: 8天");
      assert.equal(cityStatements.some((x) => /马拉喀什 4天/.test(x)), true);
      assert.equal(cityStatements.some((x) => /非斯 2天/.test(x)), true);
    },
  },
  {
    name: "partial city allocation should drop stale country duration envelope during signal merge",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我想和妈妈去摩洛哥玩7到8天，第一次去，想轻松一点，英语沟通压力别太大。",
        "先按马拉喀什4晚、非斯2晚，卡萨最多半天过渡，整体还是8天。"
      );
      assert.equal(merged.durationDays, 8);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "摩洛哥"), false);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "马拉喀什" && x.days === 4), true);
      assert.equal((merged.cityDurations || []).some((x) => x.city === "非斯" && x.days === 2), true);
    },
  },
  {
    name: "partial city allocation should keep the coarse country anchor in goal text",
    run: () => {
      const latest = "先按马拉喀什4晚、非斯2晚，卡萨最多半天过渡，整体还是8天。";
      const merged = extractIntentSignalsWithRecency(
        "我想和妈妈去摩洛哥玩7到8天，第一次去，想轻松一点，英语沟通压力别太大。",
        latest
      );
      assert.equal(buildTravelIntentStatement(merged, latest, "zh-CN"), "意图：去摩洛哥旅游8天");
    },
  },
  {
    name: "slot state should drop removed destinations so compiler can clean stale graph nodes",
    run: () => {
      const signals = extractIntentSignalsWithRecency(
        [
          "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，卡萨可以作为落地中转，想去马拉喀什和非斯。",
          "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡。",
        ].join("\n"),
        "再纠正一下，卡萨先完全去掉，总时长还是按8天。"
      );
      const state = buildSlotStateMachine({
        userText: "再纠正一下，卡萨先完全去掉，总时长还是按8天。",
        recentTurns: [
          { role: "user", content: "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，卡萨可以作为落地中转，想去马拉喀什和非斯。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "再纠正一下，卡萨先完全去掉，总时长还是按8天。" },
        ],
        signals,
      });
      assert.equal(state.nodes.some((n: any) => String(n.slotKey) === "slot:destination:卡萨"), false);
    },
  },
  {
    name: "slot state should honor explicit removal wording even when polluted signals still contain stale destination slots",
    run: () => {
      const state = buildSlotStateMachine({
        userText: "卡萨先完全去掉，剩下时间宁可在马拉喀什放空，也别频繁换城。",
        recentTurns: [{ role: "user", content: "卡萨先完全去掉，剩下时间宁可在马拉喀什放空，也别频繁换城。" }],
        signals: {
          destinations: ["摩洛哥", "马拉喀什", "非斯", "卡萨布兰卡"],
          cityDurations: [
            {
              city: "马拉喀什",
              days: 4,
              evidence: "马拉喀什4晚",
              kind: "travel",
            },
            {
              city: "非斯",
              days: 2,
              evidence: "非斯2晚",
              kind: "travel",
            },
            {
              city: "卡萨布兰卡",
              days: 1,
              evidence: "卡萨布兰卡1天",
              kind: "travel",
            },
          ],
          durationDays: 8,
          durationEvidence: "8天",
        },
        locale: "zh-CN",
      });
      const slotKeys = state.nodes.map((n: any) => String(n.slotKey || ""));
      assert.equal(slotKeys.includes("slot:destination:卡萨布兰卡"), false);
      assert.equal(slotKeys.includes("slot:duration_city:卡萨布兰卡"), false);
      assert.equal(slotKeys.includes("slot:destination:马拉喀什"), true);
      assert.equal(slotKeys.includes("slot:destination:非斯"), true);
    },
  },
  {
    name: "apply patch should remove stale destination slot when deletion is compiled",
    run: () => {
      const signals = extractIntentSignalsWithRecency(
        [
          "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，卡萨可以作为落地中转，想去马拉喀什和非斯。",
          "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡。",
        ].join("\n"),
        "再纠正一下，卡萨先完全去掉，总时长还是按8天。"
      );
      const state = buildSlotStateMachine({
        userText: "再纠正一下，卡萨先完全去掉，总时长还是按8天。",
        recentTurns: [
          { role: "user", content: "我们想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，卡萨可以作为落地中转，想去马拉喀什和非斯。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "那就先以马拉喀什4晚、非斯2晚，卡萨最多半天过渡。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "再纠正一下，卡萨先完全去掉，总时长还是按8天。" },
        ],
        signals,
      });
      const graph = {
        id: "g_remove_destination",
        version: 1,
        nodes: [
          {
            id: "n_kasa",
            type: "factual_assertion",
            layer: "requirement",
            statement: "目的地: 卡萨",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.8,
            key: "slot:destination:卡萨",
          },
          {
            id: "n_morocco",
            type: "factual_assertion",
            layer: "requirement",
            statement: "目的地: 摩洛哥",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.8,
            key: "slot:destination:摩洛哥",
          },
        ],
        edges: [],
      } as any;
      const patch = compileSlotStateToPatch({ graph, state });
      const applied = applyPatchWithGuards(graph, patch).newGraph;
      assert.equal(applied.nodes.some((n: any) => n.key === "slot:destination:卡萨"), false);
    },
  },
  {
    name: "patch guard should preserve stale-slot removals even when compiled patch exceeds 12 ops",
    run: () => {
      const state = buildSlotStateMachine({
        userText: "卡萨先完全去掉，剩下时间宁可在马拉喀什放空，也别频繁换城。",
        recentTurns: [
          { role: "user", content: "我想带妈妈第一次去摩洛哥，7到8天，预算总共3万元，别太折腾，法语和阿拉伯语都不会，主要想去马拉喀什和非斯。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "可以，先按马拉喀什4晚、非斯2晚，卡萨最多半天中转，整体还是8天。" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "卡萨先完全去掉，剩下时间宁可在马拉喀什放空，也别频繁换城。" },
        ],
        signals: {
          destination: "摩洛哥",
          destinations: ["摩洛哥", "马拉喀什", "非斯", "卡萨"],
          destinationEvidence: "摩洛哥、马拉喀什、非斯",
          cityDurations: [
            { city: "马拉喀什", days: 4, evidence: "马拉喀什4晚", kind: "travel" },
            { city: "非斯", days: 2, evidence: "非斯2晚", kind: "travel" },
            { city: "卡萨", days: 1, evidence: "卡萨最多半天中转", kind: "travel" },
          ],
          durationDays: 8,
          durationEvidence: "整体还是8天",
          budgetCny: 30000,
          budgetRemainingCny: 30000,
          budgetEvidence: "预算总共3万元",
          languageConstraint: "法语和阿拉伯语都不会",
          languageEvidence: "法语和阿拉伯语都不会",
          activityPreference: "别太折腾",
          activityPreferenceEvidence: "别太折腾",
          lodgingPreference: "别太折腾",
          lodgingPreferenceEvidence: "别太折腾",
          genericConstraints: [
            { text: "别太折腾", evidence: "别太折腾", hard: true, kind: "mobility", importance: 0.84 },
            { text: "也别频繁换城", evidence: "也别频繁换城", hard: true, kind: "mobility", importance: 0.82 },
          ],
          removedDestinations: ["卡萨"],
        },
        locale: "zh-CN",
      });
      const graph = {
        id: "g_patch_guard_removal_budget",
        version: 1,
        nodes: [
          { id: "n_goal", type: "belief", layer: "intent", statement: "意图：去摩洛哥和马拉喀什和非斯旅游8天", status: "confirmed", confidence: 0.9, importance: 0.9, key: "slot:goal" },
          { id: "n_dest_morocco", type: "factual_assertion", layer: "requirement", statement: "目的地: 摩洛哥", status: "confirmed", confidence: 0.9, importance: 0.84, key: "slot:destination:摩洛哥" },
          { id: "n_dest_marrakech", type: "factual_assertion", layer: "requirement", statement: "目的地: 马拉喀什", status: "confirmed", confidence: 0.9, importance: 0.84, key: "slot:destination:马拉喀什" },
          { id: "n_dest_fes", type: "factual_assertion", layer: "requirement", statement: "目的地: 非斯", status: "confirmed", confidence: 0.9, importance: 0.84, key: "slot:destination:非斯" },
          { id: "n_activity", type: "preference", layer: "preference", statement: "活动偏好: 别太折腾", status: "confirmed", confidence: 0.82, importance: 0.78, key: "slot:activity_preference" },
          { id: "n_duration_total", type: "constraint", layer: "requirement", statement: "总行程时长: 8天", status: "confirmed", confidence: 0.9, importance: 0.84, key: "slot:duration_total" },
          { id: "n_budget", type: "constraint", layer: "requirement", statement: "预算上限: 30000元", status: "confirmed", confidence: 0.9, importance: 0.84, key: "slot:budget" },
          { id: "n_budget_remaining", type: "factual_assertion", layer: "requirement", statement: "剩余预算: 30000元", status: "confirmed", confidence: 0.88, importance: 0.82, key: "slot:budget_remaining" },
          { id: "n_language", type: "constraint", layer: "requirement", statement: "限制因素: 法语和阿拉伯语都不会", status: "confirmed", confidence: 0.88, importance: 0.84, key: "slot:constraint:limiting:language" },
          { id: "n_mobility", type: "constraint", layer: "requirement", statement: "限制因素: 别太折腾", status: "confirmed", confidence: 0.88, importance: 0.84, key: "slot:constraint:limiting:mobility" },
          { id: "n_lodging", type: "preference", layer: "preference", statement: "住宿偏好: 别太折腾", status: "confirmed", confidence: 0.8, importance: 0.74, key: "slot:lodging" },
          { id: "n_dest_kasa", type: "factual_assertion", layer: "requirement", statement: "目的地: 卡萨", status: "confirmed", confidence: 0.86, importance: 0.76, key: "slot:destination:卡萨" },
          { id: "n_dur_marrakech", type: "factual_assertion", layer: "requirement", statement: "城市时长: 马拉喀什 4天", status: "confirmed", confidence: 0.84, importance: 0.74, key: "slot:duration_city:马拉喀什" },
          { id: "n_dur_fes", type: "factual_assertion", layer: "requirement", statement: "城市时长: 非斯 2天", status: "confirmed", confidence: 0.84, importance: 0.74, key: "slot:duration_city:非斯" },
          { id: "n_dur_kasa", type: "factual_assertion", layer: "requirement", statement: "城市时长: 卡萨 1天", status: "confirmed", confidence: 0.82, importance: 0.7, key: "slot:duration_city:卡萨" },
        ],
        edges: [
          { id: "e_dest_kasa_goal", from: "n_dest_kasa", to: "n_goal", type: "enable", confidence: 0.8 },
          { id: "e_dur_kasa_dest", from: "n_dur_kasa", to: "n_dest_kasa", type: "determine", confidence: 0.82 },
        ],
      } as any;
      const compiled = compileSlotStateToPatch({ graph, state });
      assert.ok(compiled.ops.length > 12);
      const sanitized = sanitizeGraphPatchStrict(compiled);
      const removedNodeIds = sanitized.ops
        .filter((op: any) => op.op === "remove_node")
        .map((op: any) => op.id)
        .sort();
      const removedEdgeIds = sanitized.ops
        .filter((op: any) => op.op === "remove_edge")
        .map((op: any) => op.id)
        .sort();
      assert.deepEqual(removedNodeIds, ["n_dest_kasa", "n_dur_kasa"]);
      assert.deepEqual(removedEdgeIds, ["e_dest_kasa_goal", "e_dur_kasa_dest"]);
      assert.ok(sanitized.ops.length > 12);
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
    name: "sub-location hard-constraint confirmation should not be re-asked after user answered",
    run: () => {
      const plan = planUncertaintyQuestion({
        graph: {
          id: "g_sub_loc",
          version: 1,
          nodes: [
            {
              id: "n_sub_loc",
              type: "constraint",
              layer: "requirement",
              statement: "子地点: 圣西罗（米兰）",
              status: "proposed",
              confidence: 0.43,
              importance: 0.82,
              key: "slot:sub_location:米兰:圣西罗",
            } as any,
          ],
          edges: [],
        },
        recentTurns: [
          { role: "assistant", content: "请确认这条信息是否是硬约束：“子地点: 圣西罗（米兰）”？" },
          { role: "user", content: "是硬约束" },
        ],
      });
      assert.equal(/硬约束.*圣西罗|圣西罗.*硬约束/.test(String(plan.question || "")), false);
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
              type: "belief",
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
              type: "factual_assertion",
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
    name: "travel plan state should honor graph foreign-currency spent override and recompute remaining",
    run: () => {
      const state = buildTravelPlanState({
        graph: {
          id: "g4",
          version: 1,
          nodes: [
            {
              id: "n_goal",
              type: "belief",
              layer: "intent",
              statement: "意图：去米兰旅游3天",
              status: "confirmed",
              confidence: 0.86,
              importance: 0.84,
              key: "slot:goal",
            } as any,
            {
              id: "n_budget",
              type: "constraint",
              layer: "requirement",
              statement: "预算上限: 10000元",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.78,
              key: "slot:budget",
            } as any,
            {
              id: "n_spent_manual",
              type: "constraint",
              layer: "requirement",
              statement: "已花预算: 60欧元",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.78,
              key: "slot:budget_spent",
            } as any,
            {
              id: "n_remaining_stale",
              type: "constraint",
              layer: "requirement",
              statement: "剩余预算: 9940元",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.78,
              key: "slot:budget_remaining",
            } as any,
          ],
          edges: [],
        },
        turns: [
          {
            createdAt: "2026-02-26T10:00:00.000Z",
            userText: "预算10000元",
            assistantText: "收到",
          },
          {
            createdAt: "2026-02-26T10:05:00.000Z",
            userText: "我花60元买了球票",
            assistantText: "收到",
          },
        ],
        previous: null,
      });

      // 60 EUR * 7.9 = 474 CNY, remaining should be 10000 - 474 = 9526.
      assert.equal(state.budget?.totalCny, 10000);
      assert.equal(state.budget?.spentCny, 474);
      assert.equal(state.budget?.remainingCny, 9526);
    },
  },
  {
    name: "travel plan state should keep detailed assistant itinerary snapshot for date-based plans",
    run: () => {
      const state = buildTravelPlanState({
        graph: {
          id: "g4_plan_snapshot",
          version: 1,
          nodes: [
            {
              id: "n_goal",
              type: "belief",
              layer: "intent",
              statement: "意图：去米兰旅游3天",
              status: "confirmed",
              confidence: 0.9,
              importance: 0.9,
              key: "slot:goal",
            } as any,
            {
              id: "n_dest",
              type: "factual_assertion",
              layer: "requirement",
              statement: "目的地: 米兰",
              status: "confirmed",
              confidence: 0.91,
              importance: 0.86,
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
            createdAt: "2026-03-04T05:00:00.000Z",
            userText: "好的，就按你说的制定旅行计划",
            assistantText:
              "明白了，参观圣西罗是硬约束。4月10日 上午：参观米兰大教堂及其屋顶。下午：逛埃马努埃莱二世长廊和蒙特拿破仑大街。晚上：在布雷拉区晚餐。4月11日 上午：游览斯福尔扎城堡。下午：参观布雷拉画廊。晚上：布雷拉区用餐。4月12日 上午：自由活动。下午：前往圣西罗体育场参观。晚上：返回市中心晚餐。请确认这条信息是否是硬约束：“子地点: 圣西罗（米兰）”？",
          },
        ],
        previous: null,
      });

      assert.equal(state.assistantPlan?.parser, "date_header");
      assert.equal(state.assistantPlan?.dayPlans.length, 3);
      assert.equal(String(state.assistantPlan?.rawText || "").includes("4月10日"), true);
      assert.equal(String(state.exportNarrative || "").includes("圣西罗体育场"), true);
    },
  },
  {
    name: "manual graph remaining budget should persist on non-budget user turns",
    run: async () => {
      const graph = {
        id: "g_manual_budget_keep",
        version: 7,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图：去米兰旅游3天",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.84,
            key: "slot:goal",
          },
          {
            id: "n_budget",
            type: "constraint",
            layer: "requirement",
            statement: "预算上限: 10000元",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.8,
            key: "slot:budget",
          },
          {
            id: "n_budget_remaining",
            type: "constraint",
            layer: "requirement",
            statement: "剩余预算: 3250元",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.82,
            key: "slot:budget_remaining",
          },
        ] as any,
        edges: [
          {
            id: "e_budget_goal",
            from: "n_budget",
            to: "n_goal",
            type: "constraint",
            confidence: 0.9,
          },
        ] as any,
      } as any;

      const patch = await generateGraphPatch({
        graph,
        userText: "请把明天行程安排得轻松一点，下午看展",
        recentTurns: [
          { role: "user", content: "预算10000元" },
          { role: "assistant", content: "收到" },
        ],
        stateContextUserTurns: ["预算10000元"],
        assistantText: "",
        locale: "zh-CN" as any,
      });

      const state = buildSlotStateMachine({
        userText: "请把明天行程安排得轻松一点，下午看展",
        recentTurns: [
          { role: "user", content: "预算10000元" },
          { role: "assistant", content: "收到" },
        ],
        signals: extractIntentSignalsWithRecency("预算10000元", "请把明天行程安排得轻松一点，下午看展"),
        locale: "zh-CN" as any,
      });
      const compiled = compileSlotStateToPatch({ graph, state });
      assert.ok(Array.isArray(patch.ops));
      assert.ok(Array.isArray(compiled.ops));

      const budgetRemainingNodeOp = patch.ops.find((op: any) => {
        if (op.op !== "add_node" && op.op !== "update_node") return false;
        const node = (op as any).node || (op as any).patch || {};
        const key = String(node.key || "");
        return key === "slot:budget_remaining";
      }) as any;

      if (budgetRemainingNodeOp) {
        const node = budgetRemainingNodeOp.node || budgetRemainingNodeOp.patch || {};
        assert.equal(/3250/.test(String(node.statement || "")), true);
      } else {
        const originalRemaining = (graph.nodes || []).find((n: any) => n.key === "slot:budget_remaining");
        assert.equal(/3250/.test(String(originalRemaining?.statement || "")), true);
      }
    },
  },
  {
    name: "near-duplicate safety limiting factors should collapse to one concept",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：治安、夜间出行要考虑",
        "所以要尽量让我安全感强（治安、夜间出行都要考虑），需安全感强"
      );
      const state = buildSlotStateMachine({
        userText: "所以要尽量让我安全感强（治安、夜间出行都要考虑），需安全感强",
        recentTurns: [
          { role: "user", content: "限制因素：治安、夜间出行要考虑" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "所以要尽量让我安全感强（治安、夜间出行都要考虑），需安全感强" },
        ],
        signals: merged,
      });

      const safetyLimitingNodes = state.nodes.filter((n: any) => {
        const key = String(n?.slotKey || "");
        const tags = Array.isArray(n?.tags) ? n.tags.map((x: any) => String(x)) : [];
        return key.startsWith("slot:constraint:limiting:") && tags.includes("safety");
      });
      assert.equal(safetyLimitingNodes.length, 1);
    },
  },
  {
    name: "structural raw kinds (constraint/risk) should still collapse to one safety limiting concept",
    run: () => {
      const state = buildSlotStateMachine({
        userText: "所以要尽量让我安全感强（治安、夜间出行都要考虑）",
        recentTurns: [
          { role: "user", content: "限制因素：治安、夜间出行要考虑" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "所以要尽量让我安全感强（治安、夜间出行都要考虑）" },
        ],
        signals: {
          destinations: ["米兰"],
          destination: "米兰",
          genericConstraints: [
            {
              text: "限制因素：治安、夜间出行要考虑",
              evidence: "限制因素：治安、夜间出行要考虑",
              kind: "safety",
              hard: false,
              severity: "high",
              importance: 0.82,
            },
            {
              text: "所以要尽量让我安全感强（治安、夜间出行都要考虑）",
              evidence: "所以要尽量让我安全感强（治安、夜间出行都要考虑）",
              kind: "constraint" as any,
              hard: false,
              severity: "medium",
              importance: 0.78,
            },
            {
              text: "需安全感强",
              evidence: "需安全感强",
              kind: "risk" as any,
              hard: true,
              severity: "high",
              importance: 0.9,
            },
          ],
        } as any,
      });

      const safetyLimitingNodes = state.nodes.filter((n: any) => {
        const key = String(n?.slotKey || "");
        const tags = Array.isArray(n?.tags) ? n.tags.map((x: any) => String(x)) : [];
        return key.startsWith("slot:constraint:limiting:") && tags.includes("safety");
      });
      assert.equal(safetyLimitingNodes.length, 1);
    },
  },
  {
    name: "latest opposite limiting factor should revoke previous axis without creating opposite node",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：一定要坐船",
        "限制因素：不坐船了"
      );
      const state = buildSlotStateMachine({
        userText: "限制因素：不坐船了",
        recentTurns: [
          { role: "user", content: "限制因素：一定要坐船" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "限制因素：不坐船了" },
        ],
        signals: merged,
      });

      const boatNodes = state.nodes.filter((n: any) => {
        const key = String(n?.slotKey || "");
        const statement = String(n?.statement || "");
        return key.startsWith("slot:constraint:limiting:") && /坐船|乘船|ferry|boat/i.test(statement);
      });
      assert.equal(boatNodes.length, 0);
      assert.equal((merged.revokedConstraintAxes || []).length > 0, true);
    },
  },
  {
    name: "opposite limiting factor with acknowledgement/noisy phrasing should still revoke axis",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：好的一定要坐船",
        "限制因素：不坐船了，不喜欢船了"
      );
      const state = buildSlotStateMachine({
        userText: "限制因素：不坐船了，不喜欢船了",
        recentTurns: [
          { role: "user", content: "限制因素：好的一定要坐船" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "限制因素：不坐船了，不喜欢船了" },
        ],
        signals: merged,
      });

      const boatNodes = state.nodes.filter((n: any) => {
        const key = String(n?.slotKey || "");
        const statement = String(n?.statement || "");
        return key.startsWith("slot:constraint:limiting:") && /坐船|乘船|ferry|boat|船/i.test(statement);
      });
      assert.equal(boatNodes.length, 0);
      assert.equal((merged.revokedConstraintAxes || []).length > 0, true);
    },
  },
  {
    name: "opposite limiting factor update should remove stale node and detach stale edge",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：一定要坐船",
        "限制因素：不坐船了"
      );
      const state = buildSlotStateMachine({
        userText: "限制因素：不坐船了",
        recentTurns: [
          { role: "user", content: "限制因素：一定要坐船" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "限制因素：不坐船了" },
        ],
        signals: merged,
      });
      const graph = {
        id: "g_opposite_limit_patch",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图: 旅行计划",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.84,
            key: "slot:goal",
          },
          {
            id: "n_old_boat",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 一定要坐船",
            status: "confirmed",
            confidence: 0.88,
            importance: 0.8,
            key: "slot:constraint:limiting:other:otherpos要坐船",
          },
        ],
        edges: [
          { id: "e_old_boat_goal", from: "n_old_boat", to: "n_goal", type: "constraint", confidence: 0.9 },
        ],
      } as any;

      const patch = compileSlotStateToPatch({ graph, state });
      assert.equal(
        patch.ops.some((op: any) => op.op === "remove_node" && op.id === "n_old_boat"),
        true
      );
      assert.equal(
        patch.ops.some((op: any) => op.op === "remove_edge" && op.id === "e_old_boat_goal"),
        true
      );
      assert.equal(
        patch.ops.some(
          (op: any) =>
            op.op === "add_node" && /坐船|乘船|ferry|boat/i.test(String(op.node?.statement || ""))
        ),
        false
      );
    },
  },
  {
    name: "car opposite update should also revoke old axis without creating opposite node",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：一定要坐车",
        "限制因素：不坐车了"
      );
      const state = buildSlotStateMachine({
        userText: "限制因素：不坐车了",
        recentTurns: [
          { role: "user", content: "限制因素：一定要坐车" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "限制因素：不坐车了" },
        ],
        signals: merged,
      });
      const carNodes = state.nodes.filter((n: any) => {
        const key = String(n?.slotKey || "");
        const statement = String(n?.statement || "");
        return key.startsWith("slot:constraint:limiting:") && /坐车|乘车|car|taxi|drive/i.test(statement);
      });
      assert.equal(carNodes.length, 0);
    },
  },
  {
    name: "revocation-only input should not overwrite existing goal statement",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "限制因素：一定要坐车",
        "不坐车了"
      );
      const state = buildSlotStateMachine({
        userText: "不坐车了",
        recentTurns: [
          { role: "user", content: "限制因素：一定要坐车" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "不坐车了" },
        ],
        signals: merged,
      });
      const graph = {
        id: "g_goal_preserve",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图：去米兰旅游",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.88,
            key: "slot:goal",
          },
        ],
        edges: [],
      } as any;
      const patch = compileSlotStateToPatch({ graph, state });
      assert.equal(
        patch.ops.some(
          (op: any) => op.op === "update_node" && op.id === "n_goal" && op.patch && typeof op.patch.statement === "string"
        ),
        false
      );
    },
  },
  {
    name: "scenic preference opposite update should revoke old preference without creating opposite node",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "景点偏好：人文景观优先",
        "不喜欢人文了"
      );
      const state = buildSlotStateMachine({
        userText: "不喜欢人文了",
        recentTurns: [
          { role: "user", content: "景点偏好：人文景观优先" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "不喜欢人文了" },
        ],
        signals: merged,
      });
      assert.equal(state.nodes.some((n: any) => String(n?.slotKey || "") === "slot:scenic_preference"), false);
    },
  },
  {
    name: "lodging preference opposite update should revoke old preference without creating opposite node",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "住宿偏好：全程高星级酒店优先",
        "不要高星级酒店了"
      );
      const state = buildSlotStateMachine({
        userText: "不要高星级酒店了",
        recentTurns: [
          { role: "user", content: "住宿偏好：全程高星级酒店优先" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "不要高星级酒店了" },
        ],
        signals: merged,
      });
      assert.equal(state.nodes.some((n: any) => String(n?.slotKey || "") === "slot:lodging"), false);
    },
  },
  {
    name: "activity preference opposite update should revoke old preference without creating opposite node",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "活动偏好：体育赛事优先",
        "不看球了"
      );
      const state = buildSlotStateMachine({
        userText: "不看球了",
        recentTurns: [
          { role: "user", content: "活动偏好：体育赛事优先" },
          { role: "assistant", content: "收到" },
          { role: "user", content: "不看球了" },
        ],
        signals: merged,
      });
      assert.equal(state.nodes.some((n: any) => String(n?.slotKey || "") === "slot:activity_preference"), false);
    },
  },
  {
    name: "health constraint should drive low-intensity and diet subtree",
    run: () => {
      const latestText = "我有冠心病，旅游选择低强度，饮食上选择低盐低脂高纤维";
      const signals = extractIntentSignalsWithRecency(
        "我4月10日到4月12日去米兰，预算10000元",
        latestText
      );
      assert.equal(/冠心病|心脏|cardiac/i.test(String(signals.healthConstraint || "")), true);
      assert.equal(/低强度|low[-\\s]?intensity/i.test(String(signals.activityPreference || "")), true);
      assert.equal(
        (signals.genericConstraints || []).some((x) => {
          const text = String(x?.text || "");
          return x?.kind === "diet" || /低盐|低脂|高纤维|low[-\\s]?salt|low[-\\s]?fat|high[-\\s]?fiber/i.test(text);
        }),
        true
      );

      const state = buildSlotStateMachine({
        userText: latestText,
        recentTurns: [
          { role: "user", content: "我4月10日到4月12日去米兰，预算10000元" },
          { role: "assistant", content: "好的" },
          { role: "user", content: latestText },
        ],
        signals,
      });

      const healthNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:health")
      );
      const activityNode = state.nodes.find(
        (n: any) => String(n?.slotKey || "") === "slot:activity_preference"
      );
      const dietNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:diet")
      );
      assert.ok(healthNode, "missing health limiting factor node");
      assert.ok(activityNode, "missing low-intensity activity preference node");
      assert.ok(dietNode, "missing diet limiting factor node");
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === String(healthNode?.slotKey || "") &&
            e.toSlot === "slot:activity_preference" &&
            e.type === "determine"
        ),
        true
      );
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === String(healthNode?.slotKey || "") &&
            e.toSlot === String(dietNode?.slotKey || "") &&
            e.type === "constraint"
        ),
        true
      );
    },
  },
  {
    name: "family low-hassle pattern should form mobility to lodging subtree",
    run: () => {
      const latestText = "带爸妈去巴黎，不要太折腾，酒店最好离地铁近";
      const signals = extractIntentSignalsWithRecency(
        "同行人数2人，去巴黎玩4天",
        latestText
      );
      const state = buildSlotStateMachine({
        userText: latestText,
        recentTurns: [
          { role: "user", content: "同行人数2人，去巴黎玩4天" },
          { role: "assistant", content: "收到" },
          { role: "user", content: latestText },
        ],
        signals,
      });

      const mobilityNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:mobility")
      );
      const lodgingNode = state.nodes.find((n: any) => String(n?.slotKey || "") === "slot:lodging");
      assert.ok(mobilityNode, "missing mobility limiting node");
      assert.ok(lodgingNode, "missing lodging preference node");
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === String(mobilityNode?.slotKey || "") &&
            e.toSlot === "slot:lodging"
        ),
        true
      );
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === "slot:people" &&
            e.toSlot === "slot:lodging" &&
            e.type === "determine"
        ),
        true
      );
    },
  },
  {
    name: "safety factor should constrain lodging strategy subtree",
    run: () => {
      const latestText = "我不想被坑，我想住在市中心安全一些的酒店";
      const signals = extractIntentSignalsWithRecency(
        "我去米兰旅游3天",
        latestText
      );
      const state = buildSlotStateMachine({
        userText: latestText,
        recentTurns: [
          { role: "user", content: "我去米兰旅游3天" },
          { role: "assistant", content: "收到" },
          { role: "user", content: latestText },
        ],
        signals,
      });

      const safetyNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:safety")
      );
      assert.ok(safetyNode, "missing safety limiting node");
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === String(safetyNode?.slotKey || "") &&
            e.toSlot === "slot:lodging" &&
            e.type === "constraint"
        ),
        true
      );
    },
  },
  {
    name: "language barrier should drive logistics subtree",
    run: () => {
      const latestText = "我不会英语，尽量少换乘，酒店靠近地铁";
      const signals = extractIntentSignalsWithRecency(
        "我4月去伦敦旅游",
        latestText
      );
      const state = buildSlotStateMachine({
        userText: latestText,
        recentTurns: [
          { role: "user", content: "我4月去伦敦旅游" },
          { role: "assistant", content: "收到" },
          { role: "user", content: latestText },
        ],
        signals,
      });

      const languageNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:language")
      );
      const logisticsNode = state.nodes.find((n: any) =>
        String(n?.slotKey || "").startsWith("slot:constraint:limiting:logistics")
      );
      assert.ok(languageNode, "missing language limiting node");
      assert.ok(logisticsNode, "missing logistics limiting node");
      assert.equal(
        state.edges.some(
          (e: any) =>
            e.fromSlot === String(languageNode?.slotKey || "") &&
            e.toSlot === String(logisticsNode?.slotKey || "") &&
            e.type === "determine"
        ),
        true
      );
    },
  },
  {
    name: "highly similar freeform concepts should be deduplicated",
    run: () => {
      const graph = {
        id: "g_concept_high_similarity",
        version: 1,
        nodes: [
          {
            id: "n1",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 住安全区域",
            status: "confirmed",
            confidence: 0.88,
            importance: 0.84,
            key: "slot:freeform:constraint:safe_zone_a",
          },
          {
            id: "n2",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 住安全区域",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.8,
            key: "slot:freeform:constraint:safe_zone_b",
          },
        ],
        edges: [],
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      assert.equal(concepts.length, 1);
      assert.equal((concepts[0].nodeIds || []).length >= 2, true);
      assert.equal((concepts[0].migrationHistory || []).some((x) => String(x).startsWith("high_similarity_merged:")), true);
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
            type: "belief",
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
            type: "factual_assertion",
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
      const deprecated = motifs.filter((m) => m.status === "deprecated");

      const budgetRemainConcept = concepts.find((c) => c.semanticKey === "slot:budget_remaining");
      assert.ok(budgetRemainConcept);
      assert.equal(active.some((m) => m.conceptIds.includes(budgetRemainConcept!.id)), false);

      const byAnchor = new Map<string, number>();
      for (const m of active) {
        const k = String(m.anchorConceptId || "");
        byAnchor.set(k, (byAnchor.get(k) || 0) + 1);
      }
      for (const count of byAnchor.values()) {
        assert.equal(count <= 3, true);
      }

      const hasSoftDeprecated = deprecated.some((m) => {
        const r = String(m.statusReason || "");
        return (
          r.startsWith("redundant_with:") ||
          r.startsWith("subsumed_by:") ||
          r.startsWith("density_pruned:") ||
          r.startsWith("relation_shadowed_by:")
        );
      });
      assert.equal(hasSoftDeprecated, false);
    },
  },
  {
    name: "highly similar motifs on same anchor should be cancelled as duplicates",
    run: () => {
      const graph = {
        id: "g_motif_high_similarity",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图: 去米兰旅游",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.9,
            key: "slot:goal",
          },
          {
            id: "n_limit",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 住安全区域",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.82,
            key: "slot:constraint:limiting:other:safe_zone",
          },
          {
            id: "n_generic",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 住安全区域",
            status: "confirmed",
            confidence: 0.87,
            importance: 0.79,
            key: "slot:constraint:safe_zone",
          },
        ] as any,
        edges: [
          { id: "e1", from: "n_limit", to: "n_goal", type: "constraint", confidence: 0.9 },
          { id: "e2", from: "n_generic", to: "n_goal", type: "constraint", confidence: 0.87 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
      assert.equal(
        motifs.length,
        1,
        "highly similar motifs should collapse to one exposed motif"
      );
      assert.equal(
        motifs.every((m) => m.status === "active"),
        true
      );
    },
  },
  {
    name: "motif titles should refresh when stable concept ids get new graph statements",
    run: () => {
      const graph = {
        id: "g_motif_title_refresh",
        version: 4,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图：去京都和大阪旅游7天",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.84,
            key: "slot:goal",
          },
          {
            id: "n_duration",
            type: "constraint",
            layer: "requirement",
            statement: "总行程时长: 7天",
            status: "confirmed",
            confidence: 0.95,
            importance: 0.8,
            key: "slot:duration_total",
          },
        ] as any,
        edges: [{ id: "e1", from: "n_duration", to: "n_goal", type: "constraint", confidence: 0.9 }] as any,
      } as any;

      const baseConcepts = [
        {
          id: "c_semantic:slot:goal_belief_positive_global_dv4jnl",
          title: "意图：去关西和京都和大阪旅游7天",
          semanticKey: "slot:goal",
        },
        {
          id: "c_semantic:slot:duration_total_constraint_positive_global_18gtnyd",
          title: "总行程时长: 7天",
          semanticKey: "slot:duration_total",
        },
      ] as any;
      const baseMotifs = [
        {
          id: "m_pattern:pair_constraint_duration_total->goal",
          title: "总行程时长: 7天 限制 意图：去关西和京都和大阪旅游7天",
          relation: "constraint",
          dependencyClass: "constraint",
          conceptIds: [
            "c_semantic:slot:duration_total_constraint_positive_global_18gtnyd",
            "c_semantic:slot:goal_belief_positive_global_dv4jnl",
          ],
          anchorConceptId: "c_semantic:slot:goal_belief_positive_global_dv4jnl",
          status: "active",
        },
      ] as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts });
      const goalConcept = concepts.find((c) => c.semanticKey === "slot:goal");
      assert.ok(goalConcept);
      assert.equal(goalConcept!.title.includes("关西"), false);
      assert.equal(goalConcept!.title.includes("意图：去京都和大阪旅游7天"), true);

      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs, locale: "zh-CN" });
      const target = motifs.find((m) => m.id === "m_pattern:pair_constraint_duration_total->goal");
      assert.ok(target);
      assert.equal(target!.title.includes("关西"), false);
      assert.equal(target!.title.includes("意图：去京都和大阪旅游7天"), true);
    },
  },
  {
    name: "same-semantic relation shadow should be cancelled instead of deprecated",
    run: () => {
      const graph = {
        id: "g_motif_relation_shadow",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图: 去米兰旅游",
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
        ] as any,
        edges: [
          { id: "e1", from: "n_budget", to: "n_goal", type: "constraint", confidence: 0.92 },
          { id: "e2", from: "n_budget", to: "n_goal", type: "determine", confidence: 0.9 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
      assert.equal(
        motifs.length,
        1,
        "relation-shadow duplicate should be folded out of output"
      );
      assert.equal(
        motifs[0]?.relation === "constraint" || motifs[0]?.dependencyClass === "constraint",
        true
      );
      assert.equal(
        motifs.some((m) => m.status === "deprecated" && String(m.statusReason || "").startsWith("relation_conflict_with:")),
        false
      );
    },
  },
  {
    name: "explicit opposite-polarity relation should remain deprecated conflict",
    run: () => {
      const graph = {
        id: "g_motif_relation_conflict",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
            layer: "intent",
            statement: "意图: 旅游",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.84,
            key: "slot:goal",
          },
          {
            id: "n_safe_yes",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 必须住安全区域",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.82,
            key: "slot:constraint:limiting:other:safe_yes",
          },
          {
            id: "n_safe_no",
            type: "constraint",
            layer: "requirement",
            statement: "限制因素: 不要住安全区域",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.78,
            key: "slot:constraint:limiting:other:safe_no",
          },
        ] as any,
        edges: [
          { id: "e1", from: "n_safe_yes", to: "n_goal", type: "constraint", confidence: 0.9 },
          { id: "e2", from: "n_safe_no", to: "n_goal", type: "determine", confidence: 0.86 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
      assert.equal(
        motifs.some((m) => m.status === "deprecated" && String(m.statusReason || "").startsWith("relation_conflict_with:")),
        true
      );
    },
  },
  {
    name: "motif reasoning view should keep semantic motif links and structured explanations only",
    run: () => {
      const graph = {
        id: "g_reasoning_view_semantic",
        version: 1,
        nodes: [
          {
            id: "n_goal",
            type: "belief",
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
            id: "n_lodging",
            type: "preference",
            layer: "preference",
            statement: "住宿偏好: 安全区域优先",
            status: "confirmed",
            confidence: 0.86,
            importance: 0.76,
            key: "slot:lodging",
          },
        ] as any,
        edges: [
          { id: "e1", from: "n_budget", to: "n_goal", type: "enable", confidence: 0.9 },
          { id: "e2", from: "n_budget", to: "n_lodging", type: "determine", confidence: 0.86 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });
      const motifLinks = reconcileMotifLinks({ motifs, baseLinks: [] });
      const view = buildMotifReasoningView({ concepts, motifs, motifLinks, locale: "zh-CN" as any });
      const nodeIds = new Set(view.nodes.map((n) => n.id));

      assert.equal(view.edges.length > 0, true);
      assert.equal(view.edges.every((e) => nodeIds.has(String(e.from)) && nodeIds.has(String(e.to)) && e.from !== e.to), true);
      assert.equal(
        view.edges.every((e) => ["precedes", "supports", "conflicts_with", "refines"].includes(String(e.type))),
        true
      );
      assert.equal(view.steps.length > 0, true);
      assert.equal(
        view.steps.every((s) => /第\d+步|Step\s+\d+/i.test(String(s.explanation || ""))),
        true
      );
      assert.equal(
        view.steps.some((s) => /我想|I want|because|推理过程|chain of thought/i.test(String(s.explanation || ""))),
        false
      );
    },
  },
  {
    name: "activity/scenic to destination motif should be downgraded as context-specific and cancelled",
    run: () => {
      const graph = {
        id: "g_non_reusable_destination_link",
        version: 1,
        nodes: [
          {
            id: "n_activity",
            type: "preference",
            layer: "preference",
            statement: "活动偏好: 坐船",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.86,
            key: "slot:activity_preference",
          },
          {
            id: "n_scenic",
            type: "preference",
            layer: "preference",
            statement: "景点偏好: 自然之旅",
            status: "confirmed",
            confidence: 0.88,
            importance: 0.8,
            key: "slot:scenic_preference",
          },
          {
            id: "n_destination",
            type: "factual_assertion",
            layer: "requirement",
            statement: "目的地: 香港",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.82,
            key: "slot:destination:香港",
          },
        ] as any,
        edges: [
          { id: "e1", from: "n_activity", to: "n_destination", type: "determine", confidence: 0.9 },
          { id: "e2", from: "n_scenic", to: "n_destination", type: "determine", confidence: 0.88 },
        ] as any,
      } as any;

      const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
      const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] });

      const destinationMotifs = motifs.filter((m) => {
        const includesDestinationConcept = (m.conceptIds || []).some((cid) => {
          const c = concepts.find((x) => x.id === cid);
          return c?.family === "destination";
        });
        return includesDestinationConcept;
      });
      assert.equal(
        destinationMotifs.length,
        0,
        "context-specific cancelled destination motifs should not be exposed"
      );
    },
  },
  {
    name: "motif low-confidence thresholds should be relation-specific",
    run: () => {
      assert.equal(motifLowConfidenceThreshold("determine" as any), 0.82);
      assert.equal(motifLowConfidenceThreshold("constraint" as any), 0.78);
      assert.equal(motifLowConfidenceThreshold("enable" as any), 0.75);

      assert.equal(isMotifLowConfidence(0.79, "determine" as any), true);
      assert.equal(isMotifLowConfidence(0.77, "constraint" as any), true);
      assert.equal(isMotifLowConfidence(0.74, "enable" as any), true);
      assert.equal(isMotifLowConfidence(0.83, "determine" as any), false);
    },
  },
  {
    name: "motif uncertain question should use direct confirmation template",
    run: () => {
      const plan = planMotifQuestion({
        motifs: [
          {
            id: "m_direct",
            motif_id: "m_direct",
            motif_type: "enable",
            motifType: "pair",
            relation: "enable",
            dependencyClass: "enable",
            roles: { sources: ["c_budget"], target: "c_goal" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_budget", "c_goal"],
            conceptIds: ["c_budget", "c_goal"],
            anchorConceptId: "c_goal",
            title: "预算影响目标",
            description: "d",
            confidence: 0.61,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "uncertain",
            causalOperator: "direct_causation",
            novelty: "new",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
        ] as any,
        concepts: [
          {
            id: "c_budget",
            title: "预算上限",
            kind: "constraint",
            family: "budget",
            nodeIds: [],
            sourceMsgIds: [],
            evidenceTerms: ["2000元预算上限"],
          },
          { id: "c_goal", title: "旅行目标", kind: "belief", family: "goal", nodeIds: [], sourceMsgIds: [] },
        ] as any,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      assert.equal(/直接确认/.test(String(plan.question || "")), true);
      assert.equal(/2000|预算/.test(String(plan.question || "")), true);
      assert.equal(/旅行目标/.test(String(plan.question || "")), true);
      assert.equal(/motif_uncertain:/.test(String(plan.rationale)), true);
    },
  },
  {
    name: "non-conflict deprecated motifs should not trigger conflict question",
    run: () => {
      const plan = planMotifQuestion({
        motifs: [
          {
            id: "m_pruned",
            motif_id: "m_pruned",
            motif_type: "constraint",
            motifType: "pair",
            relation: "constraint",
            dependencyClass: "constraint",
            roles: { sources: ["c_pace"], target: "c_goal" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_pace", "c_goal"],
            conceptIds: ["c_pace", "c_goal"],
            anchorConceptId: "c_goal",
            title: "节奏约束旧关系",
            description: "d",
            confidence: 0.82,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "deprecated",
            statusReason: "evidence_stable;objective_pruned",
            causalOperator: "direct_causation",
            novelty: "historical",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
        ] as any,
        concepts: [
          { id: "c_pace", title: "不想太赶", kind: "constraint", family: "constraint", nodeIds: [], sourceMsgIds: [] },
          { id: "c_goal", title: "旅行目标", kind: "belief", family: "goal", nodeIds: [], sourceMsgIds: [] },
        ] as any,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      assert.equal(plan.question, null);
      assert.equal(plan.rationale, "motif_stable");
    },
  },
  {
    name: "true conflict deprecated motifs should still trigger conflict question",
    run: () => {
      const plan = planMotifQuestion({
        motifs: [
          {
            id: "m_conflict",
            motif_id: "m_conflict",
            motif_type: "constraint",
            motifType: "pair",
            relation: "constraint",
            dependencyClass: "constraint",
            roles: { sources: ["c_old"], target: "c_goal" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_old", "c_goal"],
            conceptIds: ["c_old", "c_goal"],
            anchorConceptId: "c_goal",
            title: "旧关系",
            description: "d",
            confidence: 0.85,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "deprecated",
            statusReason: "relation_conflict_with:m_keep",
            causalOperator: "direct_causation",
            novelty: "historical",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
          {
            id: "m_keep",
            motif_id: "m_keep",
            motif_type: "constraint",
            motifType: "pair",
            relation: "constraint",
            dependencyClass: "constraint",
            roles: { sources: ["c_new"], target: "c_goal" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_new", "c_goal"],
            conceptIds: ["c_new", "c_goal"],
            anchorConceptId: "c_goal",
            title: "保留关系",
            description: "d",
            confidence: 0.88,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "active",
            causalOperator: "direct_causation",
            novelty: "new",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
        ] as any,
        concepts: [
          { id: "c_old", title: "旧约束", kind: "constraint", family: "constraint", nodeIds: [], sourceMsgIds: [] },
          { id: "c_new", title: "新约束", kind: "constraint", family: "constraint", nodeIds: [], sourceMsgIds: [] },
          { id: "c_goal", title: "旅行目标", kind: "belief", family: "goal", nodeIds: [], sourceMsgIds: [] },
        ] as any,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      assert.equal(/检测到冲突 motif/.test(String(plan.question || "")), true);
      assert.equal(plan.rationale, "motif_conflict:m_conflict");
    },
  },
  {
    name: "motif uncertain question should use counterfactual template for intervention",
    run: () => {
      const plan = planMotifQuestion({
        motifs: [
          {
            id: "m_cf",
            motif_id: "m_cf",
            motif_type: "determine",
            motifType: "pair",
            relation: "determine",
            dependencyClass: "determine",
            roles: { sources: ["c_city"], target: "c_plan" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_city", "c_plan"],
            conceptIds: ["c_city", "c_plan"],
            anchorConceptId: "c_plan",
            title: "城市决定方案",
            description: "d",
            confidence: 0.58,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "uncertain",
            causalOperator: "intervention",
            novelty: "new",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
        ] as any,
        concepts: [
          {
            id: "c_city",
            title: "目的地城市",
            kind: "belief",
            family: "destination",
            nodeIds: [],
            sourceMsgIds: [],
            evidenceTerms: ["巴黎目的地城市"],
          },
          { id: "c_plan", title: "执行方案", kind: "belief", family: "goal", nodeIds: [], sourceMsgIds: [] },
        ] as any,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      assert.equal(/反事实确认/.test(String(plan.question || "")), true);
      assert.equal(/巴黎|目的地城市/.test(String(plan.question || "")), true);
      assert.equal(/执行方案/.test(String(plan.question || "")), true);
      assert.equal(/counterfactual/.test(String(plan.rationale)), true);
    },
  },
  {
    name: "motif uncertain question should use mediation template for mediated causation",
    run: () => {
      const plan = planMotifQuestion({
        motifs: [
          {
            id: "m_med",
            motif_id: "m_med",
            motif_type: "enable",
            motifType: "triad",
            relation: "enable",
            dependencyClass: "enable",
            roles: { sources: ["c_date", "c_season"], target: "c_cost" },
            scope: "global",
            aliases: [],
            concept_bindings: ["c_date", "c_season", "c_cost"],
            conceptIds: ["c_date", "c_season", "c_cost"],
            anchorConceptId: "c_cost",
            title: "日期通过季节影响成本",
            description: "d",
            confidence: 0.55,
            supportEdgeIds: [],
            supportNodeIds: [],
            status: "uncertain",
            causalOperator: "mediated_causation",
            novelty: "new",
            updatedAt: new Date().toISOString(),
            reuseClass: "reusable",
          },
        ] as any,
        concepts: [
          { id: "c_date", title: "出行日期", kind: "belief", family: "duration_total", nodeIds: [], sourceMsgIds: [] },
          { id: "c_season", title: "季节定价", kind: "factual_assertion", family: "other", nodeIds: [], sourceMsgIds: [] },
          { id: "c_cost", title: "总成本", kind: "constraint", family: "budget", nodeIds: [], sourceMsgIds: [] },
        ] as any,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      assert.equal(/中介链路确认/.test(String(plan.question || "")), true);
      assert.equal(/出行日期/.test(String(plan.question || "")), true);
      assert.equal(/总成本/.test(String(plan.question || "")), true);
      assert.equal(/mediation/.test(String(plan.rationale)), true);
    },
  },
  {
    name: "motif uncertain question should not repeat when asked recently",
    run: () => {
      const motifs = [
        {
          id: "m_repeat",
          motif_id: "m_repeat",
          motif_type: "enable",
          motifType: "pair",
          relation: "enable",
          dependencyClass: "enable",
          roles: { sources: ["c_src"], target: "c_tgt" },
          scope: "global",
          aliases: [],
          concept_bindings: ["c_src", "c_tgt"],
          conceptIds: ["c_src", "c_tgt"],
          anchorConceptId: "c_tgt",
          title: "A影响B",
          description: "d",
          confidence: 0.62,
          supportEdgeIds: [],
          supportNodeIds: [],
          status: "uncertain",
          causalOperator: "direct_causation",
          novelty: "new",
          updatedAt: new Date().toISOString(),
          reuseClass: "reusable",
        },
      ] as any;
      const concepts = [
        { id: "c_src", title: "源概念", kind: "belief", family: "other", nodeIds: [], sourceMsgIds: [] },
        { id: "c_tgt", title: "目标概念", kind: "belief", family: "other", nodeIds: [], sourceMsgIds: [] },
      ] as any;
      const first = planMotifQuestion({
        motifs,
        concepts,
        recentTurns: [],
        locale: "zh-CN" as any,
      });
      const second = planMotifQuestion({
        motifs,
        concepts,
        recentTurns: [{ role: "assistant", content: String(first.question || "") }],
        locale: "zh-CN" as any,
      });
      assert.ok(first.question);
      assert.equal(second.question, null);
      assert.equal(/recently_asked/.test(String(second.rationale)), true);
    },
  },
  {
    name: "activity preference should fall back to destination when sub-location is only weakly related",
    run: () => {
      const nodes = [
        {
          id: "goal",
          type: "belief",
          layer: "intent",
          statement: "意图：制定澳大利亚旅行计划",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.9,
          key: "slot:goal",
        },
        {
          id: "dest",
          type: "factual_assertion",
          statement: "目的地：澳大利亚",
          status: "confirmed",
          confidence: 0.88,
          importance: 0.82,
          key: "slot:destination:australia",
        },
        {
          id: "sub",
          type: "factual_assertion",
          statement: "子地点：邦迪海滩（澳大利亚）",
          status: "confirmed",
          confidence: 0.8,
          importance: 0.7,
          key: "slot:sub_location:australia:bondi_beach",
        },
        {
          id: "act",
          type: "preference",
          statement: "活动偏好：野生动物体验优先",
          status: "confirmed",
          confidence: 0.82,
          importance: 0.74,
          key: "slot:activity_preference",
        },
      ] as any[];
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const edgesById = new Map();
      const touched = new Set(nodes.map((node) => node.id));

      rebalanceIntentTopology(nodesById as any, edgesById as any, touched);

      const activityEdge = Array.from(edgesById.values()).find((edge: any) => edge.from === "act");
      assert.equal(activityEdge?.to, "dest");
    },
  },
  {
    name: "activity preference can still anchor to explicit venue sub-location",
    run: () => {
      const nodes = [
        {
          id: "goal",
          type: "belief",
          layer: "intent",
          statement: "意图：安排米兰观赛旅行",
          status: "confirmed",
          confidence: 0.9,
          importance: 0.9,
          key: "slot:goal",
        },
        {
          id: "dest",
          type: "factual_assertion",
          statement: "目的地：米兰",
          status: "confirmed",
          confidence: 0.88,
          importance: 0.82,
          key: "slot:destination:milan",
        },
        {
          id: "sub",
          type: "factual_assertion",
          statement: "子地点：圣西罗球场（米兰）",
          status: "confirmed",
          confidence: 0.8,
          importance: 0.72,
          key: "slot:sub_location:milan:san_siro",
        },
        {
          id: "act",
          type: "preference",
          statement: "活动偏好：体育赛事优先",
          status: "confirmed",
          confidence: 0.82,
          importance: 0.74,
          key: "slot:activity_preference",
        },
      ] as any[];
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const edgesById = new Map();
      const touched = new Set(nodes.map((node) => node.id));

      rebalanceIntentTopology(nodesById as any, edgesById as any, touched);

      const activityEdge = Array.from(edgesById.values()).find((edge: any) => edge.from === "act");
      assert.equal(activityEdge?.to, "sub");
    },
  },
  {
    name: "manual edge overrides should preserve deletions and type changes across later patches",
    run: () => {
      const prevGraph = {
        id: "g_override",
        version: 1,
        nodes: [
          {
            id: "goal",
            type: "belief",
            layer: "intent",
            statement: "意图：制定澳大利亚旅行计划",
            status: "confirmed",
            confidence: 0.9,
            importance: 0.9,
            key: "slot:goal",
          },
          {
            id: "dest",
            type: "factual_assertion",
            statement: "目的地：澳大利亚",
            status: "confirmed",
            confidence: 0.88,
            importance: 0.82,
            key: "slot:destination:australia",
          },
          {
            id: "sub",
            type: "factual_assertion",
            statement: "子地点：邦迪海滩（澳大利亚）",
            status: "confirmed",
            confidence: 0.8,
            importance: 0.72,
            key: "slot:sub_location:australia:bondi_beach",
          },
          {
            id: "act",
            type: "preference",
            statement: "活动偏好：野生动物体验优先",
            status: "confirmed",
            confidence: 0.82,
            importance: 0.74,
            key: "slot:activity_preference",
          },
        ],
        edges: [
          { id: "e_dest_goal", from: "dest", to: "goal", type: "enable", confidence: 0.8 },
          { id: "e_sub_dest", from: "sub", to: "dest", type: "determine", confidence: 0.74 },
          { id: "e_act_sub", from: "act", to: "sub", type: "determine", confidence: 0.74 },
        ],
      } as any;
      const nextGraph = {
        ...prevGraph,
        edges: [
          { id: "e_dest_goal", from: "dest", to: "goal", type: "enable", confidence: 0.8 },
          { id: "e_sub_dest", from: "sub", to: "dest", type: "determine", confidence: 0.74 },
          { id: "e_act_dest", from: "act", to: "dest", type: "constraint", confidence: 0.74 },
        ],
      } as any;
      const overrides = rebuildManualGraphOverrides({
        prevGraph,
        nextGraph,
        existing: { edges: [] },
        updatedAt: "2026-03-07T00:00:00.000Z",
      });

      const replayedGraph = applyManualGraphOverrides(
        {
          ...prevGraph,
          edges: [
            { id: "e_dest_goal", from: "dest", to: "goal", type: "enable", confidence: 0.8 },
            { id: "e_sub_dest", from: "sub", to: "dest", type: "determine", confidence: 0.74 },
            { id: "e_act_sub_recreated", from: "act", to: "sub", type: "determine", confidence: 0.74 },
            { id: "e_act_dest_wrong_type", from: "act", to: "dest", type: "enable", confidence: 0.7 },
          ],
        } as any,
        overrides
      );

      assert.equal(
        replayedGraph.edges.some((edge: any) => edge.from === "act" && edge.to === "sub"),
        false
      );
      const preserved = replayedGraph.edges.find((edge: any) => edge.from === "act" && edge.to === "dest");
      assert.ok(preserved);
      assert.equal(preserved?.type, "constraint");
      assert.equal(
        overrides.edges.some((edge) => edge.state === "removed" && edge.fromRef.includes("activity_preference")),
        true
      );
    },
  },
];

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
