// src/services/graphUpdater.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG, GraphPatch, Severity, Strength } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph]", ...args);
}

const PATCH_START = "<<<PATCH_JSON>>>";
const PATCH_END = "<<<END_PATCH_JSON>>>";

// 你可以给建图单独指定模型（更稳/更便宜都行）
const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;

const RISK_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;
const HARD_CONSTRAINT_RE = /不能|不宜|避免|禁忌|必须|只能|不要|不可|不得|无法|不方便|不能够/i;
const HARD_REQUIRE_RE = /硬性要求|一定要|必须|务必|绝对/i;
const CRITICAL_PRESENTATION_RE = /汇报|报告|演讲|讲论文|宣讲|presentation|talk|keynote|答辩|讲座/i;
const CULTURE_PREF_RE = /人文|历史|文化|博物馆|古城|古镇|遗址|美术馆|展览|文博/i;
const NATURE_TOPIC_RE = /自然景观|自然风光|爬山|徒步|森林|湿地|海边|户外/i;
const PREFERENCE_MARKER_RE = /喜欢|更喜欢|偏好|倾向|感兴趣|想看|想去|不感兴趣|不喜欢|厌恶/i;
const ITINERARY_NOISE_RE = /第[一二三四五六七八九十0-9]+天|上午|中午|下午|晚上|行程|建议|入住|晚餐|午餐|景点|游览|返回|酒店|餐馆|安排如下/i;
const STRUCTURED_PREFIX_RE =
  /^(意图|目的地|同行人数|预算(?:上限)?|行程时长|总行程时长|会议时长|城市时长|停留时长|会议关键日|关键会议日|论文汇报日|健康约束|景点偏好|活动偏好|住宿偏好|交通偏好|饮食偏好|人数|时长)[:：]/;

function cleanStatement(s: any, maxLen = 180) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(用户任务|任务|用户补充)[:：]\s*/i, "")
    .trim()
    .slice(0, maxLen);
}

function inferRiskMeta(statement: string): { severity: Severity; importance: number; tags: string[] } | null {
  const s = cleanStatement(statement, 300);
  if (!s) return null;
  if (!RISK_HEALTH_RE.test(s)) return null;

  const critical = /心脏|冠心|心血管|急救|cardiac|heart/i.test(s);
  return {
    severity: critical ? "critical" : "high",
    importance: 0.9,
    tags: ["health"],
  };
}

function inferFallbackNodeType(userText: string): "constraint" | "fact" {
  const s = cleanStatement(userText, 300);
  if (HARD_CONSTRAINT_RE.test(s) || RISK_HEALTH_RE.test(s)) return "constraint";
  return "fact";
}

function mergeTags(a?: string[], b?: string[]) {
  const set = new Set<string>([...(a || []), ...(b || [])].map((x) => String(x).trim()).filter(Boolean));
  return set.size ? Array.from(set).slice(0, 8) : undefined;
}

function mergeEvidence(a?: Array<string | null | undefined>, b?: Array<string | null | undefined>) {
  const set = new Set<string>(
    [...(a || []), ...(b || [])]
      .map((x) => cleanStatement(x, 60))
      .filter((x): x is string => Boolean(x))
  );
  return set.size ? Array.from(set).slice(0, 6) : undefined;
}

function inferEvidenceFromStatement(userText: string, statement: string): string[] | undefined {
  const t = String(userText || "");
  const s = cleanStatement(statement, 120);
  if (!t || !s) return undefined;

  const colonIdx = s.indexOf("：");
  if (colonIdx > 0) {
    const rhs = cleanStatement(s.slice(colonIdx + 1), 40);
    if (rhs && t.includes(rhs)) return [rhs];
  }

  const words = s
    .split(/[，。,；;、\s]/)
    .map((x) => cleanStatement(x, 24))
    .filter((x) => x.length >= 2);

  const hit = words.find((w) => t.includes(w));
  if (hit) return [hit];

  if (t.includes(s)) return [s];
  return undefined;
}

function sentenceParts(text: string) {
  return String(text || "")
    .split(/[。！？!?；;\n]/)
    .map((x) => cleanStatement(x, 120))
    .filter(Boolean);
}

function normalizePreferenceStatement(raw: string) {
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

function isStructuredStatement(statement: string) {
  return STRUCTURED_PREFIX_RE.test(cleanStatement(statement, 200));
}

function isLikelyNarrativeNoise(statement: string, type?: string) {
  const s = cleanStatement(statement, 240);
  if (!s) return true;
  if (type === "goal") return false;
  if (isStructuredStatement(s)) return false;
  if (RISK_HEALTH_RE.test(s) || normalizePreferenceStatement(s)) return false;
  if (s.length >= 30) return true;
  if (ITINERARY_NOISE_RE.test(s) && s.length >= 16) return true;
  return false;
}

function isStrategicNode(node: any) {
  const s = cleanStatement(node?.statement || "", 160);
  if (!s) return false;
  if (String(node?.type || "") === "goal") return true;
  if (isHealthConstraintNode(node)) return true;
  if (isStructuredStatement(s)) return true;
  return false;
}

function shouldAutoAttachToRoot(node: {
  type?: string;
  statement?: string;
  severity?: string;
  importance?: number;
}) {
  const s = cleanStatement(node?.statement || "", 180);
  if (!s) return false;
  if (isStructuredStatement(s)) return true;
  if (/^健康约束[:：]/.test(s)) return true;
  if (String(node?.severity || "") === "high" || String(node?.severity || "") === "critical") return true;
  if ((Number(node?.importance) || 0) >= 0.82) return true;
  if (String(node?.type || "") === "preference" && /偏好|喜欢|不喜欢|人文|自然/.test(s)) return true;
  return false;
}

function mergeTextSegments(parts: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join("\n");
}

type BudgetMatch = { value: number; evidence: string; index: number };

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

function enrichNodeRisk(node: any) {
  if (!node || typeof node !== "object") return node;

  const statement = cleanStatement(node.statement);
  if (!statement) return node;

  const out: any = { ...node, statement };
  const risk = inferRiskMeta(statement);

  if (risk) {
    out.severity = out.severity || risk.severity;
    out.importance = out.importance != null ? Math.max(Number(out.importance) || 0, risk.importance) : risk.importance;
    out.tags = mergeTags(out.tags, risk.tags);
  }

  if (out.type === "constraint" && HARD_CONSTRAINT_RE.test(statement) && !out.strength) {
    out.strength = "hard";
  }

  return out;
}

function enrichPatchRiskAndText(patch: GraphPatch, latestUserText: string): GraphPatch {
  const ops = (patch.ops || []).map((op: any) => {
    if (op?.op === "add_node" && op.node) {
      const node = enrichNodeRisk(op.node);
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, node?.statement || "");
      return {
        ...op,
        node: {
          ...node,
          evidenceIds: mergeEvidence(node?.evidenceIds, inferredEvidence),
          sourceMsgIds: mergeEvidence(node?.sourceMsgIds, ["latest_user"]),
        },
      };
    }
    if (op?.op === "update_node" && op.patch && typeof op.patch === "object") {
      const p = { ...op.patch };
      if (typeof p.statement === "string") p.statement = cleanStatement(p.statement);
      const risk = inferRiskMeta(p.statement);
      if (risk) {
        p.severity = p.severity || risk.severity;
        p.importance = p.importance != null ? Math.max(Number(p.importance) || 0, risk.importance) : risk.importance;
        p.tags = mergeTags(p.tags, risk.tags);
      }
      if (p.statement && HARD_CONSTRAINT_RE.test(p.statement) && !p.strength) p.strength = "hard";
      const inferredEvidence = inferEvidenceFromStatement(latestUserText, p.statement || "");
      p.evidenceIds = mergeEvidence(p.evidenceIds, inferredEvidence);
      p.sourceMsgIds = mergeEvidence(p.sourceMsgIds, ["latest_user"]);
      return { ...op, patch: p };
    }
    return op;
  });

  return { ...patch, ops };
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
  return out;
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
    const isMeeting = /(学术会议|会议|开会|chi|conference|workshop|forum|summit)/i.test(ctx);
    const isCriticalEvent =
      CRITICAL_PRESENTATION_RE.test(ctx) && (HARD_REQUIRE_RE.test(ctx) || HARD_CONSTRAINT_RE.test(ctx) || /需要|要|必须|强制/.test(ctx));
    const isSegment = /(米兰|巴塞罗那|停留|逛|游|玩|旅行|旅游|度假|行程|city|stay)/i.test(ctx);

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

function inferDurationFromText(text: string): { days: number; evidence: string; strength: number } | null {
  const durationCandidates = extractDurationCandidates(text);
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
    if (days > best.days) {
      best = { days, evidence: e, strength };
      return;
    }
    if (days === best.days && strength > best.strength) {
      best = { days, evidence: e, strength };
    }
  };

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
  if (meetingMax && segmentMax) {
    consider(
      meetingMax.days + segmentMax.days,
      `${segmentMax.evidence} + ${meetingMax.evidence}`,
      Math.max(meetingMax.strength, segmentMax.strength) + 0.06
    );
  }

  if (uniqueDateMentions.length >= 2) {
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

  if (uniqueDateMentions.length >= 1) {
    const earliest = uniqueDateMentions.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
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
      const totalLowerBound = offset + confDays;
      consider(totalLowerBound, cleanStatement(m[0] || `${m[1]}月${m[2]}日 ${confDays}天会议`, 60), 0.92);
    }
  }

  if (!best) return null;

  const onlyCriticalOrTiny =
    durationCandidates.length > 0 &&
    durationCandidates.every((x) => x.kind === "critical_event" || x.days <= 2 || x.kind === "meeting");
  if (onlyCriticalOrTiny && best.days <= 2 && best.strength < 0.9) return null;

  return best;
}

function extractCriticalPresentationRequirement(text: string): { days: number; evidence: string; city?: string } | null {
  const s = String(text || "");
  if (!s) return null;
  if (!CRITICAL_PRESENTATION_RE.test(s)) return null;

  const sentence = sentenceParts(s).find((x) => CRITICAL_PRESENTATION_RE.test(x) && /(一天|1天|一日|1日|[0-9一二三四五六七八九十两]{1,2}\s*天)/.test(x)) || "";
  const target = sentence || s;

  const dm = target.match(/([0-9一二三四五六七八九十两]{1,2})\s*天/);
  const days = dm?.[1] ? parseCnInt(dm[1]) || 1 : /(一天|一日|1天|1日)/.test(target) ? 1 : 1;
  if (!days || days <= 0 || days > 7) return null;

  const forced = HARD_REQUIRE_RE.test(target) || HARD_CONSTRAINT_RE.test(target) || /强制|必须|务必|一定|不得缺席|需要/.test(target);
  if (!forced && days <= 1) {
    // 一天级别事件若无强约束措辞，避免噪声误触发
    return null;
  }

  let city: string | undefined;
  const cm = target.match(/(?:在|于)\s*([^\s，。,；;！!？?\d]{2,16})/);
  const cityNorm = normalizeDestination(cm?.[1] || "");
  if (cityNorm && isLikelyDestinationCandidate(cityNorm)) city = cityNorm;

  return {
    days,
    evidence: cleanStatement(sentence || target, 60),
    city,
  };
}

function normalizeDestination(raw: string): string {
  let s = cleanStatement(raw, 24);
  s = s.replace(/省/g, "").replace(/市/g, "");
  s = s.replace(/^(江苏|浙江|广东|山东|四川|云南|福建|安徽|江西|河北|河南|湖北|湖南|广西|海南|黑龙江|吉林|辽宁|山西|陕西|甘肃|青海|贵州|内蒙古|宁夏|新疆|西藏|北京|上海|天津|重庆)/, "$1");
  s = s.replace(/(旅游|旅行|游玩|出行|度假)$/i, "");
  s = s.trim();
  return s;
}

function isLikelyDestinationCandidate(x: string): boolean {
  const s = normalizeDestination(x);
  if (!s) return false;
  if (s.length < 2 || s.length > 10) return false;
  if (/心脏|母亲|父亲|家人|预算|人数|行程|计划|注意|高强度|旅行时|旅游时|需要|限制|不能|安排/i.test(s)) {
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

  const singleRe = /(?:去|到|在)\s*([^\s，。,；;！!？?\d]{2,16}?)(?:玩|旅游|旅行|度假|出行|住|待|逛|，|。|,|$)/g;
  for (const m of text.matchAll(singleRe)) {
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
  const re = /(?:在)?([^\s，。,；;！!？?\d]{2,16})[^\n。；;，,]{0,12}?([0-9一二三四五六七八九十两]{1,3})\s*天/g;
  for (const m of text.matchAll(re)) {
    const rawCity = m?.[1] || "";
    const rawDays = m?.[2] || "";
    const city = normalizeDestination(rawCity);
    const days = parseCnInt(rawDays);
    if (!city || !days || days <= 0 || days > 60) continue;
    if (!isLikelyDestinationCandidate(city)) continue;

    const idx = Number(m.index) || 0;
    const right = Math.min(text.length, idx + String(m[0] || "").length + 26);
    const ctx = cleanStatement(text.slice(idx, right), 80);
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

  const bestByCity = new Map<string, { city: string; days: number; evidence: string; kind: "travel" | "meeting"; index: number }>();
  for (const x of out) {
    const cur = bestByCity.get(x.city);
    if (!cur || x.days > cur.days || x.kind === "meeting") bestByCity.set(x.city, x);
  }
  return Array.from(bestByCity.values()).sort((a, b) => a.index - b.index).slice(0, 6);
}

function isHealthConstraintNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (String(node.type || "") !== "constraint") return false;
  return RISK_HEALTH_RE.test(String(node.statement || ""));
}

function scoreHealthNode(node: any): number {
  if (!isHealthConstraintNode(node)) return -1;
  const s = cleanStatement(node?.statement || "", 120);
  let score = Number(node?.confidence) || 0;
  if (/^健康约束[:：]/.test(s)) score += 4;
  if (String(node?.severity || "") === "critical") score += 2;
  if (node?.locked) score += 1;
  if (String(node?.strength || "") === "hard") score += 1;
  return score;
}

function isValidDestinationStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^目的地[:：]\s*(.+)$/);
  if (!m?.[1]) return true;
  if (/[和、,，/]/.test(m[1])) return false;
  return isLikelyDestinationCandidate(m[1]);
}

function isValidPeopleStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^同行人数[:：]\s*([0-9]+)\s*人?$/);
  return !statement.startsWith("同行人数") || !!m;
}

function isValidBudgetStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
  return !/预算/.test(statement) || !!m;
}

function isValidTotalDurationStatement(statement: string): boolean {
  const s = cleanStatement(statement);
  const m = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  return !/行程时长/.test(s) || !!m;
}

function isValidCityDurationStatement(statement: string): boolean {
  const s = cleanStatement(statement);
  if (!/^(?:城市时长|停留时长)[:：]/.test(s)) return true;
  const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
  if (!m?.[1] || !m?.[2]) return false;
  return isLikelyDestinationCandidate(m[1]);
}

function isValidAtomicNode(node: any): boolean {
  const s = cleanStatement(node?.statement || "");
  if (!s) return false;
  if (!isValidDestinationStatement(s)) return false;
  if (!isValidPeopleStatement(s)) return false;
  if (!isValidBudgetStatement(s)) return false;
  if (!isValidTotalDurationStatement(s)) return false;
  if (!isValidCityDurationStatement(s)) return false;
  return true;
}

type IntentSignals = {
  peopleCount?: number;
  peopleEvidence?: string;
  destination?: string;
  destinationEvidence?: string;
  destinations?: string[];
  destinationEvidences?: string[];
  durationDays?: number;
  durationEvidence?: string;
  durationStrength?: number;
  cityDurations?: Array<{
    city: string;
    days: number;
    evidence: string;
    kind: "travel" | "meeting";
  }>;
  criticalPresentation?: {
    days: number;
    evidence: string;
    city?: string;
  };
  durationUnknown?: boolean;
  durationUnknownEvidence?: string;
  budgetCny?: number;
  budgetEvidence?: string;
  healthConstraint?: string;
  healthEvidence?: string;
  scenicPreference?: string;
  scenicPreferenceEvidence?: string;
  scenicPreferenceHard?: boolean;
};

function isTravelIntentText(text: string, signals: IntentSignals) {
  if (signals.destination || signals.durationDays || signals.budgetCny || signals.peopleCount) return true;
  return /旅游|旅行|出行|行程|景点|酒店|攻略|目的地|去|玩/i.test(String(text || ""));
}

function buildTravelIntentStatement(signals: IntentSignals, userText: string): string | null {
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

function shouldNormalizeGoalStatement(statement: string, signals: IntentSignals, userText: string) {
  const s = cleanStatement(statement, 240);
  const tooLong = s.length >= 26;
  const mixed = /预算|一家|同行|元|天|计划|制定|一起|人|心脏|健康|限制/i.test(s);
  return isTravelIntentText(userText, signals) && (tooLong || mixed);
}

function pickHealthClause(userText: string): string | undefined {
  const parts = sentenceParts(userText);
  const hit = parts.find((x) => RISK_HEALTH_RE.test(x));
  return hit || undefined;
}

function extractIntentSignals(userText: string): IntentSignals {
  const text = String(userText || "");
  const out: IntentSignals = {};

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

  const duration = inferDurationFromText(text);
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
    const hasTravelSegment = citySegments.some((x) => x.kind === "travel");
    const shouldPromoteAsTotal = hasTravelSegment || citySegments.length >= 2 || sumDays >= 3;
    if (sumDays > 0 && shouldPromoteAsTotal) {
      const segmentStrength = citySegments.some((x) => x.kind === "meeting") ? 0.9 : 0.8;
      if (!out.durationDays || sumDays > out.durationDays || segmentStrength > (out.durationStrength || 0)) {
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
  out.destinations = mergeDestinations(out.destinations, latest.destinations);
  if (out.destinations?.length) {
    out.destination = out.destinations[0];
  }
  if (latest.destination) {
    out.destination = latest.destination;
    out.destinationEvidence = latest.destinationEvidence || out.destinationEvidence;
    out.destinations = mergeDestinations(out.destinations, [latest.destination]);
  }
  out.cityDurations = mergeCityDurations(out.cityDurations, latest.cityDurations);
  if (latest.criticalPresentation) {
    out.criticalPresentation = latest.criticalPresentation;
  }

  if (latest.durationDays != null) {
    const latestStrength = Number(latest.durationStrength) || 0.55;
    const historyStrength = Number(out.durationStrength) || 0;
    const shouldUseLatest =
      out.durationDays == null ||
      latestStrength >= 0.9 ||
      latestStrength + 0.08 >= historyStrength ||
      latest.durationDays > (out.durationDays || 0);

    if (shouldUseLatest) {
      out.durationDays = latest.durationDays;
      out.durationEvidence = latest.durationEvidence || out.durationEvidence;
      out.durationStrength = latestStrength;
      out.durationUnknown = false;
      out.durationUnknownEvidence = undefined;
    }
  } else if (latest.durationUnknown) {
    out.durationUnknown = true;
    out.durationUnknownEvidence = latest.durationUnknownEvidence || out.durationUnknownEvidence;
  }

  if (out.cityDurations?.length) {
    const segSum = out.cityDurations.reduce((acc, x) => acc + (Number(x.days) || 0), 0);
    if (segSum > 0 && (!out.durationDays || segSum > out.durationDays)) {
      out.durationDays = segSum;
      out.durationEvidence = out.cityDurations.map((x) => `${x.city}${x.days}天`).join(" + ");
      out.durationStrength = Math.max(Number(out.durationStrength) || 0.55, 0.88);
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
  if (latest.healthConstraint) {
    out.healthConstraint = latest.healthConstraint;
    out.healthEvidence = latest.healthEvidence || out.healthEvidence;
  }
  if (latest.scenicPreference) {
    out.scenicPreference = latest.scenicPreference;
    out.scenicPreferenceEvidence = latest.scenicPreferenceEvidence || out.scenicPreferenceEvidence;
    out.scenicPreferenceHard = latest.scenicPreferenceHard;
  }

  return out;
}

function extractIntentSignalsWithRecency(historyText: string, latestUserText: string): IntentSignals {
  const fromHistory = extractIntentSignals(historyText);
  const fromLatest = extractIntentSignals(latestUserText);
  return mergeSignalsWithLatest(fromHistory, fromLatest);
}

function buildHeuristicIntentOps(
  graph: CDG,
  signalText: string,
  latestUserText: string,
  knownStmt: Set<string>,
  seedOps: GraphPatch["ops"]
): GraphPatch["ops"] {
  const ops: GraphPatch["ops"] = [];
  const signals = extractIntentSignalsWithRecency(signalText, latestUserText);
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);

  const edgePairs = new Set<string>();
  for (const e of graph.edges || []) {
    edgePairs.add(`${e.from}|${e.to}|${e.type}`);
  }

  let rootId: string | null = pickRootGoalId(graph);
  const layer2Set = new Set<string>();
  if (rootId) {
    const nodesById = new Map((graph.nodes || []).map((n: any) => [n.id, n]));
    for (const e of graph.edges || []) {
      if (e?.to === rootId && (e.type === "enable" || e.type === "constraint" || e.type === "determine")) {
        const n = nodesById.get(e.from);
        if (isStrategicNode(n)) layer2Set.add(e.from);
      }
    }
  }

  const pushNode = (node: any): string | null => {
    const statement = cleanStatement(node.statement);
    if (!statement) return null;
    const key = normalizeForMatch(statement);
    if (!key || knownStmt.has(key)) return null;
    knownStmt.add(key);
    const id = makeTempId("n");
    const evidenceIds = mergeEvidence(
      node.evidenceIds,
      inferEvidenceFromStatement(latestUserText, statement) || inferEvidenceFromStatement(signalText, statement)
    );
    const sourceMsgIds = mergeEvidence(node.sourceMsgIds, ["latest_user"]);
    ops.push({
      op: "add_node",
      node: { ...node, id, statement, evidenceIds, sourceMsgIds },
    });
    return id;
  };

  const pushEdge = (from: string, to: string, type: "enable" | "constraint" | "determine") => {
    const k = `${from}|${to}|${type}`;
    if (edgePairs.has(k)) return;
    edgePairs.add(k);
    ops.push({
      op: "add_edge",
      edge: {
        id: makeTempId("e"),
        from,
        to,
        type,
        confidence: 0.75,
      },
    });
  };

  // 无 root 且出现可识别目标信号时，先补一个目标节点。
  if (!rootId && canonicalIntent) {
    rootId = pushNode({
      type: "goal",
      statement: canonicalIntent,
      status: "proposed",
      confidence: 0.9,
      importance: 0.85,
      evidenceIds: [
        ...(signals.destinationEvidences || []),
        signals.destinationEvidence,
        signals.durationEvidence,
        signals.durationUnknownEvidence,
        signals.budgetEvidence,
        signals.peopleEvidence,
      ].filter((x): x is string => Boolean(x)),
    });
  }
  if (rootId && canonicalIntent) {
    const rootNode = (graph.nodes || []).find((n: any) => n.id === rootId);
    if (rootNode?.statement && shouldNormalizeGoalStatement(rootNode.statement, signals, signalText)) {
      ops.push({
        op: "update_node",
        id: rootId,
        patch: {
          statement: canonicalIntent,
          confidence: Math.max(Number(rootNode.confidence) || 0.6, 0.85),
          importance: Math.max(Number(rootNode.importance) || 0, 0.8),
          evidenceIds: mergeEvidence(
            rootNode.evidenceIds,
            [
              ...(signals.destinationEvidences || []),
              signals.destinationEvidence,
              signals.durationEvidence,
              signals.durationUnknownEvidence,
              signals.budgetEvidence,
              signals.peopleEvidence,
            ].filter((x): x is string => Boolean(x))
          ),
          sourceMsgIds: mergeEvidence(rootNode.sourceMsgIds, ["latest_user"]),
        },
      } as any);
    }
  }

  if (signals.peopleCount) {
    const id = pushNode({
      type: "fact",
      statement: `同行人数：${signals.peopleCount}人`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.72,
      evidenceIds: [signals.peopleEvidence || `${signals.peopleCount}人`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "enable");
  }

  const destinationNodeIds = new Map<string, string>();
  const destinationList = ([...(signals.destinations || []), ...(signals.destination ? [signals.destination] : [])] as string[])
    .map((x) => normalizeDestination(x))
    .filter((x, i, arr) => x && arr.indexOf(x) === i);
  for (let i = 0; i < destinationList.length; i += 1) {
    const city = destinationList[i];
    const evidence = signals.destinationEvidences?.[i] || signals.destinationEvidence || city;
    const id = pushNode({
      type: "fact",
      statement: `目的地：${city}`,
      status: "proposed",
      confidence: 0.9,
      importance: 0.8,
      evidenceIds: [evidence],
    });
    if (!id) continue;
    destinationNodeIds.set(city, id);
    layer2Set.add(id);
    if (rootId) pushEdge(id, rootId, "enable");
  }

  if (signals.durationDays) {
    const id = pushNode({
      type: "constraint",
      statement: `总行程时长：${signals.durationDays}天`,
      strength: "hard",
      status: "proposed",
      confidence: 0.88,
      importance: 0.78,
      evidenceIds: [signals.durationEvidence || `${signals.durationDays}天`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }
  if (!signals.durationDays && signals.durationUnknown) {
    const id = pushNode({
      type: "question",
      statement: "行程时长：待确认",
      status: "proposed",
      confidence: 0.78,
      importance: 0.62,
      evidenceIds: [signals.durationUnknownEvidence || "几天"],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "determine");
  }

  for (const seg of signals.cityDurations || []) {
    const city = normalizeDestination(seg.city);
    if (!city) continue;
    const stmt = `城市时长：${city} ${seg.days}天`;
    const id = pushNode({
      type: "fact",
      statement: stmt,
      status: "proposed",
      confidence: seg.kind === "meeting" ? 0.9 : 0.84,
      importance: seg.kind === "meeting" ? 0.82 : 0.72,
      tags: seg.kind === "meeting" ? ["meeting"] : ["travel"],
      evidenceIds: [seg.evidence || `${city}${seg.days}天`],
    });
    if (!id) continue;
    layer2Set.add(id);
    const cityDestinationId = destinationNodeIds.get(city);
    if (cityDestinationId) pushEdge(id, cityDestinationId, "determine");
    else if (rootId) pushEdge(id, rootId, "determine");
  }

  if (signals.criticalPresentation) {
    const p = signals.criticalPresentation;
    const city = p.city ? normalizeDestination(p.city) : "";
    const label = city ? `${city}论文汇报（${p.days}天）` : `论文汇报（${p.days}天）`;
    const id = pushNode({
      type: "constraint",
      statement: `会议关键日：${label}`,
      strength: "hard",
      status: "proposed",
      confidence: 0.94,
      severity: "critical",
      importance: 0.98,
      tags: ["meeting", "presentation", "deadline"],
      evidenceIds: [p.evidence || `${p.days}天论文汇报`],
    });
    if (id) {
      layer2Set.add(id);
      if (rootId) pushEdge(id, rootId, "constraint");
      if (city) {
        const cityDestinationId = destinationNodeIds.get(city);
        if (cityDestinationId) pushEdge(id, cityDestinationId, "determine");
      }
    }
  }

  if (signals.budgetCny) {
    const id = pushNode({
      type: "constraint",
      statement: `预算上限：${signals.budgetCny}元`,
      strength: "hard",
      status: "proposed",
      confidence: 0.92,
      importance: 0.86,
      evidenceIds: [signals.budgetEvidence || `${signals.budgetCny}元`],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, "constraint");
  }

  if (signals.scenicPreference) {
    const hardPref = !!signals.scenicPreferenceHard;
    const prefType = hardPref ? "constraint" : "preference";
    const id = pushNode({
      type: prefType,
      statement: signals.scenicPreference,
      strength: hardPref ? "hard" : "soft",
      status: "proposed",
      confidence: hardPref ? 0.88 : 0.82,
      severity: "medium",
      importance: hardPref ? 0.8 : 0.68,
      tags: ["preference", "culture"],
      evidenceIds: [signals.scenicPreferenceEvidence || signals.scenicPreference],
    });
    if (id) layer2Set.add(id);
    if (id && rootId) pushEdge(id, rootId, hardPref ? "constraint" : "enable");
  }

  let healthId: string | null = null;
  const existingHealth = (graph.nodes || []).find(isHealthConstraintNode);
  const existingHealthInSeed = (seedOps || []).find(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any;
  if (existingHealthInSeed?.node?.id) {
    healthId = existingHealthInSeed.node.id;
  } else if (existingHealth?.id) {
    healthId = existingHealth.id;
  }

  if (signals.healthConstraint) {
    const healthStatement = `健康约束：${signals.healthConstraint}`;
    const healthEvidence = mergeEvidence(
      [signals.healthEvidence || signals.healthConstraint],
      inferEvidenceFromStatement(latestUserText, signals.healthConstraint) ||
        inferEvidenceFromStatement(signalText, signals.healthConstraint)
    );

    if (healthId) {
      ops.push({
        op: "update_node",
        id: healthId,
        patch: {
          statement: healthStatement,
          strength: "hard",
          status: "proposed",
          confidence: 0.95,
          severity: "critical",
          importance: 0.98,
          tags: ["health", "safety"],
          locked: true,
          evidenceIds: healthEvidence,
          sourceMsgIds: ["latest_user"],
        },
      } as any);
    } else {
      const id = pushNode({
        type: "constraint",
        statement: healthStatement,
        strength: "hard",
        status: "proposed",
        confidence: 0.95,
        severity: "critical",
        importance: 0.98,
        tags: ["health", "safety"],
        locked: true,
        evidenceIds: healthEvidence,
      });
      if (id) healthId = id;
    }
  }

  if (healthId && rootId) {
    pushEdge(healthId, rootId, "constraint");
  }
  if (healthId) {
    for (const sid of Array.from(layer2Set)) {
      if (!sid || sid === healthId) continue;
      pushEdge(sid, healthId, "determine");
    }
  }

  return ops;
}

function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^用户任务[:：]\s*/g, "")
    .replace(/^任务[:：]\s*/g, "")
    .replace(/[“”"]/g, "")
    .toLowerCase();
}

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n: any) => n?.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((g: any) => g.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((g: any) => g.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals[0].id;
}

function extractBetween(text: string, start: string, end: string): string | null {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0 || e <= s) return null;
  return text.slice(s + start.length, e).trim();
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function makeTempId(prefix: string) {
  return `t_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function fallbackPatch(graph: CDG, userText: string, reason: string): GraphPatch {
  const root = pickRootGoalId(graph);
  const short = cleanStatement(userText, 140);
  const signals = extractIntentSignals(userText);
  const canonicalIntent = buildTravelIntentStatement(signals, userText);

  if (!root) {
    return {
      ops: [
        {
          op: "add_node",
          node: {
            id: makeTempId("n"),
            type: "goal",
            statement: canonicalIntent || short || "未提供任务",
            status: "proposed",
            confidence: canonicalIntent ? 0.85 : 0.55,
            evidenceIds: [signals.destinationEvidence, signals.durationEvidence, signals.budgetEvidence, signals.peopleEvidence].filter(
              (x): x is string => Boolean(x)
            ),
            sourceMsgIds: ["latest_user"],
          },
        },
      ],
      notes: [`fallback_patch:${reason}`],
    };
  }

  const nid = makeTempId("n");
  const nodeType = inferFallbackNodeType(short);
  const risk = inferRiskMeta(short);
  return {
    ops: [
      {
        op: "add_node",
        node: {
          id: nid,
          type: nodeType,
          statement: short || "未提供补充信息",
          status: "proposed",
          confidence: 0.55,
          strength: (nodeType === "constraint" ? "hard" : undefined) as Strength | undefined,
          severity: risk?.severity,
          importance: risk?.importance,
          tags: risk?.tags,
          evidenceIds: [signals.healthEvidence, signals.budgetEvidence, signals.durationEvidence, signals.destinationEvidence, signals.peopleEvidence].filter(
            (x): x is string => Boolean(x)
          ),
          sourceMsgIds: ["latest_user"],
        },
      },
      {
        op: "add_edge",
        edge: {
          id: makeTempId("e"),
          from: nid,
          to: root,
          type: nodeType === "constraint" ? "constraint" : "enable",
          confidence: 0.55,
        },
      },
    ],
    notes: [`fallback_patch:${reason}`],
  };
}

function normalizeDurationFromFreeText(statement: string): { kind: "total" | "city" | "meeting"; city?: string; days: number } | null {
  const s = cleanStatement(statement, 200);
  if (!s) return null;

  const cityM = s.match(/^(?:在)?([^\s，。,；;！!？?\d]{2,16})[^\n。；;，,]{0,8}?([0-9一二三四五六七八九十两]{1,3})\s*天$/);
  if (cityM?.[1] && cityM?.[2]) {
    const city = normalizeDestination(cityM[1]);
    const days = parseCnInt(cityM[2]);
    if (city && days && days > 0 && days <= 60 && isLikelyDestinationCandidate(city)) {
      const kind: "city" | "meeting" = /(会议|开会|chi|conference|workshop|论坛)/i.test(s) ? "meeting" : "city";
      return { kind, city, days };
    }
  }

  const totalM = s.match(/(?:总|整体|整个|行程|旅行|旅游)[^0-9一二三四五六七八九十两]{0,6}([0-9一二三四五六七八九十两]{1,3})\s*(天|周|星期)/);
  if (totalM?.[1]) {
    const base = parseCnInt(totalM[1]);
    if (!base) return null;
    const unit = totalM[2];
    const days = unit === "天" ? base : base * 7;
    if (days > 0 && days <= 120) return { kind: "total", days };
  }

  return null;
}

function normalizeIncomingNode(node: any, signalText: string, latestUserText: string) {
  if (!node || typeof node !== "object") return null;

  const out: any = { ...node };
  out.statement = cleanStatement(out.statement || "");
  if (!out.statement) return null;

  if (isLikelyNarrativeNoise(out.statement, out.type)) return null;

  const healthClause =
    (RISK_HEALTH_RE.test(out.statement) && pickHealthClause(out.statement)) ||
    pickHealthClause(latestUserText) ||
    pickHealthClause(signalText);
  if (healthClause && RISK_HEALTH_RE.test(out.statement)) {
    return {
      ...out,
      type: "constraint",
      statement: `健康约束：${healthClause}`,
      strength: "hard",
      severity: "critical",
      importance: Math.max(Number(out.importance) || 0, 0.95),
      confidence: Math.max(Number(out.confidence) || 0.6, 0.9),
      locked: true,
      tags: mergeTags(out.tags, ["health", "safety"]),
    };
  }

  const pref = normalizePreferenceStatement(out.statement);
  if (pref) {
    const hardPref = !!pref.hard;
    return {
      ...out,
      type: hardPref ? "constraint" : "preference",
      statement: pref.statement,
      strength: hardPref ? "hard" : "soft",
      severity: out.severity || "medium",
      importance: Math.max(Number(out.importance) || 0, hardPref ? 0.78 : 0.66),
      confidence: Math.max(Number(out.confidence) || 0.6, hardPref ? 0.82 : 0.76),
      tags: mergeTags(out.tags, ["preference", "culture"]),
    };
  }

  const criticalPresentation = extractCriticalPresentationRequirement(out.statement);
  if (criticalPresentation) {
    const city = criticalPresentation.city ? normalizeDestination(criticalPresentation.city) : "";
    const label = city
      ? `${city}论文汇报（${criticalPresentation.days}天）`
      : `论文汇报（${criticalPresentation.days}天）`;
    return {
      ...out,
      type: "constraint",
      statement: `会议关键日：${label}`,
      strength: "hard",
      severity: out.severity || "critical",
      importance: Math.max(Number(out.importance) || 0, 0.96),
      confidence: Math.max(Number(out.confidence) || 0.6, 0.9),
      tags: mergeTags(out.tags, ["meeting", "presentation", "deadline"]),
    };
  }

  const durationNorm = normalizeDurationFromFreeText(out.statement);
  if (durationNorm) {
    if (durationNorm.kind === "total") {
      return {
        ...out,
        type: "constraint",
        statement: `总行程时长：${durationNorm.days}天`,
        strength: out.strength || "hard",
        confidence: Math.max(Number(out.confidence) || 0.6, 0.82),
        importance: Math.max(Number(out.importance) || 0, 0.76),
      };
    }
    if (durationNorm.kind === "meeting") {
      return {
        ...out,
        type: "constraint",
        statement: `会议时长：${durationNorm.days}天`,
        strength: out.strength || "hard",
        confidence: Math.max(Number(out.confidence) || 0.6, 0.82),
        importance: Math.max(Number(out.importance) || 0, 0.8),
      };
    }
    return {
      ...out,
      type: "fact",
      statement: `城市时长：${durationNorm.city} ${durationNorm.days}天`,
      confidence: Math.max(Number(out.confidence) || 0.6, 0.78),
      importance: Math.max(Number(out.importance) || 0, 0.7),
    };
  }

  if (out.type !== "goal" && !isStructuredStatement(out.statement) && out.statement.length >= 32) {
    return null;
  }

  return out;
}

/** 后处理：去重 + 自动补边 + 限制 op 数量 */
function postProcessPatch(
  graph: CDG,
  patch: GraphPatch,
  latestUserText: string,
  recentTurns?: Array<{ role: "user" | "assistant"; content: string }>
): GraphPatch {
  const signalText = mergeTextSegments([
    ...((recentTurns || [])
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .slice(-6)),
    latestUserText,
  ]);
  const enriched = enrichPatchRiskAndText(patch, latestUserText);
  const signals = extractIntentSignalsWithRecency(signalText, latestUserText);
  const canonicalIntent = buildTravelIntentStatement(signals, signalText);
  const existingByStmt = new Map<string, string>();
  for (const n of graph.nodes || []) {
    const key = normalizeForMatch(n.statement);
    if (key) existingByStmt.set(key, n.id);
  }

  const knownStmt = new Set<string>(existingByStmt.keys());
  for (const op of enriched.ops || []) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = normalizeForMatch(op.node.statement);
      if (key) knownStmt.add(key);
    }
  }

  const heuristicOps = buildHeuristicIntentOps(graph, signalText, latestUserText, knownStmt, enriched.ops || []);
  const mergedOps = [...(enriched.ops || []), ...heuristicOps].map((op: any) => {
    if (
      canonicalIntent &&
      op?.op === "add_node" &&
      op?.node?.type === "goal" &&
      typeof op?.node?.statement === "string" &&
      shouldNormalizeGoalStatement(op.node.statement, signals, signalText)
    ) {
      return {
        ...op,
        node: {
          ...op.node,
          statement: canonicalIntent,
          confidence: Math.max(Number(op.node.confidence) || 0.6, 0.85),
          importance: op.node.importance != null ? Math.max(Number(op.node.importance) || 0, 0.8) : 0.8,
        },
      };
    }
    return op;
  });

  const existingHealthId = (graph.nodes || []).find(isHealthConstraintNode)?.id || null;
  const healthAdds = (mergedOps || []).filter(
    (op: any) => op?.op === "add_node" && isHealthConstraintNode(op?.node)
  ) as any[];
  const keepHealthAddId =
    !existingHealthId && healthAdds.length
      ? [...healthAdds].sort((a, b) => scoreHealthNode(b.node) - scoreHealthNode(a.node))[0]?.node?.id || null
      : null;
  const healthMainId = existingHealthId || keepHealthAddId;
  const idRemap = new Map<string, string>();
  if (healthMainId) {
    for (const op of healthAdds) {
      const sid = String(op?.node?.id || "");
      if (!sid || sid === healthMainId) continue;
      idRemap.set(sid, healthMainId);
    }
  }

  const root = pickRootGoalId(graph);
  const newStmt = new Set<string>();
  const newStmtId = new Map<string, string>();
  const newNodes: Array<{
    id: string;
    type: string;
    statement: string;
    severity?: string;
    importance?: number;
  }> = [];
  const keptAddIds = new Set<string>();
  const edgePairs = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  const prepped = (mergedOps || []).reduce<any[]>((acc, op: any) => {
    if (op?.op === "add_node" && op?.node) {
      const normalizedNode = normalizeIncomingNode(op.node, signalText, latestUserText);
      if (!normalizedNode) return acc;
      if (!isValidAtomicNode(normalizedNode)) return acc;
      const sid = String(normalizedNode.id || op.node.id || "");
      if (sid && idRemap.has(sid)) return acc;
      acc.push({
        ...op,
        node: { ...normalizedNode, id: sid || op.node.id },
      });
      return acc;
    }
    if (op?.op === "update_node" && op?.patch && typeof op.patch === "object") {
      const patchObj: any = { ...op.patch };
      if (typeof patchObj.statement === "string") {
        const normalizedPatch = normalizeIncomingNode(
          { type: patchObj.type || "fact", ...patchObj, statement: patchObj.statement },
          signalText,
          latestUserText
        );
        if (!normalizedPatch) {
          delete patchObj.statement;
        } else {
          const s = cleanStatement(normalizedPatch.statement);
          if (
            !isValidDestinationStatement(s) ||
            !isValidPeopleStatement(s) ||
            !isValidBudgetStatement(s) ||
            !isValidTotalDurationStatement(s) ||
            !isValidCityDurationStatement(s)
          ) {
            delete patchObj.statement;
          } else {
            patchObj.statement = s;
            if (normalizedPatch.strength) patchObj.strength = normalizedPatch.strength;
            if (normalizedPatch.severity) patchObj.severity = normalizedPatch.severity;
            if (normalizedPatch.importance != null) patchObj.importance = normalizedPatch.importance;
            if (normalizedPatch.tags) patchObj.tags = normalizedPatch.tags;
            if (normalizedPatch.locked != null) patchObj.locked = normalizedPatch.locked;
          }
        }
      }
      if (!Object.keys(patchObj).length) return acc;
      acc.push({
        ...op,
        id: idRemap.get(String(op.id || "")) || op.id,
        patch: patchObj,
      });
      return acc;
    }
    if (op?.op === "add_edge" && op?.edge) {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) return acc;
      const key = `${from}|${to}|${op.edge.type}`;
      if (edgePairs.has(key)) return acc;
      edgePairs.add(key);
      acc.push({
        ...op,
        edge: { ...op.edge, from, to },
      });
      return acc;
    }
    acc.push(op);
    return acc;
  }, []);

  const determineOutCount = new Map<string, number>();
  const sparsePrepped: any[] = [];
  for (const op of prepped) {
    if (op?.op !== "add_edge" || op?.edge?.type !== "determine") {
      sparsePrepped.push(op);
      continue;
    }
    const from = String(op.edge.from || "");
    const next = (determineOutCount.get(from) || 0) + 1;
    if (next > 2) continue;
    determineOutCount.set(from, next);
    sparsePrepped.push(op);
  }

  for (const op of sparsePrepped) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = normalizeForMatch(op.node.statement);
      if (!key) continue;
      const existedId = existingByStmt.get(key);
      if (existedId) {
        idRemap.set(op.node.id, existedId);
        continue;
      }
      if (newStmt.has(key)) {
        const mapped = newStmtId.get(key);
        if (mapped) idRemap.set(op.node.id, mapped);
        continue;
      }
      newStmt.add(key);
      newStmtId.set(key, op.node.id);
      keptAddIds.add(op.node.id);
      newNodes.push({
        id: op.node.id,
        type: op.node.type,
        statement: cleanStatement(op.node.statement || "", 180),
        severity: op.node.severity,
        importance: op.node.importance,
      });
      continue;
    }
  }

  const kept: any[] = [];
  const addedEdgeKeys = new Set<string>((graph.edges || []).map((e) => `${e.from}|${e.to}|${e.type}`));
  for (const op of sparsePrepped) {
    if (op?.op === "add_node") {
      if (keptAddIds.has(op.node.id)) kept.push(op);
      continue;
    }
    if (op?.op === "update_node") {
      const mappedId = idRemap.get(String(op.id || "")) || op.id;
      if (!mappedId) continue;
      kept.push({ ...op, id: mappedId });
      continue;
    }
    if (op?.op === "add_edge") {
      const from = idRemap.get(String(op.edge.from || "")) || op.edge.from;
      const to = idRemap.get(String(op.edge.to || "")) || op.edge.to;
      if (!from || !to || from === to) continue;
      const key = `${from}|${to}|${op.edge.type}`;
      if (addedEdgeKeys.has(key)) continue;
      addedEdgeKeys.add(key);
      kept.push({ ...op, edge: { ...op.edge, from, to } });
      continue;
    }
    kept.push(op);
  }

  const rootForEdge =
    root ||
    (kept.find((x: any) => x?.op === "add_node" && x?.node?.type === "goal" && typeof x?.node?.id === "string")
      ?.node?.id as string | undefined) ||
    null;

  if (rootForEdge) {
    const hasEdge = (from: string, to: string) =>
      kept.some((x) => x?.op === "add_edge" && x?.edge?.from === from && x?.edge?.to === to);

    let k = 1;
    let autoAttachCount = 0;
    for (const n of newNodes) {
      if (autoAttachCount >= 4) break;
      if (!["constraint", "preference", "fact", "belief"].includes(n.type)) continue;
      if (!shouldAutoAttachToRoot(n)) continue;
      if (hasEdge(n.id, rootForEdge)) continue;
      kept.push({
        op: "add_edge",
        edge: {
          id: makeTempId(`e_auto${k++}`),
          from: n.id,
          to: rootForEdge,
          type: n.type === "constraint" ? "constraint" : "enable",
          confidence: 0.65,
        },
      });
      autoAttachCount += 1;
    }
  }

  return { ops: kept.slice(0, 24), notes: (enriched.notes || []).slice(0, 16) };
}

const GRAPH_SYSTEM_PROMPT = `
你是“用户意图图（CDG）更新器”。你不与用户对话，只输出用于更新图的增量 patch。

输出协议（必须严格遵守）：
<<<PATCH_JSON>>>
{ "ops": [ ... ], "notes": [ ... ] }
<<<END_PATCH_JSON>>>
不要输出任何其他文字，不要 Markdown，不要解释。

规则：
- 默认只使用 add_node / update_node / add_edge 三种操作。
- 禁止 remove_node/remove_edge（除非用户明确要求删除且你非常确定）。
- 节点类型：goal / constraint / preference / belief / fact / question
- constraint 可带 strength: hard|soft
- 若信息包含健康/安全/法律等高风险因素，务必设置 severity（high 或 critical），并可补 tags（如 ["health"]）。
- 若信息表达“不能/必须/禁忌”等限制，优先用 constraint，且 strength 优先 hard。
- 若出现“喜欢/更喜欢/不感兴趣”这类景点偏好，优先生成 preference；若用户明确“硬性要求”，可升为 constraint（通常 severity=medium）。
- statement 保持简洁，不要加“用户补充：/用户任务：”前缀。
- 旅行类请求优先拆分成原子节点：人数、目的地、时长、预算、健康限制、住宿偏好，不要把所有信息塞进一个节点。
- 避免把“第一天/第二天/详细行程建议”这类叙事文本直接建成节点。
- 对同一槽位（预算/时长/人数/目的地/住宿偏好）优先 update 旧节点，不要重复 add。
- 意图（goal）作为根节点，子节点尽量与根节点连通，避免孤立节点。
- 若有健康/安全硬约束，可作为第三层约束节点，第二层关键节点可用 determine 指向它。
- 非核心细节节点优先挂到相关二级节点（determine），不要全部直接连到根节点。
- 节点尽量附 evidenceIds（来自用户原句的短片段），用于前端高亮证据文本。
- 边类型：enable / constraint / determine / conflicts_with
- 去重：已有等价节点优先 update_node
- 连边克制：有 root_goal_id 时，constraint/preference/fact/belief 可以连到 root_goal_id
- 每轮 op 建议 1~6 个，少而准。
`.trim();

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const rootGoalId = pickRootGoalId(params.graph);

  const modelInput = {
    root_goal_id: rootGoalId,
    current_graph: params.graph,
    recent_dialogue: params.recentTurns,
    latest_turn: { user: params.userText, assistant: params.assistantText },
  };

  const resp = await openai.chat.completions.create({
    model: GRAPH_MODEL,
    messages: [
      { role: "system", content: GRAPH_SYSTEM_PROMPT },
      ...(params.systemPrompt
        ? [{ role: "system" as const, content: `任务补充（可参考）：\n${String(params.systemPrompt).trim()}` }]
        : []),
      {
        role: "user",
        content:
          `输入如下（JSON）。只输出分隔符包裹的 patch JSON：\n` + JSON.stringify(modelInput),
      },
    ],
    max_tokens: 900,
    temperature: 0.1,
  });

  const raw = String(resp.choices?.[0]?.message?.content ?? "");
  dlog("raw_len=", raw.length, "finish=", resp.choices?.[0]?.finish_reason);

  let basePatch: GraphPatch;
  const jsonText = extractBetween(raw, PATCH_START, PATCH_END);
  if (!jsonText) {
    dlog("missing markers -> fallback");
    basePatch = fallbackPatch(params.graph, params.userText, "missing_markers");
  } else {
    const parsed = safeJsonParse(jsonText);
    if (!parsed) {
      dlog("invalid json -> fallback");
      basePatch = fallbackPatch(params.graph, params.userText, "invalid_json");
    } else {
      // ✅ 核心：严格白名单清洗（默认禁止 remove）
      const strict = sanitizeGraphPatchStrict(parsed);
      if (!strict.ops.length) {
        dlog("empty strict ops -> fallback");
        basePatch = fallbackPatch(params.graph, params.userText, "empty_ops");
      } else {
        basePatch = strict;
      }
    }
  }

  const post = postProcessPatch(params.graph, basePatch, params.userText, params.recentTurns);
  if (!post.ops.length) {
    return fallbackPatch(params.graph, params.userText, "post_empty_ops");
  }

  // 打印 op 概览，定位“为什么图被清空”
  if (DEBUG) {
    const counts: Record<string, number> = {};
    for (const op of post.ops) counts[op.op] = (counts[op.op] || 0) + 1;
    dlog("ops_counts=", counts, "notes=", post.notes);
  }

  return post;
}
