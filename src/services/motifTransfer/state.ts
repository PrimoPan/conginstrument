import type { ConceptMotif } from "../motif/conceptMotifs.js";
import type { MotifTransferState } from "./types.js";
import { emptyMotifTransferState } from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeMotifTransferState(raw: any): MotifTransferState {
  if (!raw || typeof raw !== "object") return emptyMotifTransferState();
  return {
    recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    activeInjections: Array.isArray(raw.activeInjections) ? raw.activeInjections : [],
    feedbackEvents: Array.isArray(raw.feedbackEvents) ? raw.feedbackEvents : [],
    revisionRequests: Array.isArray(raw.revisionRequests) ? raw.revisionRequests : [],
    lastEvaluatedAt: clean(raw.lastEvaluatedAt, 40) || undefined,
    lastDecisionAt: clean(raw.lastDecisionAt, 40) || undefined,
    lastFeedbackAt: clean(raw.lastFeedbackAt, 40) || undefined,
  };
}

export function annotateMotifExtractionMeta(params: {
  motifs: ConceptMotif[];
  previousMotifs?: ConceptMotif[];
  turnNumber: number;
}): ConceptMotif[] {
  const prevById = new Map((params.previousMotifs || []).map((m) => [clean(m.id, 140), m]));
  return (params.motifs || []).map((m) => {
    const id = clean(m.id, 140);
    const prev = prevById.get(id);
    const previousTrace = Array.isArray((prev as any)?.confidence_trace) ? (prev as any).confidence_trace : [];
    const confidence = Math.max(0, Math.min(1, Number(m.confidence || 0.7)));
    const changed =
      !prev ||
      Number(prev.confidence || 0) !== confidence ||
      clean(prev.status, 24) !== clean(m.status, 24) ||
      clean(prev.title, 200) !== clean(m.title, 200) ||
      clean((prev as any)?.updatedAt, 40) !== clean((m as any)?.updatedAt, 40);
    const changeSource =
      !prev
        ? "new"
        : changed
        ? "updated"
        : clean((prev as any)?.change_source, 24) || "unchanged";
    const trace = changed ? [...previousTrace, { turn: params.turnNumber, confidence }] : previousTrace;
    return {
      ...m,
      last_extracted_turn: params.turnNumber,
      confidence_trace: trace.slice(-32),
      change_source: changeSource,
    } as ConceptMotif;
  });
}
