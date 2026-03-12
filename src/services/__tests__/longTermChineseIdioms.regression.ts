import assert from "node:assert/strict";

import {
  advanceLongTermScenario,
  defaultLongTermScenarioState,
  rebuildLongTermScenarioState,
} from "../longTermPlan/state.js";

function nowIso(step = 0) {
  return new Date(Date.UTC(2026, 2, 3, 0, step, 0)).toISOString();
}

function includesAll(haystack: string[], needles: string[], label: string) {
  for (const needle of needles) {
    assert.ok(haystack.includes(needle), `${label} should include "${needle}", got [${haystack.join(", ")}]`);
  }
}

function excludesAll(haystack: string[], needles: string[], label: string) {
  for (const needle of needles) {
    assert.ok(!haystack.includes(needle), `${label} should not include "${needle}", got [${haystack.join(", ")}]`);
  }
}

async function main() {
  const conversationId = "idiom_regression";
  let scenario = defaultLongTermScenarioState({
    conversationId,
    locale: "zh-CN",
    nowIso: nowIso(0),
  });

  scenario = rebuildLongTermScenarioState({
    previous: scenario,
    conversationId,
    locale: "zh-CN",
    activeSegment: "fitness",
    updatedAt: nowIso(1),
    recentTurns: [
      {
        userText: "我想做健身计划，主要想缓解压力，不然最近工作一忙整个人都很僵。",
        assistantText: "",
      },
      {
        userText: "最近排班飘忽，经常临时被叫去开会，下班后像被抽干一样，还总是三天打鱼两天晒网。",
        assistantText: "",
      },
      {
        userText: "所以最好有空就练十来分钟，徒手或者快走都行，插空做一点也可以。",
        assistantText: "",
      },
    ],
  });

  includesAll(
    scenario.segments.fitness.constraints,
    ["schedule is unstable", "energy is limited", "motivation is unstable"],
    "fitness idiom constraints"
  );
  excludesAll(
    scenario.segments.fitness.constraints,
    ["keep the process low pressure"],
    "fitness stress-relief goal should not become low-pressure constraint"
  );
  includesAll(
    scenario.segments.fitness.adherence_strategy,
    ["start with short, low-friction sessions", "keep sessions flexible", "fit sessions into small time slots"],
    "fitness idiom adherence"
  );

  scenario = advanceLongTermScenario({
    previous: scenario,
    conversationId,
    locale: "zh-CN",
    nowIso: nowIso(2),
  });

  scenario = rebuildLongTermScenarioState({
    previous: scenario,
    conversationId,
    locale: "zh-CN",
    activeSegment: "study",
    updatedAt: nowIso(3),
    recentTurns: [
      {
        userText: "学习这边我想补一点 AI 和数据素养，最好跟工作相关。",
        assistantText: "",
      },
      {
        userText: "但别搞得像第二份工作，我希望通勤听播客也算，有空再看案例，一想到开始就犯懒。",
        assistantText: "",
      },
    ],
  });

  includesAll(
    scenario.segments.study.constraints,
    ["keep the process low pressure", "motivation is unstable"],
    "study idiom constraints"
  );
  includesAll(
    scenario.segments.study.methods_or_activities,
    ["audio learning"],
    "study idiom methods"
  );
  includesAll(
    scenario.segments.study.adherence_strategy,
    ["keep sessions flexible", "fit sessions into small time slots"],
    "study idiom adherence"
  );
  includesAll(
    scenario.segments.study.fallback_plan,
    ["use a tiny starter task to reduce resistance"],
    "study idiom fallback"
  );

  let chatbotLikeScenario = defaultLongTermScenarioState({
    conversationId: `${conversationId}_chatbot_like`,
    locale: "zh-CN",
    nowIso: nowIso(10),
  });

  chatbotLikeScenario = rebuildLongTermScenarioState({
    previous: chatbotLikeScenario,
    conversationId: `${conversationId}_chatbot_like`,
    locale: "zh-CN",
    activeSegment: "fitness",
    updatedAt: nowIso(11),
    recentTurns: [
      {
        userText: "我想做个健身计划，但时间被切得很碎，工作日程也不稳定。",
        assistantText: "",
      },
      {
        userText: "最好有空就练十来分钟，不然我很容易往后拖。",
        assistantText: "",
      },
    ],
  });

  includesAll(
    chatbotLikeScenario.segments.fitness.constraints,
    ["time becomes more limited", "schedule is unstable", "motivation is unstable"],
    "chatbot-like fitness constraints"
  );
  includesAll(
    chatbotLikeScenario.segments.fitness.adherence_strategy,
    ["start with short, low-friction sessions", "keep sessions flexible"],
    "chatbot-like fitness adherence"
  );

  console.log("longTermChineseIdioms.regression: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
