import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppLocale } from "../../i18n/locale.js";
import {
  advanceLongTermScenario,
  canAdvanceLongTermScenario,
  defaultLongTermScenarioState,
  rebuildLongTermScenarioState,
  type LongTermScenarioState,
} from "../longTermPlan/state.js";

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
  fitness: {
    turns: FixtureTurn[];
  };
  study: {
    turns: FixtureTurn[];
  };
  expected: {
    fitnessConstraints: string[];
    studyConstraints: string[];
    studyMethods: string[];
  };
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = path.join(REPO_ROOT, "user-study", "scenario-b");
const FIXTURE_NAMES = ["li_wei.bundled.json", "mei_lin.bundled.json", "daniel_chen.bundled.json"];

async function loadFixtures(): Promise<Fixture[]> {
  const fixtures = await Promise.all(
    FIXTURE_NAMES.map(async (name) => {
      const raw = await fs.readFile(path.join(FIXTURE_DIR, name), "utf8");
      return JSON.parse(raw) as Fixture;
    })
  );
  assert.equal(fixtures.length, 3);
  for (const fixture of fixtures) {
    assert.equal(fixture.fitness.turns.length, 8, `${fixture.id} fitness should have 8 user-assistant pairs`);
    assert.equal(fixture.study.turns.length, 8, `${fixture.id} study should have 8 user-assistant pairs`);
  }
  return fixtures;
}

function isoFor(step: number) {
  return new Date(Date.UTC(2026, 2, 1, 0, step, 0)).toISOString();
}

function includesAll(haystack: string[], needles: string[], label: string) {
  for (const needle of needles) {
    assert.ok(
      haystack.includes(needle),
      `${label} should include "${needle}", got [${haystack.join(", ")}]`
    );
  }
}

function runSegment(params: {
  scenario: LongTermScenarioState;
  conversationId: string;
  locale: AppLocale;
  segment: "fitness" | "study";
  turns: FixtureTurn[];
}): LongTermScenarioState {
  const recentTurns: FixtureTurn[] = [];
  let scenario = params.scenario;
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
  }
  return scenario;
}

async function main() {
  const fixtures = await loadFixtures();

  for (const fixture of fixtures) {
    let scenario = defaultLongTermScenarioState({
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(0),
    });
    assert.equal(canAdvanceLongTermScenario(scenario), false, `${fixture.id} should not advance before Task 3 has content`);

    scenario = runSegment({
      scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      segment: "fitness",
      turns: fixture.fitness.turns,
    });

    assert.equal(scenario.active_segment, "fitness", `${fixture.id} should stay in fitness before advancing`);
    assert.equal(scenario.bundle_status, "active");
    assert.equal(scenario.segments.fitness.status, "active");
    assert.equal(canAdvanceLongTermScenario(scenario), true, `${fixture.id} fitness should become advanceable after progress`);
    assert.ok(scenario.segments.fitness.export_ready_text.length > 20, `${fixture.id} fitness export text should be populated`);
    includesAll(scenario.segments.fitness.constraints, fixture.expected.fitnessConstraints, `${fixture.id} fitness constraints`);
    const fitnessTaskId = scenario.segments.fitness.task_id;
    const fitnessExportText = scenario.segments.fitness.export_ready_text;

    scenario = advanceLongTermScenario({
      previous: scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(99),
    });

    assert.equal(scenario.active_segment, "study", `${fixture.id} should advance to study`);
    assert.equal(scenario.segments.fitness.status, "completed");
    assert.equal(scenario.segments.study.status, "active");
    assert.equal(canAdvanceLongTermScenario(scenario), false, `${fixture.id} should not complete before Task 4 has content`);
    assert.equal(scenario.transfer_source_task_id, fitnessTaskId);
    assert.equal(scenario.transfer_source_conversation_id, fixture.id);

    scenario = runSegment({
      scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      segment: "study",
      turns: fixture.study.turns,
    });

    assert.equal(
      scenario.segments.fitness.export_ready_text,
      fitnessExportText,
      `${fixture.id} fitness segment should not be overwritten by study turns`
    );
    assert.ok(scenario.segments.study.export_ready_text.length > 20, `${fixture.id} study export text should be populated`);
    includesAll(scenario.segments.study.constraints, fixture.expected.studyConstraints, `${fixture.id} study constraints`);
    includesAll(scenario.segments.study.methods_or_activities, fixture.expected.studyMethods, `${fixture.id} study methods`);
    assert.equal(canAdvanceLongTermScenario(scenario), true, `${fixture.id} study should become completable after progress`);
    assert.ok(
      scenario.combined_export_ready_text.includes("Task 3") && scenario.combined_export_ready_text.includes("Task 4"),
      `${fixture.id} combined export text should include both task labels`
    );

    scenario = advanceLongTermScenario({
      previous: scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(199),
    });

    assert.equal(scenario.bundle_status, "completed", `${fixture.id} should complete the bundle`);
    assert.equal(scenario.segments.study.status, "completed");
    assert.equal(canAdvanceLongTermScenario(scenario), false, `${fixture.id} completed bundle should not advance again`);
  }

  console.log("longTermScenario.regression: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
