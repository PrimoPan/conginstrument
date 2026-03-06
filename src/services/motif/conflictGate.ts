import type { ConceptMotif } from "./conceptMotifs.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

export type ConflictGateItem = {
  id: string;
  title: string;
  status: ConceptMotif["status"];
  statusReason?: string;
  confidence: number;
};

export type ConflictGatePayload = {
  blocked: true;
  unresolvedMotifs: ConflictGateItem[];
  message: string;
};

function cleanText(input: any, max = 140): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function isResolved(m: ConceptMotif): boolean {
  if (m.status !== "deprecated") return true;
  if ((m as any)?.resolved === true) return true;
  const reason = cleanText((m as any)?.statusReason, 120).toLowerCase();
  return reason.startsWith("user_resolved");
}

function isBlockingDeprecatedReason(reason: string): boolean {
  const r = cleanText(reason, 180).toLowerCase();
  if (!r) return false;
  if (r.startsWith("relation_conflict_with:")) return true;
  if (r === "relation_conflicts_with") return true;
  if (r.startsWith("explicit_negation")) return true;
  return false;
}

export function listUnresolvedDeprecatedMotifs(motifs: ConceptMotif[]): ConflictGateItem[] {
  return (motifs || [])
    .filter((m) => m.status === "deprecated" && !isResolved(m))
    .filter((m) => isBlockingDeprecatedReason(String((m as any)?.statusReason || "")))
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      title: cleanText(m.title || m.description || m.id, 120),
      status: m.status,
      statusReason: cleanText(m.statusReason || "", 120) || undefined,
      confidence: Number.isFinite(Number(m.confidence)) ? Number(m.confidence) : 0.7,
    }));
}

export function buildConflictGateMessage(items: ConflictGateItem[], locale?: AppLocale): string {
  const list = (items || []).slice(0, 4);
  const lines = list.map((x, i) => `${i + 1}. ${x.title}`).join("\n");
  return [
    t(
      locale,
      `当前检测到 ${items.length} 条冲突 motif，继续生成计划前需要先确认。`,
      `${items.length} conflicting motifs detected. Resolve them before continuing.`
    ),
    t(
      locale,
      "请在中间 Motif 面板对冲突项选择“确认保留”或“确认取消”，然后点击“保存并生成建议”。",
      'In the Motif panel, choose "keep" or "cancel" for each conflict, then click "Save and generate advice".'
    ),
    t(locale, "待确认冲突：", "Pending conflicts:"),
    lines || "- (none)",
  ].join("\n");
}

export function buildConflictGatePayload(motifs: ConceptMotif[], locale?: AppLocale): ConflictGatePayload | null {
  const unresolved = listUnresolvedDeprecatedMotifs(Array.isArray(motifs) ? motifs : []);
  if (!unresolved.length) return null;
  return {
    blocked: true,
    unresolvedMotifs: unresolved,
    message: buildConflictGateMessage(unresolved, locale),
  };
}
