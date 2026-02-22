import type { ConceptMotif } from "./conceptMotifs.js";

export type ConflictGateItem = {
  id: string;
  title: string;
  status: ConceptMotif["status"];
  statusReason?: string;
  confidence: number;
};

function cleanText(input: any, max = 140): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isResolved(m: ConceptMotif): boolean {
  if (m.status !== "deprecated") return true;
  if ((m as any)?.resolved === true) return true;
  const reason = cleanText((m as any)?.statusReason, 120).toLowerCase();
  return reason.startsWith("user_resolved");
}

export function listUnresolvedDeprecatedMotifs(motifs: ConceptMotif[]): ConflictGateItem[] {
  return (motifs || [])
    .filter((m) => m.status === "deprecated" && !isResolved(m))
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

export function buildConflictGateMessage(items: ConflictGateItem[]): string {
  const list = (items || []).slice(0, 4);
  const lines = list.map((x, i) => `${i + 1}. ${x.title}`).join("\n");
  return [
    `当前检测到 ${items.length} 条冲突 motif，继续生成计划前需要先确认。`,
    "请在中间 Motif 面板对冲突项选择“确认保留”或“确认停用”，然后点击“保存并生成建议”。",
    "待确认冲突：",
    lines || "- (none)",
  ].join("\n");
}

