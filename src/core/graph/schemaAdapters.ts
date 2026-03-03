export type StrictConceptType =
  | "belief"
  | "constraint"
  | "preference"
  | "factual_assertion";

export type LegacyConceptType = StrictConceptType | "goal" | "fact" | "question";

export type ConceptValidationStatus = "unasked" | "pending" | "resolved";

export type ConceptExtractionStage = "identification" | "disambiguation";

export type MotifLinkType = "precedes" | "supports" | "conflicts_with" | "refines";

function cleanText(input: unknown): string {
  return String(input ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeConceptType(
  raw: unknown,
  fallback: StrictConceptType = "constraint"
): StrictConceptType {
  const t = cleanText(raw);
  if (t === "belief" || t === "constraint" || t === "preference" || t === "factual_assertion") {
    return t;
  }
  if (t === "factual assertion") return "factual_assertion";

  // Legacy persisted values.
  if (t === "goal") return "belief";
  if (t === "fact") return "factual_assertion";
  if (t === "question") return "belief";

  return fallback;
}

export function conceptTypeMigration(raw: unknown): {
  type: StrictConceptType;
  migratedFrom?: string;
  validationStatus?: ConceptValidationStatus;
  note?: string;
} {
  const src = cleanText(raw);
  const mapped = normalizeConceptType(src, "constraint");
  if (!src || src === mapped || src === "factual assertion") return { type: mapped };
  if (src === "question") {
    return {
      type: "belief",
      migratedFrom: "question",
      validationStatus: "pending",
      note: "legacy_question_migrated_to_belief_pending_validation",
    };
  }
  if (src === "goal") {
    return {
      type: "belief",
      migratedFrom: "goal",
      note: "legacy_goal_migrated_to_belief",
    };
  }
  if (src === "fact") {
    return {
      type: "factual_assertion",
      migratedFrom: "fact",
      note: "legacy_fact_migrated_to_factual_assertion",
    };
  }
  return {
    type: "constraint",
    migratedFrom: src,
    note: "unknown_legacy_type_migrated_to_constraint",
  };
}

export function normalizeValidationStatus(
  raw: unknown,
  fallback: ConceptValidationStatus = "unasked"
): ConceptValidationStatus {
  const s = cleanText(raw);
  if (s === "unasked" || s === "pending" || s === "resolved") return s;
  return fallback;
}

export function normalizeExtractionStage(
  raw: unknown,
  fallback: ConceptExtractionStage = "identification"
): ConceptExtractionStage {
  const s = cleanText(raw);
  if (s === "identification" || s === "disambiguation") return s;
  // Legacy "validation" stage is now represented by validation_status.
  if (s === "validation") return "disambiguation";
  return fallback;
}

export function normalizeMotifLinkType(
  raw: unknown,
  fallback: MotifLinkType = "supports"
): MotifLinkType {
  const s = cleanText(raw);
  if (s === "precedes" || s === "supports" || s === "conflicts_with" || s === "refines") return s;

  // Canonical migration for persisted legacy values.
  if (s === "depends_on" || s === "determine") return "precedes";
  if (s === "supports" || s === "enable") return "supports";
  if (s === "conflicts" || s === "conflict") return "conflicts_with";
  if (s === "constraint") return "conflicts_with";
  if (s === "refines") return "refines";

  return fallback;
}
