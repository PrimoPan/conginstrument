import assert from "node:assert/strict";

import {
  extractIntentSignals,
  extractIntentSignalsWithRecency,
} from "../intentSignals.js";
import { analyzeConstraintConflicts } from "../conflictAnalyzer.js";

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
    name: "duration should stay 3 days when later sentence has no new duration",
    run: () => {
      const merged = extractIntentSignalsWithRecency(
        "我想去米兰玩3天，和父母一起，预算10000元",
        "机票已经买了，不需要考虑机票钱"
      );
      assert.equal(merged.durationDays, 3);
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
