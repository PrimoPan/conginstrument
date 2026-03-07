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
  return { edges: [] };
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
