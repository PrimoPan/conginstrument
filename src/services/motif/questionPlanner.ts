import type { AppLocale } from "../../i18n/locale.js";
import { isEnglishLocale } from "../../i18n/locale.js";
import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "./conceptMotifs.js";
import type { MotifTransferState } from "../motifTransfer/types.js";

export type MotifQuestionPlan = {
  question: string | null;
  rationale: string;
  topMotifId?: string;
  template?: "direct" | "counterfactual" | "mediation";
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

function normalizeForMatch(input: string): string {
  return cleanText(input, 260).toLowerCase().replace(/\s+/g, "");
}

function wasAskedRecently(question: string, recentTurns: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  const q = normalizeForMatch(question);
  if (!q) return false;
  const recentAssistant = (recentTurns || [])
    .filter((x) => x.role === "assistant")
    .slice(-4)
    .map((x) => normalizeForMatch(String(x.content || "")))
    .filter(Boolean);
  return recentAssistant.some((x) => x.includes(q) || q.includes(x.slice(0, Math.min(18, x.length))));
}

function isResolvedDeprecated(m: ConceptMotif): boolean {
  if (m.status !== "deprecated") return false;
  if (m.resolved === true) return true;
  const reason = cleanText(m.statusReason, 120).toLowerCase();
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

function motifUncertaintyScore(m: ConceptMotif): number {
  const confidence = Math.max(0, Math.min(1, Number(m.confidence || 0.7)));
  const statusBoost = m.status === "uncertain" ? 1.08 : m.status === "deprecated" ? 1.12 : 0.86;
  return Math.max(0.05, (1 - confidence) * statusBoost);
}

function motifCentralityScore(m: ConceptMotif, motifs: ConceptMotif[]): number {
  const ids = new Set((m.conceptIds || []).map((x) => cleanText(x, 100)).filter(Boolean));
  if (!ids.size) return 0.3;
  let touch = 0;
  for (const other of motifs || []) {
    if (other.id === m.id || other.status === "cancelled") continue;
    const overlap = (other.conceptIds || []).some((cid) => ids.has(cleanText(cid, 100)));
    if (overlap) touch += 1;
  }
  return Math.max(0.25, Math.min(1, touch / Math.max(2, motifs.length || 1)));
}

function coverageGapWeight(m: ConceptMotif): number {
  const reason = cleanText(m.statusReason, 160).toLowerCase();
  if (reason.includes("coverage_repair") || reason.includes("not_supported_by_current_graph")) return 1.16;
  if (reason.includes("relation_conflict_with")) return 1.2;
  return m.status === "deprecated" ? 1.1 : 1;
}

function transferRiskScore(m: ConceptMotif, transferState?: MotifTransferState | null): number {
  const motifTypeId = cleanText((m as any)?.motif_type_id, 180);
  if (!motifTypeId) return 0.72;
  const injection = (transferState?.activeInjections || []).find((x) => cleanText(x.motif_type_id, 180) === motifTypeId);
  if (!injection) return 0.72;
  const confidence = Math.max(0, Math.min(1, Number(injection.transfer_confidence || 0.7)));
  const disabledBoost = injection.injection_state === "disabled" ? 1.18 : 1;
  return Math.max(0.45, (1 - confidence) * disabledBoost + 0.55);
}

function motifImpactScore(m: ConceptMotif, motifs: ConceptMotif[], transferState?: MotifTransferState | null): number {
  return (
    motifUncertaintyScore(m) *
    motifCentralityScore(m, motifs) *
    coverageGapWeight(m) *
    transferRiskScore(m, transferState)
  );
}

function termPriorityScore(raw: string): number {
  const text = cleanText(raw, 80);
  if (!text) return -1;
  let score = 0;
  if (/[0-9]/.test(text)) score += 2;
  if (/(元|人民币|预算|cny|usd|eur|gbp|hkd|jpy|\$|€|£|hotel|酒店|住宿|dining|餐饮)/i.test(text)) score += 2;
  if (text.length >= 6) score += 1;
  return score;
}

function conceptPhrase(id: string, conceptById: Map<string, ConceptItem>): string {
  const concept = conceptById.get(id);
  const evidenceTerms = Array.isArray(concept?.evidenceTerms) ? concept!.evidenceTerms : [];
  const bestEvidence = evidenceTerms
    .map((x) => cleanText(x, 80))
    .filter(Boolean)
    .sort((a, b) => termPriorityScore(b) - termPriorityScore(a) || b.length - a.length)[0];
  if (bestEvidence) return bestEvidence;
  return cleanText(concept?.title, 56) || cleanText(id, 32) || "concept";
}

function motifSourceIds(m: ConceptMotif): string[] {
  const roleSources = Array.isArray((m as any)?.roles?.sources) ? ((m as any).roles.sources as string[]) : [];
  if (roleSources.length) return roleSources.map((x) => cleanText(x, 100)).filter(Boolean);
  return (m.conceptIds || [])
    .map((x) => cleanText(x, 100))
    .filter(Boolean)
    .filter((id) => id !== cleanText(m.anchorConceptId, 100));
}

function motifTargetId(m: ConceptMotif): string {
  const roleTarget = cleanText((m as any)?.roles?.target, 100);
  if (roleTarget) return roleTarget;
  const anchor = cleanText(m.anchorConceptId, 100);
  if (anchor) return anchor;
  const ids = (m.conceptIds || []).map((x) => cleanText(x, 100)).filter(Boolean);
  return ids[ids.length - 1] || "";
}

function directTemplate(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
  locale?: AppLocale;
}): string {
  const sourceId = motifSourceIds(params.motif)[0] || "";
  const targetId = motifTargetId(params.motif);
  const source = conceptPhrase(sourceId, params.conceptById);
  const target = conceptPhrase(targetId, params.conceptById);
  const dep = cleanText(params.motif.dependencyClass || params.motif.relation, 40);
  if (dep === "constraint") {
    return t(
      params.locale,
      `直接确认：你是说“${source}”会直接限制“${target}”吗？`,
      `Direct confirmation: do you mean "${source}" directly limits "${target}"?`
    );
  }
  return t(
    params.locale,
    `直接确认：你是说“${source}”会直接促成“${target}”吗？`,
    `Direct confirmation: do you mean "${source}" directly enables "${target}"?`
  );
}

function counterfactualTemplate(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
  locale?: AppLocale;
}): string {
  const sourceId = motifSourceIds(params.motif)[0] || "";
  const targetId = motifTargetId(params.motif);
  const source = conceptPhrase(sourceId, params.conceptById);
  const target = conceptPhrase(targetId, params.conceptById);
  return t(
    params.locale,
    `反事实确认：如果“${source}”变成另一种情况，你对“${target}”的决策会改变吗？`,
    `Counterfactual probe: if "${source}" changed, would your decision on "${target}" change as well?`
  );
}

function mediationTemplate(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
  locale?: AppLocale;
}): string {
  const sourceIds = motifSourceIds(params.motif);
  const sourceId = sourceIds[0] || "";
  const mediatorId = sourceIds[1] || "";
  const targetId = motifTargetId(params.motif);
  const source = conceptPhrase(sourceId, params.conceptById);
  const mediator = conceptPhrase(mediatorId, params.conceptById);
  const target = conceptPhrase(targetId, params.conceptById);
  return t(
    params.locale,
    `中介链路确认：你是说“${source}”会先影响“${mediator}”，再影响“${target}”吗？`,
    `Mediation check: do you mean "${source}" influences "${mediator}" first, then affects "${target}"?`
  );
}

function pickTemplate(motif: ConceptMotif): "direct" | "counterfactual" | "mediation" {
  const dep = cleanText(motif.dependencyClass || motif.relation, 40);
  const op = cleanText(motif.causalOperator, 40);
  if (op === "mediated_causation") return "mediation";
  if (op === "intervention" || dep === "determine") return "counterfactual";
  return "direct";
}

function buildTemplateQuestion(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
  locale?: AppLocale;
}): { question: string; template: "direct" | "counterfactual" | "mediation" } {
  const template = pickTemplate(params.motif);
  if (template === "mediation") {
    return { question: mediationTemplate(params), template };
  }
  if (template === "counterfactual") {
    return { question: counterfactualTemplate(params), template };
  }
  return { question: directTemplate(params), template };
}

function transferMismatchTemplate(params: {
  locale?: AppLocale;
  transferState?: MotifTransferState | null;
}): { question: string; rationale: string } | null {
  const state = params.transferState;
  if (!state) return null;
  const pendingRevision = (state.revisionRequests || []).find((x) => x.status === "pending_user_choice");
  if (pendingRevision) {
    const q = t(
      params.locale,
      "你刚才否定了已迁移规则。请确认：要覆盖原 motif，还是新建版本？",
      "You negated an adopted transfer rule. Should we overwrite the old motif or create a new version?"
    );
    return { question: q, rationale: `transfer_revision_pending:${pendingRevision.motif_type_id}` };
  }
  const degraded = (state.activeInjections || [])
    .filter((x) => x.injection_state === "disabled" || Number(x.transfer_confidence || 0) < 0.62)
    .sort((a, b) => Number(a.transfer_confidence || 0) - Number(b.transfer_confidence || 0));
  if (!degraded.length) return null;
  const top = degraded[0];
  const phrase = cleanText(top.constraint_text || top.motif_type_title, 80);
  const q = t(
    params.locale,
    `上次规则这次是否仍适用？例如「${phrase}」如果不再适用，我会改为新版本。`,
    `Does the prior rule still apply here? For example "${phrase}". If not, I can create a new version.`
  );
  return { question: q, rationale: `transfer_mismatch:${top.motif_type_id}` };
}

export function planMotifQuestion(params: {
  motifs: ConceptMotif[];
  concepts: ConceptItem[];
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  locale?: AppLocale;
  transferState?: MotifTransferState | null;
}): MotifQuestionPlan {
  const motifs = (Array.isArray(params.motifs) ? params.motifs : []).filter(
    (m) => (m.reuseClass || "reusable") === "reusable"
  );
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));

  const deprecated = motifs
    .filter((m) => m.status === "deprecated" && !isResolvedDeprecated(m))
    .filter((m) => isBlockingDeprecatedReason(String(m.statusReason || "")))
    .slice()
    .sort(
      (a, b) =>
        motifImpactScore(b, motifs, params.transferState) - motifImpactScore(a, motifs, params.transferState) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    );
  if (deprecated.length) {
    const top = deprecated[0];
    const conflictWithId = String(top.statusReason || "").match(/relation_conflict_with:([a-z0-9_\-:]+)/i)?.[1] || "";
    const peer = conflictWithId ? motifs.find((m) => m.id === conflictWithId) : undefined;
    const pairHint =
      peer && peer.title
        ? t(
            params.locale,
            `冲突关系：A=「${top.title}」 vs B=「${peer.title}」`,
            `Conflicting relation: A="${top.title}" vs B="${peer.title}"`
          )
        : "";
    const question = t(
      params.locale,
      `检测到冲突 motif。继续规划前需要先确认保留哪一侧关系。${pairHint}`.trim(),
      `A deprecated/conflicting motif is detected. Before we continue, choose which side to keep. ${pairHint}`.trim()
    );
    if (wasAskedRecently(question, params.recentTurns)) {
      return {
        question: null,
        rationale: `motif_conflict_recently_asked:${top.id}`,
        topMotifId: top.id,
      };
    }
    return {
      question,
      rationale: `motif_conflict:${top.id}`,
      topMotifId: top.id,
    };
  }

  const transferMismatch = transferMismatchTemplate({
    locale: params.locale,
    transferState: params.transferState,
  });
  if (transferMismatch?.question) {
    if (wasAskedRecently(transferMismatch.question, params.recentTurns)) {
      return {
        question: null,
        rationale: `transfer_mismatch_recently_asked:${transferMismatch.rationale}`,
      };
    }
    return {
      question: transferMismatch.question,
      rationale: transferMismatch.rationale,
      template: "direct",
    };
  }

  const uncertain = motifs
    .filter((m) => m.status === "uncertain")
    .slice()
    .sort(
      (a, b) =>
        motifImpactScore(b, motifs, params.transferState) - motifImpactScore(a, motifs, params.transferState) ||
        a.confidence - b.confidence ||
        a.id.localeCompare(b.id)
    );
  if (!uncertain.length) return { question: null, rationale: "motif_stable" };

  const top = uncertain[0];
  const template = buildTemplateQuestion({
    motif: top,
    conceptById,
    locale: params.locale,
  });
  if (wasAskedRecently(template.question, params.recentTurns)) {
    return {
      question: null,
      rationale: `motif_uncertain_recently_asked:${top.id}:${template.template}`,
      topMotifId: top.id,
      template: template.template,
    };
  }
  return {
    question: template.question,
    rationale: `motif_uncertain:${top.id}:${template.template}`,
    topMotifId: top.id,
    template: template.template,
  };
}
