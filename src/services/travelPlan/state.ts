import type { CDG, ConceptNode } from "../../core/graph.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "../graphUpdater/intentSignals.js";
import {
  buildBudgetLedgerFromUserTurns,
  type BudgetEvent,
} from "./budgetLedger.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "../motif/conceptMotifs.js";

export type TravelPlanDay = {
  day: number;
  city?: string;
  dateLabel?: string;
  title: string;
  items: string[];
};

export type TravelPlanAssistantPlan = {
  sourceTurnIndex: number;
  sourceTurnCreatedAt?: string;
  rawText: string;
  narrative: string;
  parser: "day_header" | "date_header" | "mixed" | "fallback";
  dayPlans: TravelPlanDay[];
};

export type TravelPlanSourceLabel =
  | "assistant_proposed"
  | "user_confirmed"
  | "co_authored"
  | "transferred_pattern_based";

export type TravelPlanSourceMap = Record<
  string,
  {
    source_label: TravelPlanSourceLabel;
    notes?: string;
  }
>;

export type TravelPlanChangelogItem = {
  plan_version: number;
  changed_at: string;
  action: "plan_initialized" | "plan_updated" | "plan_unchanged";
  summary: string;
  source_label: TravelPlanSourceLabel;
};

export type TravelPlanTaskHistorySegment = {
  task_id: string;
  trip_title: string;
  destination_scope: string[];
  travelers: string[];
  duration?: string;
  trip_goal_summary: string;
  export_ready_text: string;
  open_questions: string[];
  rationale_refs: string[];
  source_map: TravelPlanSourceMap;
  status: "archived" | "active";
  closed_at: string;
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
  assistantPlan?: TravelPlanAssistantPlan;
  evidenceAppendix?: Array<{
    title: string;
    content: string;
    source: "dialogue" | "budget" | "graph";
  }>;
  dayPlans: TravelPlanDay[];
  task_id: string;
  plan_version: number;
  destination_scope: string[];
  travel_dates_or_duration?: string;
  travelers: string[];
  trip_goal_summary: string;
  candidate_options: string[];
  itinerary_outline: string[];
  day_by_day_plan: TravelPlanDay[];
  transport_plan: string[];
  stay_plan: string[];
  food_plan: string[];
  risk_notes: string[];
  budget_notes: string[];
  open_questions: string[];
  rationale_refs: string[];
  source_map: TravelPlanSourceMap;
  export_ready_text: string;
  changelog: TravelPlanChangelogItem[];
  task_history?: TravelPlanTaskHistorySegment[];
  last_updated: string;
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
const DATE_HEADER_RE = /([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日/g;
const STRUCTURED_ITINERARY_RE =
  /第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}|[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日/i;
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

function parseDateBlocksFromText(text: string): TravelPlanDay[] {
  const src = String(text || "").replace(/\r/g, "");
  if (!src.trim()) return [];

  type Header = { dateLabel: string; start: number; bodyStart: number };
  const headers: Header[] = [];
  for (const m of src.matchAll(DATE_HEADER_RE)) {
    if (!m?.[0] || !m?.[1] || !m?.[2]) continue;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const dateLabel = `${month}月${day}日`;
    const start = Number(m.index) || 0;
    const bodyStart = start + String(m[0]).length;
    headers.push({ dateLabel, start, bodyStart });
  }
  if (!headers.length) return [];

  const orderedHeaders = headers.sort((a, b) => a.start - b.start);
  const dedupHeaders: Header[] = [];
  for (const h of orderedHeaders) {
    const prev = dedupHeaders[dedupHeaders.length - 1];
    if (prev && prev.dateLabel === h.dateLabel && Math.abs(prev.start - h.start) <= 2) continue;
    dedupHeaders.push(h);
  }

  const out: TravelPlanDay[] = [];
  for (let i = 0; i < dedupHeaders.length; i += 1) {
    const cur = dedupHeaders[i];
    const next = dedupHeaders[i + 1];
    const rawBody = src.slice(cur.bodyStart, next ? next.start : src.length).trim();
    const body = rawBody
      .replace(/(?:请问|你觉得|是否需要|是否有|有其他问题|还需要|do you|would you|any other|need me to|confirm).{0,160}(?:吗|？|\?)?$/i, "")
      .trim();
    if (!body) continue;
    const items = splitItineraryItems(body).filter((x) => !shouldDropQuestionLikeSentence(x));
    if (!items.length && clean(body, 200).length < 10) continue;
    const firstSentence = clean(body.split(/[。；;\n\r]/)[0] || "", 64);
    const title = clean(
      firstSentence
        .replace(/^(上午|早上|中午|下午|傍晚|晚上|夜间|晚间|午后)\s*[：:]\s*/i, "")
        .trim(),
      48
    ) || `${cur.dateLabel} 行程`;
    out.push({
      day: out.length + 1,
      dateLabel: cur.dateLabel,
      title,
      items: items.length ? items : [clean(body, 160)],
    });
  }

  return out;
}

function scoreParsedDayPlans(dayPlans: TravelPlanDay[], expectedDays?: number): number {
  if (!dayPlans.length) return -1;
  const itemCount = dayPlans.reduce((sum, d) => sum + Math.min(8, (d.items || []).length), 0);
  const datedCount = dayPlans.filter((d) => String(d.dateLabel || "").trim()).length;
  let score = dayPlans.length * 8 + itemCount * 2 + datedCount;
  if (expectedDays && expectedDays > 0) {
    if (dayPlans.length === expectedDays) score += 10;
    else score -= Math.min(12, Math.abs(dayPlans.length - expectedDays) * 3);
  }
  return score;
}

function pickBestParsedDayPlans(params: {
  byDayHeader: TravelPlanDay[];
  byDateHeader: TravelPlanDay[];
  expectedDays?: number;
}): { dayPlans: TravelPlanDay[]; parser: "day_header" | "date_header" | "mixed" | "fallback" } {
  const dayScore = scoreParsedDayPlans(params.byDayHeader, params.expectedDays);
  const dateScore = scoreParsedDayPlans(params.byDateHeader, params.expectedDays);

  if (dayScore < 0 && dateScore < 0) return { dayPlans: [], parser: "fallback" };
  if (dayScore >= 0 && dateScore < 0) return { dayPlans: params.byDayHeader, parser: "day_header" };
  if (dayScore < 0 && dateScore >= 0) return { dayPlans: params.byDateHeader, parser: "date_header" };

  const chooseDate = dateScore > dayScore;
  if (chooseDate) return { dayPlans: params.byDateHeader, parser: "date_header" };

  const merged = params.byDayHeader.map((d, idx) => {
    const fromDate = params.byDateHeader[idx];
    if (!fromDate?.dateLabel || String(d.dateLabel || "").trim()) return d;
    return { ...d, dateLabel: fromDate.dateLabel };
  });
  const parser = params.byDateHeader.length > 0 ? "mixed" : "day_header";
  return { dayPlans: merged, parser };
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
  const dateMarkers = (t.match(/[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日/g) || []).length;
  const timeMarkers = (t.match(/上午|早上|中午|下午|傍晚|晚上|夜间|晚间/g) || []).length;
  const listMarkers = (t.match(/[0-9]{1,2}[\.、]/g) || []).length + (t.match(/[-•*]\s/g) || []).length;
  const hasPlanCue = /(行程|安排|建议|第1天|第一天|Day 1|月[0-9]{1,2}日)/i.test(t) ? 1 : 0;
  const hasQuestionTail = /(请问|你觉得|是否|吗？|吗\?|还有什么|需要调整)/.test(clean(t.slice(-120), 140)) ? 1 : 0;
  return dayMarkers * 4 + dateMarkers * 3 + timeMarkers * 2 + Math.min(listMarkers, 8) + hasPlanCue * 2 - hasQuestionTail;
}

function pickBestItineraryAssistantText(
  turns: Array<{ createdAt?: Date | string; assistantText: string }>
): { text: string; turnIndex: number } {
  if (!turns.length) return { text: "", turnIndex: -1 };
  let bestText = "";
  let bestIndex = turns.length - 1;
  let bestScore = -Infinity;
  for (let i = 0; i < turns.length; i += 1) {
    const t = String(turns[i]?.assistantText || "");
    const score = scoreItineraryText(t);
    if (score > bestScore || (score === bestScore && i === turns.length - 1)) {
      bestScore = score;
      bestText = t;
      bestIndex = i;
    }
  }
  if (!bestText) {
    bestIndex = turns.length - 1;
    bestText = String(turns[bestIndex]?.assistantText || "");
  }
  return { text: bestText, turnIndex: bestIndex };
}

function extractNarrativeText(text: string): string {
  const src = String(text || "").trim();
  if (!src) return "";
  const dayHeaderIdx = src.search(STRUCTURED_ITINERARY_RE);
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

function stripQuestionTail(s: string): string {
  const src = clean(s, 2200);
  if (!src) return "";
  return src
    .replace(
      /(?:请确认|请问|你觉得|是否需要|是否有|有其他问题|还有其他问题|还有其他需要调整|还需要我|do you|would you|any other|need me to|confirm).{0,180}(?:吗|？|\?)?$/i,
      ""
    )
    .trim();
}

function dedupeParagraphs(text: string, maxLen = 3600): string {
  const src = String(text || "").replace(/\r/g, "");
  if (!src.trim()) return "";
  const lineMax = Math.max(260, Math.min(2000, maxLen));
  const parts = src
    .split(/\n{1,}/)
    .map((x) => stripQuestionTail(clean(x, lineMax)))
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
  assistantPlan?: TravelPlanAssistantPlan;
}): string {
  const assistantNarrative = dedupeParagraphs(
    String(plan.assistantPlan?.narrative || plan.assistantPlan?.rawText || ""),
    5200
  );
  if (assistantNarrative.length >= 80) return assistantNarrative;

  const narrative = dedupeParagraphs(String(plan.narrativeText || ""), 4600);
  const hasStructuredDayPlan = STRUCTURED_ITINERARY_RE.test(narrative);
  if ((hasStructuredDayPlan && narrative.length >= 80) || narrative.length >= 220) return narrative;

  const fallback = buildFallbackNarrativeFromDayPlans(plan.dayPlans || [], plan.locale);
  if (fallback) return fallback;
  return dedupeParagraphs(plan.summary || "", 800);
}

function extractTravelers(graph: CDG, locale?: AppLocale): string[] {
  const out: string[] = [];
  const push = (raw: any) => {
    const x = clean(raw, 48);
    if (!x) return;
    if (!out.includes(x)) out.push(x);
  };

  const peopleNode = nodeByKey(graph, "slot:people");
  const peopleBody = statementBodyByPrefixes(String(peopleNode?.statement || ""), ["出行人数", "同行人", "Travelers", "Traveler"]);
  if (peopleBody) push(peopleBody);

  for (const n of graph.nodes || []) {
    if (n.status === "rejected") continue;
    const key = clean((n as any).key, 80).toLowerCase();
    const statement = clean(n.statement, 140);
    if (!statement) continue;
    if (key.startsWith("slot:people")) {
      push(statementBodyByPrefixes(statement, ["出行人数", "同行人", "Travelers", "Traveler"]) || statement);
      continue;
    }
    const explicit = statement.match(/^(?:出行人数|同行人|Travelers?|Traveler)[:：]\s*(.+)$/i);
    if (explicit?.[1]) push(explicit[1]);
  }

  if (out.length) return out.slice(0, 6);
  return [t(locale, "待确认", "TBD")];
}

function buildTravelDatesOrDuration(totalDays: number | undefined, dateAnchor: { startMonth: number; startDay: number } | null, locale?: AppLocale): string | undefined {
  if (dateAnchor && totalDays && totalDays > 0) {
    const start = new Date(2026, dateAnchor.startMonth - 1, dateAnchor.startDay);
    const end = new Date(start.getTime());
    end.setDate(start.getDate() + Math.max(0, totalDays - 1));
    return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()} (${totalDays}${isEnglishLocale(locale) ? "d" : "天"})`;
  }
  if (totalDays && totalDays > 0) {
    return isEnglishLocale(locale) ? `${totalDays} days` : `${totalDays}天`;
  }
  return undefined;
}

function collectItineraryOutline(dayPlans: TravelPlanDay[], locale?: AppLocale): string[] {
  return (dayPlans || [])
    .slice(0, 20)
    .map((day) => {
      const datePart = day.dateLabel ? `${day.dateLabel}${day.city ? ` · ${day.city}` : ""}` : day.city || "";
      const head = isEnglishLocale(locale) ? `Day ${day.day}` : `第${day.day}天`;
      const body = clean(day.title, 80) || t(locale, "行程安排", "Plan");
      return clean(`${head}${datePart ? ` (${datePart})` : ""}: ${body}`, 180);
    })
    .filter(Boolean);
}

function collectCandidateOptions(params: {
  destinations: string[];
  dayPlans: TravelPlanDay[];
  cityDurations: Array<{ city: string; days: number }>;
  locale?: AppLocale;
}): string[] {
  const out: string[] = [];
  const push = (x: string) => {
    const v = clean(x, 180);
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  for (const city of params.destinations || []) {
    push(isEnglishLocale(params.locale) ? `Destination option: ${city}` : `目的地选项：${city}`);
  }
  for (const seg of params.cityDurations || []) {
    push(
      isEnglishLocale(params.locale)
        ? `Stay duration option: ${seg.city} ${seg.days} days`
        : `停留时长选项：${seg.city} ${seg.days}天`
    );
  }
  for (const day of params.dayPlans || []) {
    const firstItem = clean(day.items?.[0], 80);
    if (!firstItem) continue;
    push(
      isEnglishLocale(params.locale)
        ? `Day ${day.day} option: ${firstItem}`
        : `第${day.day}天候选：${firstItem}`
    );
    if (out.length >= 16) break;
  }
  return out.slice(0, 16);
}

function collectPlanLinesByKeyword(params: {
  constraints: string[];
  dayPlans: TravelPlanDay[];
  locale?: AppLocale;
  keywordType: "transport" | "stay" | "food" | "risk";
}): string[] {
  const out: string[] = [];
  const patterns: Record<string, RegExp> = {
    transport: /(交通|地铁|公交|高铁|火车|飞行|航班|接驳|打车|步行|transit|transport|flight|train|bus|metro|taxi|walk)/i,
    stay: /(住宿|酒店|民宿|旅馆|酒店区|hotel|stay|accommodation|hostel)/i,
    food: /(餐|美食|晚餐|午餐|早餐|小吃|餐厅|food|dinner|lunch|breakfast|restaurant)/i,
    risk: /(风险|安全|天气|暴雨|高温|拥挤|夜间|诈骗|risk|safety|weather|storm|heat|crowd)/i,
  };
  const p = patterns[params.keywordType];
  const push = (raw: string) => {
    const v = clean(raw, 180);
    if (!v || out.includes(v)) return;
    out.push(v);
  };
  for (const c of params.constraints || []) {
    if (p.test(c)) push(c);
  }
  for (const day of params.dayPlans || []) {
    for (const item of day.items || []) {
      if (!p.test(item)) continue;
      const line = isEnglishLocale(params.locale)
        ? `Day ${day.day}: ${clean(item, 120)}`
        : `第${day.day}天：${clean(item, 120)}`;
      push(line);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

function extractOpenQuestions(turns: Array<{ assistantText: string }>, locale?: AppLocale): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const v = clean(raw, 180);
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  const latestAssistant = clean(turns[turns.length - 1]?.assistantText || "", 1200);
  if (latestAssistant) {
    const qParts = latestAssistant
      .split(/(?<=[？?。.!])/)
      .map((x) => clean(x, 180))
      .filter((x) => /[？?]$/.test(x) || /请确认|是否|请问|confirm|whether|do you|would you|could you/i.test(x));
    for (const q of qParts) push(q);
  }

  if (!out.length) {
    push(
      t(
        locale,
        "请确认当前按天安排是否需要增减活动密度。",
        "Please confirm whether the day-by-day pacing needs adjustment."
      )
    );
  }
  return out.slice(0, 8);
}

function buildBudgetNotes(params: {
  locale?: AppLocale;
  total?: number;
  spent?: number;
  remaining?: number;
  pending?: number;
}): string[] {
  const out: string[] = [];
  if (params.total != null) {
    out.push(isEnglishLocale(params.locale) ? `Total budget: ${params.total} CNY` : `总预算：${params.total}元`);
  }
  if (params.spent != null) {
    out.push(isEnglishLocale(params.locale) ? `Spent: ${params.spent} CNY` : `已花预算：${params.spent}元`);
  }
  if (params.remaining != null) {
    out.push(isEnglishLocale(params.locale) ? `Remaining: ${params.remaining} CNY` : `剩余预算：${params.remaining}元`);
  }
  if (params.pending != null && params.pending > 0) {
    out.push(isEnglishLocale(params.locale) ? `Pending: ${params.pending} CNY` : `待确认支出：${params.pending}元`);
  }
  return out.slice(0, 8);
}

function normalizeForMatch(input: any): string {
  return clean(input, 260)
    .toLowerCase()
    .replace(/[\s,.;:!?，。；：！？/\\\-()（）\[\]{}"'`]+/g, "");
}

function conceptSourceTokens(concept: ConceptItem | undefined): string[] {
  return dedupe((Array.isArray(concept?.sourceMsgIds) ? concept!.sourceMsgIds : []).map((x) => clean(x, 80).toLowerCase()));
}

function isAssistantToken(token: string): boolean {
  const tkn = clean(token, 80).toLowerCase();
  if (!tkn) return false;
  return tkn.includes("assistant") || tkn.startsWith("msg_a") || tkn.startsWith("a_") || tkn === "latest_assistant";
}

function isUserToken(token: string): boolean {
  const tkn = clean(token, 80).toLowerCase();
  if (!tkn || isAssistantToken(tkn)) return false;
  return (
    tkn.includes("user") ||
    tkn.startsWith("msg_u") ||
    tkn.startsWith("u_") ||
    tkn.startsWith("turn_u") ||
    tkn.startsWith("turn_") ||
    tkn === "latest_user" ||
    tkn.startsWith("manual_")
  );
}

function conceptIsUserConfirmed(concept: ConceptItem | undefined): boolean {
  if (!concept) return false;
  const validationStatus = clean((concept as any).validationStatus, 24).toLowerCase();
  if (validationStatus !== "resolved") return false;
  const tokens = conceptSourceTokens(concept);
  if (!tokens.length) return false;
  const hasUser = tokens.some((x) => isUserToken(x));
  const hasAssistant = tokens.some((x) => isAssistantToken(x));
  return hasUser && !(!hasUser && hasAssistant);
}

function userConfirmationLexicon(concepts: ConceptItem[]): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const value = normalizeForMatch(raw);
    if (!value || value.length < 2 || out.includes(value)) return;
    out.push(value);
  };
  for (const concept of concepts || []) {
    if (!conceptIsUserConfirmed(concept)) continue;
    push(clean(concept.title, 120));
    push(clean(concept.description, 120));
    for (const term of concept.evidenceTerms || []) push(clean(term, 80));
  }
  return out.slice(0, 120);
}

function isTextUserConfirmed(text: string, lexicon: string[]): boolean {
  const normalized = normalizeForMatch(text);
  if (!normalized || !lexicon.length) return false;
  return lexicon.some((token) => token.length >= 2 && normalized.includes(token));
}

function buildRationaleRefs(params: {
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  destinations: string[];
  constraints: string[];
}): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const x = clean(raw, 120);
    if (!x || out.includes(x)) return;
    out.push(x);
  };

  const activeMotifs = (params.motifs || [])
    .filter((m) => clean((m as any)?.status, 24).toLowerCase() === "active")
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  for (const motif of activeMotifs.slice(0, 10)) {
    if (motif.id) push(`motif:${motif.id}`);
    const patternId = clean((motif as any).motif_type_id, 120);
    if (patternId) push(`motif_type:${patternId}`);
  }

  const topConcepts = (params.concepts || [])
    .filter((c) => conceptIsUserConfirmed(c))
    .sort((a, b) => (Number((b as any).score) || 0) - (Number((a as any).score) || 0));
  for (const concept of topConcepts.slice(0, 10)) {
    if (concept.id) push(`concept:${concept.id}`);
  }

  for (const d of params.destinations || []) push(`destination:${clean(d, 40)}`);
  for (const c of params.constraints || []) push(`constraint:${clean(c, 80)}`);
  return out.slice(0, 24);
}

function buildSourceMap(params: {
  tripGoalSummary: string;
  destinationScope: string[];
  travelDatesOrDuration?: string;
  travelers: string[];
  dayPlans: TravelPlanDay[];
  candidateOptions: string[];
  itineraryOutline: string[];
  transportPlan: string[];
  stayPlan: string[];
  foodPlan: string[];
  riskNotes: string[];
  budgetNotes: string[];
  rationaleRefs: string[];
  exportReadyText: string;
  userConfirmedLexicon: string[];
  openQuestions: string[];
}): TravelPlanSourceMap {
  const map: TravelPlanSourceMap = {};
  const mark = (key: string, source: TravelPlanSourceLabel, text?: string) => {
    const shouldUpgradeToUserConfirmed =
      source === "assistant_proposed" && !!text && isTextUserConfirmed(text, params.userConfirmedLexicon);
    map[key] = { source_label: source };
    if (shouldUpgradeToUserConfirmed) {
      map[key] = {
        source_label: "user_confirmed",
        notes: "matched_user_confirmation_evidence",
      };
    }
  };
  mark("trip_goal_summary", "assistant_proposed", params.tripGoalSummary);
  mark("destination_scope", "assistant_proposed", params.destinationScope.join(" "));
  mark("travel_dates_or_duration", "assistant_proposed", params.travelDatesOrDuration || "");
  mark("travelers", "assistant_proposed", params.travelers.join(" "));
  params.dayPlans.forEach((day, idx) =>
    mark(`day_by_day_plan.${idx + 1}`, "assistant_proposed", `${day.title} ${(day.items || []).join(" ")}`)
  );
  params.candidateOptions.forEach((x, idx) => mark(`candidate_options.${idx + 1}`, "assistant_proposed", x));
  params.itineraryOutline.forEach((x, idx) => mark(`itinerary_outline.${idx + 1}`, "assistant_proposed", x));
  params.transportPlan.forEach((x, idx) => mark(`transport_plan.${idx + 1}`, "assistant_proposed", x));
  params.stayPlan.forEach((x, idx) => mark(`stay_plan.${idx + 1}`, "assistant_proposed", x));
  params.foodPlan.forEach((x, idx) => mark(`food_plan.${idx + 1}`, "assistant_proposed", x));
  params.riskNotes.forEach((x, idx) => mark(`risk_notes.${idx + 1}`, "assistant_proposed", x));
  params.budgetNotes.forEach((x, idx) => mark(`budget_notes.${idx + 1}`, "assistant_proposed", x));
  params.rationaleRefs.forEach((x, idx) => mark(`rationale_refs.${idx + 1}`, "transferred_pattern_based", x));
  params.openQuestions.forEach((x, idx) => mark(`open_questions.${idx + 1}`, "co_authored", x));
  mark("export_ready_text", "assistant_proposed", params.exportReadyText);
  return map;
}

function stablePlanSignature(params: {
  summary: string;
  destinations: string[];
  totalDays?: number;
  budget?: { totalCny?: number; spentCny?: number; remainingCny?: number; pendingCny?: number };
  dayPlans: TravelPlanDay[];
  exportNarrative: string;
  constraints: string[];
}): string {
  return JSON.stringify({
    summary: clean(params.summary, 260),
    destinations: params.destinations.map((x) => clean(x, 48)),
    totalDays: params.totalDays || 0,
    budget: params.budget || {},
    dayPlans: (params.dayPlans || []).map((d) => ({
      day: d.day,
      city: clean(d.city, 48),
      dateLabel: clean(d.dateLabel, 32),
      title: clean(d.title, 80),
      items: (d.items || []).map((x) => clean(x, 100)),
    })),
    exportNarrative: clean(params.exportNarrative, 1800),
    constraints: (params.constraints || []).map((x) => clean(x, 120)),
  });
}

function buildPlanChangelog(params: {
  locale?: AppLocale;
  previous?: TravelPlanState | null;
  planVersion: number;
  changed: boolean;
  resetTrack?: boolean;
}): TravelPlanChangelogItem[] {
  const prev = Array.isArray(params.previous?.changelog) ? params.previous?.changelog || [] : [];
  if (!params.previous || params.resetTrack) {
    return [
      {
        plan_version: params.planVersion,
        changed_at: new Date().toISOString(),
        action: "plan_initialized",
        summary: t(params.locale, "初始化旅行计划文本快照。", "Initialized travel plan snapshot."),
        source_label: "assistant_proposed",
      },
    ];
  }
  if (!params.changed) return prev.slice(-20);
  return [
    ...prev.slice(-19),
    {
      plan_version: params.planVersion,
      changed_at: new Date().toISOString(),
      action: "plan_updated",
      summary: t(params.locale, "根据最新对话与图状态更新行程。", "Updated itinerary from latest dialogue and graph state."),
      source_label: "co_authored",
    },
  ];
}

function detectDestinationTaskSwitch(current: string[], previous: string[]): boolean {
  const cur = dedupe((current || []).map((x) => clean(x, 60).toLowerCase()).filter(Boolean));
  const prev = dedupe((previous || []).map((x) => clean(x, 60).toLowerCase()).filter(Boolean));
  if (!cur.length || !prev.length) return false;
  const overlap = cur.some((x) => prev.includes(x));
  return !overlap;
}

function historySegmentFromPlan(params: {
  plan: TravelPlanState;
  closedAt: string;
  locale?: AppLocale;
}): TravelPlanTaskHistorySegment | null {
  const plan = params.plan;
  const taskId = clean(plan.task_id, 80);
  if (!taskId) return null;
  const destinationScope = dedupe(
    ((plan.destination_scope || plan.destinations || []) as string[]).map((x) => clean(x, 40)).filter(Boolean)
  ).slice(0, 12);
  const tripGoal = clean(plan.trip_goal_summary || plan.summary, 220);
  const exportReady = clean(plan.export_ready_text || plan.exportNarrative || plan.summary, 12000);
  if (!tripGoal && !exportReady && !destinationScope.length) return null;
  return {
    task_id: taskId,
    trip_title: clean(destinationScope[0] || tripGoal || t(params.locale, "未命名行程", "Untitled trip"), 120),
    destination_scope: destinationScope,
    travelers: dedupe((plan.travelers || []).map((x) => clean(x, 40)).filter(Boolean)).slice(0, 8),
    duration:
      clean(plan.travel_dates_or_duration, 80) ||
      (Number(plan.totalDays) > 0
        ? isEnglishLocale(params.locale)
          ? `${plan.totalDays} days`
          : `${plan.totalDays}天`
        : undefined),
    trip_goal_summary: tripGoal,
    export_ready_text: exportReady,
    open_questions: dedupe((plan.open_questions || []).map((x) => clean(x, 180)).filter(Boolean)).slice(0, 10),
    rationale_refs: dedupe((plan.rationale_refs || []).map((x) => clean(x, 120)).filter(Boolean)).slice(0, 24),
    source_map: (plan.source_map || {}) as TravelPlanSourceMap,
    status: "archived",
    closed_at: params.closedAt,
  };
}

export function buildTravelPlanState(params: {
  locale?: AppLocale;
  graph: CDG;
  turns: Array<{ createdAt?: Date | string; userText: string; assistantText: string }>;
  concepts?: ConceptItem[];
  motifs?: ConceptMotif[];
  taskId?: string;
  previous?: TravelPlanState | null;
}): TravelPlanState {
  const locale = params.locale;
  const graph = params.graph;
  const turns = params.turns || [];
  const concepts = Array.isArray(params.concepts) ? params.concepts : [];
  const motifs = Array.isArray(params.motifs) ? params.motifs : [];

  const goalNode = (graph.nodes || [])
    .filter(
      (n) =>
        n.type === "belief" &&
        n.status !== "rejected" &&
        (String((n as any).key || "").startsWith("slot:goal") || n.layer === "intent")
    )
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

  const itineraryPick = pickBestItineraryAssistantText(turns);
  const itineraryText = String(itineraryPick.text || "");
  const narrativeText = dedupeParagraphs(extractNarrativeText(itineraryText), 4200);
  const parsedDayPlans = pickBestParsedDayPlans({
    byDayHeader: parseDayBlocksFromText(itineraryText),
    byDateHeader: parseDateBlocksFromText(itineraryText),
    expectedDays: totalDays,
  });
  let dayPlans = parsedDayPlans.dayPlans.slice();
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
  const assistantDayPlansWithDate = addDateLabelsToDayPlans(parsedDayPlans.dayPlans.slice(), dateAnchor);
  const assistantPlan =
    itineraryPick.turnIndex >= 0 && itineraryText.trim()
      ? {
          sourceTurnIndex: itineraryPick.turnIndex,
          sourceTurnCreatedAt: turns[itineraryPick.turnIndex]?.createdAt
            ? new Date(turns[itineraryPick.turnIndex].createdAt as any).toISOString()
            : undefined,
          rawText: dedupeParagraphs(itineraryText, 5200),
          narrative: narrativeText || dedupeParagraphs(itineraryText, 5200),
          parser: parsedDayPlans.parser,
          dayPlans: assistantDayPlansWithDate,
        }
      : undefined;

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
    assistantPlan,
  });
  const baseTaskId = clean(params.taskId || graph.id || "task_default", 80) || "task_default";
  const previousDestinations = dedupe(
    ((params.previous?.destination_scope || params.previous?.destinations || []) as string[])
      .map((x) => clean(x, 40))
      .filter(Boolean)
  );
  const isTaskSwitch =
    !!params.previous &&
    Number(params.previous?.source?.turnCount || 0) > 0 &&
    detectDestinationTaskSwitch(destinations, previousDestinations);
  const taskId = isTaskSwitch
    ? `${baseTaskId}:task_${Math.max(1, Number(params.previous?.plan_version || params.previous?.version || 0) + 1)}`
    : clean(params.previous?.task_id, 80) || baseTaskId;
  const travelDatesOrDuration = buildTravelDatesOrDuration(totalDays, dateAnchor, locale);
  const travelers = extractTravelers(graph, locale);
  const candidateOptions = collectCandidateOptions({
    destinations,
    dayPlans,
    cityDurations,
    locale,
  });
  const itineraryOutline = collectItineraryOutline(dayPlans, locale);
  const transportPlan = collectPlanLinesByKeyword({
    constraints: normalizedConstraints,
    dayPlans,
    locale,
    keywordType: "transport",
  });
  const stayPlan = collectPlanLinesByKeyword({
    constraints: normalizedConstraints,
    dayPlans,
    locale,
    keywordType: "stay",
  });
  const foodPlan = collectPlanLinesByKeyword({
    constraints: normalizedConstraints,
    dayPlans,
    locale,
    keywordType: "food",
  });
  const riskNotes = collectPlanLinesByKeyword({
    constraints: normalizedConstraints,
    dayPlans,
    locale,
    keywordType: "risk",
  });
  const budgetNotes = buildBudgetNotes({
    locale,
    total: effectiveBudget.totalCny,
    spent: effectiveBudget.spentCny,
    remaining: effectiveBudget.remainingCny,
    pending: effectiveBudget.pendingCny,
  });
  const openQuestions = extractOpenQuestions(turns, locale);
  const rationaleRefs = buildRationaleRefs({
    concepts,
    motifs,
    destinations,
    constraints: normalizedConstraints,
  });

  const currentSignature = stablePlanSignature({
    summary,
    destinations,
    totalDays,
    budget: effectiveBudget,
    dayPlans,
    exportNarrative,
    constraints: normalizedConstraints,
  });
  const previousSignature = params.previous
    ? stablePlanSignature({
        summary: params.previous.summary || "",
        destinations: (params.previous.destination_scope || params.previous.destinations || []) as string[],
        totalDays: params.previous.totalDays,
        budget: params.previous.budget,
        dayPlans: (params.previous.day_by_day_plan || params.previous.dayPlans || []) as TravelPlanDay[],
        exportNarrative: params.previous.exportNarrative || "",
        constraints: params.previous.constraints || [],
      })
    : "";
  const changed = !params.previous || currentSignature !== previousSignature;
  const previousPlanVersion = Number((params.previous as any)?.plan_version) || Number(params.previous?.version) || 1;
  const planVersion = isTaskSwitch ? 1 : params.previous ? previousPlanVersion + (changed ? 1 : 0) : 1;
  const changelog = buildPlanChangelog({
    locale,
    previous: params.previous || null,
    planVersion,
    changed,
    resetTrack: isTaskSwitch,
  });
  const exportReadyText = clean(
    [
      summary,
      travelDatesOrDuration ? `${isEnglishLocale(locale) ? "Duration" : "时长"}: ${travelDatesOrDuration}` : "",
      destinations.length
        ? isEnglishLocale(locale)
          ? `Destinations: ${destinations.join(" / ")}`
          : `目的地：${destinations.join("、")}`
        : "",
      exportNarrative,
    ]
      .filter(Boolean)
      .join("\n\n"),
    12000
  );
  const userLexicon = userConfirmationLexicon(concepts);
  const sourceMap = buildSourceMap({
    tripGoalSummary: summary,
    destinationScope: destinations,
    travelDatesOrDuration,
    travelers,
    dayPlans,
    candidateOptions,
    itineraryOutline,
    transportPlan,
    stayPlan,
    foodPlan,
    riskNotes,
    budgetNotes,
    rationaleRefs,
    exportReadyText,
    userConfirmedLexicon: userLexicon,
    openQuestions,
  });

  const previousHistory = Array.isArray(params.previous?.task_history) ? params.previous?.task_history || [] : [];
  const nextTaskHistory: TravelPlanTaskHistorySegment[] = previousHistory.slice(-15);
  if (isTaskSwitch && params.previous) {
    const archived = historySegmentFromPlan({
      plan: params.previous,
      closedAt: new Date().toISOString(),
      locale,
    });
    if (archived) {
      const exists = nextTaskHistory.some((x) => clean(x.task_id, 80) === clean(archived.task_id, 80));
      if (!exists) nextTaskHistory.push(archived);
    }
  }

  return {
    version: Math.max(1, Number(graph.version) || 1),
    task_id: taskId,
    plan_version: planVersion,
    updatedAt: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    summary,
    trip_goal_summary: summary,
    destinations,
    destination_scope: destinations,
    constraints: normalizedConstraints,
    travel_dates_or_duration: travelDatesOrDuration,
    travelers,
    candidate_options: candidateOptions,
    itinerary_outline: itineraryOutline,
    day_by_day_plan: dayPlans,
    transport_plan: transportPlan,
    stay_plan: stayPlan,
    food_plan: foodPlan,
    risk_notes: riskNotes,
    budget_notes: budgetNotes,
    open_questions: openQuestions,
    rationale_refs: rationaleRefs,
    source_map: sourceMap,
    export_ready_text: exportReadyText,
    changelog,
    task_history: nextTaskHistory.length ? nextTaskHistory.slice(-16) : undefined,
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
    assistantPlan,
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

  const narrativeHasDay = STRUCTURED_ITINERARY_RE.test(
    String(plan.exportNarrative || plan.assistantPlan?.narrative || "")
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
