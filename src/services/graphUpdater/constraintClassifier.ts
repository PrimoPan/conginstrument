import {
  HARD_CONSTRAINT_RE,
  HARD_REQUIRE_RE,
  LANGUAGE_CONSTRAINT_RE,
  MEDICAL_HEALTH_RE,
} from "./constants.js";
import { cleanStatement } from "./text.js";

export type GenericConstraintKind =
  | "legal"
  | "safety"
  | "mobility"
  | "logistics"
  | "diet"
  | "religion"
  | "other";

export type ConstraintClassified = {
  family: "health" | "language" | "generic";
  kind?: GenericConstraintKind;
  text: string;
  hard: boolean;
  severity?: "medium" | "high" | "critical";
  importance: number;
  evidence: string;
};

const LEGAL_RE =
  /签证|申根|护照|入境|出入境|海关|居留|许可|visa|passport|immigration|permit|consulate|embassy/i;
const SAFETY_RE =
  /危险|高风险|不安全|治安|诈骗|抢劫|急救|夜间不宜|安全一点|更安全|治安好|security|safety|danger|emergency|risk/i;
const MOBILITY_RE =
  /行动不便|轮椅|无障碍|不能久走|不能爬|台阶|体力|走不动|搬运行李|mobility|wheelchair|accessibility/i;
const LOGISTICS_RE =
  /转机|换乘|赶路|托运|交通衔接|时差|航班|火车|机场接送|中转|connection|layover|flight|train|logistics/i;
const DIET_RE =
  /饮食|忌口|素食|清真|清真餐|过敏原|海鲜过敏|乳糖不耐|麸质|不吃辣|halal|kosher|vegetarian|vegan|allergy/i;
const RELIGION_RE =
  /宗教|礼拜|祷告|清真寺|教堂|寺庙|斋月|安息日|宗教活动|religion|prayer|mosque|church|temple|ramadan|sabbath/i;

function clampImportance(x: any, fallback = 0.72) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.35, Math.min(0.98, n));
}

function normalizeConstraintText(input: string): string {
  let s = cleanStatement(input || "", 120);
  s = s.replace(/^(健康约束|语言约束|关键约束|法律约束|安全约束|出行约束|沟通约束|区域偏好|住宿区域偏好)[:：]\s*/i, "").trim();
  const parts = s
    .split(/[，,。；;]/)
    .map((x) => cleanStatement(x, 80))
    .filter(Boolean);
  if (parts.length > 1) {
    const cueRe =
      /不能|必须|务必|一定|避免|禁忌|签证|护照|入境|治安|安全|轮椅|无障碍|转机|换乘|托运|语言障碍|不会英语|翻译|饮食|忌口|素食|清真|宗教|礼拜|祷告|斋月|安息日|halal|kosher|vegetarian|vegan|religion|prayer|visa|passport|safety|logistics/i;
    const picked = parts.find((p) => cueRe.test(p));
    if (picked) s = picked;
  }
  return s;
}

function semanticTokenize(text: string): string[] {
  const reduced = text
    .toLowerCase()
    .replace(
      /(所以|因此|就是|然后|这个|那个|尽量|需要|必须|最好|希望|我要|我们|我|请|一下|有点|比较|更|特别|都要|都得|that|this|need|must|please|just|really|kind of|sort of|a little|more|very|much|prefer|want)/g,
      " "
    )
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!reduced) return [];
  const raw = reduced.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,20}/g) || [];
  return Array.from(new Set(raw)).slice(0, 10);
}

function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union > 0 ? inter / union : 0;
}

function semanticConstraintFingerprint(text: string): string {
  const s = normalizeConstraintText(text);
  if (!s) return "";
  if (MEDICAL_HEALTH_RE.test(s)) return "health:core";
  if (LANGUAGE_CONSTRAINT_RE.test(s)) return "language:core";
  const { kind } = inferGenericKind(s);
  const tokens = semanticTokenize(s);
  if (kind === "safety") {
    const hasNight = /夜|night|late/i.test(s);
    const hasArea = /区域|片区|地段|社区|neighborhood|district|area|酒店|住宿|hotel|lodging|accommodation/i.test(s);
    return `safety:${hasNight ? "night" : "general"}:${hasArea ? "area" : "core"}`;
  }
  const core = tokens.slice(0, 4).join("+") || "core";
  return `${kind}:${core}`;
}

function inferHardness(text: string): boolean {
  return HARD_REQUIRE_RE.test(text) || HARD_CONSTRAINT_RE.test(text);
}

function inferGenericKind(text: string): { kind: GenericConstraintKind; severity?: "medium" | "high" | "critical" } {
  if (LEGAL_RE.test(text)) return { kind: "legal", severity: "high" };
  if (SAFETY_RE.test(text)) {
    const critical = /急救|人身|危及|critical|urgent/i.test(text);
    return { kind: "safety", severity: critical ? "critical" : "high" };
  }
  if (MOBILITY_RE.test(text)) return { kind: "mobility", severity: "high" };
  if (DIET_RE.test(text)) return { kind: "diet", severity: "high" };
  if (RELIGION_RE.test(text)) return { kind: "religion", severity: "high" };
  if (LOGISTICS_RE.test(text)) return { kind: "logistics", severity: "medium" };
  return { kind: "other", severity: "medium" };
}

export function classifyConstraintText(params: {
  text: string;
  evidence?: string;
  importance?: number;
  hardHint?: boolean;
}): ConstraintClassified | null {
  const text = normalizeConstraintText(params.text || "");
  if (!text) return null;
  const evidence = cleanStatement(params.evidence || text, 80);
  const hard = !!params.hardHint || inferHardness(text);

  if (MEDICAL_HEALTH_RE.test(text)) {
    return {
      family: "health",
      text,
      hard: true,
      severity: "critical",
      importance: clampImportance(params.importance, 0.95),
      evidence,
    };
  }

  if (LANGUAGE_CONSTRAINT_RE.test(text)) {
    return {
      family: "language",
      text,
      hard,
      severity: hard ? "high" : "medium",
      importance: clampImportance(params.importance, hard ? 0.84 : 0.76),
      evidence,
    };
  }

  const generic = inferGenericKind(text);
  const baseImportanceByKind: Record<GenericConstraintKind, number> = {
    legal: 0.88,
    safety: 0.9,
    mobility: 0.86,
    logistics: 0.76,
    diet: 0.84,
    religion: 0.84,
    other: 0.72,
  };

  return {
    family: "generic",
    kind: generic.kind,
    text,
    hard,
    severity: generic.severity,
    importance: clampImportance(
      params.importance,
      hard ? Math.max(baseImportanceByKind[generic.kind], 0.82) : baseImportanceByKind[generic.kind]
    ),
    evidence,
  };
}

export function dedupeClassifiedConstraints<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const accepted: Array<{ item: T; tokens: string[]; kindKey: string }> = [];
  const out: T[] = [];
  for (const it of items) {
    const key = normalizeConstraintText(it.text).toLowerCase();
    if (!key || seen.has(key)) continue;
    const kindKey = semanticConstraintFingerprint(key);
    if (kindKey && seen.has(kindKey)) continue;

    const tokens = semanticTokenize(key);
    const nearDup = accepted.some((x) => {
      if (kindKey && x.kindKey && kindKey.split(":")[0] !== x.kindKey.split(":")[0]) return false;
      const overlap = tokenOverlap(tokens, x.tokens);
      return overlap >= 0.75 || key.includes(normalizeConstraintText(x.item.text).toLowerCase()) || normalizeConstraintText(x.item.text).toLowerCase().includes(key);
    });
    if (nearDup) continue;

    out.push(it);
    accepted.push({ item: it, tokens, kindKey });
    seen.add(key);
    if (kindKey) seen.add(kindKey);
  }
  return out;
}
