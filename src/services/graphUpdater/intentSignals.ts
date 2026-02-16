import {
  COUNTRY_PREFIX_RE,
  CRITICAL_PRESENTATION_RE,
  CULTURE_PREF_RE,
  DESTINATION_NOISE_RE,
  HARD_CONSTRAINT_RE,
  HARD_DAY_ACTION_RE,
  HARD_DAY_FORCE_RE,
  HARD_REQUIRE_RE,
  NATURE_TOPIC_RE,
  PLACE_STOPWORD_RE,
  PREFERENCE_MARKER_RE,
  RISK_HEALTH_RE,
} from "./constants.js";
import { cleanStatement, sentenceParts } from "./text.js";

type BudgetMatch = { value: number; evidence: string; index: number };

type DurationCandidate = {
  days: number;
  evidence: string;
  index: number;
  kind: "total" | "meeting" | "segment" | "critical_event" | "unknown";
  strength: number;
};

type DateMention = {
  month: number;
  day: number;
  ordinal: number;
  index: number;
  evidence: string;
};

type DateRangeCandidate = {
  days: number;
  evidence: string;
  index: number;
  isMeetingLike: boolean;
};

export type IntentSignals = {
  peopleCount?: number;
  peopleEvidence?: string;
  peopleImportance?: number;
  destination?: string;
  destinationEvidence?: string;
  destinations?: string[];
  destinationEvidences?: string[];
  destinationImportance?: number;
  destinationImportanceByCity?: Record<string, number>;
  durationDays?: number;
  durationEvidence?: string;
  durationStrength?: number;
  durationImportance?: number;
  hasTemporalAnchor?: boolean;
  hasDurationUpdateCue?: boolean;
  cityDurations?: Array<{
    city: string;
    days: number;
    evidence: string;
    kind: "travel" | "meeting";
  }>;
  cityDurationImportanceByCity?: Record<string, number>;
  criticalPresentation?: {
    days: number;
    reason: string;
    evidence: string;
    city?: string;
  };
  criticalImportance?: number;
  durationUnknown?: boolean;
  durationUnknownEvidence?: string;
  budgetCny?: number;
  budgetEvidence?: string;
  budgetImportance?: number;
  healthConstraint?: string;
  healthEvidence?: string;
  healthImportance?: number;
  scenicPreference?: string;
  scenicPreferenceEvidence?: string;
  scenicPreferenceHard?: boolean;
  scenicPreferenceImportance?: number;
  lodgingPreference?: string;
  lodgingPreferenceEvidence?: string;
  lodgingPreferenceHard?: boolean;
  lodgingPreferenceImportance?: number;
  goalImportance?: number;
};

export function parseCnInt(raw: string): number | null {
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

function pickLatestBudgetMatch(
  text: string,
  pattern: RegExp,
  parseValue: (raw: string) => number
): BudgetMatch | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let best: BudgetMatch | null = null;

  for (const m of text.matchAll(re)) {
    if (!m?.[1]) continue;
    const value = parseValue(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const index = Number(m.index) || 0;
    const candidate: BudgetMatch = {
      value,
      index,
      evidence: cleanStatement(m[0] || m[1], 40),
    };
    if (!best || candidate.index >= best.index) best = candidate;
  }

  return best;
}

function pickBudgetFromText(text: string): { value: number; evidence: string } | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;

  const wanPatterns = [
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]+(?:\.[0-9]+)?)\s*万/i,
    /([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币)?\s*(?:预算|经费|花费|费用)?/i,
  ];
  let best: BudgetMatch | null = null;
  for (const re of wanPatterns) {
    const match = pickLatestBudgetMatch(t, re, (raw) => Math.round(Number(raw) * 10000));
    if (!match) continue;
    if (!best || match.index >= best.index) best = match;
  }

  const yuanPatterns = [
    /(?:总预算|预算(?:上限)?|经费|花费|费用)\s*(?:调整为|改成|改到|上调到|提高到|提升到|放宽到|调到|更新为|大概|大约|约|在|为|是|控制在|控制|不超过|不要超过|上限为|上限是|以内|左右|约为|大致|大致在|大概在)?\s*([0-9]{3,9})(?:\s*[-~到至]\s*[0-9]{3,9})?\s*(?:元|块|人民币)?/i,
    /([0-9]{3,9})\s*(?:元|块|人民币)\s*(?:预算|总预算|经费|花费|费用)?/i,
  ];
  for (const re of yuanPatterns) {
    const match = pickLatestBudgetMatch(t, re, (raw) => Number(raw));
    if (!match) continue;
    if (!best || match.index >= best.index) best = match;
  }

  if (!best) return null;
  return { value: best.value, evidence: best.evidence };
}

function parseDateMentions(text: string): DateMention[] {
  const out: DateMention[] = [];
  const re = /([0-9]{1,2})月([0-9]{1,2})日/g;
  for (const m of text.matchAll(re)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const index = Number(m.index) || 0;
    out.push({
      month,
      day,
      ordinal: month * 31 + day,
      index,
      evidence: cleanStatement(m[0] || "", 24),
    });
  }

  const rangeRe = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/g;
  for (const m of text.matchAll(rangeRe)) {
    const month = Number(m[1]);
    const day1 = Number(m[2]);
    const day2 = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day1) || !Number.isFinite(day2)) continue;
    if (month < 1 || month > 12 || day1 < 1 || day1 > 31 || day2 < 1 || day2 > 31) continue;
    const index = Number(m.index) || 0;
    out.push({
      month,
      day: day1,
      ordinal: month * 31 + day1,
      index,
      evidence: cleanStatement(`${month}月${day1}日`, 24),
    });
    out.push({
      month,
      day: day2,
      ordinal: month * 31 + day2,
      index: index + String(m[0] || "").length - 1,
      evidence: cleanStatement(`${month}月${day2}日`, 24),
    });
  }

  const shortRe = /(^|[^\d])([0-9]{1,2})[-/]([0-9]{1,2})(?=[^\d]|$)/g;
  for (const m of text.matchAll(shortRe)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const index = (Number(m.index) || 0) + String(m[1] || "").length;
    out.push({
      month,
      day,
      ordinal: month * 31 + day,
      index,
      evidence: cleanStatement(`${month}-${day}`, 24),
    });
  }

  return out;
}

function calcRangeDays(monthA: number, dayA: number, monthB: number, dayB: number): number {
  const year = 2026;
  const start = new Date(year, monthA - 1, dayA);
  let end = new Date(year, monthB - 1, dayB);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end.getTime() < start.getTime()) {
    end = new Date(year + 1, monthB - 1, dayB);
  }
  const diff = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (!Number.isFinite(diff)) return 0;
  return diff;
}

function extractDateRangeDurations(text: string): DateRangeCandidate[] {
  const out: DateRangeCandidate[] = [];

  const sameMonthRe = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/g;
  for (const m of text.matchAll(sameMonthRe)) {
    const month = Number(m[1]);
    const dayA = Number(m[2]);
    const dayB = Number(m[3]);
    if (!Number.isFinite(month) || !Number.isFinite(dayA) || !Number.isFinite(dayB)) continue;
    if (month < 1 || month > 12 || dayA < 1 || dayA > 31 || dayB < 1 || dayB > 31) continue;
    const days = calcRangeDays(month, dayA, month, dayB);
    if (days <= 0 || days > 62) continue;
    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + String(m[0] || "").length + 44)), 120);
    const isMeetingLike = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会|发表|汇报|报告|讲论文)/i.test(ctx);
    out.push({
      days,
      evidence: cleanStatement(m[0] || `${month}月${dayA}日-${dayB}日`, 36),
      index: idx,
      isMeetingLike,
    });
  }

  const crossMonthRe =
    /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})月([0-9]{1,2})日?/g;
  for (const m of text.matchAll(crossMonthRe)) {
    const monthA = Number(m[1]);
    const dayA = Number(m[2]);
    const monthB = Number(m[3]);
    const dayB = Number(m[4]);
    if (!Number.isFinite(monthA) || !Number.isFinite(dayA) || !Number.isFinite(monthB) || !Number.isFinite(dayB)) continue;
    if (monthA < 1 || monthA > 12 || monthB < 1 || monthB > 12 || dayA < 1 || dayA > 31 || dayB < 1 || dayB > 31) continue;
    const days = calcRangeDays(monthA, dayA, monthB, dayB);
    if (days <= 0 || days > 62) continue;
    const idx = Number(m.index) || 0;
    const ctx = cleanStatement(text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + String(m[0] || "").length + 44)), 120);
    const isMeetingLike = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会|发表|汇报|报告|讲论文)/i.test(ctx);
    out.push({
      days,
      evidence: cleanStatement(m[0] || `${monthA}月${dayA}日-${monthB}月${dayB}日`, 42),
      index: idx,
      isMeetingLike,
    });
  }

  return out
    .sort((a, b) => a.index - b.index)
    .filter((x, i, arr) => i === arr.findIndex((y) => y.index === x.index && y.days === x.days));
}

function extractDurationCandidates(text: string): DurationCandidate[] {
  const out: DurationCandidate[] = [];
  const re = /([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)/g;
  for (const m of text.matchAll(re)) {
    if (!m?.[1] || !m?.[2]) continue;
    const base = parseCnInt(m[1]);
    if (!base || base <= 0) continue;
    const unit = m[2];
    const days = unit === "天" ? base : base * 7;
    if (days <= 0 || days > 120) continue;

    const index = Number(m.index) || 0;
    const left = Math.max(0, index - 20);
    const right = Math.min(text.length, index + String(m[0] || "").length + 28);
    const ctx = cleanStatement(text.slice(left, right), 120);

    const isTotal = /(总共|一共|总计|全程|整个(?:行程|旅行)?|整体|行程时长|trip length|overall|total|in total)/i.test(ctx);
    const isMeeting = /(学术会议|会议|开会|chi|conference|workshop|forum|summit|参会)/i.test(ctx);
    const isCriticalEvent = hasHardDayReservationSignal(ctx);
    const isSegment = /(米兰|巴塞罗那|停留|逛|游|玩|旅行|旅游|度假|行程|city|stay|香港|机场|飞到|前往)/i.test(ctx);

    let kind: DurationCandidate["kind"] = "unknown";
    let strength = 0.55;
    if (isTotal) {
      kind = "total";
      strength = 0.95;
    } else if (isCriticalEvent) {
      kind = "critical_event";
      strength = 0.96;
    } else if (isMeeting) {
      kind = "meeting";
      strength = 0.64;
    } else if (isSegment) {
      kind = "segment";
      strength = 0.68;
    }

    out.push({
      days,
      evidence: cleanStatement(m[0] || m[1], 30),
      index,
      kind,
      strength,
    });
  }
  return out;
}

function inferDurationFromText(
  text: string,
  opts?: { historyMode?: boolean }
): { days: number; evidence: string; strength: number } | null {
  const historyMode = !!opts?.historyMode;
  const durationCandidates = extractDurationCandidates(text);
  const dateRangeCandidates = extractDateRangeDurations(text);
  const dateMentions = parseDateMentions(text);
  const uniqueDateMentions = dateMentions.filter(
    (d, i, arr) => i === arr.findIndex((x) => x.month === d.month && x.day === d.day)
  );

  const explicitTotal = durationCandidates
    .filter((x) => x.kind === "total")
    .sort((a, b) => b.index - a.index)[0];
  if (explicitTotal) {
    return {
      days: explicitTotal.days,
      evidence: explicitTotal.evidence,
      strength: explicitTotal.strength,
    };
  }

  let best: { days: number; evidence: string; strength: number } | null = null;
  const consider = (days: number, evidence: string, strength: number) => {
    if (!Number.isFinite(days) || days <= 0 || days > 120) return;
    const e = cleanStatement(evidence, 80);
    if (!best) {
      best = { days, evidence: e, strength };
      return;
    }
    if (strength > best.strength + 0.06) {
      best = { days, evidence: e, strength };
      return;
    }
    if (days > best.days) {
      best = { days, evidence: e, strength };
      return;
    }
    if (days === best.days && strength > best.strength) {
      best = { days, evidence: e, strength };
    }
  };

  const rangeLatest = dateRangeCandidates.slice().sort((a, b) => b.index - a.index)[0];
  if (!historyMode && rangeLatest) {
    const rangeStrength = rangeLatest.isMeetingLike ? 0.92 : 0.88;
    consider(rangeLatest.days, rangeLatest.evidence, rangeStrength);
  }

  const eligibleForTotal = durationCandidates.filter(
    (x) =>
      x.kind === "total" ||
      x.kind === "segment" ||
      (x.kind === "meeting" && x.days >= 3) ||
      (x.kind === "unknown" && x.days >= 3)
  );
  const maxSingle = eligibleForTotal.slice().sort((a, b) => b.days - a.days || b.strength - a.strength)[0];
  if (maxSingle) consider(maxSingle.days, maxSingle.evidence, maxSingle.strength);

  const meetingMax = durationCandidates
    .filter((x) => x.kind === "meeting" && x.days >= 2)
    .sort((a, b) => b.days - a.days || b.index - a.index)[0];
  const segmentMax = durationCandidates
    .filter((x) => x.kind === "segment")
    .sort((a, b) => b.days - a.days || b.index - a.index)[0];

  if (!historyMode && meetingMax && segmentMax) {
    consider(
      meetingMax.days + segmentMax.days,
      `${segmentMax.evidence} + ${meetingMax.evidence}`,
      Math.max(meetingMax.strength, segmentMax.strength) + 0.06
    );
  }

  if (!historyMode && uniqueDateMentions.length >= 2) {
    const ordinals = uniqueDateMentions.map((d) => d.ordinal);
    const minOrdinal = Math.min(...ordinals);
    const maxOrdinal = Math.max(...ordinals);
    const span = maxOrdinal - minOrdinal + 1;
    if (span >= 2 && span <= 60) {
      const first = uniqueDateMentions.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
      const last = uniqueDateMentions.slice().sort((a, b) => b.ordinal - a.ordinal)[0];
      consider(span, `${first.evidence}-${last.evidence}`, 0.74);
    }
  }

  // 仅在没有明确日期区间时，用“会议起始日+会议时长”估计总时长下界，避免把 5 天误抬高成 14 天。
  if (!historyMode && dateRangeCandidates.length === 0 && uniqueDateMentions.length >= 1) {
    const earliest = uniqueDateMentions.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
    const hasBeforeCue = /之前|此前|先|然后|再|之后|再从|before|then/i.test(text);
    const confRe =
      /([0-9]{1,2})月([0-9]{1,2})日[\s\S]{0,40}?([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)[\s\S]{0,20}?(学术会议|会议|开会|chi|conference|workshop)/gi;
    for (const m of text.matchAll(confRe)) {
      const month = Number(m[1]);
      const day = Number(m[2]);
      const rawDuration = m[3];
      const unit = m[4];
      const d = parseCnInt(rawDuration || "");
      if (!Number.isFinite(month) || !Number.isFinite(day) || !d || d <= 0) continue;
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      const confDays = unit === "天" ? d : d * 7;
      const startOrdinal = month * 31 + day;
      const offset = startOrdinal - earliest.ordinal;
      if (offset < 0 || offset > 60) continue;
      if (!hasBeforeCue && offset > 0) continue;
      const totalLowerBound = offset + confDays;
      consider(totalLowerBound, cleanStatement(m[0] || `${m[1]}月${m[2]}日 ${confDays}天会议`, 60), 0.9);
    }
  }

  if (!best) return null;

  const onlyCriticalOrTiny =
    durationCandidates.length > 0 &&
    durationCandidates.every((x) => x.kind === "critical_event" || x.days <= 2 || x.kind === "meeting");
  if (onlyCriticalOrTiny && best.days <= 2 && best.strength < 0.9) return null;

  const hasExplicitTotalCue = /(总共|一共|总计|全程|整个(?:行程|旅行)?|整体|行程时长|trip length|overall|total|in total)/i.test(text);
  const trustedUpper = Math.max(
    ...dateRangeCandidates.map((x) => x.days),
    ...durationCandidates.filter((x) => x.kind === "meeting" && x.days >= 3).map((x) => x.days),
    0
  );
  if (!hasExplicitTotalCue && trustedUpper > 0 && best.days > trustedUpper + 3) {
    best = {
      days: trustedUpper,
      evidence: dateRangeCandidates[0]?.evidence || durationCandidates.find((x) => x.days === trustedUpper)?.evidence || best.evidence,
      strength: Math.max(best.strength, 0.9),
    };
  }

  return best;
}

export function normalizeDestination(raw: string): string {
  let s = cleanStatement(raw, 24);
  s = s.replace(/^(在|于|到|去|从|飞到|前往|抵达)\s*/i, "");
  s = s.replace(/^(我想|想|想去|想到|想逛|逛一逛|逛逛|逛|游览|游玩|探索|体验|顺带|顺便|顺路|顺道)\s*/i, "");
  s = s.replace(/(这座城市|这座城|这座|城市|城区|城)$/i, "");
  s = s.replace(/(之外|之内|以内|以内地区)$/i, "");
  // 迭代剥离尾部噪声，避免“巴塞罗那参加CHI”“米兰玩”这类污染目的地槽位。
  const tailNoiseRe =
    /(参加|参会|开会|会议|chi|conference|workshop|summit|论坛|峰会|玩|逛|旅游|旅行|游玩|出行|度假|计划|安排)$/i;
  let changed = true;
  while (changed && s) {
    const next = s.replace(tailNoiseRe, "");
    changed = next !== s;
    s = next.trim();
  }
  s = s.replace(/省/g, "").replace(/市/g, "");
  s = s.replace(COUNTRY_PREFIX_RE, "");
  s = s.replace(/(旅游|旅行|游玩|出行|度假|参会|开会|会议|行程|计划|玩|逛)$/i, "");
  s = s.trim();
  return s;
}

export function isLikelyDestinationCandidate(x: string): boolean {
  const s = normalizeDestination(x);
  if (!s) return false;
  if (s.length < 2 || s.length > 16) return false;
  if (!/^[A-Za-z\u4e00-\u9fff]+$/.test(s)) return false;
  if (DESTINATION_NOISE_RE.test(s)) return false;
  if (PLACE_STOPWORD_RE.test(s)) return false;
  if (/[A-Za-z]/.test(s) && /[\u4e00-\u9fff]/.test(s)) return false;
  if (/^[A-Za-z]+$/.test(s) && s.length <= 2) return false;
  if (/(参加|参会|开会|会议|玩|旅游|旅行|度假|计划|安排)$/i.test(s)) return false;
  if (
    /心脏|母亲|父亲|家人|预算|人数|行程|计划|注意|高强度|旅行时|旅游时|需要|限制|不能|安排|在此之前|此前|之前|之后|然后|再从|我会|我要|参会|参加|开会|会议|飞到|出发|机场|航班|汇报|论文|报告|顺带|顺便|顺路|顺道/i.test(
      s
    )
  ) {
    return false;
  }
  return true;
}

function extractDestinationList(text: string): Array<{ city: string; evidence: string; index: number }> {
  const out: Array<{ city: string; evidence: string; index: number }> = [];
  const push = (raw: string, evidence: string, index: number) => {
    const city = normalizeDestination(raw);
    if (!isLikelyDestinationCandidate(city)) return;
    out.push({
      city,
      evidence: cleanStatement(evidence || raw, 30),
      index,
    });
  };

  const routeRe =
    /从\s*([A-Za-z\u4e00-\u9fff]{2,20})[^\n。；;，,]{0,10}?(?:飞|出发|前往|去|到)?[^\n。；;，,]{0,3}?到\s*([A-Za-z\u4e00-\u9fff]{2,20})/gi;
  for (const m of text.matchAll(routeRe)) {
    if (!m?.[2]) continue;
    push(m[2], m[0] || m[2], Number(m.index) || 0);
  }

  const goRe = /(?:去|到|前往|飞到|抵达)\s*([A-Za-z\u4e00-\u9fff]{2,14}?)(?=参加|参会|开会|会议|玩|旅游|旅行|度假|逛|游|[，。,；;！!？?\s]|$)/gi;
  for (const m of text.matchAll(goRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const visitRe = /(?:逛|游览|游玩|探索|体验)\s*(?:一逛|一下|一圈|一遍)?\s*([A-Za-z\u4e00-\u9fff]{2,14})(?:这座城市|这座城|城市|城)?/gi;
  for (const m of text.matchAll(visitRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const atMeetingRe = /(?:在|于)\s*([A-Za-z\u4e00-\u9fff]{2,20})\s*(?:参加|参会|开会|办会|召开)/gi;
  for (const m of text.matchAll(atMeetingRe)) {
    if (!m?.[1]) continue;
    push(m[1], m[1], Number(m.index) || 0);
  }

  const pairRe = /(?:去|到|在)?\s*([^\s，。,；;！!？?\d]{2,16})\s*(?:和|与|及|、|,|，)\s*([^\s，。,；;！!？?\d]{2,16})(?:旅游|旅行|出行|玩|度假|开会|会议|chi|conference|$)/gi;
  for (const m of text.matchAll(pairRe)) {
    if (!m?.[1] || !m?.[2]) continue;
    const idx = Number(m.index) || 0;
    push(m[1], m[1], idx);
    push(m[2], m[2], idx + String(m[1]).length + 1);
  }

  const seen = new Set<string>();
  const dedup = out
    .sort((a, b) => a.index - b.index)
    .filter((x) => {
      const key = normalizeDestination(x.city);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return dedup.slice(0, 4);
}

function extractCityDurationSegments(text: string): Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }> {
  const out: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }> = [];
  const travelHintRe =
    /(?:在|于|到|去|飞到|抵达)\s*([A-Za-z\u4e00-\u9fff]{2,16})\s*(?:玩|逛|停留|待|旅行|旅游|参会|开会|参加)?\s*([0-9一二三四五六七八九十两]{1,3})\s*天/gi;
  for (const m of text.matchAll(travelHintRe)) {
    const city = normalizeDestination(m?.[1] || "");
    const days = parseCnInt(m?.[2] || "");
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    const idx = Number(m.index) || 0;
    const snippet = cleanStatement(m[0] || `${city}${days}天`, 80);
    if (hasHardDayReservationSignal(snippet) && days <= 2) continue;
    const kind: "travel" | "meeting" =
      /(会议|开会|chi|conference|workshop|论坛|参会)/i.test(snippet) ? "meeting" : "travel";
    out.push({
      city,
      days,
      evidence: cleanStatement(snippet, 50),
      kind,
      index: idx,
    });
  }

  const re = /(?:在|于|到|去)?([^\s，。,；;！!？?\d]{2,14})[^\n。；;，,]{0,10}?([0-9一二三四五六七八九十两]{1,3})\s*天/g;
  for (const m of text.matchAll(re)) {
    const rawCity = m?.[1] || "";
    const rawDays = m?.[2] || "";
    const city = normalizeDestination(rawCity);
    const days = parseCnInt(rawDays);
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;
    if (DESTINATION_NOISE_RE.test(city) || PLACE_STOPWORD_RE.test(city)) continue;

    const idx = Number(m.index) || 0;
    const right = Math.min(text.length, idx + String(m[0] || "").length + 26);
    const ctx = cleanStatement(text.slice(idx, right), 80);
    if (hasHardDayReservationSignal(ctx) && days <= 2) continue;
    const kind: "travel" | "meeting" =
      /(会议|开会|chi|conference|workshop|论坛)/i.test(ctx) ? "meeting" : "travel";

    out.push({
      city,
      days,
      evidence: cleanStatement(m[0] || `${city}${days}天`, 50),
      kind,
      index: idx,
    });
  }

  const rangeRe =
    /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?[^\n。；;]{0,28}?(?:去|到|在|飞到)\s*([A-Za-z\u4e00-\u9fff]{2,20})[^\n。；;]{0,20}?(参加|参会|开会|会议|chi|conference|workshop|玩|旅游|旅行|度假)?/gi;
  for (const m of text.matchAll(rangeRe)) {
    const month = Number(m[1]);
    const startDay = Number(m[2]);
    const endDay = Number(m[3]);
    const city = normalizeDestination(m[4] || "");
    if (!Number.isFinite(month) || !Number.isFinite(startDay) || !Number.isFinite(endDay)) continue;
    if (!city || !isLikelyDestinationCandidate(city)) continue;
    const days = calcRangeDays(month, startDay, month, endDay);
    if (days <= 0 || days > 31) continue;
    const action = String(m[5] || "");
    const kind: "travel" | "meeting" =
      /(参加|参会|开会|会议|chi|conference|workshop)/i.test(action) ? "meeting" : "travel";
    out.push({
      city,
      days,
      evidence: cleanStatement(m[0] || `${city}${days}天`, 52),
      kind,
      index: Number(m.index) || 0,
    });
  }

  const bestByCity = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }>();
  for (const x of out) {
    const cur = bestByCity.get(x.city);
    if (!cur || x.days > cur.days || x.kind === "meeting") bestByCity.set(x.city, x);
  }
  return Array.from(bestByCity.values()).sort((a, b) => a.index - b.index).slice(0, 6);
}

export function isTravelIntentText(text: string, signals: IntentSignals) {
  if (signals.destination || signals.durationDays || signals.budgetCny || signals.peopleCount) return true;
  return /旅游|旅行|出行|行程|景点|酒店|攻略|目的地|去|玩/i.test(String(text || ""));
}

export function buildTravelIntentStatement(signals: IntentSignals, userText: string): string | null {
  if (!isTravelIntentText(userText, signals)) return null;

  const destinations = (signals.destinations || []).filter(Boolean);
  const destinationPhrase =
    destinations.length >= 2
      ? `${destinations.slice(0, 3).join("和")}`
      : signals.destination || destinations[0] || "";

  if (destinationPhrase && signals.durationDays) {
    return `意图：去${destinationPhrase}旅游${signals.durationDays}天`;
  }
  if (destinationPhrase) {
    return `意图：去${destinationPhrase}旅游`;
  }
  if (signals.durationDays) {
    return `意图：制定${signals.durationDays}天旅行计划`;
  }
  return "意图：制定旅行计划";
}

export function hasHardDayReservationSignal(text: string): boolean {
  const s = cleanStatement(text, 160);
  if (!s) return false;
  const hasDay = /(一天|1天|一日|1日|[0-9一二三四五六七八九十两]{1,2}\s*天)/.test(s);
  const hasForce = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s) || HARD_DAY_FORCE_RE.test(s);
  const hasAction = HARD_DAY_ACTION_RE.test(s) || CRITICAL_PRESENTATION_RE.test(s);
  return hasDay && hasForce && hasAction;
}

export function normalizePreferenceStatement(raw: string) {
  const s = cleanStatement(raw, 160);
  if (!s) return null;

  const hasCulture = CULTURE_PREF_RE.test(s);
  const hasNature = NATURE_TOPIC_RE.test(s);
  const dislikeNature = hasNature && /不感兴趣|不喜欢|避免|不要|不能|厌恶/.test(s);
  if (!hasCulture && !dislikeNature) return null;
  if (!PREFERENCE_MARKER_RE.test(s) && !HARD_REQUIRE_RE.test(s) && !HARD_CONSTRAINT_RE.test(s)) return null;

  const hard = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s);
  const statement =
    hasCulture && dislikeNature
      ? "景点偏好：优先人文景观，减少纯自然景观"
      : hasCulture
        ? "景点偏好：人文景观优先"
        : "景点偏好：尽量避免纯自然景观";
  return {
    statement,
    hard,
    evidence: s,
  };
}

export function normalizeLodgingPreferenceStatement(raw: string) {
  const s = cleanStatement(raw, 160);
  if (!s) return null;
  const hasLodging =
    /酒店|民宿|住宿|房型|星级|房费|住在|入住|住全程|全程住|酒店标准/i.test(s);
  if (!hasLodging) return null;
  const hard = HARD_REQUIRE_RE.test(s) || HARD_CONSTRAINT_RE.test(s);

  if (/(五星|5星|豪华|高端)/i.test(s)) {
    return {
      statement: "住宿偏好：全程高星级酒店优先",
      hard,
      evidence: s,
    };
  }
  if (/(经济型|省钱|便宜|青年旅舍|青旅)/i.test(s)) {
    return {
      statement: "住宿偏好：优先经济型住宿",
      hard,
      evidence: s,
    };
  }
  return {
    statement: "住宿偏好：需满足指定住宿标准",
    hard,
    evidence: s,
  };
}

function clampImportance(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function mergeImportanceMap(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (!k) continue;
      out[k] = Math.max(out[k] || 0, clampImportance(v, 0.72));
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function pickHealthClause(userText: string): string | undefined {
  const parts = sentenceParts(userText);
  const hit = parts.find((x) => RISK_HEALTH_RE.test(x));
  return hit || undefined;
}

export function extractCriticalPresentationRequirement(text: string): { days: number; reason: string; evidence: string; city?: string } | null {
  const s = String(text || "");
  if (!s) return null;
  const candidates = sentenceParts(s).filter((x) => hasHardDayReservationSignal(x));
  if (!candidates.length) return null;

  const target =
    candidates
      .slice()
      .sort((a, b) => {
        const score = (y: string) => {
          let v = 0;
          if (CRITICAL_PRESENTATION_RE.test(y)) v += 3;
          if (HARD_DAY_FORCE_RE.test(y) || HARD_REQUIRE_RE.test(y) || HARD_CONSTRAINT_RE.test(y)) v += 2;
          if (/用于|留给|安排|见|拜访|会见|参加|汇报|报告|发表|办理/.test(y)) v += 1;
          return v;
        };
        return score(b) - score(a);
      })[0] || "";

  const dm = target.match(/([0-9一二三四五六七八九十两]{1,2})\s*天/);
  const days = dm?.[1] ? parseCnInt(dm[1]) || 1 : /(一天|一日|1天|1日)/.test(target) ? 1 : 0;
  if (!days || days <= 0 || days > 7) return null;

  let reason = "";
  const p1 = target.match(/(?:用于|留给|安排给|用来)([^，。；;]{2,28})/);
  if (p1?.[1]) reason = cleanStatement(p1[1], 24);
  if (!reason) {
    const p2 = target.match(/(见[^，。；;]{1,20}|拜访[^，。；;]{1,20}|会见[^，。；;]{1,20}|参加[^，。；;]{1,20}|办理[^，。；;]{1,20}|处理[^，。；;]{1,20}|汇报[^，。；;]{1,20}|发表[^，。；;]{1,20})/);
    if (p2?.[1]) reason = cleanStatement(p2[1], 24);
  }
  if (!reason && CRITICAL_PRESENTATION_RE.test(target)) reason = "论文/报告汇报";
  if (!reason && HARD_DAY_ACTION_RE.test(target)) reason = "关键事项处理";
  if (!reason) return null;

  let city: string | undefined;
  const cm = target.match(/(?:在|于|到|去)\s*([A-Za-z\u4e00-\u9fff]{2,20})/);
  const cityNorm = normalizeDestination(cm?.[1] || "");
  if (cityNorm && isLikelyDestinationCandidate(cityNorm)) city = cityNorm;

  return {
    days,
    reason,
    evidence: cleanStatement(`${reason} ${days}天（硬约束）`, 60),
    city,
  };
}

export function extractIntentSignals(userText: string, opts?: { historyMode?: boolean }): IntentSignals {
  const text = String(userText || "");
  const out: IntentSignals = {};
  out.hasTemporalAnchor = /([0-9]{1,2})月([0-9]{1,2})日?(?:\s*[-~到至]\s*([0-9]{1,2})日?)?/.test(text);
  out.hasDurationUpdateCue = /改成|改为|更新|调整|变为|变成|改到|上调|下调|放宽|改成了|改成到|从.*改到/i.test(text);

  const peopleM =
    text.match(/(?:一家|全家|我们|同行)[^\d一二三四五六七八九十两]{0,4}([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)/) ||
    text.match(/([0-9一二三四五六七八九十两]{1,3})\s*(?:口|人)(?:同行|一起|出游|旅游|出行)?/);
  if (peopleM?.[1]) {
    const n = parseCnInt(peopleM[1]);
    if (n && n > 0 && n < 30) {
      out.peopleCount = n;
      out.peopleEvidence = cleanStatement(peopleM[0] || peopleM[1], 40);
    }
  }

  const destinationList = extractDestinationList(text);
  if (destinationList.length) {
    out.destinations = destinationList.map((x) => x.city);
    out.destinationEvidences = destinationList.map((x) => x.evidence);
    out.destination = destinationList[0].city;
    out.destinationEvidence = destinationList[0].evidence;
  } else {
    const destM =
      text.match(/(?:去|到|在)\s*([^\s，。,；;！!？?\d]{2,16}?)(?:玩|旅游|旅行|度假|出行|住|待|逛|，|。|,|$)/) ||
      text.match(/目的地(?:是|为)?\s*([^\s，。,；;！!？?\d]{2,16})/);
    if (destM?.[1]) {
      const d = normalizeDestination(destM[1]);
      if (d && isLikelyDestinationCandidate(d)) {
        out.destination = d;
        out.destinationEvidence = cleanStatement(destM[1], 32);
        out.destinations = [d];
        out.destinationEvidences = [out.destinationEvidence];
      }
    }
  }

  const duration = inferDurationFromText(text, { historyMode: !!opts?.historyMode });
  if (duration?.days) {
    out.durationDays = duration.days;
    out.durationEvidence = duration.evidence;
    out.durationStrength = duration.strength;
  }

  const citySegments = extractCityDurationSegments(text);
  if (citySegments.length) {
    out.cityDurations = citySegments.map((x) => ({
      city: x.city,
      days: x.days,
      evidence: x.evidence,
      kind: x.kind,
    }));
    for (const seg of citySegments) {
      if (!out.destinations) out.destinations = [];
      if (!out.destinationEvidences) out.destinationEvidences = [];
      if (!out.destinations.includes(seg.city)) {
        out.destinations.push(seg.city);
        out.destinationEvidences.push(seg.evidence);
      }
    }

    const sumDays = citySegments.reduce((acc, x) => acc + x.days, 0);
    const distinctCities = new Set(citySegments.map((x) => x.city)).size;
    const hasTravelSegment = citySegments.some((x) => x.kind === "travel");
    const hasExplicitTotalCue = /(总共|一共|全程|总计|整体|整个(?:行程|旅行)?|总行程|行程时长)/.test(text);
    const shouldPromoteAsTotal = hasExplicitTotalCue || (distinctCities >= 2 && hasTravelSegment);
    if (sumDays > 0 && shouldPromoteAsTotal) {
      const segmentStrength = citySegments.some((x) => x.kind === "meeting") ? 0.9 : 0.8;
      const shouldTakeSegments =
        !out.durationDays ||
        sumDays > out.durationDays ||
        segmentStrength >= (out.durationStrength || 0) + 0.08 ||
        ((out.durationStrength || 0) <= 0.78 && Math.abs(sumDays - (out.durationDays || 0)) <= 2);
      if (shouldTakeSegments) {
        out.durationDays = sumDays;
        out.durationEvidence = citySegments.map((x) => `${x.city}${x.days}天`).join(" + ");
        out.durationStrength = Math.max(out.durationStrength || 0, segmentStrength);
      }
    }
  }

  const criticalPresentation = extractCriticalPresentationRequirement(text);
  if (criticalPresentation) {
    out.criticalPresentation = criticalPresentation;
  }

  if (!out.durationDays && /几天|多少天|天数待定|时长待定/i.test(text)) {
    out.durationUnknown = true;
    const du = text.match(/几天|多少天|天数待定|时长待定/i);
    out.durationUnknownEvidence = du?.[0] || "时长待确认";
  }

  const budget = pickBudgetFromText(text);
  if (budget) {
    out.budgetCny = budget.value;
    out.budgetEvidence = budget.evidence;
  }

  const healthClause = pickHealthClause(text);
  if (healthClause) {
    out.healthConstraint = healthClause;
    out.healthEvidence = healthClause;
  }

  const prefClause = sentenceParts(text).map(normalizePreferenceStatement).find(Boolean);
  if (prefClause) {
    out.scenicPreference = prefClause.statement;
    out.scenicPreferenceHard = prefClause.hard;
    out.scenicPreferenceEvidence = prefClause.evidence;
    out.scenicPreferenceImportance = prefClause.hard ? 0.8 : 0.68;
  }

  const lodgingClause = sentenceParts(text).map(normalizeLodgingPreferenceStatement).find(Boolean);
  if (lodgingClause) {
    out.lodgingPreference = lodgingClause.statement;
    out.lodgingPreferenceHard = lodgingClause.hard;
    out.lodgingPreferenceEvidence = lodgingClause.evidence;
    out.lodgingPreferenceImportance = lodgingClause.hard ? 0.82 : 0.66;
  }

  return out;
}

function mergeSignalsWithLatest(history: IntentSignals, latest: IntentSignals): IntentSignals {
  const out: IntentSignals = { ...history };

  const mergeDestinations = (a?: string[], b?: string[]) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const x of [...(a || []), ...(b || [])]) {
      const city = normalizeDestination(String(x || ""));
      if (!city || seen.has(city)) continue;
      seen.add(city);
      result.push(city);
    }
    return result.length ? result.slice(0, 4) : undefined;
  };

  const mergeCityDurations = (
    a?: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting" }>,
    b?: Array<{ city: string; days: number; evidence: string; kind: "travel" | "meeting" }>
  ) => {
    const map = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting" }>();
    for (const seg of [...(a || []), ...(b || [])]) {
      const city = normalizeDestination(seg?.city || "");
      const days = Number(seg?.days) || 0;
      if (!city || days <= 0 || days > 60) continue;
      if (!isLikelyDestinationCandidate(city)) continue;
      const cur = map.get(city);
      const kind: "travel" | "meeting" = seg?.kind === "meeting" ? "meeting" : "travel";
      const cand = {
        city,
        days,
        evidence: cleanStatement(seg?.evidence || `${city}${days}天`, 40),
        kind,
      };
      if (!cur || cand.days > cur.days || cand.kind === "meeting") map.set(city, cand);
    }
    return map.size ? Array.from(map.values()).slice(0, 6) : undefined;
  };

  if (latest.peopleCount != null) {
    out.peopleCount = latest.peopleCount;
    out.peopleEvidence = latest.peopleEvidence || out.peopleEvidence;
  }
  if (latest.peopleImportance != null) {
    out.peopleImportance = clampImportance(latest.peopleImportance, out.peopleImportance || 0.72);
  }

  out.destinations = mergeDestinations(out.destinations, latest.destinations);
  if (out.destinations?.length) {
    out.destination = out.destinations[0];
  }
  out.destinationImportanceByCity = mergeImportanceMap(
    out.destinationImportanceByCity,
    latest.destinationImportanceByCity
  );
  if (latest.destinationImportance != null) {
    out.destinationImportance = clampImportance(
      latest.destinationImportance,
      out.destinationImportance || 0.8
    );
  }
  if (latest.destination) {
    out.destination = latest.destination;
    out.destinationEvidence = latest.destinationEvidence || out.destinationEvidence;
    out.destinations = mergeDestinations(out.destinations, [latest.destination]);
  }
  const latestHasSnapshotDuration =
    latest.durationDays != null &&
    (!!latest.hasTemporalAnchor || !!latest.hasDurationUpdateCue || (latest.cityDurations?.length || 0) > 0);

  if (latest.cityDurations?.length) {
    out.cityDurations = latestHasSnapshotDuration
      ? mergeCityDurations(undefined, latest.cityDurations)
      : mergeCityDurations(out.cityDurations, latest.cityDurations);
  } else {
    out.cityDurations = mergeCityDurations(out.cityDurations, latest.cityDurations);
  }
  out.cityDurationImportanceByCity = mergeImportanceMap(
    out.cityDurationImportanceByCity,
    latest.cityDurationImportanceByCity
  );

  if (latest.criticalPresentation) {
    out.criticalPresentation = latest.criticalPresentation;
  }
  if (latest.criticalImportance != null) {
    out.criticalImportance = clampImportance(
      latest.criticalImportance,
      out.criticalImportance || 0.96
    );
  }

  if (latest.durationDays != null) {
    const latestStrength = Number(latest.durationStrength) || 0.55;
    const historyStrength = Number(out.durationStrength) || 0;
    const tinyCriticalOnly =
      !!latest.criticalPresentation &&
      latest.durationDays <= 2 &&
      !latest.hasTemporalAnchor &&
      !latest.hasDurationUpdateCue;
    const shouldUseLatest =
      !tinyCriticalOnly &&
      (out.durationDays == null ||
        latestHasSnapshotDuration ||
        latestStrength >= 0.9 ||
        latest.durationDays > (out.durationDays || 0) ||
        latestStrength + 0.06 >= historyStrength);

    if (shouldUseLatest) {
      out.durationDays = latest.durationDays;
      out.durationEvidence = latest.durationEvidence || out.durationEvidence;
      out.durationStrength = latestStrength;
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
      if (latest.durationImportance != null) {
        out.durationImportance = clampImportance(
          latest.durationImportance,
          out.durationImportance || 0.78
        );
      }
    }
  } else if (latest.durationUnknown) {
    out.durationUnknown = true;
    out.durationUnknownEvidence = latest.durationUnknownEvidence || out.durationUnknownEvidence;
  }

  if (out.cityDurations?.length) {
    const segSum = out.cityDurations.reduce((acc, x) => acc + (Number(x.days) || 0), 0);
    const distinctCities = new Set(out.cityDurations.map((x) => x.city)).size;
    const hasTravelSegment = out.cityDurations.some((x) => x.kind === "travel");
    const canPromoteBySegments = distinctCities >= 2 && hasTravelSegment;
    const segStrength = out.cityDurations.some((x) => x.kind === "meeting") ? 0.9 : 0.82;
    const shouldTakeSeg =
      canPromoteBySegments &&
      segSum > 0 &&
      (!out.durationDays ||
        segSum > out.durationDays ||
        segStrength >= (Number(out.durationStrength) || 0) + 0.08 ||
        ((Number(out.durationStrength) || 0) <= 0.78 && Math.abs(segSum - (out.durationDays || 0)) <= 2));
    if (shouldTakeSeg) {
      out.durationDays = segSum;
      out.durationEvidence = out.cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
      out.durationStrength = Math.max(Number(out.durationStrength) || 0.55, segStrength);
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
    }
  }

  if (out.criticalPresentation && out.cityDurations?.length && !out.criticalPresentation.city) {
    const meetingCity = out.cityDurations.find((x) => x.kind === "meeting")?.city;
    if (meetingCity) out.criticalPresentation.city = meetingCity;
  }

  if (latest.budgetCny != null) {
    out.budgetCny = latest.budgetCny;
    out.budgetEvidence = latest.budgetEvidence || out.budgetEvidence;
  }
  if (latest.budgetImportance != null) {
    out.budgetImportance = clampImportance(
      latest.budgetImportance,
      out.budgetImportance || 0.86
    );
  }
  if (latest.healthConstraint) {
    out.healthConstraint = latest.healthConstraint;
    out.healthEvidence = latest.healthEvidence || out.healthEvidence;
  }
  if (latest.healthImportance != null) {
    out.healthImportance = clampImportance(
      latest.healthImportance,
      out.healthImportance || 0.96
    );
  }
  if (latest.scenicPreference) {
    out.scenicPreference = latest.scenicPreference;
    out.scenicPreferenceEvidence = latest.scenicPreferenceEvidence || out.scenicPreferenceEvidence;
    out.scenicPreferenceHard = latest.scenicPreferenceHard;
  }
  if (latest.scenicPreferenceImportance != null) {
    out.scenicPreferenceImportance = clampImportance(
      latest.scenicPreferenceImportance,
      out.scenicPreferenceImportance || 0.68
    );
  }
  if (latest.lodgingPreference) {
    out.lodgingPreference = latest.lodgingPreference;
    out.lodgingPreferenceEvidence =
      latest.lodgingPreferenceEvidence || out.lodgingPreferenceEvidence;
    out.lodgingPreferenceHard = latest.lodgingPreferenceHard;
  }
  if (latest.lodgingPreferenceImportance != null) {
    out.lodgingPreferenceImportance = clampImportance(
      latest.lodgingPreferenceImportance,
      out.lodgingPreferenceImportance || 0.66
    );
  }
  if (latest.goalImportance != null) {
    out.goalImportance = clampImportance(latest.goalImportance, out.goalImportance || 0.82);
  }

  return out;
}

export function extractIntentSignalsWithRecency(historyText: string, latestUserText: string): IntentSignals {
  const fromHistory = extractIntentSignals(historyText, { historyMode: true });
  const fromLatest = extractIntentSignals(latestUserText);
  return mergeSignalsWithLatest(fromHistory, fromLatest);
}

export function mergeIntentSignals(base: IntentSignals, incoming: IntentSignals): IntentSignals {
  return mergeSignalsWithLatest(base, incoming);
}
