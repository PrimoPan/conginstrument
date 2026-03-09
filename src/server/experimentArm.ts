export type ExperimentArm = "main" | "compare_concept_only";

export const DEFAULT_EXPERIMENT_ARM: ExperimentArm = "main";

export function normalizeExperimentArm(input: unknown): ExperimentArm {
  const raw = String(input ?? "").trim().toLowerCase();
  if (
    raw === "compare" ||
    raw === "compare_concept_only" ||
    raw === "concept_only" ||
    raw === "control" ||
    raw === "control_llm" ||
    raw === "llm_only"
  ) {
    return "compare_concept_only";
  }
  return DEFAULT_EXPERIMENT_ARM;
}

export function isMotifEnabledForArm(arm: ExperimentArm): boolean {
  return arm === "main";
}

export function isPureChatControlArm(arm: ExperimentArm): boolean {
  return arm === "compare_concept_only";
}

export function emptyMotifReasoningView() {
  return { nodes: [], edges: [], steps: [] as any[] };
}

export function sanitizeMotifPayloadForArm<T extends Record<string, any>>(payload: T, arm: ExperimentArm): T {
  if (isMotifEnabledForArm(arm)) return payload;
  return {
    ...payload,
    motifs: [],
    motifLinks: [],
    contexts: [],
    motifReasoningView: emptyMotifReasoningView(),
    motifGraph: {
      ...(payload?.motifGraph || { motifs: [], motifLinks: [] }),
      motifs: [],
      motifLinks: [],
    },
    motifInvariantReport: undefined,
    motifTransferState: null,
    motifClarificationState: null,
    transferRecommendationsEnabled: false,
  };
}
