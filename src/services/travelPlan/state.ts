import type { CDG, ConceptNode } from "../../core/graph.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "../graphUpdater/intentSignals.js";
import {
  buildBudgetLedgerFromUserTurns,
  type BudgetEvent,
} from "./budgetLedger.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

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
    pendingCny?: number;
  };
  budgetLedger?: BudgetEvent[];
  budgetSummary?: {
    totalCny?: number;
    spentCny?: number;
    remainingCny?: number;
    pendingCny?: number;
  };
  narrativeText?: string;
  exportNarrative?: string;
  evidenceAppendix?: Array<{
    title: string;
    content: string;
    source: "dialogue" | "budget" | "graph";
  }>;
  dayPlans: TravelPlanDay[];
  source: {
    turnCount: number;
    lastTurnAt?: string;
  };
};

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

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

const FX_SNAPSHOT_RATE_TO_CNY: Record<string, number> = {
  CNY: 1,
  RMB: 1,
  EUR: 7.9,
  USD: 7.2,
  GBP: 9.1,
  HKD: 0.92,
  JPY: 0.05,
  KRW: 0.0054,
  SGD: 5.35,
};

function normalizeCurrency(raw: string): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "€" || s === "eur" || s === "欧元") return "EUR";
  if (s === "$" || s === "usd" || s === "美元") return "USD";
  if (s === "£" || s === "gbp" || s === "英镑") return "GBP";
  if (s === "hkd" || s === "港币" || s === "港元") return "HKD";
  if (s === "jpy" || s === "yen" || s === "円" || s === "日元") return "JPY";
  if (s === "krw" || s === "韩元") return "KRW";
  if (s === "sgd" || s === "新币" || s === "新加坡元") return "SGD";
  if (s === "人民币" || s === "元" || s === "块" || s === "cny" || s === "rmb") return "CNY";
  return "";
}

type ParsedBudgetAmount = {
  amountCny?: number;
  amountOriginal?: number;
  currency?: string;
  hasExplicitCurrency: boolean;
};

function parseDays(raw: string): number | undefined {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= 365) return Math.round(n);
  const cn = parseCnInt(raw);
  if (cn && cn > 0 && cn <= 365) return cn;
  return undefined;
}

function nodeByKey(graph: CDG, key: string): ConceptNode | undefined {
  return (graph.nodes || [])
    .filter((n) => String((n as any).key || "") === key)
    .sort((a, b) => {
      const statusRank = (x: ConceptNode) =>
        x.status === "confirmed" ? 3 : x.status === "proposed" ? 2 : x.status === "disputed" ? 1 : 0;
      const rankDiff = statusRank(b) - statusRank(a);
      if (rankDiff !== 0) return rankDiff;
      return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
    })[0];
}

function statementBodyByPrefixes(statement: string, prefixes: string[]): string {
  const s = clean(statement, 220);
  for (const p of prefixes) {
    const re = new RegExp(`^${p}\\s*[:：]\\s*`, "i");
    if (re.test(s)) return s.replace(re, "").trim();
  }
  return "";
}

function parseAmountFromNodeStatement(node: ConceptNode | undefined, prefixes: string[]): ParsedBudgetAmount {
  if (!node) return { hasExplicitCurrency: false };
  const body = statementBodyByPrefixes(String(node.statement || ""), prefixes);
  if (!body) return { hasExplicitCurrency: false };

  const withCurrency = body.match(
    /([0-9]{1,12}(?:\.[0-9]{1,2})?)\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円|韩元|krw|新币|新加坡元|sgd|人民币|cny|rmb|元|块)/i
  );
  if (withCurrency?.[1] && withCurrency?.[2]) {
    const amountOriginal = parseMoney(withCurrency[1]);
    const currency = normalizeCurrency(withCurrency[2]);
    const rate = currency ? FX_SNAPSHOT_RATE_TO_CNY[currency] : undefined;
    if (amountOriginal != null && Number.isFinite(Number(rate)) && Number(rate) > 0) {
      return {
        amountCny: Math.round(amountOriginal * Number(rate)),
        amountOriginal,
        currency,
        hasExplicitCurrency: currency !== "CNY",
      };
    }
  }

  const m = body.match(/([0-9]{1,12}(?:\.[0-9]{1,2})?)/);
  if (!m?.[1]) return { hasExplicitCurrency: false };
  const amountCny = parseMoney(m[1]);
  if (amountCny == null) return { hasExplicitCurrency: false };
  return { amountCny, hasExplicitCurrency: false };
}

function parseDaysFromNodeStatement(node: ConceptNode | undefined, prefixes: string[]): number | undefined {
  if (!node) return undefined;
  const body = statementBodyByPrefixes(String(node.statement || ""), prefixes);
  if (!body) return undefined;
  const m = body.match(/([0-9]{1,3})/);
  if (!m?.[1]) return undefined;
  return parseDays(m[1]);
}

const DAY_HEADER_RE =
  /(第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}|[0-9]{1,2}[\.、]\s*第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}\s*[:：\-]?)/gi;
const CONFIRMATION_QUESTION_RE =
  /(请确认|是否是硬约束|是否为硬约束|还是可协商偏好|你希望优先满足哪一项|是否允许微调|这条信息是否是硬约束|please confirm|hard constraint|negotiable preference|which should be prioritized|allow adjustment)/i;

const DESTINATION_NOISE_RE =
  /(一个人|独自|自己|我们|我和|父母|家人|全家|去|前往|抵达|飞到|旅游|旅行|游玩|玩|现场观看|看球|比赛|球赛|预算|人民币|安全一点|地方吧|solo|myself|with family|travel|trip|go to|arrive|flight|budget|safe place)/i;

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
  const d = s.match(/^([0-9]{1,2})[\\.)]\\s*day/i);
  if (d?.[1]) return parseDays(d[1]);
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
    /(上午|早上|中午|下午|傍晚|晚上|夜间|晚间|午后|morning|noon|afternoon|evening|night)\s*[：: ]?\s*([^。；;\n\r]{2,140})/gi;
  for (const m of src.matchAll(timeRe)) {
    if (m?.[1] && m?.[2]) push(`${m[1]}：${m[2]}`);
  }

  if (!out.length) {
    const sentenceRe = /([^。；;\n\r]{6,140})/g;
    for (const m of src.matchAll(sentenceRe)) {
      if (!m?.[1]) continue;
      const seg = clean(m[1], 120);
      if (/^(行程|建议|安排|预算|交通建议|住宿建议|请问|你觉得|是否|itinerary|suggestion|plan|budget|transport|accommodation|question)/i.test(seg)) continue;
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
    const body = rawBody
      .replace(/(?:请问|你觉得|是否需要|是否有|有其他问题|还需要|do you|would you|any other|need me to|confirm).{0,160}(?:吗|？|\?)?$/i, "")
      .trim();
    const items = splitItineraryItems(body).filter((x) => !shouldDropQuestionLikeSentence(x));
    const firstSentence = clean(body.split(/[。；;\n\r]/)[0] || "", 64);
    const title = clean(
      firstSentence
        .replace(/\s*[0-9]{1,2}[\.、]\s*.+$/g, "")
        .replace(/^（[^）]{1,12}）\s*[:：]?\s*/g, "")
        .trim(),
      48
    ) || `Day ${cur.day} Plan`;
    out.push({
      day: cur.day,
      title,
      items: items.length ? items : ["Arrange sights, meals, and transit based on the day pacing."],
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
  locale?: AppLocale;
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

  const defaultCity = params.destinations[0] || t(params.locale, "目的地", "Destination");
  const out: TravelPlanDay[] = [];
  for (let d = 1; d <= total; d += 1) {
    const city = cityTimeline[d - 1] || defaultCity;
    out.push({
      day: d,
      city,
      title: isEnglishLocale(params.locale) ? `${city} Day ${d}` : `${city}第${d}天`,
      items: [
        t(params.locale, `上午：围绕${city}安排核心地标或必去点。`, `Morning: cover must-see landmarks in ${city}.`),
        t(params.locale, "下午：补充博物馆/街区漫步等次重点活动。", "Afternoon: add secondary activities such as museums or district walks."),
        t(params.locale, "晚上：安排本地餐厅并预留机动时间。", "Evening: arrange local dinner and keep buffer time."),
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
  locale?: AppLocale;
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
  if (params.destinations.length)
    parts.push(
      isEnglishLocale(params.locale)
        ? `Destinations: ${params.destinations.join(" / ")}`
        : `目的地：${params.destinations.join("、")}`
    );
  if (params.totalDays)
    parts.push(
      isEnglishLocale(params.locale)
        ? `Total duration: ${params.totalDays} days`
        : `总时长：${params.totalDays}天`
    );
  if (params.totalBudget != null) {
    const budgetPart: string[] = isEnglishLocale(params.locale)
      ? [`total ${params.totalBudget} CNY`]
      : [`总预算${params.totalBudget}元`];
    if (params.spentBudget != null) {
      budgetPart.push(isEnglishLocale(params.locale) ? `spent ${params.spentBudget} CNY` : `已花${params.spentBudget}元`);
    }
    if (params.remainingBudget != null) {
      budgetPart.push(
        isEnglishLocale(params.locale) ? `remaining ${params.remainingBudget} CNY` : `剩余${params.remainingBudget}元`
      );
    }
    parts.push(
      isEnglishLocale(params.locale)
        ? `Budget: ${budgetPart.join(", ")}`
        : `预算：${budgetPart.join("，")}`
    );
  }
  if (params.constraints.length) {
    parts.push(
      isEnglishLocale(params.locale)
        ? `Key constraints: ${params.constraints.slice(0, 2).join("; ")}`
        : `关键约束：${params.constraints.slice(0, 2).join("；")}`
    );
  }
  return clean(parts.join(isEnglishLocale(params.locale) ? ". " : "。"), 260);
}

function parseCityDurations(graph: CDG): Array<{ city: string; days: number }> {
  const out: Array<{ city: string; days: number }> = [];
  for (const n of graph.nodes || []) {
    if (n.status === "rejected") continue;
    const s = clean(n.statement, 120);
    const m = s.match(/^(?:城市时长|停留时长|city duration|stay duration)[:：]\s*(.+?)\s+([0-9]{1,3})\s*(?:天|days?)$/i);
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

function shouldDropQuestionLikeSentence(s: string): boolean {
  const v = clean(s, 200);
  if (!v) return true;
  if (CONFIRMATION_QUESTION_RE.test(v)) return true;
  if (/^(请问|你觉得|是否|还有什么|需要调整|有其他问题吗|do you|would you|is there anything|any adjustments|any other questions)/i.test(v)) return true;
  return false;
}

function normalizeConstraintStatement(s: string): string {
  let out = clean(s, 100);
  if (!out) return "";
  if (CONFIRMATION_QUESTION_RE.test(out)) return "";
  out = out.replace(
    /^限制因素[:：]\s*限制因素[“"']?\s*(.+?)\s*[”"']?\s*是硬约束$/i,
    "限制因素: $1（硬约束）"
  );
  out = out.replace(
    /^限制因素[“"']?\s*(.+?)\s*[”"']?\s*是硬约束$/i,
    "限制因素: $1（硬约束）"
  );
  out = out.replace(
    /^限制因素[“"']?\s*(.+?)\s*[”"']?\s*是可协商偏好$/i,
    "限制因素: $1（可协商偏好）"
  );
  out = out.replace(
    /^Limiting factor[:：]?\s*[\"']?(.+?)[\"']?\s*is a hard constraint$/i,
    "Limiting factor: $1 (hard constraint)"
  );
  out = out.replace(
    /^Limiting factor[:：]?\s*[\"']?(.+?)[\"']?\s*is a negotiable preference$/i,
    "Limiting factor: $1 (negotiable preference)"
  );
  return clean(out, 100);
}

function dedupeParagraphs(text: string, maxLen = 3600): string {
  const src = String(text || "").replace(/\r/g, "");
  if (!src.trim()) return "";
  const parts = src
    .split(/\n{1,}/)
    .map((x) => clean(x, 260))
    .filter(Boolean)
    .filter((x) => !shouldDropQuestionLikeSentence(x));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.replace(/[。；;，,\s]+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return clean(out.join("\n"), maxLen);
}

function buildFallbackNarrativeFromDayPlans(dayPlans: TravelPlanDay[], locale?: AppLocale): string {
  if (!dayPlans.length) return "";
  const lines: string[] = [];
  for (const day of dayPlans) {
    const datePart = day.dateLabel
      ? `（${day.dateLabel}${day.city ? `，${day.city}` : ""}）`
      : day.city
        ? `（${day.city}）`
        : "";
    lines.push(
      isEnglishLocale(locale)
        ? `Day ${day.day}${day.city ? ` (${day.city})` : ""}: ${clean(day.title || "Plan", 64)}`
        : `第${day.day}天${datePart}：${clean(day.title || "行程安排", 64)}`
    );
    for (const item of day.items || []) {
      lines.push(`- ${clean(item, 140)}`);
    }
  }
  return dedupeParagraphs(lines.join("\n"), 4200);
}

function buildExportNarrative(plan: {
  locale?: AppLocale;
  summary: string;
  narrativeText?: string;
  dayPlans: TravelPlanDay[];
}): string {
  const narrative = dedupeParagraphs(String(plan.narrativeText || ""), 4600);
  const hasStructuredDayPlan = /第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/i.test(narrative);
  if (hasStructuredDayPlan && narrative.length >= 80) return narrative;

  const fallback = buildFallbackNarrativeFromDayPlans(plan.dayPlans || [], plan.locale);
  if (fallback) return fallback;
  return dedupeParagraphs(plan.summary || "", 800);
}

export function buildTravelPlanState(params: {
  locale?: AppLocale;
  graph: CDG;
  turns: Array<{ createdAt?: Date | string; userText: string; assistantText: string }>;
  previous?: TravelPlanState | null;
}): TravelPlanState {
  const locale = params.locale;
  const graph = params.graph;
  const turns = params.turns || [];

  const goalNode = (graph.nodes || [])
    .filter((n) => n.type === "goal" && n.status !== "rejected")
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))[0];
  const goalStatement = clean(goalNode?.statement || "", 120) || t(locale, "制定旅行计划", "Plan the trip");

  const destinationNodes = (graph.nodes || [])
    .filter((n) => n.status !== "rejected")
    .filter((n) => /^(目的地|destination)[:：]/i.test(clean(n.statement, 120)) || String((n as any).key || "").startsWith("slot:destination:"))
    .map((n) => {
      const fromKey = String((n as any).key || "").startsWith("slot:destination:")
        ? clean(String((n as any).statement || "").replace(/^(目的地|destination)[:：]/i, ""), 30)
        : clean(String(n.statement || "").split(/[:：]/)[1] || "", 30);
      return normalizeDestinationLabel(fromKey);
    })
    .filter(Boolean);
  const destinations = dedupe(destinationNodes).slice(0, 8);

  const durationNode = nodeByKey(graph, "slot:duration_total");
  const totalDays = parseDaysFromNodeStatement(durationNode, ["总行程时长", "行程时长", "Total duration", "Trip duration"]);

  const budgetNode = nodeByKey(graph, "slot:budget");
  const spentNode = nodeByKey(graph, "slot:budget_spent");
  const remainNode = nodeByKey(graph, "slot:budget_remaining");
  const pendingNode = nodeByKey(graph, "slot:budget_pending");

  const totalBudgetParsed = parseAmountFromNodeStatement(budgetNode, ["预算上限", "预算", "Budget cap", "Budget"]);
  const spentBudgetParsed = parseAmountFromNodeStatement(spentNode, ["已花预算", "Spent budget"]);
  const remainingBudgetParsed = parseAmountFromNodeStatement(remainNode, [
    "剩余预算",
    "可用预算",
    "Remaining budget",
    "Available budget",
  ]);
  const pendingBudgetParsed = parseAmountFromNodeStatement(pendingNode, [
    "待确认预算",
    "待确认支出",
    "Pending budget",
    "Pending spending",
  ]);

  const totalBudget = totalBudgetParsed.amountCny;
  const spentBudget = spentBudgetParsed.amountCny;
  let remainingBudget = remainingBudgetParsed.amountCny;
  const pendingBudget = pendingBudgetParsed.amountCny;
  if (remainingBudget == null && totalBudget != null && spentBudget != null) {
    remainingBudget = Math.max(0, totalBudget - spentBudget);
  }

  const budgetLedger = buildBudgetLedgerFromUserTurns(
    turns.map((t, i) => ({
      text: String(t.userText || ""),
      turnId: `turn_${i + 1}`,
      createdAt: t.createdAt ? new Date(t.createdAt as any).toISOString() : undefined,
    }))
  );
  const ledgerTotal = budgetLedger.summary.totalCny;
  const ledgerSpent = budgetLedger.summary.spentCny;
  const ledgerRemaining = budgetLedger.summary.remainingCny;
  const ledgerPending = budgetLedger.summary.pendingCny;

  const constraints = (graph.nodes || [])
    .filter((n) => n.status !== "rejected")
    .filter((n) => n.type === "constraint")
    .map((n) => normalizeConstraintStatement(n.statement))
    .filter(
      (s) =>
        s &&
        !/^(?:预算(?:上限)?|Budget(?: cap)?)[:：]/i.test(s) &&
        !/^(?:已花预算|Spent budget)[:：]/i.test(s) &&
        !/^(?:剩余预算|可用预算|待确认预算|待确认支出|Remaining budget|Available budget|Pending budget|Pending spending)[:：]/i.test(s) &&
        !/^(?:总行程时长|行程时长|Total duration|Trip duration)[:：]/i.test(s)
    );
  const normalizedConstraints = dedupe(constraints).slice(0, 10);

  const cityDurations = parseCityDurations(graph);

  const itineraryText = pickBestItineraryAssistantText(turns);
  const narrativeText = dedupeParagraphs(extractNarrativeText(itineraryText), 3600);
  let dayPlans = parseDayBlocksFromText(itineraryText);
  if (!dayPlans.length) {
    dayPlans = buildFallbackDayPlans({
      totalDays,
      cityDurations,
      destinations,
      locale,
    });
  }

  if (totalDays && dayPlans.length && dayPlans.length !== totalDays) {
    const fallback = buildFallbackDayPlans({ totalDays, cityDurations, destinations, locale });
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

  const hasGraphCurrencyOverride =
    totalBudgetParsed.hasExplicitCurrency ||
    spentBudgetParsed.hasExplicitCurrency ||
    remainingBudgetParsed.hasExplicitCurrency ||
    pendingBudgetParsed.hasExplicitCurrency;

  let effectiveTotal = ledgerTotal ?? totalBudget;
  let effectiveSpent = ledgerSpent ?? spentBudget;
  let effectiveRemaining = ledgerRemaining ?? remainingBudget;
  let effectivePending = ledgerPending ?? pendingBudget;

  // Manual graph edits with explicit foreign currency (e.g., "60 EUR") should override
  // stale turn-derived ledger values for this export/state snapshot.
  if (hasGraphCurrencyOverride) {
    if (totalBudget != null) effectiveTotal = totalBudget;
    if (spentBudget != null) effectiveSpent = spentBudget;
    if (pendingBudget != null) effectivePending = pendingBudget;
    if (remainingBudget != null) effectiveRemaining = remainingBudget;
    if (effectiveTotal != null && effectiveSpent != null) {
      effectiveRemaining = Math.max(0, effectiveTotal - effectiveSpent);
    }
  }

  const summary = buildSummary({
    locale,
    goalStatement,
    destinations,
    totalDays,
    totalBudget: effectiveTotal,
    spentBudget: effectiveSpent,
    remainingBudget: effectiveRemaining,
    constraints: normalizedConstraints,
  });

  const lastTurnAt = turns[turns.length - 1]?.createdAt
    ? new Date(turns[turns.length - 1].createdAt as any).toISOString()
    : params.previous?.source?.lastTurnAt;

  const effectiveBudget = {
    totalCny: effectiveTotal,
    spentCny: effectiveSpent,
    remainingCny: effectiveRemaining,
    pendingCny: effectivePending,
  };
  const evidenceAppendix: Array<{ title: string; content: string; source: "dialogue" | "budget" | "graph" }> = [];
  for (const ev of budgetLedger.events.slice(-10)) {
    evidenceAppendix.push({
      title: isEnglishLocale(locale) ? `Budget event · ${ev.type}` : `预算事件 · ${ev.type}`,
      content: `${ev.evidence}${ev.amountCny != null ? (isEnglishLocale(locale) ? ` (${ev.amountCny} CNY)` : `（${ev.amountCny}元）`) : ""}`,
      source: "budget",
    });
  }
  for (const c of normalizedConstraints.slice(0, 6)) {
    evidenceAppendix.push({
      title: isEnglishLocale(locale) ? "Constraint evidence" : "约束证据",
      content: c,
      source: "graph",
    });
  }
  for (const t of turns.slice(-8)) {
    const u = clean(t.userText || "", 140);
    if (!u || shouldDropQuestionLikeSentence(u)) continue;
    evidenceAppendix.push({
      title: isEnglishLocale(locale) ? "User utterance" : "用户原句",
      content: u,
      source: "dialogue",
    });
  }
  const appendixMap = new Map<string, { title: string; content: string; source: "dialogue" | "budget" | "graph" }>();
  for (const e of evidenceAppendix) {
    const key = `${e.source}::${clean(e.title, 60)}::${clean(e.content, 180)}`;
    if (!appendixMap.has(key)) appendixMap.set(key, e);
  }
  const dedupAppendix = Array.from(appendixMap.values()).slice(0, 20);

  const exportNarrative = buildExportNarrative({
    locale,
    summary,
    narrativeText,
    dayPlans,
  });

  return {
    version: Math.max(1, Number(graph.version) || 1),
    updatedAt: new Date().toISOString(),
    summary,
    destinations,
    constraints: normalizedConstraints,
    totalDays,
    budget:
      effectiveBudget.totalCny != null ||
      effectiveBudget.spentCny != null ||
      effectiveBudget.remainingCny != null ||
      effectiveBudget.pendingCny != null
        ? {
            totalCny: effectiveBudget.totalCny,
            spentCny: effectiveBudget.spentCny,
            remainingCny: effectiveBudget.remainingCny,
            pendingCny: effectiveBudget.pendingCny,
          }
        : undefined,
    budgetSummary: effectiveBudget,
    budgetLedger: budgetLedger.events,
    narrativeText,
    exportNarrative,
    evidenceAppendix: dedupAppendix,
    dayPlans,
    source: {
      turnCount: turns.length,
      lastTurnAt,
    },
  };
}

export function buildTravelPlanText(plan: TravelPlanState, locale?: AppLocale): string {
  const lines: string[] = [];
  lines.push(t(locale, "旅行计划（可执行版）", "Travel Plan (Executable Version)"));
  lines.push("");
  lines.push(
    isEnglishLocale(locale)
      ? `Summary: ${plan.summary || "(no summary)"}`
      : `行程摘要：${plan.summary || "（暂无摘要）"}`
  );

  if (plan.destinations?.length) {
    lines.push(
      isEnglishLocale(locale)
        ? `Destinations: ${plan.destinations.join(" / ")}`
        : `目的地：${plan.destinations.join("、")}`
    );
  }
  if (plan.totalDays) {
    lines.push(isEnglishLocale(locale) ? `Total duration: ${plan.totalDays} days` : `总时长：${plan.totalDays}天`);
  }

  if (plan.budget) {
    const b = plan.budget;
    lines.push(t(locale, "预算总览：", "Budget Overview:"));
    if (b.totalCny != null)
      lines.push(isEnglishLocale(locale) ? `- Total budget: ${b.totalCny} CNY` : `- 总预算：${b.totalCny}元`);
    if (b.spentCny != null)
      lines.push(isEnglishLocale(locale) ? `- Spent: ${b.spentCny} CNY` : `- 已花预算：${b.spentCny}元`);
    if (b.remainingCny != null)
      lines.push(isEnglishLocale(locale) ? `- Remaining: ${b.remainingCny} CNY` : `- 剩余预算：${b.remainingCny}元`);
    if (b.pendingCny != null && b.pendingCny > 0)
      lines.push(isEnglishLocale(locale) ? `- Pending: ${b.pendingCny} CNY` : `- 待确认支出：${b.pendingCny}元`);
  }

  if (plan.constraints?.length) {
    lines.push(t(locale, "关键约束：", "Key Constraints:"));
    for (const c of plan.constraints) {
      lines.push(`- ${c}`);
    }
  }

  const narrativeHasDay = /第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/i.test(
    String(plan.exportNarrative || "")
  );

  if (plan.exportNarrative) {
    lines.push("");
    lines.push(t(locale, "可执行行程：", "Executable Itinerary:"));
    lines.push(plan.exportNarrative);
  }

  if (!narrativeHasDay) {
    lines.push("");
    lines.push(t(locale, "按天行程：", "Day-by-Day Plan:"));
    if (!plan.dayPlans?.length) {
      lines.push(t(locale, "- 暂无按天行程，请继续对话补全。", "- No day-by-day plan yet. Continue the conversation to complete it."));
    } else {
      for (const day of plan.dayPlans) {
        const datePart = day.dateLabel ? `（${day.dateLabel}${day.city ? `，${day.city}` : ""}）` : day.city ? `（${day.city}）` : "";
        lines.push(
          isEnglishLocale(locale)
            ? `Day ${day.day}${day.city ? ` (${day.city})` : ""}: ${day.title || "Plan"}`
            : `第${day.day}天${datePart}：${day.title || "行程安排"}`
        );
        for (const item of day.items || []) {
          lines.push(`  - ${item}`);
        }
      }
    }
  }

  if (plan.evidenceAppendix?.length) {
    lines.push("");
    lines.push(t(locale, "附录（证据片段）：", "Appendix (Evidence Snippets):"));
    for (const e of plan.evidenceAppendix.slice(0, 20)) {
      lines.push(
        isEnglishLocale(locale)
          ? `- [${e.source}] ${e.title}: ${e.content}`
          : `- [${e.source}] ${e.title}：${e.content}`
      );
    }
  }

  return lines.join("\n");
}
