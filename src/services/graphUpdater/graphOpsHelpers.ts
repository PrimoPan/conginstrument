import type { CDG } from "../../core/graph.js";
import { cleanStatement } from "./text.js";

export function inferEvidenceFromStatement(userText: string, statement: string): string[] | undefined {
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

export function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^用户任务[:：]\s*/g, "")
    .replace(/^任务[:：]\s*/g, "")
    .replace(/[“”"]/g, "")
    .toLowerCase();
}

export function statementDedupKey(statement: string, type?: string) {
  const core = normalizeForMatch(statement);
  if (!core) return "";
  const t = String(type || "").trim().toLowerCase();
  return t ? `${t}|${core}` : core;
}

export function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n: any) => n?.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((g: any) => g.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((g: any) => g.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals[0].id;
}
