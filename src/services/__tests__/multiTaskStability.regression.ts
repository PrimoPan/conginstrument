import assert from "node:assert/strict";

import { applyPatchWithGuards } from "../../core/graph/patchApply.js";
import type { CDG, CDGEdge } from "../../core/graph.js";
import type { AppLocale } from "../../i18n/locale.js";
import { buildCognitiveModel, type CognitiveModel } from "../cognitiveModel.js";
import { generateGraphPatch } from "../graphUpdater.js";
import { buildPortfolioDocumentState, detectTaskSwitchFromLatestUserTurn } from "../planningState.js";
import { buildTravelPlanState, type TravelPlanState } from "../travelPlan/state.js";
import {
  applyManualGraphOverrides,
  rebuildManualGraphOverrides,
  type ManualGraphOverrides,
} from "../../routes/conversations.js";
import type { MotifLink } from "../motif/motifLinks.js";

type TaskScenario = {
  name: string;
  turns: string[];
};

type ScenarioDefinition = {
  name: string;
  locale: AppLocale;
  firstTask: TaskScenario;
  secondTask: TaskScenario;
  secondTaskShouldSwitch: true;
  afterSecondTaskTurn?: (ctx: TaskTurnHookContext) => TaskTurnHookResult | void;
  validate?: (ctx: ScenarioRunResult) => void;
};

type TaskTurnHookContext = {
  taskName: string;
  turnIndex: number;
  graph: CDG;
  model: CognitiveModel;
  manualGraphOverrides: ManualGraphOverrides;
  motifLinks: MotifLink[];
};

type TaskTurnHookResult = {
  graph?: CDG;
  manualGraphOverrides?: ManualGraphOverrides;
  motifLinks?: MotifLink[];
};

type TaskRunResult = {
  graph: CDG;
  model: CognitiveModel;
  plan: TravelPlanState;
  manualGraphOverrides: ManualGraphOverrides;
  motifLinks: MotifLink[];
};

type ScenarioRunResult = {
  firstTask: TaskRunResult;
  secondTask: TaskRunResult;
  portfolio: ReturnType<typeof buildPortfolioDocumentState>;
};

const ASSISTANT_ACK = "收到，我按这个方向继续。";

function makeEmptyGraph(conversationId: string): CDG {
  return {
    id: conversationId,
    version: 0,
    nodes: [],
    edges: [],
  };
}

function run(name: string, fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS ${name}`),
      (err: any) => {
        console.error(`FAIL ${name}:`, err?.message || err);
        throw err;
      }
    );
}

function emptyOverrides(): ManualGraphOverrides {
  return { edges: [], nodes: [] };
}

function findNodeIdByKeyPrefix(graph: CDG, keyPrefix: string | string[]): string {
  const prefixes = Array.isArray(keyPrefix) ? keyPrefix : [keyPrefix];
  const node = (graph.nodes || []).find((item) =>
    prefixes.some((prefix) => String(item.key || "").startsWith(prefix))
  );
  assert.ok(node, `expected node with key prefix ${prefixes.join(" | ")}`);
  return String(node!.id);
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

function readEdge(graph: CDG, fromId: string, toId: string): CDGEdge | undefined {
  return (graph.edges || []).find((edge) => edge.from === fromId && edge.to === toId);
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

function sharedMotifTypeIds(left: CognitiveModel, right: CognitiveModel): string[] {
  const rightSet = new Set(motifStructureSignatures(right));
  return motifStructureSignatures(left).filter((id) => rightSet.has(id));
}

function applyManualConceptEdge(params: {
  graph: CDG;
  manualGraphOverrides: ManualGraphOverrides;
  fromKeyPrefix: string | string[];
  toKeyPrefix: string | string[];
  type: CDGEdge["type"];
}) {
  const fromId = findNodeIdByKeyPrefix(params.graph, params.fromKeyPrefix);
  const toId = findNodeIdByKeyPrefix(params.graph, params.toKeyPrefix);
  const nextGraph: CDG = {
    ...params.graph,
    edges: [
      ...(params.graph.edges || []).filter((edge) => !(edge.from === fromId && edge.to === toId)),
      {
        id: "e_manual_override",
        from: fromId,
        to: toId,
        type: params.type,
        confidence: 0.93,
      },
    ],
  };
  const manualGraphOverrides = rebuildManualGraphOverrides({
    prevGraph: params.graph,
    nextGraph,
    existing: params.manualGraphOverrides,
    updatedAt: "2026-03-07T00:00:00.000Z",
  });
  const graph = applyManualGraphOverrides(params.graph, manualGraphOverrides);
  const preserved = readEdge(graph, fromId, toId);
  assert.ok(preserved, "manual concept edge should be present immediately after override");
  assert.equal(preserved?.type, params.type);
  return {
    graph,
    manualGraphOverrides,
  };
}

function applyManualMotifLink(model: CognitiveModel): MotifLink[] {
  assert.ok((model.motifs || []).length >= 2, "expected at least two motifs for manual motif-link edit");
  const [fromMotif, toMotif] = model.motifs.slice(0, 2);
  return [
    ...(model.motifLinks || []).filter(
      (link) => !(link.fromMotifId === fromMotif.id && link.toMotifId === toMotif.id)
    ),
    {
      id: "ml_user_refines",
      fromMotifId: fromMotif.id,
      toMotifId: toMotif.id,
      type: "refines",
      confidence: 0.91,
      source: "user",
      updatedAt: "2026-03-07T00:00:00.000Z",
    },
  ];
}

async function runTask(params: {
  conversationId: string;
  locale: AppLocale;
  task: TaskScenario;
  previousPlan: TravelPlanState | null;
  expectTaskSwitch: boolean;
  afterTurn?: (ctx: TaskTurnHookContext) => TaskTurnHookResult | void;
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
  let manualGraphOverrides = emptyOverrides();
  let motifLinks: MotifLink[] = [];
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
        `${params.task.name} turn 1 task-switch expectation mismatch`
      );
    } else {
      assert.equal(detection.is_task_switch, false, `${params.task.name} turn ${turnNumber} should stay in the same task`);
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
      baseMotifLinks: motifLinks,
      baseContexts: model.contexts,
      locale: params.locale,
    });
    motifLinks = model.motifLinks;

    if (params.afterTurn) {
      const adjustment = params.afterTurn({
        taskName: params.task.name,
        turnIndex: turnNumber,
        graph,
        model,
        manualGraphOverrides,
        motifLinks,
      });
      if (adjustment?.graph || adjustment?.manualGraphOverrides || adjustment?.motifLinks) {
        graph = adjustment.graph || graph;
        manualGraphOverrides = adjustment.manualGraphOverrides || manualGraphOverrides;
        motifLinks = adjustment.motifLinks || motifLinks;
        model = buildCognitiveModel({
          graph,
          prevConcepts: model.concepts,
          baseConcepts: model.concepts,
          baseMotifs: model.motifs,
          baseMotifLinks: motifLinks,
          baseContexts: model.contexts,
          locale: params.locale,
        });
        motifLinks = model.motifLinks;
      }
    }

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

  assert.ok(plan, `${params.task.name} should produce a travel plan`);
  return {
    graph,
    model,
    plan: plan!,
    manualGraphOverrides,
    motifLinks,
  };
}

const scenarios: ScenarioDefinition[] = [
  {
    name: "long-form 10+10 domestic -> international restart keeps shared pace and transit motifs while destinations stay scoped",
    locale: "zh-CN",
    firstTask: {
      name: "hangzhou_parents_10x10",
      turns: [
        "想带父母去杭州6天，第一次一起去，核心是慢一点、稳一点，不要被景点密度推着走。",
        "总预算控制在2万2左右，花钱可以均衡一些，也希望预算留一点余量。",
        "酒店最好靠地铁而且有电梯，爸妈累了能比较快回去休息。",
        "西湖可以看，但不想每天都换一个热门点，宁可上午一个重点、下午留白。",
        "中午最好能安排明确午休，上午和下午之间留出稳定休息空档。",
        "如果下雨，希望直接切到室内备选，不要让我临时再从头重排。",
        "最多换一次酒店，而且要有很明确的理由，比如返程方便。",
        "晚上别安排太晚，吃饭也尽量在住处附近解决。",
        "最后一天一定给返程留缓冲，不要把退房前塞满。",
        "如果要总结这趟的原则，请保留慢节奏、交通方便、可午休、雨天有备选这几条。",
      ],
    },
    secondTask: {
      name: "kyoto_parents_10x10",
      turns: [
        "重新规划一个新任务，这次想带父母去京都6天，整体还是慢一点、稳一点，但不要把杭州那边的地点带过来。",
        "京都这趟预算大概3万2左右，能接受稍微贵一点，但还是不想为豪华感牺牲便利。",
        "京都这趟的酒店请优先靠车站或者地铁，爸妈累了能快速回房间休息。",
        "景点上以京都本身为主，不想顺手再加大阪或奈良这种支线。",
        "京都这趟每天最多一个重点片区，中午留午休或者低强度时段。",
        "如果京都下雨，也要直接切到室内寺院、博物馆、商场一类的备选。",
        "京都这趟最多换一次酒店，最后两晚最好住稳一点。",
        "在京都晚上不想跑很远吃饭，住处附近方便坐下吃就行。",
        "京都回程前一天尤其轻一点，方便收拾和调整状态。",
        "如果要总结这趟京都行，请保留慢节奏、交通便利、午休、雨天备选这些原则，但只服务京都这趟行程。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "杭州"));
      assert.ok(hasDestination(secondTask.graph, "京都"));
      assert.equal(hasDestination(secondTask.graph, "杭州"), false);
      assert.equal(hasDestination(secondTask.graph, "大阪"), false);
      assert.equal(hasDestination(secondTask.graph, "奈良"), false);
      assert.ok(planHasDestination(secondTask.plan, "京都"));
      assert.equal(planHasDestination(secondTask.plan, "杭州"), false);
      assert.ok(sharedMotifTypeIds(firstTask.model, secondTask.model).length >= 1);
      assert.ok((secondTask.plan.task_history || []).some((item) => item.task_id === firstTask.plan.task_id));
    },
  },
  {
    name: "domestic -> domestic stays clean across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "hangzhou_family",
      turns: [
        "想带父母和孩子去杭州玩5天，节奏轻一点，不要太累。",
        "总预算控制在2万元以内。",
        "酒店最好地铁方便，而且有电梯。",
        "西湖想去，但不想每天都在热门景点打卡。",
        "最多换一次酒店。",
        "想留一天给小朋友活动，室外室内都行。",
        "晚上别安排太晚，爸妈休息要稳一点。",
        "如果下雨，希望有明确的室内备选。",
      ],
    },
    secondTask: {
      name: "qingdao_couple",
      turns: [
        "重新规划一个新任务，想和伴侣去青岛4天，看海散步为主，不要太赶。",
        "预算大概1万2。",
        "酒店要靠地铁或者火车站，回程方便。",
        "不追求景点密度，海边慢慢走和咖啡店都可以。",
        "海鲜想吃，但不要特别贵。",
        "尽量少打车，多靠步行和地铁。",
        "最后一天留足返程缓冲。",
        "如果天气不好，也给我一点室内替代。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask, portfolio }) => {
      assert.ok(hasDestination(firstTask.graph, "杭州"));
      assert.equal(hasDestination(firstTask.graph, "青岛"), false);
      assert.ok(hasDestination(secondTask.graph, "青岛"));
      assert.equal(hasDestination(secondTask.graph, "杭州"), false);
      assert.equal(hasDestination(secondTask.graph, "一个新任务"), false);
      assert.ok((secondTask.plan.destination_scope || []).includes("青岛"));
      assert.equal((secondTask.plan.destination_scope || []).includes("杭州"), false);
      assert.equal((secondTask.plan.destination_scope || []).includes("一个新任务"), false);
      assert.ok((secondTask.plan.task_history || []).some((item) => item.task_id === firstTask.plan.task_id));
      assert.equal(portfolio.trips.length >= 2, true);
      assert.equal(portfolio.trips.some((trip) => trip.status === "archived"), true);
      assert.equal(portfolio.trips.some((trip) => trip.destination_scope.includes("青岛")), true);
    },
  },
  {
    name: "domestic -> international keeps manual concept-edge overrides through later turns",
    locale: "zh-CN",
    firstTask: {
      name: "chengdu_family",
      turns: [
        "想带爸妈去成都5天，第一次去，不想太折腾。",
        "预算每人1万左右。",
        "酒店离地铁近一点，最好周边吃饭方便。",
        "宽窄巷子可以看看，但不想每天跑很多点。",
        "希望至少有一天轻松散步和喝茶。",
        "不要频繁换酒店。",
        "晚上早点回，第二天别太累。",
        "如果天气太热，安排一些室内备选。",
      ],
    },
    secondTask: {
      name: "osaka_family",
      turns: [
        "重新规划一个新任务，想带孩子去大阪和京都7天，整体轻松一点。",
        "预算总共3万元左右。",
        "酒店希望交通方便，有电梯，最好儿童友好。",
        "大阪想住得更集中一点，减少搬运行李。",
        "每天留出午休或者低强度时段。",
        "热门景点可以去，但不想排太多队。",
        "回程前一晚要特别稳，不折腾换酒店。",
        "如果孩子状态不好，希望有能随时缩减的版本。",
      ],
    },
    secondTaskShouldSwitch: true,
    afterSecondTaskTurn: ({ turnIndex, graph, manualGraphOverrides }) => {
      if (turnIndex !== 4) return;
      return applyManualConceptEdge({
        graph,
        manualGraphOverrides,
        fromKeyPrefix: ["slot:lodging_preference", "slot:lodging"],
        toKeyPrefix: "slot:goal",
        type: "constraint",
      });
	    },
	    validate: ({ secondTask }) => {
	      const fromId = findNodeIdByKeyPrefix(secondTask.graph, ["slot:lodging_preference", "slot:lodging"]);
	      const toId = findNodeIdByKeyPrefix(secondTask.graph, "slot:goal");
	      const edge = readEdge(secondTask.graph, fromId, toId);
	      assert.ok(edge, "manual lodging -> goal edge should remain after later turns");
      assert.equal(edge?.type, "constraint");
      assert.equal(secondTask.manualGraphOverrides.edges.some((item) => item.state === "active"), true);
      assert.ok((secondTask.plan.destination_scope || []).some((dest) => dest === "大阪" || dest === "京都"));
    },
  },
  {
    name: "international -> international keeps manual motif-link overrides through later turns",
    locale: "zh-CN",
    firstTask: {
      name: "morocco_with_mother",
      turns: [
        "想带妈妈第一次去摩洛哥，8天，别太累。",
        "总预算3万元，语言不太通。",
        "想去马拉喀什和非斯，卡萨只想做中转。",
        "酒店不要频繁换，最好靠交通方便一点。",
        "希望安排里有一些在地体验，但不要太硬核。",
        "妈妈膝盖一般，楼梯太多不行。",
        "晚上早点回住处，安全感要强一点。",
        "如果天气太热，希望能把户外压缩一点。",
      ],
    },
    secondTask: {
      name: "iberia_with_father",
      turns: [
        "重新规划一个新任务，想和父亲去西班牙加葡萄牙10天，慢一点。",
        "总预算4万元左右。",
        "里斯本和塞维利亚优先，马德里不是必须。",
        "父亲膝盖不好，不想爬太多台阶。",
        "最好不要频繁换酒店，交通接驳要清楚。",
        "可以保留一点在地散步和看城市生活的时间。",
        "如果某天太累，要能删掉一两个点而不影响主线。",
        "回程前留一天轻量安排，别压满。",
      ],
    },
    secondTaskShouldSwitch: true,
    afterSecondTaskTurn: ({ turnIndex, model }) => {
      if (turnIndex !== 5) return;
      return {
        motifLinks: applyManualMotifLink(model),
      };
    },
    validate: ({ secondTask }) => {
      assert.equal(
        secondTask.model.motifLinks.some((link) => link.id === "ml_user_refines" && link.source === "user" && link.type === "refines"),
        true
      );
      assert.equal(
        secondTask.model.motifLinks.every(
          (link) =>
            (secondTask.model.motifs || []).some((motif) => motif.id === link.fromMotifId) &&
            (secondTask.model.motifs || []).some((motif) => motif.id === link.toMotifId)
        ),
        true
      );
      assert.equal(hasDestination(secondTask.graph, "摩洛哥"), false);
      assert.equal(hasDestination(secondTask.graph, "西班牙"), true);
      assert.equal(hasDestination(secondTask.graph, "葡萄牙"), true);
    },
  },
  {
    name: "domestic -> domestic keeps later-night and hill constraints from polluting destination slots across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "suzhou_elder_trip",
      turns: [
        "想带老人去苏州4天，园林可以看，但整体慢一点。",
        "预算控制在1万5左右。",
        "酒店最好靠地铁，有电梯。",
        "想保留一天只散步喝茶，不排太满。",
        "拙政园可以去，其他景点不必硬塞。",
        "晚饭尽量就在住处附近解决，别折返太多。",
        "最后一天给返程留足缓冲。",
        "如果下雨，希望有清楚的室内替代。",
      ],
    },
    secondTask: {
      name: "chongqing_friend_trip",
      turns: [
        "重新规划一个新任务，和两个朋友去重庆4天，想吃和看夜景，但节奏别太满。",
        "预算大概1万8。",
        "酒店靠地铁，不要拖箱爬坡太多。",
        "洪崖洞可以看一眼，但不想一路排队。",
        "白天太热的话，多放室内备选和午休。",
        "火锅和小面分开吃，不要一顿塞太多。",
        "最后一晚住得稳一点，方便第二天回程。",
        "如果体力不行，希望删掉一两个点也还成立。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "苏州"));
      assert.ok(hasDestination(secondTask.graph, "重庆"));
      assert.equal(hasDestination(secondTask.graph, "苏州"), false);
      assert.equal(hasDestination(secondTask.graph, "爬坡"), false);
      assert.ok(planHasDestination(secondTask.plan, "重庆"));
      assert.equal(planHasDestination(secondTask.plan, "苏州"), false);
    },
  },
  {
    name: "domestic -> international keeps hot-weather and family-rest refinements from turning into false destinations across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "dali_lijiang_solo",
      turns: [
        "想自己去大理和丽江6天，慢一点，不要太赶。",
        "预算控制在1万6左右。",
        "酒店靠古城外一点也行，但要安静。",
        "想多留一点在地吃喝和散步时间。",
        "不需要天天换地方住，最好两段就够。",
        "晚上不要安排太晚，第二天还能轻松出门。",
        "如果下雨，希望有室内替代和茶馆时间。",
        "最后一天留足回程缓冲。",
      ],
    },
    secondTask: {
      name: "singapore_family_trip",
      turns: [
        "重新规划一个新任务，想带家人去新加坡5天，天气热也想轻松一点。",
        "预算总共2万5。",
        "酒店靠地铁，最好亲子友好。",
        "圣淘沙不是每天都要去，市区也要有轻松活动。",
        "中午要能随时回酒店休息。",
        "吃东西以方便和干净为主，不追网红。",
        "回程前一晚不要换酒店。",
        "如果下雨，给我一些室内替代。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "大理"));
      assert.ok(hasDestination(firstTask.graph, "丽江"));
      assert.ok(hasDestination(secondTask.graph, "新加坡"));
      assert.equal(hasDestination(secondTask.graph, "大理"), false);
      assert.equal(hasDestination(secondTask.graph, "丽江"), false);
      assert.equal(hasDestination(secondTask.graph, "天气热"), false);
      assert.ok(planHasDestination(secondTask.plan, "新加坡"));
      assert.equal(planHasDestination(secondTask.plan, "大理"), false);
    },
  },
  {
    name: "international -> international keeps broad-country anchors stable while city priorities refine later turns across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "turkey_with_mother",
      turns: [
        "想和妈妈去土耳其8天，伊斯坦布尔和卡帕多奇亚为主，不要太累。",
        "预算大概3万8。",
        "酒店要交通方便，不想搬太多次。",
        "如果可以，希望留一点看城市生活和慢慢走的时间。",
        "热气球不是必须，别让早起把节奏压得太紧。",
        "妈妈走楼梯不太舒服，台阶太多不行。",
        "晚上早点回住处，安全感要强一点。",
        "回程前一天轻一点，不要塞满。",
      ],
    },
    secondTask: {
      name: "norway_couple_trip",
      turns: [
        "重新规划一个新任务，想和伴侣去挪威7天，重点奥斯陆和卑尔根，峡湾可以留但不要硬塞。",
        "预算4万元左右。",
        "酒店最好靠火车站或码头，换乘别太折腾。",
        "整体不要太赶，阴雨天也要有室内替代。",
        "最多换一次酒店。",
        "晚上不要太晚，第二天想保留轻松节奏。",
        "如果某天风雨太大，可以删掉一段外景也不影响主线。",
        "回程前一晚安排简单一点。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "土耳其"));
      assert.ok(hasDestination(secondTask.graph, "挪威"));
      assert.equal(hasDestination(secondTask.graph, "土耳其"), false);
      assert.equal(hasDestination(secondTask.graph, "阴雨天"), false);
      assert.ok(planHasDestination(secondTask.plan, "挪威"));
      assert.equal(planHasDestination(secondTask.plan, "土耳其"), false);
    },
  },
  {
    name: "domestic -> domestic revision clauses revoke earlier boating and high-star asks without destination drift across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "xiamen_family_trip",
      turns: [
        "想带爸妈去厦门5天，节奏轻一点，不要太赶。",
        "预算控制在1万8左右。",
        "酒店最好靠地铁，周边吃饭方便。",
        "鼓浪屿可以去，但不想每天都跑很多点。",
        "希望至少留一天散步和喝茶。",
        "不要频繁换酒店。",
        "晚上早点回住处，第二天轻松一点。",
        "如果下雨，希望有室内备选。",
      ],
    },
    secondTask: {
      name: "qiandaohu_family_trip",
      turns: [
        "重新规划一个新任务，想带家人去千岛湖4天，整体慢一点，一开始想划船也想坐游船。",
        "预算大概1万5。",
        "酒店想住得稳一点，本来还想住高星酒店。",
        "其实一开始想划船，后来不想划船了，只想散步喝茶就好。",
        "本来想住高星酒店，后来不想住高星酒店了，交通方便更重要。",
        "如果下雨，希望有明确的室内替代。",
        "最后一天留足返程缓冲，不要安排太满。",
        "晚上也别太晚，第二天轻松一点。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "厦门"));
      assert.ok(hasDestination(secondTask.graph, "千岛湖"));
      assert.equal(hasDestination(secondTask.graph, "厦门"), false);
      assert.ok(planHasDestination(secondTask.plan, "千岛湖"));
      assert.equal(planHasDestination(secondTask.plan, "厦门"), false);

      const statements = (secondTask.graph.nodes || []).map((node) => String(node.statement || ""));
      assert.equal(statements.some((text) => /划船|游船|boat|boating|ferry|cruise/i.test(text)), false);
      assert.equal(statements.some((text) => /高星|五星|five-star|luxury hotel/i.test(text)), false);
    },
  },
  {
    name: "domestic -> international revision clauses should not turn transfer revocation into lodging across 8+8 turns",
    locale: "zh-CN",
    firstTask: {
      name: "qingdao_couple_trip",
      turns: [
        "想和伴侣去青岛4天，看海散步为主，不要太赶。",
        "预算控制在1万2左右。",
        "酒店靠地铁或者火车站，回程方便。",
        "海鲜想吃，但不要特别贵。",
        "不追求景点密度，海边慢慢走和咖啡店都可以。",
        "尽量少打车，多靠步行和地铁。",
        "最后一天留足返程缓冲。",
        "如果天气不好，也给我一点室内替代。",
      ],
    },
    secondTask: {
      name: "vienna_mother_trip_zh",
      turns: [
        "重新规划一个新任务，想带妈妈去维也纳6天，整体轻松一点。",
        "预算总共3万左右。",
        "酒店靠主火车站或者机场快线方便，一开始觉得可以接受转机。",
        "但后来不想转机了，最好直达，别把这个要求写成住宿偏好。",
        "最多换一次酒店，最后两晚住稳一点。",
        "如果下雨，希望有明确的室内替代。",
        "妈妈不想爬太多楼梯，电梯更重要。",
        "最后一天安排轻一点，方便回程。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "青岛"));
      assert.ok(hasDestination(secondTask.graph, "维也纳"));
      assert.equal(hasDestination(secondTask.graph, "青岛"), false);
      assert.ok(planHasDestination(secondTask.plan, "维也纳"));
      assert.equal(planHasDestination(secondTask.plan, "青岛"), false);

      const lodgingStatements = (secondTask.graph.nodes || [])
        .filter((node) => String(node.key || "").startsWith("slot:lodging"))
        .map((node) => String(node.statement || ""));
      assert.equal(lodgingStatements.some((text) => /转机|换乘|transfer|layover|connection/i.test(text)), false);

      const limitingStatements = (secondTask.graph.nodes || [])
        .filter((node) => String(node.key || "").startsWith("slot:constraint:limiting:"))
        .map((node) => String(node.statement || ""));
      assert.equal(limitingStatements.some((text) => /转机|换乘|transfer|layover|connection/i.test(text)), false);
    },
  },
  {
    name: "long-form 8+8 tasks keep revised negations local and prevent destination leakage after model switch",
    locale: "zh-CN",
    firstTask: {
      name: "suzhou_parents_longform",
      turns: [
        "先规划一个苏州任务：想带父母去4天，核心不是景点数量，而是住得稳、走得慢、每天只做一件主线事情。我们不排斥园林，但也不想整趟都在热门点之间来回穿梭，更希望上午一个重点、下午留白，晚上尽量在住处附近解决吃饭和散步。",
        "预算总共控制在1万5左右，酒店不需要豪华，但要地铁方便、有电梯、周边吃饭容易，不希望为了住得好看一点反而每天换乘很多次。",
        "拙政园和苏州博物馆可以选一个重点去，其他景点不必都打卡；如果遇到下雨，希望直接切到室内方案，不要让我临时再从头重排。",
        "父母脚力一般，台阶太多或者需要长距离折返的安排都不想要；如果某段路主要是为了拍照而不是体验，就宁可删掉。",
        "我还想留半天给喝茶、在平江路附近慢慢走，但不是非得逛到很晚，重点是节奏稳一点。",
        "酒店尽量别换，如果必须换，也最多一次，而且要有明确原因，比如返程更方便，而不是为了尝试不同片区。",
        "最后一天请自动留足回程缓冲，不要把退房前的时间塞满。",
        "如果天气太热或下雨，优先保留室内园林、博物馆、茶馆这些低强度版本，不要再加新的城市或郊区点。",
      ],
    },
    secondTask: {
      name: "kyoto_parents_longform",
      turns: [
        "重新规划一个新任务：这次想带父母去京都6天。先说清楚，我一开始脑子里闪过大阪、神户这些顺路城市，也想过中间住一晚，但后来想想不想折腾了，这趟就把目标收回到京都本身，节奏越稳越好。",
        "住宿方面，本来最开始也想过住高星酒店，后来又觉得没有必要；真正重要的是从车站回酒店省力、附近吃饭方便、父母累了能随时回去休息，所以交通便利比星级和景观都重要。",
        "活动上我一开始还想安排划船、夜游船或者特别打卡式的体验，但现在也不想了，宁可换成鸭川散步、街区慢逛、寺院庭园这种低强度内容，而且不要因为删掉划船就自动给我新增别的远点。",
        "我希望每天最多一个重点区域，比如清水寺和祇园算一组、岚山算一组，别把看起来顺路但实际上换乘复杂的地方硬拼在一起。",
        "如果中午天气热、下雨或者父母状态不太好，希望能直接压缩成半天版本，不要因此推导出新的目的地或临时外插神户、大阪这种支线。",
        "吃饭不用追网红，离住处近、排队别太久、能坐得舒服就行；晚饭后也尽量只留附近散步，不安排额外的夜间移动。",
        "最后两晚请住稳一点，不要再为了所谓体验换片区；回程前一天尤其轻，方便收拾和调整状态。",
        "如果要做总结，请保持这几个最终结论：只保留京都、不住高星酒店、不要划船、优先交通方便、可以轻松散步，但不要凭这些再生成新的城市节点。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "苏州"));
      assert.ok(hasDestination(secondTask.graph, "京都"));
      assert.equal(hasDestination(secondTask.graph, "苏州"), false);
      assert.equal(hasDestination(secondTask.graph, "大阪"), false);
      assert.equal(hasDestination(secondTask.graph, "神户"), false);
      assert.ok(planHasDestination(secondTask.plan, "京都"));
      assert.equal(planHasDestination(secondTask.plan, "苏州"), false);

      const statements = (secondTask.graph.nodes || []).map((node) => String(node.statement || ""));
      assert.equal(statements.some((text) => /划船|夜游船|boat|boating|ferry|cruise/i.test(text)), false);
      assert.equal(statements.some((text) => /高星|五星|luxury hotel|five-star/i.test(text)), false);
    },
  },
  {
    name: "long-form 8+8 restart should keep only ningbo when discarded side-cities and overnight fragments appear in the new task",
    locale: "zh-CN",
    firstTask: {
      name: "quanzhou_parents_longform",
      turns: [
        "先规划一个泉州任务：想带父母去4天，重点是住得稳、吃得方便、每天不要走太多路。我们可以看看老街和寺庙，但不想为了打卡把白天排得太满，晚上也尽量早点回住处。",
        "预算总共控制在1万4左右，酒店不需要豪华，关键是打车和步行都方便、有电梯、附近有吃饭的地方，别为了景观去很偏的区域。",
        "活动上宁可上午一个重点、下午留白，也不想把很多点拼成一串；如果天气热或者下雨，希望直接切到室内替代。",
        "父母脚力一般，台阶多或者要反复折返的地方都不想要；如果某段主要只是拍照，我宁可删掉。",
        "我还想留一点街区慢逛和喝茶时间，但不是非得逛到很晚，重点还是节奏稳一点。",
        "酒店尽量别换，如果必须换也最多一次，而且要有明确理由，比如返程更方便。",
        "最后一天请自动留足返程缓冲，不要把退房前时间排满。",
        "如果要做备选，请优先保留低强度版本，不要因此再加新的城市或郊区点。",
      ],
    },
    secondTask: {
      name: "ningbo_parents_longform",
      turns: [
        "重新规划一个新任务：这次改成带父母去宁波5天。先说清楚，我一开始脑子里想过顺便去绍兴或者杭州，也想过中间住一晚再分段，但后来想想都不要了，这趟只保留宁波本身，节奏越稳越好。",
        "住宿方面，一开始也想过住高星酒店，后来觉得没必要；真正重要的是回酒店省力、附近吃饭方便、父母累了能随时回去休息，所以交通便利比星级和景观都重要。",
        "活动上我最开始还想安排游船或者夜景船，但现在也不想了，宁可换成沿江慢走、老街散步、找舒服的店坐一会儿，而且不要因为删掉游船就自动给我新增更远的点。",
        "我希望每天最多一个重点区域，别把看起来顺路但实际上换乘复杂的地方硬拼在一起。",
        "如果中午太热、下雨或者父母状态不太好，希望能直接压缩成半天版本，不要因此外插杭州、绍兴或者别的城市支线。",
        "吃饭不用追网红，离住处近、排队别太久、能坐得舒服就行；晚饭后也尽量只留附近散步。",
        "最后两晚请住稳一点，不要再为了所谓体验换片区；回程前一天尤其轻，方便收拾和调整状态。",
        "如果要做总结，请保持这几个最终结论：只保留宁波、不住高星酒店、不要游船、优先交通方便，但不要凭这些再生成新的城市节点。",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "泉州"));
      assert.ok(hasDestination(secondTask.graph, "宁波"));
      assert.equal(hasDestination(secondTask.graph, "泉州"), false);
      assert.equal(hasDestination(secondTask.graph, "杭州"), false);
      assert.equal(hasDestination(secondTask.graph, "绍兴"), false);
      assert.equal(hasDestination(secondTask.graph, "中间住"), false);
      assert.ok(planHasDestination(secondTask.plan, "宁波"));
      assert.equal(planHasDestination(secondTask.plan, "泉州"), false);
      const statements = (secondTask.graph.nodes || []).map((node) => String(node.statement || ""));
      assert.equal(statements.some((text) => /游船|夜景船|boat|boating|cruise/i.test(text)), false);
      assert.equal(statements.some((text) => /高星|五星|luxury hotel|five-star/i.test(text)), false);
    },
  },
  {
    name: "english 4+4 tasks keep destination boundaries stable with lightweight refinements",
    locale: "en-US",
    firstTask: {
      name: "seoul_parents_trip",
      turns: [
        "Plan a 4-day Seoul trip for my parents. Keep it gentle and low-hassle.",
        "Budget around 2500 dollars total.",
        "Please keep the hotel near a subway station, with elevator access.",
        "Keep the final evening light and add one rainy-day backup.",
      ],
    },
    secondTask: {
      name: "vienna_mother_trip",
      turns: [
        "Start a new task: plan a 4-day Vienna trip with my mother. Keep it calm and avoid too many stairs.",
        "Budget around 3000 euros total.",
        "Hotel near the airport rail or main train station, and do not switch hotels.",
        "Leave the last day light and give me one indoor fallback if it rains.",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "Seoul") || hasDestination(firstTask.graph, "首尔"));
      assert.ok(hasDestination(secondTask.graph, "Vienna") || hasDestination(secondTask.graph, "维也纳"));
      assert.equal(hasDestination(secondTask.graph, "Seoul"), false);
      assert.equal(hasDestination(secondTask.graph, "new task"), false);
      assert.ok(planHasDestination(secondTask.plan, "Vienna") || planHasDestination(secondTask.plan, "维也纳"));
      assert.equal(planHasDestination(secondTask.plan, "Seoul"), false);
    },
  },
  {
    name: "english 4+4 restart should keep only porto when later turns revoke lisbon cruise and luxury-hotel ideas",
    locale: "en-US",
    firstTask: {
      name: "seoul_food_trip",
      turns: [
        "Plan a 4-day Seoul trip for me and my sister. Keep it easy and food-focused.",
        "Budget around 2600 dollars total.",
        "Hotel near a subway stop and keep the last evening light.",
        "If it rains, give me one indoor backup and do not add another city.",
      ],
    },
    secondTask: {
      name: "porto_mother_trip",
      turns: [
        "Start a new task: plan a 4-day Porto trip with my mother. At first I thought about adding Lisbon, but I do not want that anymore. Keep it to Porto only.",
        "Budget around 3200 euros total.",
        "I also first imagined a river cruise and a luxury hotel, but I do not want either anymore. Easy transit and low hassle matter more.",
        "Keep the final day light, avoid extra city branches, and give me one indoor fallback if it rains.",
      ],
    },
    secondTaskShouldSwitch: true,
    validate: ({ firstTask, secondTask }) => {
      assert.ok(hasDestination(firstTask.graph, "Seoul") || hasDestination(firstTask.graph, "首尔"));
      assert.ok(hasDestination(secondTask.graph, "Porto") || hasDestination(secondTask.graph, "波尔图"));
      assert.equal(hasDestination(secondTask.graph, "Seoul"), false);
      assert.equal(hasDestination(secondTask.graph, "Lisbon"), false);
      assert.ok(planHasDestination(secondTask.plan, "Porto") || planHasDestination(secondTask.plan, "波尔图"));
      assert.equal(planHasDestination(secondTask.plan, "Seoul"), false);
      const statements = (secondTask.graph.nodes || []).map((node) => String(node.statement || ""));
      assert.equal(statements.some((text) => /cruise|boat|river cruise/i.test(text)), false);
      assert.equal(statements.some((text) => /luxury hotel|five-star/i.test(text)), false);
    },
  },
];

async function runScenario(scenario: ScenarioDefinition): Promise<ScenarioRunResult> {
  const conversationId = `conv_${scenario.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const firstTask = await runTask({
    conversationId,
    locale: scenario.locale,
    task: scenario.firstTask,
    previousPlan: null,
    expectTaskSwitch: false,
  });
  const secondTask = await runTask({
    conversationId,
    locale: scenario.locale,
    task: scenario.secondTask,
    previousPlan: firstTask.plan,
    expectTaskSwitch: scenario.secondTaskShouldSwitch,
    afterTurn: scenario.afterSecondTaskTurn,
  });
  const portfolio = buildPortfolioDocumentState({
    userId: "user_multi_task_regression",
    locale: scenario.locale,
    conversations: [
      {
        conversationId,
        title: scenario.name,
        travelPlanState: secondTask.plan,
        updatedAt: new Date("2026-03-07T12:00:00.000Z"),
      },
    ],
  });

  assert.ok(firstTask.plan.task_id, `${scenario.name}: first task should produce a task_id`);
  assert.ok(secondTask.plan.task_id, `${scenario.name}: second task should produce a task_id`);
  assert.notEqual(
    secondTask.plan.task_id,
    firstTask.plan.task_id,
    `${scenario.name}: second task should be a newly created travel task, not a continuation of the first one`
  );
  assert.match(
    secondTask.plan.task_id,
    /:task_2$/,
    `${scenario.name}: the first task switch should allocate a dedicated second-task id`
  );
  assert.equal(
    portfolio.trips.some((trip) => trip.task_id === firstTask.plan.task_id),
    true,
    `${scenario.name}: portfolio should retain the first task section`
  );
  assert.equal(
    portfolio.trips.some((trip) => trip.task_id === secondTask.plan.task_id),
    true,
    `${scenario.name}: portfolio should contain the second task as a separate section`
  );
  assert.equal(
    portfolio.trips.some((trip) => trip.task_id === secondTask.plan.task_id && trip.status === "active"),
    true,
    `${scenario.name}: second task section should be active`
  );
  assert.equal(
    portfolio.trips.some((trip) => trip.task_id === firstTask.plan.task_id && trip.status === "archived"),
    true,
    `${scenario.name}: first task section should be archived after the new task starts`
  );

  const out = { firstTask, secondTask, portfolio };
  scenario.validate?.(out);
  return out;
}

async function main() {
  for (const scenario of scenarios) {
    await runScenario(scenario);
    console.log(`PASS ${scenario.name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
