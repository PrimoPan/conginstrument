import type { CDG, ConceptNode } from "../../core/graph.js";

export type TravelPlanDay = {
  day: number;
  city?: string;
  title: string;
  items: string[];
};

export type TravelPlanState = {
  version: number;
  updatedAt: string;
  summary: string;
  destinations: string[];
  constraints: string[];
  totalDays?: number;
  budget?: {
    totalCny?: number;
    spentCny?: number;
    remainingCny?: number;
  };
  dayPlans: TravelPlanDay[];
  source: {
    turnCount: number;
    lastTurnAt?: string;
  };
};

function clean(input: any, max = 200): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseCnInt(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const map: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  if (map[s] != null) return map[s];
  return null;
}

function parseMoney(raw: string): number | undefined {
  const s = clean(raw, 40).replace(/[,，\s]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return undefined;
}

function parseDays(raw: string): number | undefined {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= 365) return Math.round(n);
  const cn = parseCnInt(raw);
  if (cn && cn > 0 && cn <= 365) return cn;
  return undefined;
}

function nodeByKey(graph: CDG, key: string): ConceptNode | undefined {
  return (graph.nodes || []).find((n) => String((n as any).key || "") === key);
}

function parseDayBlocksFromText(text: string): TravelPlanDay[] {
  const src = String(text || "");
  if (!src.trim()) return [];
  const lines = src
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const out: TravelPlanDay[] = [];
  let cur: TravelPlanDay | null = null;

  const flush = () => {
    if (!cur) return;
    cur.items = Array.from(new Set(cur.items.map((x) => clean(x, 120)).filter(Boolean))).slice(0, 8);
    if (!cur.items.length) {
      cur.items = ["根据当日节奏进行核心景点与餐食安排。"];
    }
    out.push(cur);
    cur = null;
  };

  const parseDayFromLine = (line: string): number | undefined => {
    const a = line.match(/^第\s*([一二三四五六七八九十两0-9]{1,3})\s*天(?:[:：\-\s]|$)/i);
    if (a?.[1]) return parseDays(a[1]);
    const b = line.match(/^day\s*([0-9]{1,2})(?:[:：\-\s]|$)/i);
    if (b?.[1]) return parseDays(b[1]);
    const c = line.match(/^([0-9]{1,2})[\.、]\s*第?([一二三四五六七八九十两0-9]{1,3})?\s*天?/i);
    if (c?.[2]) return parseDays(c[2]);
    if (c?.[1]) return parseDays(c[1]);
    return undefined;
  };

  for (const line of lines) {
    const day = parseDayFromLine(line);
    if (day) {
      flush();
      const title = clean(line.replace(/^([0-9]{1,2}[\.、]\s*)?第?\s*[一二三四五六七八九十两0-9]{1,3}\s*天\s*[:：\-]?/i, ""), 60);
      cur = {
        day,
        title: title || `第${day}天行程`,
        items: [],
      };
      continue;
    }

    if (!cur) continue;
    if (/^(上午|中午|下午|傍晚|晚上|夜间|早上|交通|住宿|餐饮|行程)/.test(line) || /^[-•*]/.test(line)) {
      cur.items.push(clean(line.replace(/^[-•*]\s*/, ""), 120));
      continue;
    }
    if (line.length <= 60) {
      cur.items.push(clean(line, 120));
    }
  }
  flush();

  return out
    .sort((a, b) => a.day - b.day)
    .filter((x, i, arr) => i === arr.findIndex((y) => y.day === x.day));
}

function buildFallbackDayPlans(params: {
  totalDays?: number;
  cityDurations: Array<{ city: string; days: number }>;
  destinations: string[];
}): TravelPlanDay[] {
  const total = Number(params.totalDays) || 0;
  if (total <= 0) return [];

  const byCity = params.cityDurations
    .filter((x) => x.days > 0)
    .slice(0, 12);

  const cityTimeline: string[] = [];
  if (byCity.length) {
    for (const seg of byCity) {
      for (let i = 0; i < seg.days; i += 1) cityTimeline.push(seg.city);
    }
  }

  const defaultCity = params.destinations[0] || "目的地";
  const out: TravelPlanDay[] = [];
  for (let d = 1; d <= total; d += 1) {
    const city = cityTimeline[d - 1] || defaultCity;
    out.push({
      day: d,
      city,
      title: `${city}第${d}天`,
      items: [
        "上午：安排核心景点或关键任务。",
        "下午：根据预算与体力安排次重点活动。",
        "晚上：用餐与复盘，预留机动时间。",
      ],
    });
  }
  return out;
}

function pickLatestItineraryAssistantText(turns: Array<{ assistantText: string }>): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = String(turns[i]?.assistantText || "");
    if (/第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/i.test(t)) {
      return t;
    }
  }
  return String(turns[turns.length - 1]?.assistantText || "");
}

function parseCityDurations(graph: CDG): Array<{ city: string; days: number }> {
  const out: Array<{ city: string; days: number }> = [];
  for (const n of graph.nodes || []) {
    const s = clean(n.statement, 120);
    const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    if (!m?.[1] || !m?.[2]) continue;
    const city = clean(m[1], 24);
    const days = Number(m[2]);
    if (!city || !Number.isFinite(days) || days <= 0) continue;
    out.push({ city, days: Math.round(days) });
  }
  return out;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr as any)) as any;
}

export function buildTravelPlanState(params: {
  graph: CDG;
  turns: Array<{ createdAt?: Date | string; userText: string; assistantText: string }>;
  previous?: TravelPlanState | null;
}): TravelPlanState {
  const graph = params.graph;
  const turns = params.turns || [];

  const goalNode = (graph.nodes || []).find((n) => n.type === "goal");
  const goalStatement = clean(goalNode?.statement || "", 120) || "制定旅行计划";

  const destinationNodes = (graph.nodes || [])
    .filter((n) => /^目的地[:：]/.test(clean(n.statement, 120)))
    .map((n) => clean(String(n.statement || "").split(/[:：]/)[1] || "", 30))
    .filter(Boolean);
  const destinations = dedupe(destinationNodes).slice(0, 8);

  const durationNode = nodeByKey(graph, "slot:duration_total");
  const durationM = clean(durationNode?.statement || "", 80).match(/总行程时长[:：]\s*([0-9]{1,3})\s*天/);
  const totalDays = durationM?.[1] ? Number(durationM[1]) : undefined;

  const budgetNode = nodeByKey(graph, "slot:budget");
  const spentNode = nodeByKey(graph, "slot:budget_spent");
  const remainNode = nodeByKey(graph, "slot:budget_remaining");

  const totalBudget = parseMoney((clean(budgetNode?.statement || "", 80).match(/预算(?:上限)?[:：]\s*([0-9]{1,12})\s*元?/) || [])[1] || "");
  const spentBudget = parseMoney((clean(spentNode?.statement || "", 80).match(/已花预算[:：]\s*([0-9]{1,12})\s*元?/) || [])[1] || "");
  let remainingBudget = parseMoney((clean(remainNode?.statement || "", 80).match(/(?:剩余预算|可用预算)[:：]\s*([0-9]{1,12})\s*元?/) || [])[1] || "");
  if (remainingBudget == null && totalBudget != null && spentBudget != null) {
    remainingBudget = Math.max(0, totalBudget - spentBudget);
  }

  const constraints = (graph.nodes || [])
    .filter((n) => n.type === "constraint")
    .map((n) => clean(n.statement, 90))
    .filter((s) => s && !/^预算(?:上限)?[:：]/.test(s) && !/^已花预算[:：]/.test(s) && !/^(?:剩余预算|可用预算)[:：]/.test(s) && !/^总行程时长[:：]/.test(s))
    .slice(0, 10);

  const cityDurations = parseCityDurations(graph);

  const itineraryText = pickLatestItineraryAssistantText(turns);
  let dayPlans = parseDayBlocksFromText(itineraryText);
  if (!dayPlans.length) {
    dayPlans = buildFallbackDayPlans({
      totalDays,
      cityDurations,
      destinations,
    });
  }

  if (totalDays && dayPlans.length && dayPlans.length !== totalDays) {
    const fallback = buildFallbackDayPlans({ totalDays, cityDurations, destinations });
    for (const f of fallback) {
      if (!dayPlans.find((x) => x.day === f.day)) dayPlans.push(f);
    }
    dayPlans = dayPlans
      .sort((a, b) => a.day - b.day)
      .filter((x) => x.day <= totalDays)
      .slice(0, totalDays);
  }

  const latestUser = clean(turns[turns.length - 1]?.userText || "", 120);
  const summary = clean(`${goalStatement}。${latestUser ? `当前用户补充：${latestUser}` : ""}`, 220);

  const lastTurnAt = turns[turns.length - 1]?.createdAt
    ? new Date(turns[turns.length - 1].createdAt as any).toISOString()
    : params.previous?.source?.lastTurnAt;

  return {
    version: Math.max(1, Number(graph.version) || 1),
    updatedAt: new Date().toISOString(),
    summary,
    destinations,
    constraints,
    totalDays,
    budget:
      totalBudget != null || spentBudget != null || remainingBudget != null
        ? {
            totalCny: totalBudget,
            spentCny: spentBudget,
            remainingCny: remainingBudget,
          }
        : undefined,
    dayPlans,
    source: {
      turnCount: turns.length,
      lastTurnAt,
    },
  };
}

export function buildTravelPlanText(plan: TravelPlanState): string {
  const lines: string[] = [];
  lines.push("旅行计划导出");
  lines.push("");
  lines.push(`摘要：${plan.summary || "（暂无摘要）"}`);

  if (plan.destinations?.length) {
    lines.push(`目的地：${plan.destinations.join("、")}`);
  }
  if (plan.totalDays) {
    lines.push(`总天数：${plan.totalDays}天`);
  }

  if (plan.budget) {
    const b = plan.budget;
    lines.push("预算：");
    if (b.totalCny != null) lines.push(`- 总预算：${b.totalCny}元`);
    if (b.spentCny != null) lines.push(`- 已花预算：${b.spentCny}元`);
    if (b.remainingCny != null) lines.push(`- 剩余预算：${b.remainingCny}元`);
  }

  if (plan.constraints?.length) {
    lines.push("关键约束：");
    for (const c of plan.constraints) {
      lines.push(`- ${c}`);
    }
  }

  lines.push("");
  lines.push("按天行程：");
  if (!plan.dayPlans?.length) {
    lines.push("- 暂无按天行程，请继续对话补全。");
  } else {
    for (const day of plan.dayPlans) {
      lines.push(`第${day.day}天${day.city ? `（${day.city}）` : ""}：${day.title || "行程安排"}`);
      for (const item of day.items || []) {
        lines.push(`  - ${item}`);
      }
    }
  }

  return lines.join("\n");
}
