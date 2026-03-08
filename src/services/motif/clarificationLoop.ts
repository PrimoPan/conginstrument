import type { AppLocale } from "../../i18n/locale.js";
import type { ConceptMotif } from "./conceptMotifs.js";
import type { MotifQuestionPlan } from "./questionPlanner.js";

type ClarificationResolution = "confirmed" | "rejected";

export type MotifClarificationPending = {
  motif_id?: string;
  motif_type_id?: string;
  motif_title?: string;
  question: string;
  rationale: string;
  template?: "direct" | "counterfactual" | "mediation";
  asked_at: string;
};

export type MotifClarificationHistoryItem = {
  motif_id?: string;
  motif_type_id?: string;
  motif_title?: string;
  question: string;
  rationale: string;
  template?: "direct" | "counterfactual" | "mediation";
  asked_at: string;
  resolved_at: string;
  resolution: ClarificationResolution;
  user_text: string;
};

export type MotifClarificationState = {
  pending?: MotifClarificationPending;
  history: MotifClarificationHistoryItem[];
};

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function historyAction(resolution: ClarificationResolution): "resolved" | "edited" {
  return resolution === "confirmed" ? "resolved" : "edited";
}

function nowIso() {
  return new Date().toISOString();
}

function isClarificationQuestion(plan?: MotifQuestionPlan | null): boolean {
  const rationale = clean(plan?.rationale, 120).toLowerCase();
  return !!plan?.question && rationale.startsWith("motif_uncertain:");
}

function affirmative(userText: string): boolean {
  const text = clean(userText, 320).toLowerCase();
  if (!text) return false;
  return /(^|[\s，。,.!！?？])(是|是的|对|对的|没错|可以|确实|就是这样|yes|yeah|yep|correct|exactly|that's right|thats right)([\s，。,.!！?？]|$)/i.test(
    text
  );
}

function negative(userText: string): boolean {
  const text = clean(userText, 320).toLowerCase();
  if (!text) return false;
  return /(^|[\s，。,.!！?？])(不是|不对|不是这样|不成立|没有|不是这个|no|nope|not really|that's wrong|thats wrong)([\s，。,.!！?？]|$)/i.test(
    text
  );
}

function resolveConfidence(params: {
  motif: ConceptMotif;
  resolution: ClarificationResolution;
}): number {
  const current = Math.max(0, Math.min(1, Number(params.motif.confidence || 0.7)));
  if (params.resolution === "confirmed") {
    return Math.max(current, params.motif.relation === "determine" ? 0.84 : 0.8);
  }
  return Math.min(current, 0.48);
}

function pushHistory(params: {
  motif: ConceptMotif;
  resolution: ClarificationResolution;
  askedAt: string;
  rationale: string;
  question: string;
  template?: "direct" | "counterfactual" | "mediation";
  userText: string;
  at: string;
}): NonNullable<ConceptMotif["history"]> {
  const current = Array.isArray(params.motif.history) ? params.motif.history : [];
  return [
    ...current,
    {
      at: params.at,
      by: "user",
      action: historyAction(params.resolution),
      from: params.motif.status,
      to: params.resolution === "confirmed" ? "active" : "deprecated",
      reason:
        params.resolution === "confirmed"
          ? `motif_clarification_confirmed:${clean(params.rationale, 80)}`
          : `motif_clarification_rejected:${clean(params.rationale, 80)}`,
    },
  ].slice(-20);
}

function matchPendingMotif(motif: ConceptMotif, pending: MotifClarificationPending): boolean {
  const motifId = clean(motif.id || (motif as any)?.motif_id, 140);
  const motifTypeId = clean((motif as any)?.motif_type_id, 180);
  const title = clean(motif.title, 180);
  return (
    (!!pending.motif_id && motifId === clean(pending.motif_id, 140)) ||
    (!!pending.motif_type_id && motifTypeId === clean(pending.motif_type_id, 180)) ||
    (!!pending.motif_title && title === clean(pending.motif_title, 180))
  );
}

export function emptyMotifClarificationState(): MotifClarificationState {
  return { history: [] };
}

export function normalizeMotifClarificationState(raw: any): MotifClarificationState {
  if (!raw || typeof raw !== "object") return emptyMotifClarificationState();
  const pendingRaw = raw.pending && typeof raw.pending === "object" ? raw.pending : null;
  return {
    pending: pendingRaw
      ? {
          motif_id: clean(pendingRaw.motif_id, 140) || undefined,
          motif_type_id: clean(pendingRaw.motif_type_id, 180) || undefined,
          motif_title: clean(pendingRaw.motif_title, 180) || undefined,
          question: clean(pendingRaw.question, 320),
          rationale: clean(pendingRaw.rationale, 120),
          template:
            clean(pendingRaw.template, 40) === "counterfactual" || clean(pendingRaw.template, 40) === "mediation"
              ? clean(pendingRaw.template, 40)
              : clean(pendingRaw.template, 40) === "direct"
              ? "direct"
              : undefined,
          asked_at: clean(pendingRaw.asked_at, 48) || nowIso(),
        }
      : undefined,
    history: Array.isArray(raw.history)
      ? raw.history.map((item: any) => ({
          motif_id: clean(item?.motif_id, 140) || undefined,
          motif_type_id: clean(item?.motif_type_id, 180) || undefined,
          motif_title: clean(item?.motif_title, 180) || undefined,
          question: clean(item?.question, 320),
          rationale: clean(item?.rationale, 120),
          template:
            clean(item?.template, 40) === "counterfactual" || clean(item?.template, 40) === "mediation"
              ? clean(item?.template, 40)
              : clean(item?.template, 40) === "direct"
              ? "direct"
              : undefined,
          asked_at: clean(item?.asked_at, 48) || nowIso(),
          resolved_at: clean(item?.resolved_at, 48) || nowIso(),
          resolution: clean(item?.resolution, 40) === "rejected" ? "rejected" : "confirmed",
          user_text: clean(item?.user_text, 320),
        }))
      : [],
  };
}

export function updateMotifClarificationState(params: {
  currentState?: MotifClarificationState | null;
  plan?: MotifQuestionPlan | null;
  motifs: ConceptMotif[];
  askedAt?: string;
}): MotifClarificationState {
  const state = normalizeMotifClarificationState(params.currentState);
  if (!isClarificationQuestion(params.plan)) {
    if (clean(params.plan?.rationale, 80) === "motif_stable") {
      return { ...state, pending: undefined };
    }
    return state;
  }
  const motif = (params.motifs || []).find((item) => clean(item.id, 140) === clean(params.plan?.topMotifId, 140));
  return {
    ...state,
    pending: {
      motif_id: clean(motif?.id, 140) || clean(params.plan?.topMotifId, 140) || undefined,
      motif_type_id: clean((motif as any)?.motif_type_id, 180) || undefined,
      motif_title: clean(motif?.title, 180) || undefined,
      question: clean(params.plan?.question, 320),
      rationale: clean(params.plan?.rationale, 120),
      template: params.plan?.template,
      asked_at: clean(params.askedAt, 48) || nowIso(),
    },
  };
}

export function resolveMotifClarificationTurn(params: {
  locale?: AppLocale;
  currentState?: MotifClarificationState | null;
  motifs: ConceptMotif[];
  userText: string;
  now?: string;
}): {
  state: MotifClarificationState;
  motifs: ConceptMotif[];
  resolution?: ClarificationResolution;
} {
  const state = normalizeMotifClarificationState(params.currentState);
  const pending = state.pending;
  if (!pending || !clean(pending.question, 320)) {
    return { state, motifs: params.motifs };
  }
  const userText = clean(params.userText, 320);
  const resolution = affirmative(userText) ? "confirmed" : negative(userText) ? "rejected" : null;
  if (!resolution) return { state, motifs: params.motifs };

  const at = clean(params.now, 48) || nowIso();
  const nextMotifs = (params.motifs || []).map((motif) => {
    if (!matchPendingMotif(motif, pending)) return motif;
    return {
      ...motif,
      status: resolution === "confirmed" ? "active" : "deprecated",
      statusReason:
        resolution === "confirmed" ? "user_confirmed_clarification" : "user_rejected_clarification",
      resolved: true,
      resolvedBy: "user",
      resolvedAt: at,
      confidence: resolveConfidence({ motif, resolution }),
      history: pushHistory({
        motif,
        resolution,
        askedAt: pending.asked_at,
        rationale: pending.rationale,
        question: pending.question,
        template: pending.template,
        userText,
        at,
      }),
      updatedAt: at,
      novelty: "updated",
    } as ConceptMotif;
  });

  return {
    state: {
      pending: undefined,
      history: [
        ...state.history,
        {
          motif_id: pending.motif_id,
          motif_type_id: pending.motif_type_id,
          motif_title: pending.motif_title,
          question: pending.question,
          rationale: pending.rationale,
          template: pending.template,
          asked_at: pending.asked_at,
          resolved_at: at,
          resolution,
          user_text: userText,
        },
      ].slice(-40),
    },
    motifs: nextMotifs,
    resolution,
  };
}
