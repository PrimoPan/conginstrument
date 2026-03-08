import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyPatchWithGuards } from "../../core/graph/patchApply.js";
import type { CDG } from "../../core/graph.js";
import type { AppLocale } from "../../i18n/locale.js";
import { applyManualGraphOverrides, type ManualGraphOverrides } from "../../routes/conversations.js";
import { normalizeConversationModel } from "../../server/conversationModel.js";
import { buildCognitiveModel, type CognitiveModel } from "../cognitiveModel.js";
import { generateGraphPatch } from "../graphUpdater.js";
import { buildPortfolioDocumentState, detectTaskSwitchFromLatestUserTurn } from "../planningState.js";
import { buildTravelPlanState, type TravelPlanState } from "../travelPlan/state.js";

type FixtureTask = {
  taskLabel: string;
  destinations: string[];
  forbiddenDestinations?: string[];
  turns: string[];
};

type DialogueFixture = {
  id: string;
  title: string;
  category: "domestic_international" | "domestic_domestic" | "international_international";
  locale: AppLocale;
  model: string;
  expectedSharedMotifMin?: number;
  firstTask: FixtureTask;
  secondTask: FixtureTask;
  fileName: string;
};

type TaskRunResult = {
  graph: CDG;
  model: CognitiveModel;
  plan: TravelPlanState;
};

type ScenarioReport = {
  fixture: string;
  category: string;
  locale: AppLocale;
  model: string;
  firstTaskTurns: number;
  secondTaskTurns: number;
  sharedMotifSignatures: string[];
  finalPlanDestinations: string[];
  finalGraphDestinations: string[];
  portfolioTrips: number;
  warnings: string[];
};

const ASSISTANT_ACK = "收到，我按这个方向继续。";
const ROOT_DIR = fileURLToPath(new URL("../../../../../", import.meta.url));
const REPORT_PATH = path.join(ROOT_DIR, "local_mock_dialogue_regression_report.latest.json");
const FIXTURE_PATTERN = /^mock_dialogue_(domestic|international)_[^.]+\.json$/;

function emptyOverrides(): ManualGraphOverrides {
  return { edges: [], nodes: [] };
}

function makeEmptyGraph(conversationId: string): CDG {
  return {
    id: conversationId,
    version: 0,
    nodes: [],
    edges: [],
  };
}

function motifStructureSignatures(model: CognitiveModel): string[] {
  const conceptById = new Map((model.concepts || []).map((concept) => [concept.id, concept]));
  const conceptToken = (conceptId: string): string => {
    const concept = conceptById.get(conceptId);
    if (!concept) return "other";
    const semanticKey = String(concept.semanticKey || "").trim();
    if (semanticKey.startsWith("slot:constraint:limiting:")) return semanticKey;
    return String(concept.family || "").trim() || semanticKey || "other";
  };
  return Array.from(
    new Set(
      (model.motifs || [])
        .map((motif) => {
          const relation = String(motif.dependencyClass || motif.relation || "").trim() || "other";
          const target = conceptToken(String(motif.anchorConceptId || "").trim());
          const sources = Array.from(
            new Set(
              ((motif.roles?.sources || []).length
                ? motif.roles!.sources
                : (motif.conceptIds || []).filter((id) => id !== motif.anchorConceptId)
              )
                .map((id) => conceptToken(String(id || "").trim()))
                .filter(Boolean)
                .sort()
            )
          ).join("+");
          return `${motif.motifType || "pair"}|${relation}|${sources || "none"}->${target}`;
        })
        .filter(Boolean)
    )
  );
}

function sharedMotifSignatures(left: CognitiveModel, right: CognitiveModel): string[] {
  const rightSet = new Set(motifStructureSignatures(right));
  return motifStructureSignatures(left).filter((id) => rightSet.has(id));
}

function hasDestination(graph: CDG, destination: string): boolean {
  const needle = String(destination || "").toLowerCase();
  return (graph.nodes || []).some((item) => {
    if (!String(item.key || "").startsWith("slot:destination:")) return false;
    const statement = String(item.statement || "").toLowerCase();
    const key = String(item.key || "").toLowerCase();
    return statement.includes(needle) || key.endsWith(`:${needle}`);
  });
}

function planHasDestination(plan: TravelPlanState, destination: string): boolean {
  const needle = String(destination || "").toLowerCase();
  return (plan.destination_scope || []).some((item) => String(item || "").toLowerCase().includes(needle));
}

function readPlanDestinations(plan: TravelPlanState): string[] {
  return Array.from(new Set((plan.destination_scope || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function readGraphDestinations(graph: CDG): string[] {
  return Array.from(
    new Set(
      (graph.nodes || [])
        .filter((node) => String(node.key || "").startsWith("slot:destination:"))
        .map((node) => String(node.statement || node.key || "").trim())
        .filter(Boolean)
    )
  );
}

async function loadFixtures(): Promise<DialogueFixture[]> {
  const names = (await fs.readdir(ROOT_DIR))
    .filter((name) => FIXTURE_PATTERN.test(name))
    .sort();
  assert.ok(names.length >= 6, `expected at least 6 fixture files in root, got ${names.length}`);
  const out = await Promise.all(
    names.map(async (name) => {
      const raw = await fs.readFile(path.join(ROOT_DIR, name), "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...parsed,
        fileName: name,
      } as DialogueFixture;
    })
  );
  for (const fixture of out) {
    assert.equal(normalizeConversationModel(fixture.model), "gpt-5.1", `${fixture.fileName} should use gpt-5.1`);
    assert.equal(fixture.firstTask.turns.length, 10, `${fixture.fileName} firstTask should have 10 turns`);
    assert.equal(fixture.secondTask.turns.length, 10, `${fixture.fileName} secondTask should have 10 turns`);
  }
  return out;
}

async function runTask(params: {
  conversationId: string;
  locale: AppLocale;
  task: FixtureTask;
  previousPlan: TravelPlanState | null;
  expectTaskSwitch: boolean;
}): Promise<TaskRunResult> {
  let graph: CDG = makeEmptyGraph(params.conversationId);
  let model = buildCognitiveModel({
    graph,
    baseConcepts: [],
    baseMotifs: [],
    baseMotifLinks: [],
    baseContexts: [],
    locale: params.locale,
  });
  let plan = params.previousPlan;
  const manualGraphOverrides = emptyOverrides();
  const recentTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
  const taskTurns: Array<{ createdAt: string; userText: string; assistantText: string }> = [];
  const taskUserTexts: string[] = [];

  for (const [index, userText] of params.task.turns.entries()) {
    const turnNumber = index + 1;
    const detection = detectTaskSwitchFromLatestUserTurn({
      conversationId: params.conversationId,
      locale: params.locale,
      previousTravelPlan: plan,
      latestUserText: userText,
    });
    if (turnNumber === 1) {
      assert.equal(
        detection.is_task_switch,
        params.expectTaskSwitch,
        `${params.task.taskLabel} turn 1 task-switch expectation mismatch`
      );
    } else {
      assert.equal(detection.is_task_switch, false, `${params.task.taskLabel} turn ${turnNumber} should stay in same task`);
    }

    const patch = await generateGraphPatch({
      graph,
      userText,
      recentTurns,
      stateContextUserTurns: [...taskUserTexts, userText],
      assistantText: ASSISTANT_ACK,
      locale: params.locale,
    });
    const merged = applyPatchWithGuards(graph, patch);
    graph = applyManualGraphOverrides(merged.newGraph, manualGraphOverrides);
    model = buildCognitiveModel({
      graph,
      prevConcepts: model.concepts,
      baseConcepts: model.concepts,
      baseMotifs: model.motifs,
      baseMotifLinks: model.motifLinks,
      baseContexts: model.contexts,
      locale: params.locale,
    });

    taskTurns.push({
      createdAt: new Date(Date.UTC(2026, 2, turnNumber, 10, 0, 0)).toISOString(),
      userText,
      assistantText: ASSISTANT_ACK,
    });
    const previousPlan = turnNumber === 1 ? params.previousPlan : plan;
    plan = buildTravelPlanState({
      locale: params.locale,
      graph: model.graph,
      turns: taskTurns,
      concepts: model.concepts,
      motifs: model.motifs,
      taskId: params.conversationId,
      previous: previousPlan,
      forceTaskSwitch: params.expectTaskSwitch && turnNumber === 1,
    });
    recentTurns.push({ role: "user", content: userText }, { role: "assistant", content: ASSISTANT_ACK });
    taskUserTexts.push(userText);
    graph = model.graph;
  }

  assert.ok(plan, `${params.task.taskLabel} should produce a plan`);
  return {
    graph,
    model,
    plan: plan!,
  };
}

async function runFixture(fixture: DialogueFixture): Promise<ScenarioReport> {
  const conversationId = `fixture_${fixture.id}`;
  const firstTask = await runTask({
    conversationId,
    locale: fixture.locale,
    task: fixture.firstTask,
    previousPlan: null,
    expectTaskSwitch: false,
  });
  const secondTask = await runTask({
    conversationId,
    locale: fixture.locale,
    task: fixture.secondTask,
    previousPlan: firstTask.plan,
    expectTaskSwitch: true,
  });
  const portfolio = buildPortfolioDocumentState({
    userId: "user_mock_dialogue_fixture",
    locale: fixture.locale,
    conversations: [
      {
        conversationId,
        title: fixture.title,
        travelPlanState: secondTask.plan,
        updatedAt: new Date("2026-03-08T12:00:00.000Z"),
      },
    ],
  });

  for (const destination of fixture.firstTask.destinations || []) {
    assert.ok(hasDestination(firstTask.graph, destination), `${fixture.fileName} first task missing destination ${destination}`);
  }
  for (const destination of fixture.secondTask.destinations || []) {
    assert.ok(hasDestination(secondTask.graph, destination), `${fixture.fileName} second task missing destination ${destination}`);
    assert.ok(planHasDestination(secondTask.plan, destination), `${fixture.fileName} plan missing second destination ${destination}`);
  }
  for (const forbidden of fixture.secondTask.forbiddenDestinations || []) {
    assert.equal(hasDestination(secondTask.graph, forbidden), false, `${fixture.fileName} leaked forbidden destination ${forbidden}`);
    assert.equal(planHasDestination(secondTask.plan, forbidden), false, `${fixture.fileName} plan leaked forbidden destination ${forbidden}`);
  }
  assert.ok(
    (secondTask.plan.task_history || []).some((item) => item.task_id === firstTask.plan.task_id),
    `${fixture.fileName} should keep first task in task_history`
  );
  assert.ok(portfolio.trips.length >= 2, `${fixture.fileName} should yield at least 2 portfolio trips`);

  const warnings: string[] = [];
  const shared = sharedMotifSignatures(firstTask.model, secondTask.model);
  if (shared.length < Number(fixture.expectedSharedMotifMin || 0)) {
    warnings.push(
      `shared motif count below expectation: expected >= ${fixture.expectedSharedMotifMin}, got ${shared.length}`
    );
  }

  return {
    fixture: fixture.fileName,
    category: fixture.category,
    locale: fixture.locale,
    model: normalizeConversationModel(fixture.model),
    firstTaskTurns: fixture.firstTask.turns.length,
    secondTaskTurns: fixture.secondTask.turns.length,
    sharedMotifSignatures: shared,
    finalPlanDestinations: readPlanDestinations(secondTask.plan),
    finalGraphDestinations: readGraphDestinations(secondTask.graph),
    portfolioTrips: portfolio.trips.length,
    warnings,
  };
}

async function main() {
  const fixtures = await loadFixtures();
  const reports: ScenarioReport[] = [];
  for (const fixture of fixtures) {
    const report = await runFixture(fixture);
    reports.push(report);
    console.log(`PASS ${fixture.fileName}`);
    if (report.warnings.length) {
      for (const warning of report.warnings) {
        console.log(`WARN ${fixture.fileName}: ${warning}`);
      }
    }
  }

  await fs.writeFile(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        reportCount: reports.length,
        reports,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`Saved local regression report to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
