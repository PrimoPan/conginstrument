import type { ConceptMotif } from "../motif/conceptMotifs.js";
import type { MotifTransferState } from "./types.js";
import { t } from "./types.js";

function clean(input: any, max = 320): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function buildTransferredConstraintPrompt(params: {
  locale?: "zh-CN" | "en-US";
  state?: MotifTransferState | null;
}): string {
  const state = params.state;
  if (!state?.activeInjections?.length) return "";
  const injected = state.activeInjections.filter(
    (x) => x.injection_state === "injected" && Number(x.transfer_confidence || 0) > 0.2
  );
  if (!injected.length) return "";
  const heading = t(
    params.locale,
    "Transferred Motif Constraints（仅对当前任务生效）：",
    "Transferred Motif Constraints (task-local):"
  );
  const lines = injected.slice(0, 6).map((x, idx) => {
    const mode = x.mode === "A" ? "implicit" : x.mode === "B" ? "guided" : "reference";
    const scope = x.application_scope === "local" ? "local" : "trip";
    return `${idx + 1}. [${mode}] ${clean(x.constraint_text, 220)} (confidence=${Number(
      x.transfer_confidence || 0.7
    ).toFixed(2)}, scope=${scope})`;
  });
  return [heading, ...lines].join("\n");
}

export function applyTransferStateToMotifs(params: {
  motifs: ConceptMotif[];
  state?: MotifTransferState | null;
}): ConceptMotif[] {
  const motifByType = new Map(
    (params.state?.activeInjections || []).map((x) => [clean(x.motif_type_id, 180), x])
  );
  return (params.motifs || []).map((m) => {
    const motifTypeId = clean((m as any).motif_type_id, 180);
    if (!motifTypeId || !motifByType.has(motifTypeId)) {
      return {
        ...m,
        transfer_confidence: undefined,
        injection_state: undefined,
        applied_from_task_id: undefined,
      } as ConceptMotif;
    }
    const injection = motifByType.get(motifTypeId)!;
    const nextDependency = clean(injection.dependency, 40);
    const currentDependency = clean(m.dependencyClass || m.relation, 40);
    const dependencyMismatch = !!nextDependency && !!currentDependency && nextDependency !== currentDependency;
    const revisedDescription = clean(injection.constraint_text, 320);
    return {
      ...m,
      motif_type_title: clean(injection.motif_type_title, 180) || (m as any).motif_type_title,
      motif_type_reusable_description:
        revisedDescription || (m as any).motif_type_reusable_description,
      pattern_type: clean((m as any).pattern_type, 180) || clean(injection.motif_type_title, 180) || (m as any).pattern_type,
      description: revisedDescription || m.description,
      transfer_confidence: Number(injection.transfer_confidence || 0.7),
      injection_state: injection.injection_state,
      applied_from_task_id: injection.source_task_id,
      status:
        injection.injection_state === "disabled"
          ? m.status === "cancelled"
            ? m.status
            : "uncertain"
          : dependencyMismatch && m.status === "active"
          ? "uncertain"
          : m.status,
      statusReason:
        injection.injection_state === "disabled"
          ? `transfer_disabled:${clean(injection.disabled_reason, 80) || "feedback"}`
          : dependencyMismatch
          ? `transferred_dependency_revision_pending:${nextDependency}`
          : m.statusReason,
      state_transition_reason:
        injection.injection_state === "disabled"
          ? "transferred_pattern_disabled"
          : dependencyMismatch
          ? "transferred_dependency_revision_pending"
          : (m as any).state_transition_reason,
    } as ConceptMotif;
  });
}
