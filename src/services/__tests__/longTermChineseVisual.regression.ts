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
      recentTurns,
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
