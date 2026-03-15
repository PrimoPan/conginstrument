import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

export type PlanningDomain = "travel" | "long_term_personal_plan";
export type PlanningCondition = "visual" | "chatbot";
export type LongTermSegmentKey = "fitness" | "study";
export type LongTermTaskType = "fitness_planning" | "study_planning";
export type LongTermSourceLabel = "assistant_proposed" | "user_confirmed" | "co_authored";
export type LongTermSourceMapEntry = {
  source_label: LongTermSourceLabel;
  source_msg_ids: string[];
  evidence_terms: string[];
  field?: string;
  value?: string;
};
export type LongTermRecentTurn = {
  turnId?: string;
  userText?: string;
  assistantText?: string;
};

export type LongTermTaskState = {
  task_id: string;
  task_type: LongTermTaskType;
  plan_version: number;
  goal_summary: string;
  weekly_time_or_frequency: string;
  methods_or_activities: string[];
  diet_sleep_adjustments: string[];
  adherence_strategy: string[];
  constraints: string[];
  fallback_plan: string[];
  open_questions: string[];
  rationale_refs: string[];
  source_map: Record<string, LongTermSourceMapEntry>;
  export_ready_text: string;
  status: "idle" | "active" | "completed";
  last_updated: string;
};

export type LongTermScenarioState = {
  scenario_id: string;
  scenario_template: "fitness_then_study_v1";
  active_segment: LongTermSegmentKey;
  bundle_status: "active" | "awaiting_transition" | "completed";
  segments: {
    fitness: LongTermTaskState;
    study: LongTermTaskState;
  };
  combined_export_ready_text: string;
  transfer_source_task_id?: string;
  transfer_source_conversation_id?: string;
  last_updated: string;
};

function clean(input: any, max = 220): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMultiline(input: any, max = 4000): string {
  return String(input ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim()
    .slice(0, max);
}

function uniqStrings(values: any[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values || []) {
    const text = clean(raw, 180);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function t(locale: AppLocale | undefined, zh: string, en: string) {
  return isEnglishLocale(locale) ? en : zh;
}

const LONG_TERM_ARRAY_SOURCE_FIELDS = new Set([
  "methods_or_activities",
  "constraints",
  "diet_sleep_adjustments",
  "adherence_strategy",
  "fallback_plan",
]);

function stableHash(input: string): string {
  let hash = 2166136261;
  for (const ch of String(input || "")) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function slug(input: string, max = 48): string {
  return clean(input, 240)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function normalizeLongTermSourceLabel(raw: unknown): LongTermSourceLabel {
  const text = clean(raw, 40);
  if (text === "assistant_proposed" || text === "co_authored") return text;
  return "user_confirmed";
}

function looksLikeUserScopedSourceToken(token: string): boolean {
  return (
    token.includes("user") ||
    token === "latest_user" ||
    token.startsWith("msg_u") ||
    token.startsWith("u_") ||
    token.startsWith("turn_") ||
    token.startsWith("manual_")
  );
}

function normalizeLongTermSourceToken(
  raw: unknown,
  label: LongTermSourceLabel,
  fallbackIndex?: number
): string {
  const token = clean(raw, 120);
  if (!token) {
    return label === "user_confirmed" ? `turn_u_${Number(fallbackIndex || 0) + 1}` : "";
  }
  if (label !== "user_confirmed") return token;
  if (looksLikeUserScopedSourceToken(token)) return token;
  return `turn_u_${token}`;
}

function normalizeLongTermSourceMsgIds(raw: any[], label: LongTermSourceLabel): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of (raw || []).entries()) {
    const token = normalizeLongTermSourceToken(value, label, index);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

function inferLongTermSourceField(key: string): string {
  const normalized = clean(key, 120);
  if (!normalized) return "";
  const splitAt = normalized.indexOf("__");
  return splitAt >= 0 ? normalized.slice(0, splitAt) : normalized;
}

export function buildLongTermSourceMapKey(field: string, value?: string): string {
  const base = clean(field, 80).replace(/[^a-z0-9_]+/gi, "_");
  if (!base) return "field";
  if (!LONG_TERM_ARRAY_SOURCE_FIELDS.has(base)) return base;
  const cleanedValue = clean(value, 180);
  if (!cleanedValue) return base;
  return `${base}__${slug(cleanedValue, 48) || stableHash(cleanedValue)}`;
}

function normalizeLongTermSourceMapEntry(raw: any, fieldHint?: string): LongTermSourceMapEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const field = clean(raw?.field, 80) || clean(fieldHint, 80);
  const value = clean(raw?.value, 180);
  const sourceLabel = normalizeLongTermSourceLabel(raw?.source_label);
  return {
    source_label: sourceLabel,
    source_msg_ids: normalizeLongTermSourceMsgIds(raw?.source_msg_ids || raw?.sourceMsgIds || [], sourceLabel),
    evidence_terms: uniqStrings(raw?.evidence_terms || raw?.evidenceTerms || [], 8),
    field: field || undefined,
    value: value || undefined,
  };
}

function normalizeLongTermSourceMap(
  raw: any,
  fallback: Record<string, LongTermSourceMapEntry> = {}
): Record<string, LongTermSourceMapEntry> {
  const out: Record<string, LongTermSourceMapEntry> = {};
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : fallback;
  for (const [key, value] of Object.entries(source || {})) {
    const field = inferLongTermSourceField(key);
    const entry = normalizeLongTermSourceMapEntry(value, field);
    if (!entry) continue;
    const normalizedKey = buildLongTermSourceMapKey(entry.field || field, entry.value);
    out[normalizedKey] = entry;
  }
  return out;
}

function cloneLongTermSourceMap(
  raw: Record<string, LongTermSourceMapEntry> | null | undefined
): Record<string, LongTermSourceMapEntry> {
  return normalizeLongTermSourceMap(raw || {});
}

function upsertLongTermSourceMapEntry(
  target: Record<string, LongTermSourceMapEntry>,
  entry: LongTermSourceMapEntry
) {
  const field = clean(entry.field, 80);
  if (!field) return;
  const normalized: LongTermSourceMapEntry = {
    source_label: normalizeLongTermSourceLabel(entry.source_label),
    source_msg_ids: uniqStrings(entry.source_msg_ids || [], 12),
    evidence_terms: uniqStrings(entry.evidence_terms || [], 8),
    field,
    value: clean(entry.value, 180) || undefined,
  };
  const key = buildLongTermSourceMapKey(field, normalized.value);
  const prev = normalizeLongTermSourceMapEntry(target[key], field);
  target[key] = prev
    ? {
        ...normalized,
        source_msg_ids: uniqStrings([...(prev.source_msg_ids || []), ...(normalized.source_msg_ids || [])], 12),
        evidence_terms: uniqStrings([...(prev.evidence_terms || []), ...(normalized.evidence_terms || [])], 8),
      }
    : normalized;
}

function deleteLongTermSourceMapEntries(
  target: Record<string, LongTermSourceMapEntry>,
  field: string,
  value?: string
) {
  const normalizedField = clean(field, 80);
  if (!normalizedField) return;
  if (value != null) {
    delete target[buildLongTermSourceMapKey(normalizedField, value)];
    return;
  }
  for (const key of Object.keys(target)) {
    const entryField = clean(target[key]?.field, 80) || inferLongTermSourceField(key);
    if (entryField === normalizedField) delete target[key];
  }
}

export function getLongTermSourceMapEntry(
  task: Partial<LongTermTaskState> | null | undefined,
  field: string,
  value?: string
): LongTermSourceMapEntry | null {
  const map = normalizeLongTermSourceMap(task?.source_map || {});
  const normalizedField = clean(field, 80);
  if (!normalizedField) return null;
  const direct = map[buildLongTermSourceMapKey(normalizedField, value)];
  if (direct) return direct;
  const normalizedValue = clean(value, 180);
  if (!normalizedValue) return map[normalizedField] || null;
  for (const entry of Object.values(map)) {
    if (clean(entry?.field, 80) !== normalizedField) continue;
    if (clean(entry?.value, 180) === normalizedValue) return entry;
  }
  return null;
}

function hasLongTermUserSource(
  task: Partial<LongTermTaskState> | null | undefined,
  field: string,
  value?: string
) {
  const entry = getLongTermSourceMapEntry(task, field, value);
  return !!entry && entry.source_label === "user_confirmed" && entry.source_msg_ids.length > 0;
}

export function longTermTaskHasUserGroundedEvidence(
  task: Partial<LongTermTaskState> | null | undefined
): boolean {
  const map = normalizeLongTermSourceMap(task?.source_map || {});
  return Object.values(map).some(
    (entry) => entry.source_label === "user_confirmed" && (entry.source_msg_ids || []).length > 0
  );
}

const METHOD_LABELS: Record<string, { zh: string; en: string }> = {
  running: { zh: "跑步", en: "running" },
  cycling: { zh: "骑行", en: "cycling" },
  "strength training": { zh: "力量训练", en: "strength training" },
  "yoga / stretching": { zh: "瑜伽 / 拉伸", en: "yoga / stretching" },
  walking: { zh: "快走 / 散步", en: "walking" },
  "dance workouts": { zh: "跳操 / 舞蹈训练", en: "dance workouts" },
  "mobility work": { zh: "活动度训练", en: "mobility work" },
  "short HIIT": { zh: "短时高效间歇训练", en: "short HIIT" },
  "structured course": { zh: "系统课程", en: "structured course" },
  "project-based learning": { zh: "项目式学习", en: "project-based learning" },
  "lightweight content": { zh: "轻量内容学习", en: "lightweight content" },
  "case studies": { zh: "案例拆解", en: "case studies" },
  "reflection notes": { zh: "反思笔记", en: "reflection notes" },
  tutorials: { zh: "教程学习", en: "tutorials" },
  "audio learning": { zh: "播客 / 音频学习", en: "audio learning" },
};

const ADJUSTMENT_LABELS: Record<string, { zh: string; en: string }> = {
  "adjust sleep schedule": { zh: "调整睡眠作息", en: "adjust sleep schedule" },
  "keep diet lightweight and supportive": { zh: "饮食尽量清淡并补足营养", en: "keep diet lightweight and supportive" },
  "add brief recovery/stretch breaks": { zh: "加入短时恢复 / 拉伸", en: "add brief recovery/stretch breaks" },
  "stay hydrated": { zh: "注意补水", en: "stay hydrated" },
};

const CONSTRAINT_LABELS: Record<string, { zh: string; en: string }> = {
  "time becomes more limited": { zh: "时间比预期更少", en: "time becomes more limited" },
  "motivation is unstable": { zh: "有时缺乏动力，容易拖延", en: "motivation is unstable" },
  "schedule is unstable": { zh: "工作日程 / 作息不稳定", en: "schedule is unstable" },
  "keep the process low pressure": { zh: "希望过程保持轻松，不要压力过大", en: "keep the process low pressure" },
  "energy is limited": { zh: "精力有限", en: "energy is limited" },
};

const STRATEGY_LABELS: Record<string, { zh: string; en: string }> = {
  "start with short, low-friction sessions": { zh: "先从短时、低阻力开始", en: "start with short, low-friction sessions" },
  "keep sessions flexible": { zh: "训练 / 学习时段保持灵活", en: "keep sessions flexible" },
  "track a weekly minimum goal": { zh: "设置每周最低目标", en: "track a weekly minimum goal" },
  "prepare a fallback version for busy weeks": { zh: "提前准备忙周兜底版本", en: "prepare a fallback version for busy weeks" },
  "fit sessions into small time slots": { zh: "利用碎片时间插入短时段", en: "fit sessions into small time slots" },
  "tie the habit to existing routines": { zh: "把行动绑到已有日常习惯上", en: "tie the habit to existing routines" },
};

const FALLBACK_LABELS: Record<string, { zh: string; en: string }> = {
  "do a 10-20 minute workout when time is tight": { zh: "时间紧时做 10-20 分钟短练", en: "do a 10-20 minute workout when time is tight" },
  "do a short walk or stretch when energy is low": { zh: "精力低时先快走或拉伸几分钟", en: "do a short walk or stretch when energy is low" },
  "do a 10-20 minute study session when energy is low": { zh: "精力低时先学 10-20 分钟", en: "do a 10-20 minute study session when energy is low" },
  "use a tiny starter task to reduce resistance": { zh: "先做一个很小的起步任务降低阻力", en: "use a tiny starter task to reduce resistance" },
};

function localizeCanonical(
  locale: AppLocale | undefined,
  item: string,
  table: Record<string, { zh: string; en: string }>
) {
  const hit = table[clean(item, 180)];
  if (hit) return isEnglishLocale(locale) ? hit.en : hit.zh;
  return clean(item, 180);
}

export function localizeLongTermMethod(item: string, locale?: AppLocale) {
  return localizeCanonical(locale, item, METHOD_LABELS);
}

export function localizeLongTermAdjustment(item: string, locale?: AppLocale) {
  return localizeCanonical(locale, item, ADJUSTMENT_LABELS);
}

export function localizeLongTermConstraint(item: string, locale?: AppLocale) {
  return localizeCanonical(locale, item, CONSTRAINT_LABELS);
}

export function localizeLongTermStrategy(item: string, locale?: AppLocale) {
  return localizeCanonical(locale, item, STRATEGY_LABELS);
}

export function localizeLongTermFallback(item: string, locale?: AppLocale) {
  return localizeCanonical(locale, item, FALLBACK_LABELS);
}

function pickFirstMatch(src: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = src.match(pattern);
    if (match?.[1]) return clean(match[1], 80);
    if (match?.[0]) return clean(match[0], 80);
  }
  return "";
}

function emptyTaskState(params: {
  conversationId: string;
  segment: LongTermSegmentKey;
  nowIso: string;
}): LongTermTaskState {
  const taskType: LongTermTaskType =
    params.segment === "fitness" ? "fitness_planning" : "study_planning";
  return {
    task_id: `${clean(params.conversationId, 80)}:${params.segment}`,
    task_type: taskType,
    plan_version: 1,
    goal_summary: "",
    weekly_time_or_frequency: "",
    methods_or_activities: [],
    diet_sleep_adjustments: [],
    adherence_strategy: [],
    constraints: [],
    fallback_plan: [],
    open_questions: [],
    rationale_refs: [],
    source_map: {},
    export_ready_text: "",
    status: params.segment === "fitness" ? "active" : "idle",
    last_updated: params.nowIso,
  };
}

export function defaultLongTermScenarioState(params: {
  conversationId: string;
  locale?: AppLocale;
  nowIso?: string;
}): LongTermScenarioState {
  const nowIso = clean(params.nowIso, 80) || new Date().toISOString();
  return {
    scenario_id: clean(params.conversationId, 80),
    scenario_template: "fitness_then_study_v1",
    active_segment: "fitness",
    bundle_status: "active",
    segments: {
      fitness: emptyTaskState({ conversationId: params.conversationId, segment: "fitness", nowIso }),
      study: emptyTaskState({ conversationId: params.conversationId, segment: "study", nowIso }),
    },
    combined_export_ready_text: t(
      params.locale,
      "长期个人计划已创建，当前阶段为健身计划。",
      "Long-term planning scenario created. Current stage: fitness plan."
    ),
    last_updated: nowIso,
  };
}

export function readLongTermScenarioState(
  raw: any,
  params: { conversationId: string; locale?: AppLocale; nowIso?: string }
): LongTermScenarioState {
  const fallback = defaultLongTermScenarioState(params);
  if (!raw || typeof raw !== "object") return fallback;
  const fitness = raw?.segments?.fitness && typeof raw.segments.fitness === "object" ? raw.segments.fitness : {};
  const study = raw?.segments?.study && typeof raw.segments.study === "object" ? raw.segments.study : {};
  const activeSegment = clean(raw?.active_segment, 24) === "study" ? "study" : "fitness";
  const bundleStatus =
    clean(raw?.bundle_status, 24) === "awaiting_transition" || clean(raw?.bundle_status, 24) === "completed"
      ? (clean(raw?.bundle_status, 24) as LongTermScenarioState["bundle_status"])
      : "active";
  return {
    scenario_id: clean(raw?.scenario_id, 80) || fallback.scenario_id,
    scenario_template: "fitness_then_study_v1",
    active_segment: activeSegment,
    bundle_status: bundleStatus,
    segments: {
      fitness: normalizeTaskState(fitness, fallback.segments.fitness),
      study: normalizeTaskState(study, fallback.segments.study),
    },
    combined_export_ready_text: cleanMultiline(raw?.combined_export_ready_text, 4000) || fallback.combined_export_ready_text,
    transfer_source_task_id: clean(raw?.transfer_source_task_id, 120) || undefined,
    transfer_source_conversation_id: clean(raw?.transfer_source_conversation_id, 120) || undefined,
    last_updated: clean(raw?.last_updated, 80) || fallback.last_updated,
  };
}

function normalizeTaskState(raw: any, fallback: LongTermTaskState): LongTermTaskState {
  const status =
    clean(raw?.status, 24) === "idle" || clean(raw?.status, 24) === "completed"
      ? (clean(raw?.status, 24) as LongTermTaskState["status"])
      : "active";
  return {
    task_id: clean(raw?.task_id, 120) || fallback.task_id,
    task_type: clean(raw?.task_type, 40) === "study_planning" ? "study_planning" : fallback.task_type,
    plan_version: Math.max(1, Number(raw?.plan_version || fallback.plan_version || 1)),
    goal_summary: clean(raw?.goal_summary, 280),
    weekly_time_or_frequency: clean(raw?.weekly_time_or_frequency, 180),
    methods_or_activities: uniqStrings(raw?.methods_or_activities || [], 10),
    diet_sleep_adjustments: uniqStrings(raw?.diet_sleep_adjustments || [], 8),
    adherence_strategy: uniqStrings(raw?.adherence_strategy || [], 8),
    constraints: uniqStrings(raw?.constraints || [], 10),
    fallback_plan: uniqStrings(raw?.fallback_plan || [], 8),
    open_questions: uniqStrings(raw?.open_questions || [], 6),
    rationale_refs: uniqStrings(raw?.rationale_refs || [], 8),
    source_map: normalizeLongTermSourceMap(raw?.source_map, fallback.source_map),
    export_ready_text: cleanMultiline(raw?.export_ready_text, 4000),
    status,
    last_updated: clean(raw?.last_updated, 80) || fallback.last_updated,
  };
}

export function longTermTaskHasProgress(task: Partial<LongTermTaskState> | null | undefined): boolean {
  if (!task || typeof task !== "object") return false;
  if (clean(task.goal_summary, 280)) return true;
  if (clean(task.weekly_time_or_frequency, 180)) return true;
  if (uniqStrings(task.methods_or_activities || [], 1).length) return true;
  if (uniqStrings(task.diet_sleep_adjustments || [], 1).length) return true;
  if (uniqStrings(task.adherence_strategy || [], 1).length) return true;
  if (uniqStrings(task.constraints || [], 1).length) return true;
  if (uniqStrings(task.fallback_plan || [], 1).length) return true;
  if (cleanMultiline(task.export_ready_text, 4000)) return true;
  return false;
}

export function canAdvanceLongTermScenario(scenario: LongTermScenarioState | null | undefined): boolean {
  if (!scenario || scenario.bundle_status === "completed") return false;
  const activeTask = scenario.segments?.[scenario.active_segment];
  return longTermTaskHasProgress(activeTask);
}

type RelevantLongTermUserTurn = {
  sourceMsgId: string;
  rawText: string;
  relevantText: string;
};

function sourceTokenForLongTermTurn(turnId: unknown, index: number): string {
  return normalizeLongTermSourceToken(turnId, "user_confirmed", index);
}

function collectRelevantUserTurns(turns: LongTermRecentTurn[]): RelevantLongTermUserTurn[] {
  const out: RelevantLongTermUserTurn[] = [];
  let userIndex = 0;
  for (const turn of turns || []) {
    const rawText = clean(turn?.userText, 400);
    if (!rawText) continue;
    const relevantText = extractTaskRelevantUserText(rawText);
    if (!relevantText) continue;
    out.push({
      sourceMsgId: sourceTokenForLongTermTurn(turn?.turnId, userIndex),
      rawText,
      relevantText,
    });
    userIndex += 1;
  }
  return out;
}

const PURE_SMALL_TALK_RE =
  /^(?:(?:你好(?:呀|啊|哦)?|您好|哈喽|嗨|hi|hello|hey|早上好|中午好|下午好|晚上好|再见(?:啦)?|拜拜(?:啦)?|bye|goodbye|谢谢(?:你)?|多谢|感谢(?:你)?|thanks?|thank you|辛苦了|好的|ok(?:ay)?|收到|嗯嗯?|嗯哼|在吗|有人吗|test|testing)(?:\s|[，,。.!！？~～、；;:：])*)+$/i;
const LEADING_SMALL_TALK_PATTERNS = [
  /^(?:你好(?:呀|啊|哦)?|您好|哈喽|嗨|hi|hello|hey|早上好|中午好|下午好|晚上好|请问|打扰了|不好意思|劳驾)\s*(?:[，,。.!！？~～、；;:：]|\s)*/i,
  /^(?:谢谢(?:你)?|多谢|感谢(?:你)?|thanks?|thank you|辛苦了)\s*(?:[，,。.!！？~～、；;:：]|\s)*/i,
  /^(?:好的|好呀|好的呢|ok(?:ay)?|收到|嗯嗯?|嗯哼)\s*(?:[，,。.!！？~～、；;:：]|\s)*/i,
];
const TRAILING_SMALL_TALK_PATTERNS = [
  /(?:[，,。.!！？~～、；;:：]|\s)*(?:谢谢(?:你)?|多谢|感谢(?:你)?|thanks?|thank you|辛苦了)$/i,
  /(?:[，,。.!！？~～、；;:：]|\s)*(?:再见(?:啦)?|拜拜(?:啦)?|bye|goodbye)$/i,
];

function extractTaskRelevantUserText(raw: string): string {
  let text = clean(raw, 400);
  if (!text) return "";
  if (PURE_SMALL_TALK_RE.test(text)) return "";

  let changed = true;
  while (changed && text) {
    changed = false;
    for (const pattern of LEADING_SMALL_TALK_PATTERNS) {
      const next = clean(text.replace(pattern, ""), 400);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    for (const pattern of TRAILING_SMALL_TALK_PATTERNS) {
      const next = clean(text.replace(pattern, ""), 400);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }

  if (!text) return "";
  if (PURE_SMALL_TALK_RE.test(text)) return "";
  return text;
}

function firstNonEmpty(values: string[]): string {
  for (const value of values || []) {
    const text = clean(value, 280);
    if (text) return text;
  }
  return "";
}

function splitLongTermGoalSentences(text: string): string[] {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/[。！？!?;\n]+/)
    .map((part) => clean(part, 220))
    .filter(Boolean);
}

function trimConstraintTail(text: string): string {
  return clean(
    String(text || "")
      .split(/(?:但|不过|只是|最近|因为|所以|而且|同时|后来|结果|but|because|since|so|lately|recently)/i)[0],
    180
  );
}

function normalizeLongTermGoalChunk(raw: string, segment: LongTermSegmentKey): string {
  let text = clean(raw, 180);
  if (!text) return "";

  const directPatterns =
    segment === "fitness"
      ? [
          /主要(?:想|是)\s*([^，,。；！？!?]+)/,
          /目标(?:是|想)?\s*([^，,。；！？!?]+)/,
          /(?:我)?(?:最)?(?:想|希望|打算|准备)\s*([^，,。；！？!?]+)/,
          /(?:mainly want to|mostly want to|goal is to|want to|hope to)\s*([^,.;!?]+)/i,
        ]
      : [
          /主要(?:想|是)\s*([^，,。；！？!?]+)/,
          /目标(?:是|想)?\s*([^，,。；！？!?]+)/,
          /(?:我)?(?:最)?(?:想|希望|打算|准备)\s*([^，,。；！？!?]+)/,
          /(?:mainly want to|mostly want to|goal is to|want to|hope to)\s*([^,.;!?]+)/i,
        ];
  for (const pattern of directPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      text = clean(match[1], 160);
      break;
    }
  }

  text = clean(
    text
      .replace(/^(健身|运动|学习)(这块|方面)?/u, "")
      .replace(/^(我|现在|目前|最近|其实|就是|大概|先)\s*/u, "")
      .replace(/^(想|希望|打算|准备|计划)\s*/u, "")
      .replace(/^(做个?|制定|安排|建立|开始|尝试)\s*/u, "")
      .replace(/^(一个|一套)\s*/u, "")
      .replace(/^(健身|运动|学习)(计划|习惯|routine)?/iu, "")
      .replace(/^(先把健身搞起来|把健身搞起来|先运动起来|先学起来)/u, "")
      .replace(/^(补一点|补一补)/u, "补")
      .replace(/^(提升一点|提升一丢丢)/u, "提升")
      .replace(/^(关于|有关)\s*/u, "")
      .replace(/^to\s+/i, "")
      .replace(/^learn\s+/i, "learn ")
      .replace(/^build\s+(?:a\s+)?/i, "")
      .replace(/^start\s+/i, "")
      .replace(/[，,]\s*(?:主要|最好|然后|最近|因为|所以|但|不过).*/u, "")
      .replace(/[。；！？!?]+$/u, ""),
    120
  );

  return text;
}

function isGenericLongTermGoal(text: string, segment: LongTermSegmentKey): boolean {
  const normalized = clean(text, 120).toLowerCase();
  if (!normalized) return true;
  if (segment === "fitness") {
    return /^(健身|运动|健身计划|运动计划|健身习惯|运动习惯|开始健身|开始运动|build a sustainable fitness plan|start exercising|fitness plan|fitness routine)$/i.test(
      normalized
    );
  }
  return /^(学习|学习计划|学习习惯|开始学习|补知识|学点东西|build a sustainable study plan|study plan|study routine|learn more)$/i.test(
    normalized
  );
}

function extractGoalSummary(text: string, segment: LongTermSegmentKey, _locale?: AppLocale): string {
  const sentences = splitLongTermGoalSentences(text);
  const specific: string[] = [];
  const generic: string[] = [];

  for (const sentence of sentences) {
    const candidate = normalizeLongTermGoalChunk(trimConstraintTail(sentence), segment);
    if (!candidate) continue;
    if (isGenericLongTermGoal(candidate, segment)) generic.push(candidate);
    else specific.push(candidate);
  }

  const picked = firstNonEmpty([...specific, ...generic]);
  if (picked) return picked;
  return "";
}

function shouldReplaceGoalSummary(
  previousGoal: string,
  nextGoal: string,
  segment: LongTermSegmentKey
): boolean {
  const prev = clean(previousGoal, 180);
  const next = clean(nextGoal, 180);
  if (!next) return false;
  if (!prev) return true;
  if (prev === next) return false;
  if (isGenericLongTermGoal(prev, segment) && !isGenericLongTermGoal(next, segment)) return true;
  if (prev.length > 80 && next.length <= 60) return true;
  return false;
}

function extractWeeklyCadence(text: string, _segment: LongTermSegmentKey, _locale?: AppLocale): string {
  const src = String(text || "");
  const cn = pickFirstMatch(src, [
    /(每周[^。；\n]{0,24}(?:[0-9一二三四五六七八九十两半]+(?:到|至|\-|~)?[0-9一二三四五六七八九十两半]*)(?:次|小时|个小时))/,
    /(一周[^。；\n]{0,24}(?:[0-9一二三四五六七八九十两半]+(?:到|至|\-|~)?[0-9一二三四五六七八九十两半]*)(?:次|小时|个小时))/,
    /((?:两三次|两到三次|一到两次|一两个小时|两三个小时|三四小时))/,
  ]);
  if (cn) return cn;
  const enMatch = src.match(/(\d+\s*(?:-|to)?\s*\d*\s*(?:times|hours?)\s+per week)/i);
  if (enMatch?.[1]) return clean(enMatch[1], 80);
  return "";
}

function detectMethods(text: string, segment: LongTermSegmentKey): string[] {
  const out: string[] = [];
  const src = String(text || "");
  if (segment === "fitness") {
    if (/跑步|jog|run/i.test(src)) out.push("running");
    if (/骑行|cycling|bike/i.test(src)) out.push("cycling");
    if (/力量|抗阻|strength|core|bodyweight|自重|徒手|深蹲|俯卧撑|平板|器械/i.test(src)) out.push("strength training");
    if (/瑜伽|拉伸|伸展|yoga|stretch/i.test(src)) out.push("yoga / stretching");
    if (/walk|步行|walking|快走|散步/i.test(src)) out.push("walking");
    if (/跳操|舞蹈|dance/i.test(src)) out.push("dance workouts");
    if (/活动度|灵活性|mobility/i.test(src)) out.push("mobility work");
    if (/间歇|hiit/i.test(src)) out.push("short HIIT");
  } else {
    if (
      /course|课程|structured/i.test(src) &&
      !/不要像上课|别像上课|不太想.*课程|不想.*课程|too structured|lose interest.*structured|not.*course|another course/i.test(src)
    ) {
      out.push("structured course");
    }
    if (/project|项目式|做项目|项目实战|小改版|改版|redesign/i.test(src)) out.push("project-based learning");
    if (/视频|短视频|video|article|文章|短文/i.test(src)) out.push("lightweight content");
    if (/case study|案例拆解|案例分析|案例|relevant examples?|examples?/i.test(src)) out.push("case studies");
    if (/反思|复盘|reflection|note|笔记/i.test(src)) out.push("reflection notes");
    if (/教程|tutorial/i.test(src)) out.push("tutorials");
    if (/播客|音频|podcast/i.test(src)) out.push("audio learning");
  }
  return uniqStrings(out, 6);
}

function detectDietSleepAdjustments(text: string): string[] {
  const out: string[] = [];
  const src = String(text || "");
  if (/早点睡|早睡|少熬夜|规律作息|睡|sleep|作息/i.test(src)) out.push("adjust sleep schedule");
  if (/饮食清淡|补蛋白|饮食|diet|蛋白|protein|meal/i.test(src)) out.push("keep diet lightweight and supportive");
  if (/stretch|拉伸|放松|恢复|久坐|posture/i.test(src)) out.push("add brief recovery/stretch breaks");
  if (/喝水|补水|water|hydrate/i.test(src)) out.push("stay hydrated");
  return uniqStrings(out, 4);
}

function detectConstraints(text: string): string[] {
  const out: string[] = [];
  const src = String(text || "");
  if (
    /时间(变得)?更?少|时间不够|没时间|抽不出|只能挤出|碎片时间|时间被切碎|时间被切得很碎|时间偏紧|时间更紧|排得更满|多了一门课|多一门课|只有[^，。；\n]{0,12}(小时|分钟)|每周只有[^，。；\n]{0,12}(小时|次)|只剩[^，。；\n]{0,12}(空档|空当)|less time|limited time|busy|only have|only around|one or two hours|1-2 hours|more limited/i.test(
      src
    )
  ) {
    out.push("time becomes more limited");
  }
  if (
    /拖延|没动力|动力不足|提不起劲|不想开始|总想拖到明天|很难坚持|容易放弃|三天打鱼两天晒网|犯懒|懒得开始|摆烂|总想往后拖|往后拖|拖着不开始|一想到开始就犯懒|procrastinat|lack motivation|do not feel motivated|don't feel motivated|postpone|put it off|delay/i.test(
      src
    )
  ) {
    out.push("motivation is unstable");
  }
  if (
    /工作日程|排期|排班|排班飘忽|日程飘忽|临时开会|临时加会|临时被叫去开会|加班|日程不稳定|作息不固定|时间不固定|很难固定|schedule|unpredictable|unstable/i.test(
      src
    )
  ) {
    out.push("schedule is unstable");
  }
  if (
    /轻松一点|轻一点|不想太有压力|压力别太大|别太硬核|别像上课|别搞得像第二份工作|不想太卷|不想太认真|轻松|享受|有趣|enjoyable|overwhelmed|manageable|low pressure|another course|feel light|not too serious|second job/i.test(
      src
    )
  ) {
    out.push("keep the process low pressure");
  }
  if (
    /疲惫|很累|没精力|精力有限|下班后很累|下班后只想躺|脑子转不动|没电了|整个人没电|被榨干|被抽干|累瘫|tired|fatigue|精力|energy|drain/i.test(
      src
    )
  ) {
    out.push("energy is limited");
  }
  return uniqStrings(out, 6);
}

function detectAdherence(text: string): string[] {
  const out: string[] = [];
  const src = String(text || "");
  if (/短时|十来分钟|十几分钟|十多分钟|十分钟|十五分钟|二十分钟|10分钟|15分钟|20分钟|short|10-minute|15-minute|micro/i.test(src)) {
    out.push("start with short, low-friction sessions");
  }
  if (/灵活|弹性|看状态|有空就|有空再|插空|见缝插针|flexible|optional/i.test(src)) out.push("keep sessions flexible");
  if (/每周最低|最低目标|周目标|minimum|weekly goal/i.test(src)) out.push("track a weekly minimum goal");
  if (/fallback|busy week|忙周|忙的时候|兜底/i.test(src)) out.push("prepare a fallback version for busy weeks");
  if (/between|间隙|空档|空当|碎片时间|通勤|插空|见缝插针|study sessions|meetings/i.test(src)) out.push("fit sessions into small time slots");
  if (/绑定|顺手|习惯后面|起床后|下班后|after work|routine/i.test(src)) out.push("tie the habit to existing routines");
  return uniqStrings(out, 6);
}

function detectFallback(text: string, segment: LongTermSegmentKey): string[] {
  const out: string[] = [];
  const src = String(text || "");
  if (segment === "fitness") {
    if (/15|20|10/.test(src) || /short|micro|brief|快速|短时|十来分钟|十几分钟|十多分钟|十分钟运动|15分钟运动|20分钟运动/.test(src)) {
      out.push("do a 10-20 minute workout when time is tight");
    }
    if (/快走十分钟|拉伸十分钟|做一组徒手|快走|拉伸/.test(src)) {
      out.push("do a short walk or stretch when energy is low");
    }
  } else if (/15|20|10/.test(src) || /short|micro|brief|短时|十来分钟|十几分钟|十多分钟|10分钟学习|15分钟学习|20分钟学习/.test(src)) {
    out.push("do a 10-20 minute study session when energy is low");
  }
  if (/watch|video|article|读一篇|看一个|记一条|短视频|短文|听一段|听个播客|听点播客|听播客|播客也算|播客/.test(src)) {
    out.push("use a tiny starter task to reduce resistance");
  }
  return uniqStrings(out, 4);
}

function buildOpenQuestions(segment: LongTermSegmentKey, task: Partial<LongTermTaskState>, locale?: AppLocale): string[] {
  const out: string[] = [];
  if (!clean(task.goal_summary, 120)) {
    out.push(
      segment === "fitness"
        ? t(locale, "你最想通过健身改善什么？", "What do you most want your fitness plan to improve?")
        : t(locale, "你最想通过学习提升什么？", "What do you most want your study plan to improve?")
    );
  }
  if (!clean(task.weekly_time_or_frequency, 120)) {
    out.push(
      segment === "fitness"
        ? t(locale, "每周大概能安排几次运动？", "How often can you realistically exercise each week?")
        : t(locale, "每周大概能安排多少学习时间？", "How much time can you realistically study each week?")
    );
  }
  if (!task.methods_or_activities?.length) {
    out.push(
      segment === "fitness"
        ? t(locale, "哪种运动方式更容易让你坚持？", "Which forms of exercise are easiest for you to sustain?")
        : t(locale, "哪种学习方式最适合你的节奏？", "Which study method best fits your rhythm?")
    );
  }
  return uniqStrings(out, 3);
}

function buildTaskExportText(task: LongTermTaskState, locale?: AppLocale): string {
  const lines = [
    `${t(locale, "目标", "Goal")}: ${clean(task.goal_summary, 220) || t(locale, "待确认", "TBD")}`,
    `${t(locale, "每周安排", "Weekly cadence")}: ${
      clean(task.weekly_time_or_frequency, 160) || t(locale, "待确认", "TBD")
    }`,
  ];
  if (task.methods_or_activities.length) {
    lines.push(
      `${t(locale, "方式", "Methods")}: ${task.methods_or_activities
        .map((item) => localizeLongTermMethod(item, locale))
        .join(", ")}`
    );
  }
  if (task.diet_sleep_adjustments.length) {
    lines.push(
      `${t(locale, "作息 / 饮食调整", "Diet / sleep adjustments")}: ${task.diet_sleep_adjustments
        .map((item) => localizeLongTermAdjustment(item, locale))
        .join(", ")}`
    );
  }
  if (task.constraints.length) {
    lines.push(
      `${t(locale, "约束", "Constraints")}: ${task.constraints
        .map((item) => localizeLongTermConstraint(item, locale))
        .join(", ")}`
    );
  }
  if (task.adherence_strategy.length) {
    lines.push(
      `${t(locale, "坚持策略", "Adherence strategy")}: ${task.adherence_strategy
        .map((item) => localizeLongTermStrategy(item, locale))
        .join(", ")}`
    );
  }
  if (task.fallback_plan.length) {
    lines.push(
      `${t(locale, "兜底方案", "Fallback")}: ${task.fallback_plan
        .map((item) => localizeLongTermFallback(item, locale))
        .join(", ")}`
    );
  }
  return lines.join("\n");
}

function turnContainsEvidence(turn: RelevantLongTermUserTurn, evidenceTerms: string[]): boolean {
  const haystacks = [clean(turn.rawText, 400).toLowerCase(), clean(turn.relevantText, 400).toLowerCase()].filter(Boolean);
  return evidenceTerms.some((term) => {
    const needle = clean(term, 120).toLowerCase();
    if (!needle) return false;
    return haystacks.some((text) => text.includes(needle));
  });
}

function buildLongTermSourceMapEntry(params: {
  field: string;
  value: string;
  turns: RelevantLongTermUserTurn[];
  evidenceTerms?: string[];
}): LongTermSourceMapEntry | null {
  const field = clean(params.field, 80);
  const value = clean(params.value, 180);
  if (!field || !value || !(params.turns || []).length) return null;
  const evidenceTerms = uniqStrings([...(params.evidenceTerms || []), value], 8);
  const matchedTurns = params.turns.filter((turn) => turnContainsEvidence(turn, evidenceTerms));
  const sourceMsgIds = uniqStrings(
    (matchedTurns.length ? matchedTurns : [params.turns[params.turns.length - 1]]).map((turn) => turn.sourceMsgId),
    12
  );
  return {
    source_label: "user_confirmed",
    source_msg_ids: sourceMsgIds,
    evidence_terms: evidenceTerms,
    field,
    value,
  };
}

function syncLongTermArraySourceMap(params: {
  target: Record<string, LongTermSourceMapEntry>;
  field: string;
  values: string[];
  detectedValues: string[];
  turns: RelevantLongTermUserTurn[];
}) {
  const keptValues = new Set(params.values.map((value) => clean(value, 180)).filter(Boolean));
  for (const [key, entry] of Object.entries(params.target)) {
    const field = clean(entry?.field, 80) || inferLongTermSourceField(key);
    if (field !== clean(params.field, 80)) continue;
    const value = clean(entry?.value, 180);
    if (value && !keptValues.has(value)) delete params.target[key];
  }
  for (const value of params.detectedValues || []) {
    const entry = buildLongTermSourceMapEntry({
      field: params.field,
      value,
      turns: params.turns,
      evidenceTerms: [value],
    });
    if (entry) upsertLongTermSourceMapEntry(params.target, entry);
  }
}

function nextPlanVersion(previous: LongTermTaskState, nextText: string): number {
  return clean(previous.export_ready_text, 1200) === clean(nextText, 1200)
    ? Math.max(1, Number(previous.plan_version || 1))
    : Math.max(1, Number(previous.plan_version || 1)) + 1;
}

export function rebuildLongTermScenarioState(params: {
  previous?: LongTermScenarioState | null;
  conversationId: string;
  locale?: AppLocale;
  activeSegment?: LongTermSegmentKey;
  recentTurns: LongTermRecentTurn[];
  updatedAt?: string;
}): LongTermScenarioState {
  const nowIso = clean(params.updatedAt, 80) || new Date().toISOString();
  const previous = readLongTermScenarioState(params.previous, {
    conversationId: params.conversationId,
    locale: params.locale,
    nowIso,
  });
  const activeSegment = params.activeSegment || previous.active_segment;
  const previousTask = previous.segments[activeSegment];
  const relevantUserTurns = collectRelevantUserTurns(params.recentTurns);
  const userText = relevantUserTurns.map((turn) => turn.relevantText).join(" ");
  if (!userText) {
    return {
      ...previous,
      active_segment: activeSegment,
      segments: {
        ...previous.segments,
        [activeSegment]: {
          ...previousTask,
          last_updated: nowIso,
        },
      },
      last_updated: nowIso,
    };
  }
  const fullText = userText;
  const previousGoalSummary = hasLongTermUserSource(previousTask, "goal_summary")
    ? clean(previousTask.goal_summary, 280)
    : "";
  const previousWeeklyCadence = hasLongTermUserSource(previousTask, "weekly_time_or_frequency")
    ? clean(previousTask.weekly_time_or_frequency, 180)
    : "";
  const extractedGoalSummary = extractGoalSummary(userText, activeSegment, params.locale);
  const goalSummary = shouldReplaceGoalSummary(previousGoalSummary, extractedGoalSummary, activeSegment)
    ? extractedGoalSummary
    : firstNonEmpty([previousGoalSummary, extractedGoalSummary]);
  const extractedWeeklyCadence = extractWeeklyCadence(fullText, activeSegment, params.locale);
  const weeklyTimeOrFrequency = firstNonEmpty([extractedWeeklyCadence, previousWeeklyCadence]);
  const detectedMethods = detectMethods(fullText, activeSegment);
  const methods = uniqStrings([...previousTask.methods_or_activities, ...detectedMethods], 8);
  const detectedDietSleepAdjustments = detectDietSleepAdjustments(fullText);
  const dietSleepAdjustments = uniqStrings(
    [...previousTask.diet_sleep_adjustments, ...detectedDietSleepAdjustments],
    6
  );
  const detectedAdherenceStrategy = detectAdherence(fullText);
  const adherenceStrategy = uniqStrings([...previousTask.adherence_strategy, ...detectedAdherenceStrategy], 6);
  const detectedConstraints = detectConstraints(fullText);
  const constraints = uniqStrings([...previousTask.constraints, ...detectedConstraints], 6);
  const detectedFallbackPlan = detectFallback(fullText, activeSegment);
  const fallbackPlan = uniqStrings([...previousTask.fallback_plan, ...detectedFallbackPlan], 5);
  const rationaleRefs = uniqStrings(
    [
      ...previousTask.rationale_refs,
      ...constraints,
      ...adherenceStrategy.map((item) => `strategy:${item}`),
    ],
    8
  );
  const sourceMap = cloneLongTermSourceMap(previousTask.source_map);

  deleteLongTermSourceMapEntries(sourceMap, "goal_summary");
  if (goalSummary) {
    const goalEntry =
      extractedGoalSummary && clean(goalSummary, 180) === clean(extractedGoalSummary, 180)
        ? buildLongTermSourceMapEntry({
            field: "goal_summary",
            value: goalSummary,
            turns: relevantUserTurns,
            evidenceTerms: [extractedGoalSummary],
          })
        : getLongTermSourceMapEntry(previousTask, "goal_summary");
    if (goalEntry) {
      upsertLongTermSourceMapEntry(sourceMap, {
        ...goalEntry,
        field: "goal_summary",
        value: goalSummary,
      });
    }
  }

  deleteLongTermSourceMapEntries(sourceMap, "weekly_time_or_frequency");
  if (weeklyTimeOrFrequency) {
    const cadenceEntry =
      extractedWeeklyCadence && clean(weeklyTimeOrFrequency, 180) === clean(extractedWeeklyCadence, 180)
        ? buildLongTermSourceMapEntry({
            field: "weekly_time_or_frequency",
            value: weeklyTimeOrFrequency,
            turns: relevantUserTurns,
            evidenceTerms: [extractedWeeklyCadence],
          })
        : getLongTermSourceMapEntry(previousTask, "weekly_time_or_frequency");
    if (cadenceEntry) {
      upsertLongTermSourceMapEntry(sourceMap, {
        ...cadenceEntry,
        field: "weekly_time_or_frequency",
        value: weeklyTimeOrFrequency,
      });
    }
  }

  syncLongTermArraySourceMap({
    target: sourceMap,
    field: "methods_or_activities",
    values: methods,
    detectedValues: detectedMethods,
    turns: relevantUserTurns,
  });
  syncLongTermArraySourceMap({
    target: sourceMap,
    field: "diet_sleep_adjustments",
    values: dietSleepAdjustments,
    detectedValues: detectedDietSleepAdjustments,
    turns: relevantUserTurns,
  });
  syncLongTermArraySourceMap({
    target: sourceMap,
    field: "adherence_strategy",
    values: adherenceStrategy,
    detectedValues: detectedAdherenceStrategy,
    turns: relevantUserTurns,
  });
  syncLongTermArraySourceMap({
    target: sourceMap,
    field: "constraints",
    values: constraints,
    detectedValues: detectedConstraints,
    turns: relevantUserTurns,
  });
  syncLongTermArraySourceMap({
    target: sourceMap,
    field: "fallback_plan",
    values: fallbackPlan,
    detectedValues: detectedFallbackPlan,
    turns: relevantUserTurns,
  });

  const draftTask: LongTermTaskState = {
    ...previousTask,
    goal_summary: goalSummary,
    weekly_time_or_frequency: weeklyTimeOrFrequency,
    methods_or_activities: methods,
    diet_sleep_adjustments: dietSleepAdjustments,
    adherence_strategy: adherenceStrategy,
    constraints,
    fallback_plan: fallbackPlan,
    rationale_refs: rationaleRefs,
    open_questions: [],
    source_map: sourceMap,
    status: previousTask.status === "completed" ? "completed" : "active",
    last_updated: nowIso,
  };
  const exportText = buildTaskExportText(draftTask, params.locale);
  draftTask.export_ready_text = exportText;
  draftTask.plan_version = nextPlanVersion(previousTask, exportText);
  draftTask.open_questions = buildOpenQuestions(activeSegment, draftTask, params.locale);

  const next: LongTermScenarioState = {
    ...previous,
    active_segment: activeSegment,
    bundle_status: previous.bundle_status === "completed" ? "completed" : "active",
    segments: {
      ...previous.segments,
      [activeSegment]: draftTask,
    },
    combined_export_ready_text: [
      draftTask.status === "completed" || activeSegment === "fitness"
        ? buildSegmentLabel("fitness", params.locale, previous.segments.fitness.export_ready_text || draftTask.export_ready_text)
        : buildSegmentLabel("fitness", params.locale, previous.segments.fitness.export_ready_text),
      buildSegmentLabel("study", params.locale, previous.segments.study.export_ready_text),
    ]
      .filter(Boolean)
      .join("\n\n"),
    last_updated: nowIso,
  };
  return next;
}

function buildSegmentLabel(segment: LongTermSegmentKey, locale: AppLocale | undefined, text: string): string {
  const body = cleanMultiline(text, 4000);
  if (!body) return "";
  return `${segment === "fitness" ? t(locale, "Task 3 健身计划", "Task 3 Fitness Plan") : t(locale, "Task 4 学习计划", "Task 4 Study Plan")}\n${body}`;
}

export function advanceLongTermScenario(params: {
  previous?: LongTermScenarioState | null;
  conversationId: string;
  locale?: AppLocale;
  nowIso?: string;
}): LongTermScenarioState {
  const nowIso = clean(params.nowIso, 80) || new Date().toISOString();
  const prev = readLongTermScenarioState(params.previous, {
    conversationId: params.conversationId,
    locale: params.locale,
    nowIso,
  });
  if (prev.active_segment === "fitness") {
    const fitness = {
      ...prev.segments.fitness,
      status: "completed" as const,
      last_updated: nowIso,
    };
    const study = {
      ...prev.segments.study,
      status: "active" as const,
      last_updated: nowIso,
    };
    return {
      ...prev,
      active_segment: "study",
      bundle_status: "active",
      segments: { fitness, study },
      transfer_source_task_id: fitness.task_id,
      transfer_source_conversation_id: clean(params.conversationId, 80),
      combined_export_ready_text: [
        buildSegmentLabel("fitness", params.locale, fitness.export_ready_text),
        buildSegmentLabel("study", params.locale, study.export_ready_text),
      ]
        .filter(Boolean)
        .join("\n\n"),
      last_updated: nowIso,
    };
  }
  return {
    ...prev,
    bundle_status: "completed",
    segments: {
      ...prev.segments,
      study: {
        ...prev.segments.study,
        status: "completed",
        last_updated: nowIso,
      },
    },
    combined_export_ready_text: [
      buildSegmentLabel("fitness", params.locale, prev.segments.fitness.export_ready_text),
      buildSegmentLabel("study", params.locale, prev.segments.study.export_ready_text),
    ]
      .filter(Boolean)
      .join("\n\n"),
    last_updated: nowIso,
  };
}

export function longTermTaskActionLabel(params: {
  scenario: LongTermScenarioState | null | undefined;
  locale?: AppLocale;
}): string {
  const scenario = params.scenario;
  if (!scenario) return t(params.locale, "进入下一任务", "Start next task");
  if (scenario.bundle_status === "completed") {
    return t(params.locale, "长期个人计划已完成", "Long-term planning completed");
  }
  return scenario.active_segment === "fitness"
    ? t(params.locale, "进入 Task 4 学习计划", "Go to Task 4 Study Plan")
    : t(params.locale, "完成长期个人计划", "Complete long-term planning");
}

export function buildLongTermPseudoPlanningTask(task: LongTermTaskState) {
  return {
    task_id: task.task_id,
    trip_goal_summary: task.goal_summary,
    constraints: task.constraints,
    travel_dates_or_duration: task.weekly_time_or_frequency,
    travelers: task.methods_or_activities,
    summary: task.export_ready_text,
  };
}
