import type { CDG, ConceptNode } from "../../core/graph.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "../graphUpdater/intentSignals.js";

export type TravelPlanDay = {
  day: number;
  city?: string;
  dateLabel?: string;
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
  narrativeText?: string;
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

const DAY_HEADER_RE =
  /(第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}|[0-9]{1,2}[\.、]\s*第\s*[一二三四五六七八九十两0-9]{1,3}\s*天)\s*[:：\-]?/gi;

const DESTINATION_NOISE_RE =
  /(一个人|独自|自己|我们|我和|父母|家人|全家|去|前往|抵达|飞到|旅游|旅行|游玩|玩|现场观看|看球|比赛|球赛|预算|人民币|安全一点|地方吧)/i;

function normalizeDestinationLabel(raw: string): string {
  let s = normalizeDestination(raw || "");
  if (!s) return "";
  s = s
    .replace(/^(?:我(?:和[^，。；\s]{0,8})?|我们(?:一家[三四五六七八九十]口)?|一个人|独自|自己|和父母|跟父母|带父母|陪父母|与父母|父母|家人|全家)\s*(?:去|到|前往|飞到|抵达)\s*/i, "")
    .replace(/^(?:去|到|前往|飞到|抵达)\s*/i, "")
    .replace(/(?:旅游|旅行|游玩|玩|出行)$/i, "")
    .replace(/^的+|的+$/g, "")
    .trim();
  s = normalizeDestination(s);
  if (!s || DESTINATION_NOISE_RE.test(s)) return "";
  if (!isLikelyDestinationCandidate(s)) return "";
  return s;
}

function parseDayFromHeader(header: string): number | undefined {
  const s = clean(header, 80);
  const a = s.match(/第\s*([一二三四五六七八九十两0-9]{1,3})\s*天/i);
  if (a?.[1]) return parseDays(a[1]);
  const b = s.match(/day\s*([0-9]{1,2})/i);
  if (b?.[1]) return parseDays(b[1]);
  const c = s.match(/[0-9]{1,2}[\.、]\s*第\s*([一二三四五六七八九十两0-9]{1,3})\s*天/i);
  if (c?.[1]) return parseDays(c[1]);
  return undefined;
}

function splitItineraryItems(body: string): string[] {
  const src = String(body || "");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (x: string) => {
    const v = clean(x, 120)
      .replace(/^[-•*]\s*/, "")
      .replace(/^[0-9]{1,2}[\.、]\s*/, "");
    if (!v || seen.has(v)) return;
    if (/[？?]$/.test(v) && v.length < 30) return;
    seen.add(v);
    out.push(v);
  };

  const lineBulletRe = /(?:^|[\n\r])\s*(?:[-•*]|[0-9]{1,2}[\.、])\s*([^\n\r]{4,140})/g;
  for (const m of src.matchAll(lineBulletRe)) {
    if (m?.[1]) push(m[1]);
  }

  const timeRe =
    /(上午|早上|中午|下午|傍晚|晚上|夜间|晚间|午后)\s*[：: ]?\s*([^。；;\n\r]{2,140})/g;
  for (const m of src.matchAll(timeRe)) {
    if (m?.[1] && m?.[2]) push(`${m[1]}：${m[2]}`);
  }

  if (!out.length) {
    const sentenceRe = /([^。；;\n\r]{6,140})/g;
    for (const m of src.matchAll(sentenceRe)) {
      if (!m?.[1]) continue;
      const seg = clean(m[1], 120);
      if (/^(行程|建议|安排|预算|交通建议|住宿建议|请问|你觉得|是否)/.test(seg)) continue;
      push(seg);
      if (out.length >= 8) break;
    }
  }

  return out.slice(0, 8);
}

function parseDayBlocksFromText(text: string): TravelPlanDay[] {
  const src = String(text || "").replace(/\r/g, "");
  if (!src.trim()) return [];

  type Header = { day: number; start: number; bodyStart: number };
  const headers: Header[] = [];
  for (const m of src.matchAll(DAY_HEADER_RE)) {
    const token = m?.[1] || "";
    const day = parseDayFromHeader(token);
    if (!day) continue;
    const full = String(m[0] || "");
    const tokenOffset = full.lastIndexOf(token);
    const start = (Number(m.index) || 0) + Math.max(0, tokenOffset);
    const bodyStart = (Number(m.index) || 0) + full.length;
    headers.push({ day, start, bodyStart });
  }
  if (!headers.length) return [];

  headers.sort((a, b) => a.start - b.start);
  const out: TravelPlanDay[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const cur = headers[i];
    const next = headers[i + 1];
    const rawBody = src.slice(cur.bodyStart, next ? next.start : src.length).trim();
    const items = splitItineraryItems(rawBody);
    const firstSentence = clean(rawBody.split(/[。；;\n\r]/)[0] || "", 64);
    const title = clean(
      firstSentence
        .replace(/\s*[0-9]{1,2}[\.、]\s*.+$/g, "")
        .replace(/^（[^）]{1,12}）\s*[:：]?\s*/g, "")
        .trim(),
      48
    ) || `第${cur.day}天行程`;
    out.push({
      day: cur.day,
      title,
      items: items.length ? items : ["根据当日节奏进行景点、餐饮和交通安排。"],
    });
  }

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
        `上午：围绕${city}安排核心地标或必去点。`,
        "下午：补充博物馆/街区漫步等次重点活动。",
        "晚上：安排本地餐厅并预留机动时间。",
      ],
    });
  }
  return out;
}

function scoreItineraryText(text: string): number {
  const t = String(text || "");
  if (!t.trim()) return -1;
  const dayMarkers = (t.match(/第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/gi) || []).length;
  const timeMarkers = (t.match(/上午|早上|中午|下午|傍晚|晚上|夜间|晚间/g) || []).length;
  const listMarkers = (t.match(/[0-9]{1,2}[\.、]/g) || []).length + (t.match(/[-•*]\s/g) || []).length;
  const hasPlanCue = /(行程|安排|建议|第1天|第一天|Day 1)/i.test(t) ? 1 : 0;
  const hasQuestionTail = /(请问|你觉得|是否|吗？|吗\?|还有什么|需要调整)/.test(clean(t.slice(-120), 140)) ? 1 : 0;
  return dayMarkers * 4 + timeMarkers * 2 + Math.min(listMarkers, 8) + hasPlanCue * 2 - hasQuestionTail;
}

function pickBestItineraryAssistantText(turns: Array<{ assistantText: string }>): string {
  let bestText = "";
  let bestScore = -Infinity;
  for (let i = 0; i < turns.length; i += 1) {
    const t = String(turns[i]?.assistantText || "");
    const score = scoreItineraryText(t);
    if (score > bestScore || (score === bestScore && i === turns.length - 1)) {
      bestScore = score;
      bestText = t;
    }
  }
  return bestText || String(turns[turns.length - 1]?.assistantText || "");
}

function extractNarrativeText(text: string): string {
  const src = String(text || "").trim();
  if (!src) return "";
  const dayHeaderIdx = src.search(/第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/i);
  const start = dayHeaderIdx >= 0 ? Math.max(0, dayHeaderIdx - 40) : 0;
  let out = clean(src.slice(start), 3600);
  out = out.replace(/(?:你对.*(?:吗|？|\?)|请问.*(?:吗|？|\?)|是否需要.*(?:吗|？|\?)).*$/i, "").trim();
  return out;
}

function parseDateRangeFromTurns(
  turns: Array<{ userText: string }>
): { startMonth: number; startDay: number } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = String(turns[i]?.userText || "");
    if (!text) continue;

    const cross = text.match(/([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})月([0-9]{1,2})日?/);
    if (cross?.[1] && cross?.[2]) {
      return { startMonth: Number(cross[1]), startDay: Number(cross[2]) };
    }

    const same = text.match(/([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/);
    if (same?.[1] && same?.[2]) {
      return { startMonth: Number(same[1]), startDay: Number(same[2]) };
    }
  }
  return null;
}

function addDateLabelsToDayPlans(
  dayPlans: TravelPlanDay[],
  dateAnchor: { startMonth: number; startDay: number } | null
): TravelPlanDay[] {
  if (!dateAnchor || !dayPlans.length) return dayPlans;
  const start = new Date(2026, dateAnchor.startMonth - 1, dateAnchor.startDay);
  if (Number.isNaN(start.getTime())) return dayPlans;
  return dayPlans.map((d) => {
    const offset = Math.max(0, (Number(d.day) || 1) - 1);
    const dt = new Date(start.getTime());
    dt.setDate(start.getDate() + offset);
    const dateLabel = `${dt.getMonth() + 1}月${dt.getDate()}日`;
    return { ...d, dateLabel };
  });
}

function buildSummary(params: {
  goalStatement: string;
  destinations: string[];
  totalDays?: number;
  totalBudget?: number;
  spentBudget?: number;
  remainingBudget?: number;
  constraints: string[];
}) {
  const parts: string[] = [];
  const goal = clean(params.goalStatement || "", 100);
  if (goal) parts.push(goal);
  if (params.destinations.length) parts.push(`目的地：${params.destinations.join("、")}`);
  if (params.totalDays) parts.push(`总时长：${params.totalDays}天`);
  if (params.totalBudget != null) {
    const budgetPart: string[] = [`总预算${params.totalBudget}元`];
    if (params.spentBudget != null) budgetPart.push(`已花${params.spentBudget}元`);
    if (params.remainingBudget != null) budgetPart.push(`剩余${params.remainingBudget}元`);
    parts.push(`预算：${budgetPart.join("，")}`);
  }
  if (params.constraints.length) {
    parts.push(`关键约束：${params.constraints.slice(0, 2).join("；")}`);
  }
  return clean(parts.join("。"), 240);
}

function parseCityDurations(graph: CDG): Array<{ city: string; days: number }> {
  const out: Array<{ city: string; days: number }> = [];
  for (const n of graph.nodes || []) {
    const s = clean(n.statement, 120);
    const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    if (!m?.[1] || !m?.[2]) continue;
    const city = normalizeDestinationLabel(clean(m[1], 24));
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
    .map((n) => normalizeDestinationLabel(clean(String(n.statement || "").split(/[:：]/)[1] || "", 30)))
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

  const itineraryText = pickBestItineraryAssistantText(turns);
  const narrativeText = extractNarrativeText(itineraryText);
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

  const dateAnchor = parseDateRangeFromTurns(turns);
  dayPlans = addDateLabelsToDayPlans(dayPlans, dateAnchor);

  const summary = buildSummary({
    goalStatement,
    destinations,
    totalDays,
    totalBudget,
    spentBudget,
    remainingBudget,
    constraints,
  });

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
    narrativeText,
    dayPlans,
    source: {
      turnCount: turns.length,
      lastTurnAt,
    },
  };
}

export function buildTravelPlanText(plan: TravelPlanState): string {
  const lines: string[] = [];
  lines.push("旅行计划（可执行版）");
  lines.push("");
  lines.push(`行程摘要：${plan.summary || "（暂无摘要）"}`);

  if (plan.destinations?.length) {
    lines.push(`目的地：${plan.destinations.join("、")}`);
  }
  if (plan.totalDays) {
    lines.push(`总时长：${plan.totalDays}天`);
  }

  if (plan.budget) {
    const b = plan.budget;
    lines.push("预算总览：");
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

  if (plan.narrativeText) {
    lines.push("");
    lines.push("详细建议：");
    lines.push(plan.narrativeText);
  }

  lines.push("");
  lines.push("按天行程：");
  if (!plan.dayPlans?.length) {
    lines.push("- 暂无按天行程，请继续对话补全。");
  } else {
    for (const day of plan.dayPlans) {
      const datePart = day.dateLabel ? `（${day.dateLabel}${day.city ? `，${day.city}` : ""}）` : day.city ? `（${day.city}）` : "";
      lines.push(`第${day.day}天${datePart}：${day.title || "行程安排"}`);
      for (const item of day.items || []) {
        lines.push(`  - ${item}`);
      }
    }
  }

  return lines.join("\n");
}
