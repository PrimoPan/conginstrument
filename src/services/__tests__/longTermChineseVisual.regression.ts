import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppLocale } from "../../i18n/locale.js";
import {
  advanceLongTermScenario,
  defaultLongTermScenarioState,
  rebuildLongTermScenarioState,
  type LongTermScenarioState,
} from "../longTermPlan/state.js";
import { buildLongTermVisualConversationModel } from "../longTermPlan/visualModel.js";

type FixtureTurn = {
  userText: string;
  assistantText: string;
};

type Fixture = {
  id: string;
  locale: AppLocale;
  persona: {
    name: string;
    age: number;
    occupation: string;
    profile: string;
  };
  fitness: { turns: FixtureTurn[] };
  study: { turns: FixtureTurn[] };
  expected: {
    fitnessConstraints: string[];
    studyConstraints: string[];
    studyMethods: string[];
  };
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = path.join(REPO_ROOT, "user-study", "scenario-b");
const FIXTURE_NAMES = [
  "zh_li_wei.bundled.json",
  "zh_mei_lin.bundled.json",
  "zh_daniel_chen.bundled.json",
];

function clean(input: unknown, max = 240) {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isoFor(step: number) {
  return new Date(Date.UTC(2026, 2, 2, 0, step, 0)).toISOString();
}

async function loadFixtures(): Promise<Fixture[]> {
  return Promise.all(
    FIXTURE_NAMES.map(async (name) => {
      const raw = await fs.readFile(path.join(FIXTURE_DIR, name), "utf8");
      return JSON.parse(raw) as Fixture;
    })
  );
}

function includesAll(haystack: string[], needles: string[], label: string) {
  for (const needle of needles) {
    assert.ok(haystack.includes(needle), `${label} should include "${needle}", got [${haystack.join(", ")}]`);
  }
}

function runSegment(params: {
  scenario: LongTermScenarioState;
  conversationId: string;
  locale: AppLocale;
  segment: "fitness" | "study";
  turns: FixtureTurn[];
}) {
  const recentTurns: FixtureTurn[] = [];
  let scenario = params.scenario;
  let previousGraph = null as any;
  let model = buildLongTermVisualConversationModel({
    scenario,
    locale: params.locale,
    previousGraph,
    prevConcepts: [],
    baseConcepts: [],
    prevMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
  });
  for (const [index, turn] of params.turns.entries()) {
    recentTurns.push(turn);
    scenario = rebuildLongTermScenarioState({
      previous: scenario,
      conversationId: params.conversationId,
      locale: params.locale,
      activeSegment: params.segment,
      recentTurns: recentTurns.map((item, turnIndex) => ({
        turnId: `${params.segment}_turn_${turnIndex + 1}`,
        userText: item.userText,
        assistantText: item.assistantText,
      })),
      updatedAt: isoFor(index + (params.segment === "study" ? 100 : 0)),
    });
    model = buildLongTermVisualConversationModel({
      scenario,
      locale: params.locale,
      previousGraph,
      prevConcepts: [],
      baseConcepts: [],
      prevMotifs: [],
      baseMotifLinks: [],
      baseContexts: [],
    });
    previousGraph = model.graph;
  }
  return { scenario, previousGraph, model };
}

async function main() {
  const fixtures = await loadFixtures();
  assert.equal(fixtures.length, 3);

  const prefilledScenario = defaultLongTermScenarioState({
    conversationId: "prefilled-task-3",
    locale: "zh-CN",
    nowIso: isoFor(0),
  });
  prefilledScenario.segments.fitness.goal_summary = "你好 我要规划一个柔韧性的三个月的训练";
  prefilledScenario.segments.fitness.weekly_time_or_frequency = "每周2-3次，每次15-30分钟";
  prefilledScenario.segments.fitness.last_updated = isoFor(1);
  const coldStartModel = buildLongTermVisualConversationModel({
    scenario: prefilledScenario,
    locale: "zh-CN",
    previousGraph: null,
    prevConcepts: [],
    baseConcepts: [],
    prevMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
    allowSyntheticGraphFromScenario: false,
  });
  assert.equal(coldStartModel.graph.nodes.length, 0, "Task 3 should stay empty before its first dialogue turn");
  assert.equal(coldStartModel.concepts.length, 0, "Task 3 should not project concepts before dialogue evidence exists");

  const firstTurnScenario = rebuildLongTermScenarioState({
    previous: prefilledScenario,
    conversationId: "prefilled-task-3",
    locale: "zh-CN",
    activeSegment: "fitness",
    recentTurns: [
      {
        turnId: "prefilled_turn_1",
        userText: "你好 我要规划一个柔韧性的三个月的训练",
        assistantText: "好的，我们先把目标、频率和可坚持性梳理清楚。",
      },
    ],
    updatedAt: isoFor(2),
  });
  const staleSystemGraph = {
    id: "prefilled-task-3",
    version: 4,
    nodes: [
      {
        id: "legacy_stage",
        key: "legacy:stage",
        statement: "当前阶段：Task 3 健身计划",
        type: "belief",
        layer: "intent",
        status: "confirmed",
        confidence: 0.9,
        importance: 0.8,
      } as any,
      {
        id: "legacy_bridge",
        key: "legacy:bundle_bridge",
        statement: "长期个人计划：Task 3 健身计划 -> Task 4 学习计划",
        type: "belief",
        layer: "intent",
        status: "confirmed",
        confidence: 0.9,
        importance: 0.8,
      } as any,
    ],
    edges: [],
  };
  const recoveredModel = buildLongTermVisualConversationModel({
    scenario: firstTurnScenario,
    locale: "zh-CN",
    previousGraph: staleSystemGraph,
    prevConcepts: [],
    baseConcepts: [],
    prevMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
  });
  assert.equal(
    recoveredModel.graph.nodes.some((node) => /^当前阶段[:：]/u.test(clean(node.statement))),
    false,
    "legacy current-stage nodes should not carry forward into Task 3"
  );
  assert.equal(
    recoveredModel.graph.nodes.some((node) => /^长期个人计划[:：]/u.test(clean(node.statement))),
    false,
    "legacy task-bridge nodes should not carry forward into Task 3"
  );
  assert.equal(
    recoveredModel.graph.nodes.some((node) => clean((node as any).key) === "lt:fitness:cadence"),
    false,
    "assistant cadence suggestions should not create a cadence node"
  );
  assert.ok(
    (recoveredModel.concepts || []).every((concept) => (concept.sourceMsgIds || []).length > 0),
    "all long-term concepts should keep user source ids"
  );

  for (const fixture of fixtures) {
    let scenario = defaultLongTermScenarioState({
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(0),
    });

    const fitnessResult = runSegment({
      scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      segment: "fitness",
      turns: fixture.fitness.turns,
    });
    scenario = fitnessResult.scenario;
    includesAll(
      scenario.segments.fitness.constraints,
      fixture.expected.fitnessConstraints,
      `${fixture.id} fitness constraints`
    );
    const fitnessModel = fitnessResult.model;
    assert.ok(fitnessModel.graph.nodes.length >= 5, `${fixture.id} fitness graph should have multiple nodes`);
    assert.ok(fitnessModel.concepts.length > 0, `${fixture.id} fitness concepts should not be empty`);
    assert.ok(fitnessModel.motifs.length > 0, `${fixture.id} fitness motifs should not be empty`);
    assert.ok(
      fitnessModel.concepts.every((concept) => (concept.sourceMsgIds || []).length > 0),
      `${fixture.id} fitness concepts should all stay user-grounded`
    );
    const fitnessGoalNode = fitnessModel.graph.nodes.find((node) => clean((node as any).key) === "lt:goal:fitness");
    assert.ok(fitnessGoalNode, `${fixture.id} should include a fitness goal node`);
    assert.ok(
      !/排班|临时开会|被抽干|第二份工作/u.test(clean(fitnessGoalNode?.statement)),
      `${fixture.id} fitness goal node should stay concise and avoid constraint leakage`
    );
    assert.ok(
      fitnessModel.graph.nodes.some((node) => clean(node.statement).includes("当前约束")),
      `${fixture.id} fitness graph should include localized constraint statements`
    );
    assert.ok(
      (fitnessModel.graph.nodes || []).every((node) => !/^slot:destination/.test(clean((node as any).key))),
      `${fixture.id} fitness graph should not leak travel destination keys`
    );
    assert.ok(
      fitnessModel.graph.edges.some((edge) => edge.type === "constraint"),
      `${fixture.id} fitness graph should contain constraint edges`
    );
    assert.ok(
      fitnessModel.graph.edges.some((edge) => edge.type === "enable"),
      `${fixture.id} fitness graph should contain enable edges`
    );

    scenario = advanceLongTermScenario({
      previous: scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(99),
    });
    const blankStudyModel = buildLongTermVisualConversationModel({
      scenario,
      locale: fixture.locale,
      previousGraph: fitnessModel.graph,
      prevConcepts: fitnessModel.concepts,
      baseConcepts: fitnessModel.concepts,
      prevMotifs: fitnessModel.motifs,
      baseMotifLinks: fitnessModel.motifLinks,
      baseContexts: fitnessModel.contexts,
    });
    assert.equal(blankStudyModel.graph.nodes.length, 0, `${fixture.id} Task 4 should start with an empty graph`);
    assert.equal(blankStudyModel.concepts.length, 0, `${fixture.id} Task 4 should start with no carried concepts`);

    const studyResult = runSegment({
      scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      segment: "study",
      turns: fixture.study.turns,
    });
    scenario = studyResult.scenario;
    includesAll(
      scenario.segments.study.constraints,
      fixture.expected.studyConstraints,
      `${fixture.id} study constraints`
    );
    includesAll(
      scenario.segments.study.methods_or_activities,
      fixture.expected.studyMethods,
      `${fixture.id} study methods`
    );

    const studyModel = studyResult.model;
    assert.ok(
      studyModel.graph.nodes.length >= 4,
      `${fixture.id} study graph should rebuild around the current task`
    );
    assert.ok(
      studyModel.concepts.every((concept) => (concept.sourceMsgIds || []).length > 0),
      `${fixture.id} study concepts should all stay user-grounded`
    );
    const studyGoalNode = studyModel.graph.nodes.find((node) => clean((node as any).key) === "lt:goal:study");
    assert.ok(studyGoalNode, `${fixture.id} should include a study goal node`);
    assert.ok(
      !/第二份工作|拖延|犯懒|排班/u.test(clean(studyGoalNode?.statement)),
      `${fixture.id} study goal node should stay concise and avoid constraint leakage`
    );
    assert.ok(
      studyModel.graph.nodes.every((node) => {
        const key = clean((node as any).key);
        return !key.startsWith("lt:goal:fitness") && !key.startsWith("lt:stage:");
      }),
      `${fixture.id} study graph should not keep Task 3 or stage-label nodes`
    );
    assert.ok(
      studyModel.graph.nodes.every((node) => !/^slot:(destination|budget|lodging|duration)/.test(clean((node as any).key))),
      `${fixture.id} study graph should remain isolated from travel slot keys`
    );
  }

  console.log("longTermChineseVisual.regression: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
