import type { EdgeType } from "../../core/graph.js";

export type ReasoningBoundaryEdge = {
  relation: EdgeType;
  sourceFamily: string;
  targetFamily: string;
  sourceText: string;
  targetText: string;
  score: number;
  edgeConfidence: number;
  highImpact?: boolean;
  historyAgreement?: number;
  enableLlmBoundary?: boolean;
};

export type ReasoningBoundaryDecision = {
  accepted: boolean;
  reason: string;
  validator: "rule" | "llm";
};

function cleanText(input: any, max = 220): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tokenize(input: string): string[] {
  const text = cleanText(input, 220).toLowerCase();
  if (!text) return [];
  const raw = text.match(/[\u4e00-\u9fff]{1,4}|[a-z0-9]{2,24}/g) || [];
  return Array.from(new Set(raw)).slice(0, 16);
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter += 1;
  }
  const union = new Set([...sa, ...sb]).size;
  return union > 0 ? inter / union : 0;
}

const META_FAMILY_SET = new Set(["destination", "duration_city", "sub_location", "other"]);
const HEALTH_CUE_RE = /冠心病|心脏|慢性病|支架|cardiac|heart|health|medical|体力|强度/i;
const LOW_INTENSITY_CUE_RE = /低强度|慢节奏|少走路|少步行|不爬|轻松|low[-\s]?intensity|light activity/i;
const DIET_CUE_RE = /低盐|低脂|高纤维|清淡|diet|low[-\s]?salt|low[-\s]?fat|fiber/i;

function relationFamilySupport(params: {
  relation: EdgeType;
  sourceFamily: string;
  targetFamily: string;
}): boolean {
  const source = cleanText(params.sourceFamily, 40);
  const target = cleanText(params.targetFamily, 40);
  if (!source || !target) return false;

  if (params.relation === "constraint") {
    const allowedSource = new Set([
      "limiting_factor",
      "budget",
      "duration_total",
      "people",
      "lodging",
      "generic_constraint",
      "activity_preference",
      "scenic_preference",
    ]);
    const allowedTarget = new Set([
      "goal",
      "activity_preference",
      "scenic_preference",
      "lodging",
      "budget",
      "duration_total",
      "generic_constraint",
      "limiting_factor",
    ]);
    return allowedSource.has(source) && allowedTarget.has(target);
  }

  if (params.relation === "determine") {
    const allowedSource = new Set([
      "limiting_factor",
      "budget",
      "people",
      "duration_total",
      "activity_preference",
      "scenic_preference",
      "lodging",
      "generic_constraint",
    ]);
    const allowedTarget = new Set([
      "goal",
      "activity_preference",
      "scenic_preference",
      "lodging",
      "duration_total",
      "budget",
      "generic_constraint",
      "limiting_factor",
    ]);
    return allowedSource.has(source) && allowedTarget.has(target);
  }

  if (params.relation === "enable") {
    const allowedSource = new Set([
      "activity_preference",
      "scenic_preference",
      "lodging",
      "people",
      "budget",
      "duration_total",
      "limiting_factor",
      "generic_constraint",
    ]);
    const allowedTarget = new Set([
      "goal",
      "activity_preference",
      "scenic_preference",
      "lodging",
      "duration_total",
      "generic_constraint",
    ]);
    return allowedSource.has(source) && allowedTarget.has(target);
  }

  return false;
}

function isHealthDerivedStrategy(sourceText: string, targetText: string): boolean {
  const source = cleanText(sourceText, 220);
  const target = cleanText(targetText, 220);
  if (!source || !target) return false;
  if (!HEALTH_CUE_RE.test(source)) return false;
  return LOW_INTENSITY_CUE_RE.test(target) || DIET_CUE_RE.test(target);
}

function readEdgeLlmFlag(edge: ReasoningBoundaryEdge): boolean {
  if (edge.enableLlmBoundary != null) return !!edge.enableLlmBoundary;
  const raw = String(process.env.CI_EDGE_LLM_BOUNDARY || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function baseRuleDecision(edge: ReasoningBoundaryEdge): ReasoningBoundaryDecision {
  const sourceFamily = cleanText(edge.sourceFamily, 40);
  const targetFamily = cleanText(edge.targetFamily, 40);
  const sourceText = cleanText(edge.sourceText, 220);
  const targetText = cleanText(edge.targetText, 220);
  const score = Number(edge.score) || 0;
  const confidence = Number(edge.edgeConfidence) || 0;
  const historyAgreement = Number(edge.historyAgreement || 0.65);

  if (score >= 0.74) {
    return { accepted: true, reason: "boundary_high_score", validator: "rule" };
  }
  if (score <= 0.5) {
    return { accepted: false, reason: "boundary_low_score", validator: "rule" };
  }

  if (META_FAMILY_SET.has(sourceFamily) && META_FAMILY_SET.has(targetFamily)) {
    return { accepted: false, reason: "boundary_metadata_pair", validator: "rule" };
  }

  if (isHealthDerivedStrategy(sourceText, targetText)) {
    return { accepted: true, reason: "boundary_health_strategy", validator: "rule" };
  }

  if (!relationFamilySupport({ relation: edge.relation, sourceFamily, targetFamily })) {
    return { accepted: false, reason: "boundary_relation_family_unsupported", validator: "rule" };
  }

  const lexical = overlapScore(tokenize(sourceText), tokenize(targetText));
  if (lexical >= 0.18) {
    return { accepted: true, reason: "boundary_lexical_support", validator: "rule" };
  }
  if (confidence >= 0.88 && historyAgreement >= 0.56) {
    return { accepted: true, reason: "boundary_confident_edge", validator: "rule" };
  }
  if (historyAgreement >= 0.84 && confidence >= 0.75) {
    return { accepted: true, reason: "boundary_history_support", validator: "rule" };
  }

  return { accepted: false, reason: "boundary_weak_semantic_support", validator: "rule" };
}

function llmAdjudication(edge: ReasoningBoundaryEdge): ReasoningBoundaryDecision {
  const lexical = overlapScore(tokenize(edge.sourceText), tokenize(edge.targetText));
  const historyAgreement = Math.max(0, Math.min(1, Number(edge.historyAgreement || 0.65)));
  const confidence = Math.max(0, Math.min(1, Number(edge.edgeConfidence || 0.7)));
  const score = Math.max(0, Math.min(1, Number(edge.score || 0.62)));
  const adjudicated = score * 0.46 + confidence * 0.22 + lexical * 0.18 + historyAgreement * 0.14;
  if (adjudicated >= 0.67) {
    return { accepted: true, reason: "boundary_llm_accept", validator: "llm" };
  }
  return { accepted: false, reason: "boundary_llm_reject", validator: "llm" };
}

export function validateBoundaryReasoningEdge(
  edge: ReasoningBoundaryEdge
): ReasoningBoundaryDecision {
  const base = baseRuleDecision(edge);
  if (base.accepted) return base;
  const allowLlm = readEdgeLlmFlag(edge);
  if (!allowLlm || !edge.highImpact) return base;
  const score = Number(edge.score) || 0;
  if (score < 0.57 || score > 0.75) return base;
  return llmAdjudication(edge);
}
