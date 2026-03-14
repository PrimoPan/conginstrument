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

type StageReport = {
  stage: "fitness" | "study";
  conceptCount: number;
  motifCount: number;
  nodeCount: number;
  edgeCount: number;
  goalSummary: string;
  weeklyTimeOrFrequency: string;
  constraints: string[];
  methods: string[];
  adjustments: string[];
  strategies: string[];
  fallbacks: string[];
  openQuestions: string[];
  transferStatements: string[];
  conceptStatements: string[];
  motifSignatures: string[];
  warnings: string[];
};

type FixtureReport = {
  id: string;
  locale: AppLocale;
  persona: Fixture["persona"];
  fitness: StageReport;
  study: StageReport;
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = path.join(REPO_ROOT, "user-study", "scenario-b");
const REPORT_PATH = path.join(REPO_ROOT, "local_long_term_mock_regression_report.latest.json");
const FIXTURE_NAMES = [
  "li_wei.bundled.json",
  "mei_lin.bundled.json",
  "daniel_chen.bundled.json",
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

function uniq(values: string[], limit = 24) {
  return Array.from(new Set(values.map((item) => clean(item)).filter(Boolean))).slice(0, limit);
}

function motifSignature(motif: any, conceptById: Map<string, any>) {
  const anchor = clean(
    conceptById.get(String(motif.anchorConceptId || ""))?.statement ||
      conceptById.get(String(motif.anchorConceptId || ""))?.title ||
      motif.anchorConceptId,
    120
  );
  const sources = uniq(
    ((motif.roles?.sources || []).length
      ? motif.roles.sources
      : (motif.conceptIds || []).filter((id: string) => String(id) !== String(motif.anchorConceptId || "")))
      .map((id: string) => {
        const concept = conceptById.get(String(id || ""));
        return clean(concept?.statement || concept?.title || id, 100);
      })
      .filter(Boolean),
    4
  );
  const relation = clean(motif.dependencyClass || motif.relation || motif.motifType || "related", 40);
  return `${relation}: ${sources.join(" + ") || "none"} -> ${anchor || "unknown"}`;
}

async function loadFixtures(): Promise<Fixture[]> {
  return Promise.all(
    FIXTURE_NAMES.map(async (name) => {
      const raw = await fs.readFile(path.join(FIXTURE_DIR, name), "utf8");
      const parsed = JSON.parse(raw) as Fixture;
      return parsed;
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
  previousGraph?: any;
  prevConcepts?: any[];
  prevMotifs?: any[];
  prevMotifLinks?: any[];
  prevContexts?: any[];
}) {
  const recentTurns: FixtureTurn[] = [];
  let scenario = params.scenario;
  let previousGraph = params.previousGraph || null;
  let model = buildLongTermVisualConversationModel({
    scenario,
    locale: params.locale,
    previousGraph,
    prevConcepts: params.prevConcepts || [],
    baseConcepts: params.prevConcepts || [],
    prevMotifs: params.prevMotifs || [],
    baseMotifLinks: params.prevMotifLinks || [],
    baseContexts: params.prevContexts || [],
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
      prevConcepts: params.prevConcepts || [],
      baseConcepts: params.prevConcepts || [],
      prevMotifs: params.prevMotifs || [],
      baseMotifLinks: params.prevMotifLinks || [],
      baseContexts: params.prevContexts || [],
    });
    previousGraph = model.graph;
  }
  return { scenario, model };
}

function buildStageReport(params: {
  stage: "fitness" | "study";
  scenario: LongTermScenarioState;
  model: ReturnType<typeof buildLongTermVisualConversationModel>;
  expectedConstraints: string[];
  expectedMethods?: string[];
}) {
  const task = params.scenario.segments[params.stage];
  const conceptById = new Map((params.model.concepts || []).map((concept) => [String(concept.id || ""), concept]));
  const warnings: string[] = [];
  const transferStatements = uniq(
    (params.model.graph.nodes || [])
      .filter((node) => String((node as any).key || "").startsWith("lt:study:transfer:"))
      .map((node) => clean(node.statement, 160)),
    12
  );

  for (const constraint of params.expectedConstraints || []) {
    if (!(task.constraints || []).includes(constraint)) {
      warnings.push(`missing expected constraint: ${constraint}`);
    }
  }
  for (const method of params.expectedMethods || []) {
    if (!(task.methods_or_activities || []).includes(method)) {
      warnings.push(`missing expected method: ${method}`);
    }
  }
  if ((params.model.concepts || []).length < 5) warnings.push("concept count is lower than expected");
  if ((params.model.motifs || []).length < 2) warnings.push("motif count is lower than expected");
  if ((params.model.graph.edges || []).every((edge) => edge.type !== "constraint")) {
    warnings.push("graph is missing constraint edges");
  }
  if ((params.model.graph.nodes || []).some((node) => /^slot:(destination|duration|budget|lodging|people)/.test(clean((node as any).key)))) {
    warnings.push("travel slot leakage detected");
  }
  if (params.stage === "study" && (params.model.graph.nodes || []).some((node) => clean((node as any).key).startsWith("lt:goal:fitness"))) {
    warnings.push("study stage still includes carried fitness nodes");
  }
  if ((params.model.graph.nodes || []).some((node) => clean((node as any).key).startsWith("lt:stage:"))) {
    warnings.push("stage label nodes are still present");
  }

  return {
    stage: params.stage,
    conceptCount: (params.model.concepts || []).length,
    motifCount: (params.model.motifs || []).length,
    nodeCount: (params.model.graph.nodes || []).length,
    edgeCount: (params.model.graph.edges || []).length,
    goalSummary: clean(task.goal_summary, 200),
    weeklyTimeOrFrequency: clean(task.weekly_time_or_frequency, 160),
    constraints: uniq(task.constraints || [], 12),
    methods: uniq(task.methods_or_activities || [], 12),
    adjustments: uniq(task.diet_sleep_adjustments || [], 12),
    strategies: uniq(task.adherence_strategy || [], 12),
    fallbacks: uniq(task.fallback_plan || [], 12),
    openQuestions: uniq(task.open_questions || [], 12),
    transferStatements,
    conceptStatements: uniq(
      (params.model.concepts || []).map((concept) => clean(concept.statement || concept.title, 140)),
      16
    ),
    motifSignatures: uniq(
      (params.model.motifs || []).map((motif) => motifSignature(motif, conceptById)),
      16
    ),
    warnings,
  } satisfies StageReport;
}

async function main() {
  const fixtures = await loadFixtures();
  assert.equal(fixtures.length, 6);
  const reports: FixtureReport[] = [];

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

    scenario = advanceLongTermScenario({
      previous: scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      nowIso: isoFor(99),
    });

    const studyResult = runSegment({
      scenario,
      conversationId: fixture.id,
      locale: fixture.locale,
      segment: "study",
      turns: fixture.study.turns,
      previousGraph: fitnessResult.model.graph,
      prevConcepts: fitnessResult.model.concepts,
      prevMotifs: fitnessResult.model.motifs,
      prevMotifLinks: fitnessResult.model.motifLinks,
      prevContexts: fitnessResult.model.contexts,
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

    const fitnessReport = buildStageReport({
      stage: "fitness",
      scenario,
      model: fitnessResult.model,
      expectedConstraints: fixture.expected.fitnessConstraints,
    });
    const studyReport = buildStageReport({
      stage: "study",
      scenario,
      model: studyResult.model,
      expectedConstraints: fixture.expected.studyConstraints,
      expectedMethods: fixture.expected.studyMethods,
    });

    reports.push({
      id: fixture.id,
      locale: fixture.locale,
      persona: fixture.persona,
      fitness: fitnessReport,
      study: studyReport,
    });

    console.log(
      `PASS ${fixture.id} fitness(c=${fitnessReport.conceptCount}, m=${fitnessReport.motifCount}) study(c=${studyReport.conceptCount}, m=${studyReport.motifCount})`
    );
    for (const warning of [...fitnessReport.warnings, ...studyReport.warnings]) {
      console.log(`WARN ${fixture.id}: ${warning}`);
    }
  }

  await fs.writeFile(REPORT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`, "utf8");
  console.log(`Saved long-term mock regression report to ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
