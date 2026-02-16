import type { Strength } from "../../core/graph.js";
import { HARD_CONSTRAINT_RE, RISK_HEALTH_RE } from "./constants.js";
import { cleanStatement, mergeTags } from "./text.js";
import {
  extractCriticalPresentationRequirement,
  isLikelyDestinationCandidate,
  normalizeDestination,
  normalizePreferenceStatement,
  parseCnInt,
  pickHealthClause,
} from "./intentSignals.js";

export function isHealthConstraintNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (String(node.type || "") !== "constraint") return false;
  return RISK_HEALTH_RE.test(String(node.statement || ""));
}

export function scoreHealthNode(node: any): number {
  if (!isHealthConstraintNode(node)) return -1;
  const s = cleanStatement(node?.statement || "", 120);
  let score = Number(node?.confidence) || 0;
  if (/^健康约束[:：]/.test(s)) score += 4;
  if (String(node?.severity || "") === "critical") score += 2;
  if (node?.locked) score += 1;
  if (String(node?.strength || "") === "hard") score += 1;
  return score;
}

export function isValidDestinationStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^目的地[:：]\s*(.+)$/);
  if (!m?.[1]) return true;
  if (/[和、,，/]/.test(m[1])) return false;
  return isLikelyDestinationCandidate(m[1]);
}

export function isValidPeopleStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^同行人数[:：]\s*([0-9]+)\s*人?$/);
  return !statement.startsWith("同行人数") || !!m;
}

export function isValidBudgetStatement(statement: string): boolean {
  const m = cleanStatement(statement).match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
  return !/预算/.test(statement) || !!m;
}

export function isValidTotalDurationStatement(statement: string): boolean {
  const s = cleanStatement(statement);
  const m = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  return !/行程时长/.test(s) || !!m;
}

export function isValidCityDurationStatement(statement: string): boolean {
  const s = cleanStatement(statement);
  if (!/^(?:城市时长|停留时长)[:：]/.test(s)) return true;
  const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
  if (!m?.[1] || !m?.[2]) return false;
  return isLikelyDestinationCandidate(m[1]);
}

export function isValidAtomicNode(node: any): boolean {
  const s = cleanStatement(node?.statement || "");
  if (!s) return false;
  if (!isValidDestinationStatement(s)) return false;
  if (!isValidPeopleStatement(s)) return false;
  if (!isValidBudgetStatement(s)) return false;
  if (!isValidTotalDurationStatement(s)) return false;
  if (!isValidCityDurationStatement(s)) return false;
  return true;
}

export function normalizeDurationFromFreeText(statement: string): { kind: "total" | "city" | "meeting"; city?: string; days: number } | null {
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

export function normalizeIncomingNode(
  node: any,
  opts: {
    signalText: string;
    latestUserText: string;
    withNodeLayer: <T extends Record<string, any>>(node: T) => T;
    isLikelyNarrativeNoise: (statement: string, type?: string) => boolean;
    isStructuredStatement: (statement: string) => boolean;
  }
) {
  if (!node || typeof node !== "object") return null;

  const { signalText, latestUserText, withNodeLayer, isLikelyNarrativeNoise, isStructuredStatement } = opts;

  const out: any = { ...node };
  out.statement = cleanStatement(out.statement || "");
  if (!out.statement) return null;

  if (isLikelyNarrativeNoise(out.statement, out.type)) return null;

  const healthClause =
    (RISK_HEALTH_RE.test(out.statement) && pickHealthClause(out.statement)) ||
    pickHealthClause(latestUserText) ||
    pickHealthClause(signalText);
  if (healthClause && RISK_HEALTH_RE.test(out.statement)) {
    return withNodeLayer({
      ...out,
      type: "constraint",
      statement: `健康约束：${healthClause}`,
      strength: "hard",
      severity: "critical",
      importance: Math.max(Number(out.importance) || 0, 0.95),
      confidence: Math.max(Number(out.confidence) || 0.6, 0.9),
      locked: true,
      tags: mergeTags(out.tags, ["health", "safety"]),
    });
  }

  const pref = normalizePreferenceStatement(out.statement);
  if (pref) {
    const hardPref = !!pref.hard;
    return withNodeLayer({
      ...out,
      type: hardPref ? "constraint" : "preference",
      statement: pref.statement,
      strength: (hardPref ? "hard" : "soft") as Strength,
      severity: out.severity || "medium",
      importance: Math.max(Number(out.importance) || 0, hardPref ? 0.78 : 0.66),
      confidence: Math.max(Number(out.confidence) || 0.6, hardPref ? 0.82 : 0.76),
      tags: mergeTags(out.tags, ["preference", "culture"]),
    });
  }

  const criticalPresentation = extractCriticalPresentationRequirement(out.statement);
  if (criticalPresentation) {
    const city = criticalPresentation.city ? normalizeDestination(criticalPresentation.city) : "";
    const reason = cleanStatement(criticalPresentation.reason || "关键事项", 20);
    const label = city ? `${city}${reason}（${criticalPresentation.days}天）` : `${reason}（${criticalPresentation.days}天）`;
    return withNodeLayer({
      ...out,
      type: "constraint",
      statement: `会议关键日：${label}`,
      strength: "hard",
      severity: out.severity || "critical",
      importance: Math.max(Number(out.importance) || 0, 0.96),
      confidence: Math.max(Number(out.confidence) || 0.6, 0.9),
      tags: mergeTags(out.tags, ["meeting", "presentation", "deadline"]),
    });
  }

  const durationNorm = normalizeDurationFromFreeText(out.statement);
  if (durationNorm) {
    if (durationNorm.kind === "total") {
      return withNodeLayer({
        ...out,
        type: "constraint",
        statement: `总行程时长：${durationNorm.days}天`,
        strength: out.strength || "hard",
        confidence: Math.max(Number(out.confidence) || 0.6, 0.82),
        importance: Math.max(Number(out.importance) || 0, 0.76),
      });
    }
    if (durationNorm.kind === "meeting") {
      return withNodeLayer({
        ...out,
        type: "constraint",
        statement: `会议时长：${durationNorm.days}天`,
        strength: out.strength || "hard",
        confidence: Math.max(Number(out.confidence) || 0.6, 0.82),
        importance: Math.max(Number(out.importance) || 0, 0.8),
      });
    }
    return withNodeLayer({
      ...out,
      type: "fact",
      statement: `城市时长：${durationNorm.city} ${durationNorm.days}天`,
      confidence: Math.max(Number(out.confidence) || 0.6, 0.78),
      importance: Math.max(Number(out.importance) || 0, 0.7),
    });
  }

  if (out.type !== "goal" && !isStructuredStatement(out.statement) && out.statement.length >= 32) {
    return null;
  }

  return withNodeLayer(out);
}
