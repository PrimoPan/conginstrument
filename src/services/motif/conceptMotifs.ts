import type { CDG, EdgeType } from "../../core/graph.js";
import type { ConceptItem } from "../concepts.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import { validateBoundaryReasoningEdge } from "./relationValidator.js";

export type ConceptMotifType = "pair" | "triad";
export type MotifInstanceStatus = "active" | "uncertain" | "deprecated" | "cancelled";
export type MotifLifecycleStatus = MotifInstanceStatus | "disabled";
export type MotifChangeState = "new" | "updated" | "unchanged";
export type MotifSilentChangeSource = "new" | "updated" | "transferred" | "unchanged";
export type MotifCausalOperator =
  | "direct_causation"
  | "mediated_causation"
  | "confounding"
  | "intervention"
  | "contradiction";

export type SemanticMotifType = "enable" | "constraint" | "determine";
export type MotifDependencyType = SemanticMotifType;

export type MotifRoles = {
  sources: string[];
  target: string;
};

export type MotifTypeRoleSchema = {
  drivers: string[];
  target: string[];
};

export type MotifConceptBinding = {
  drivers: string[];
  target: string[];
};

export type MotifEvidenceItem = {
  quote: string;
  source?: string;
  conceptId?: string;
};

export type MotifCoverageOrigin = "native" | "edge_repair";

export type MotifCoverageInvariantReport = {
  requiredCausalEdges: number;
  coveredCausalEdges: number;
  uncoveredCausalEdges: number;
  repairedMotifCount: number;
  repairRatio?: number;
  componentCount: number;
  excludedNonReasoningEdges?: number;
  excludedByReason?: Record<string, number>;
  boundaryChecks?: number;
  llmValidatedEdges?: number;
  llmRejectedEdges?: number;
  boundaryLlmCalls?: number;
  highImpactEdges?: number;
};

export type ConceptMotif = {
  id: string;
  motif_id: string;
  motif_type: SemanticMotifType;
  templateKey: string;
  motifType: ConceptMotifType;
  relation: EdgeType;
  roles: MotifRoles;
  scope: string;
  aliases: string[];
  concept_bindings: string[];
  conceptIds: string[];
  anchorConceptId: string;
  title: string;
  description: string;
  confidence: number;
  supportEdgeIds: string[];
  supportNodeIds: string[];
  status: MotifLifecycleStatus;
  statusReason?: string;
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: "user" | "system";
  causalOperator?: MotifCausalOperator;
  causalFormula?: string;
  dependencyClass?: EdgeType;
  history?: Array<{
    at: string;
    by: "system" | "user";
    action: "status_changed" | "edited" | "resolved";
    from?: MotifLifecycleStatus;
    to?: MotifLifecycleStatus;
    reason?: string;
  }>;
  novelty: MotifChangeState;
  updatedAt: string;
  reuseClass?: "reusable" | "context_specific";
  reuseReason?: string;
  motif_type_id?: string;
  motif_type_title?: string;
  motif_type_dependency?: MotifDependencyType[];
  motif_type_role_schema?: MotifTypeRoleSchema;
  motif_type_reusable_description?: string;
  motif_instance_id?: string;
  motif_instance_status?: MotifInstanceStatus;
  context?: string;
  bound_concepts?: MotifConceptBinding;
  evidence?: MotifEvidenceItem[];
  rationale?: string;
  coverage_origin?: MotifCoverageOrigin;
  subgraph_verified?: boolean;
  reasoning_eligible?: boolean;
  coverage_skip_reason?: string;
  transfer_confidence?: number;
  injection_state?: "injected" | "pending_confirmation" | "disabled";
  applied_from_task_id?: string;
  last_extracted_turn?: number;
  confidence_trace?: Array<{ turn: number; confidence: number }>;
  change_source?: MotifSilentChangeSource;
  selection_score?: number;
  uncertainty?: number;
  state_transition_reason?: string;
  support_count?: number;
};

type MotifLifecycleEvent =
  | "evidence_up"
  | "evidence_down"
  | "explicit_negation"
  | "conflict_resolved"
  | "transfer_failure"
  | "manual_disable";

const MAX_ACTIVE_MOTIFS_PER_ANCHOR = 3;

function cleanText(input: any, max = 200): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isAlgoV3Enabled(): boolean {
  const raw = String(process.env.CI_ALGO_V3 || "").trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function clamp01(v: any, fallback = 0.7): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function uniq(arr: string[], max = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const x = cleanText(item, 96);
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

function appendReason(base: string | undefined, extra: string): string {
  const b = cleanText(base, 180);
  const e = cleanText(extra, 120);
  if (!e) return b;
  if (!b) return e;
  if (b.includes(e)) return b;
  return cleanText(`${b};${e}`, 180);
}

function stableId(input: string): string {
  const safe = cleanText(input, 240)
    .toLowerCase()
    .replace(/[^a-z0-9_\-:>+]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `m_${safe.slice(0, 120) || "motif"}`;
}

function stableMotifTypeId(input: string): string {
  const safe = cleanText(input, 240)
    .toLowerCase()
    .replace(/[^a-z0-9_\-:>+]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `mt_${safe.slice(0, 120) || "motif_type"}`;
}

function normalizeMotifInstanceStatus(raw: any, fallback: MotifInstanceStatus = "active"): MotifInstanceStatus {
  const s = cleanText(raw, 24).toLowerCase();
  if (s === "active" || s === "uncertain" || s === "deprecated" || s === "cancelled") return s;
  if (s === "disabled") return "cancelled";
  return fallback;
}

function normalizeMotifLifecycleStatus(raw: any, fallback: MotifLifecycleStatus = "active"): MotifLifecycleStatus {
  const s = cleanText(raw, 24).toLowerCase();
  if (s === "disabled") return "cancelled";
  if (s === "active" || s === "uncertain" || s === "deprecated" || s === "cancelled") return s;
  return fallback;
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function relationLabel(type: EdgeType, locale?: AppLocale): string {
  if (type === "constraint") return t(locale, "限制", "constraints");
  if (type === "enable") return t(locale, "支持", "enables");
  if (type === "determine") return t(locale, "决定", "determines");
  if (type === "conflicts_with") return t(locale, "冲突", "conflicts with");
  return type;
}

function relationTheoryHint(type: EdgeType, motifType: ConceptMotifType, locale?: AppLocale): string {
  if (type === "enable") return motifType === "triad" ? "Enable · Mediated causation" : "Enable · Direct causation";
  if (type === "constraint") return "Constraint · Confounding";
  if (type === "determine") return "Determine · Intervention";
  return "Conflict · Contradiction";
}

function normalizeDependencyClass(raw: any, fallback: EdgeType): EdgeType {
  const v = cleanText(raw, 40);
  if (v === "constraint" || v === "enable" || v === "determine" || v === "conflicts_with") return v;
  return fallback;
}

function motifDependencyClass(m: Pick<ConceptMotif, "relation" | "dependencyClass">): EdgeType {
  return normalizeDependencyClass(m.dependencyClass, m.relation);
}

const REUSABLE_FAMILIES = new Set([
  "budget",
  "duration_total",
  "people",
  "lodging",
  "limiting_factor",
  "activity_preference",
  "scenic_preference",
  "goal",
]);

const CONTEXT_SPECIFIC_FAMILIES = new Set([
  "destination",
  "duration_city",
  "sub_location",
  "meeting_critical",
  "generic_constraint",
  "other",
]);

const REUSE_MATRIX: Record<
  "constraint" | "determine" | "enable",
  { sources: Set<string>; targets: Set<string> }
> = {
  constraint: {
    sources: new Set(["budget", "duration_total", "people", "limiting_factor"]),
    targets: new Set(["goal", "lodging", "activity_preference", "scenic_preference", "budget", "duration_total"]),
  },
  determine: {
    sources: new Set(["budget", "people", "duration_total", "activity_preference", "scenic_preference", "limiting_factor"]),
    targets: new Set(["lodging", "activity_preference", "scenic_preference", "duration_total", "budget", "goal"]),
  },
  enable: {
    sources: new Set(["budget", "people", "activity_preference", "scenic_preference", "limiting_factor", "lodging"]),
    targets: new Set(["goal", "lodging", "activity_preference", "scenic_preference", "duration_total"]),
  },
};

type MotifReuseInfo = {
  reuseClass: "reusable" | "context_specific";
  reuseReason?: string;
};

function motifSourceIds(m: ConceptMotif): string[] {
  const ids = (m.conceptIds || []).slice();
  if (m.anchorConceptId) {
    const idx = ids.indexOf(m.anchorConceptId);
    if (idx >= 0) ids.splice(idx, 1);
  }
  return ids;
}

function motifReuseInfo(m: ConceptMotif, conceptById: Map<string, ConceptItem>): MotifReuseInfo {
  const dep = motifDependencyClass(m);
  if (dep === "conflicts_with") {
    return { reuseClass: "reusable" };
  }
  const matrix = REUSE_MATRIX[dep as "constraint" | "determine" | "enable"];
  if (!matrix) return { reuseClass: "reusable" };

  const anchorFamily = canonicalConceptFamily(conceptById.get(m.anchorConceptId));
  if (CONTEXT_SPECIFIC_FAMILIES.has(anchorFamily)) {
    return { reuseClass: "context_specific", reuseReason: `target_context_specific:${anchorFamily}` };
  }
  if (!REUSABLE_FAMILIES.has(anchorFamily)) {
    return { reuseClass: "context_specific", reuseReason: `target_non_reusable:${anchorFamily || "other"}` };
  }
  if (!matrix.targets.has(anchorFamily)) {
    return { reuseClass: "context_specific", reuseReason: `target_not_allowed:${dep}:${anchorFamily}` };
  }

  const sourceFamilies = motifSourceIds(m)
    .map((id) => canonicalConceptFamily(conceptById.get(id)))
    .filter(Boolean);
  if (!sourceFamilies.length) {
    return { reuseClass: "context_specific", reuseReason: `source_missing:${dep}` };
  }
  for (const sf of sourceFamilies) {
    if (CONTEXT_SPECIFIC_FAMILIES.has(sf)) {
      return { reuseClass: "context_specific", reuseReason: `source_context_specific:${sf}` };
    }
    if (!REUSABLE_FAMILIES.has(sf)) {
      return { reuseClass: "context_specific", reuseReason: `source_non_reusable:${sf || "other"}` };
    }
    if (!matrix.sources.has(sf)) {
      return { reuseClass: "context_specific", reuseReason: `source_not_allowed:${dep}:${sf}` };
    }
  }
  return { reuseClass: "reusable" };
}

function applyMotifReuseClassification(motif: ConceptMotif, conceptById: Map<string, ConceptItem>): ConceptMotif {
  const info = motifReuseInfo(motif, conceptById);
  const normalizedUserStatus = normalizeMotifLifecycleStatus(motif.status, "active");
  if (motif.resolvedBy === "user" && motif.resolved && isUserEditableStatus(normalizedUserStatus)) {
    return {
      ...motif,
      reuseClass: info.reuseClass,
      reuseReason: info.reuseClass === "context_specific" ? cleanText(info.reuseReason, 120) || motif.reuseReason : undefined,
      status: normalizedUserStatus,
      motif_instance_status: normalizeMotifInstanceStatus(
        motif.motif_instance_status || normalizedUserStatus,
        "active"
      ),
      statusReason: motif.statusReason || `user_override:${normalizedUserStatus}`,
    };
  }
  if (info.reuseClass === "reusable") {
    return {
      ...motif,
      reuseClass: "reusable",
      reuseReason: undefined,
      motif_instance_status: normalizeMotifInstanceStatus(
        motif.motif_instance_status || motif.status,
        "active"
      ),
    };
  }
  const reason = cleanText(info.reuseReason, 120) || "non_reusable";
  const statusReasonCore = `non_reusable_context_specific:${reason}`;
  const existingReason = cleanText(motif.statusReason, 180);
  const statusReason = !existingReason
    ? statusReasonCore
    : existingReason.startsWith("non_reusable_context_specific:")
    ? existingReason
    : cleanText(`${statusReasonCore};${existingReason}`, 180);
  return {
    ...motif,
    reuseClass: "context_specific",
    reuseReason: reason,
    status: "cancelled",
    motif_instance_status: "cancelled",
    statusReason,
    resolved: true,
    resolvedBy: motif.resolvedBy || "system",
    resolvedAt: motif.resolvedAt || motif.updatedAt || new Date().toISOString(),
    novelty: motif.novelty === "new" ? "new" : "updated",
  };
}

function applyReuseClassification(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  return (motifs || []).map((m) => applyMotifReuseClassification(m, conceptById));
}

export function motifLowConfidenceThreshold(dep: EdgeType): number {
  if (dep === "determine") return 0.82;
  if (dep === "constraint") return 0.78;
  if (dep === "enable") return 0.75;
  return 0.7;
}

export function isMotifLowConfidence(confidence: number, dep: EdgeType): boolean {
  return Number(confidence) < motifLowConfidenceThreshold(dep);
}

function familyLabel(family: ConceptItem["family"], locale?: AppLocale): string {
  if (family === "goal") return t(locale, "目标", "Goal");
  if (family === "destination") return t(locale, "目的地", "Destination");
  if (family === "duration_total") return t(locale, "总时长", "Total duration");
  if (family === "duration_city") return t(locale, "城市时长", "City duration");
  if (family === "budget") return t(locale, "预算", "Budget");
  if (family === "people") return t(locale, "人数", "Party size");
  if (family === "lodging") return t(locale, "住宿", "Lodging");
  if (family === "meeting_critical") return t(locale, "关键日程", "Critical day");
  if (family === "limiting_factor") return t(locale, "限制因素", "Limiting factor");
  if (family === "scenic_preference") return t(locale, "景点偏好", "Scenic preference");
  if (family === "activity_preference") return t(locale, "活动偏好", "Activity preference");
  if (family === "generic_constraint") return t(locale, "通用约束", "General constraint");
  if (family === "sub_location") return t(locale, "子地点", "Sub-location");
  return t(locale, "概念", "Concept");
}

function conceptScore(c: ConceptItem): number {
  return clamp01(c.score, 0.72);
}

function conceptSemanticKey(c: ConceptItem | undefined): string {
  return cleanText(c?.semanticKey, 180).toLowerCase();
}

function canonicalConceptFamily(c: ConceptItem | undefined): string {
  const key = conceptSemanticKey(c);
  if (key === "slot:budget" || key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending") {
    return "budget";
  }
  if (key === "slot:duration_total" || key === "slot:duration") return "duration_total";
  if (key.startsWith("slot:duration_city:")) return "duration_city";
  if (key.startsWith("slot:destination:")) return "destination";
  if (key.startsWith("slot:constraint:limiting:")) return "limiting_factor";
  if (key.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (key.startsWith("slot:sub_location:")) return "sub_location";
  if (key === "slot:activity_preference") return "activity_preference";
  if (key === "slot:scenic_preference") return "scenic_preference";
  if (key === "slot:lodging") return "lodging";
  if (key === "slot:people") return "people";
  if (key === "slot:goal") return "goal";
  return cleanText(c?.family, 40) || "other";
}

type ConceptGroundingClass = "user" | "assistant_only" | "unknown";

function conceptSourceTokens(c: ConceptItem | undefined): string[] {
  return uniq(
    (Array.isArray(c?.sourceMsgIds) ? c!.sourceMsgIds : []).map((x: any) => cleanText(x, 80).toLowerCase()),
    20
  );
}

function isAssistantSourceToken(token: string): boolean {
  const tkn = cleanText(token, 80).toLowerCase();
  if (!tkn) return false;
  return tkn.includes("assistant") || tkn.startsWith("a_") || tkn.startsWith("msg_a");
}

function isUserSourceToken(token: string): boolean {
  const tkn = cleanText(token, 80).toLowerCase();
  if (!tkn) return false;
  if (isAssistantSourceToken(tkn)) return false;
  return (
    tkn.includes("user") ||
    tkn.startsWith("u_") ||
    tkn.startsWith("msg_u") ||
    tkn.startsWith("turn_u") ||
    tkn.startsWith("manual_") ||
    tkn === "latest_user"
  );
}

function conceptGroundingClass(c: ConceptItem | undefined): ConceptGroundingClass {
  const tokens = conceptSourceTokens(c);
  if (!tokens.length) return "unknown";
  const hasAssistant = tokens.some((x) => isAssistantSourceToken(x));
  const hasUser = tokens.some((x) => isUserSourceToken(x)) || tokens.some((x) => !isAssistantSourceToken(x));
  if (hasAssistant && !hasUser) return "assistant_only";
  return "user";
}

function motifGroundingClass(conceptIds: string[], conceptById: Map<string, ConceptItem>): "user_grounded" | "mixed" | "unknown" {
  let userCount = 0;
  let assistantOnlyCount = 0;
  let unknownCount = 0;
  for (const cid of conceptIds || []) {
    const cls = conceptGroundingClass(conceptById.get(cid));
    if (cls === "user") userCount += 1;
    if (cls === "assistant_only") assistantOnlyCount += 1;
    if (cls === "unknown") unknownCount += 1;
  }
  if (assistantOnlyCount > 0 && userCount <= 0) return "unknown";
  if (assistantOnlyCount > 0 || unknownCount > 0) return "mixed";
  return "user_grounded";
}

function sourceSignatureToken(c: ConceptItem | undefined): string {
  const key = conceptSemanticKey(c);
  if (key === "slot:budget" || key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending") {
    return "slot:budget";
  }
  if (key.startsWith("slot:destination:")) return "slot:destination";
  if (key.startsWith("slot:duration_city:")) return "slot:duration_city";
  if (key.startsWith("slot:meeting_critical:")) return "slot:meeting_critical";
  if (key.startsWith("slot:constraint:limiting:")) {
    const rest = key.slice("slot:constraint:limiting:".length);
    const seg = rest
      .split(":")
      .map((x) => cleanText(x, 40).toLowerCase())
      .filter(Boolean);
    const kind = seg[0] || "other";
    const detail = seg
      .slice(1)
      .join(":")
      .replace(/[^a-z0-9_:\-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    return detail ? `slot:constraint:limiting:${kind}:${detail}` : `slot:constraint:limiting:${kind}`;
  }
  if (key.startsWith("slot:sub_location:")) return "slot:sub_location";
  if (key === "slot:goal") return "slot:goal";
  if (key === "slot:duration_total" || key === "slot:duration") return "slot:duration_total";
  if (key === "slot:people") return "slot:people";
  if (key === "slot:lodging") return "slot:lodging";
  if (key === "slot:activity_preference") return "slot:activity_preference";
  if (key === "slot:scenic_preference") return "slot:scenic_preference";
  return canonicalConceptFamily(c);
}

function isBudgetBookkeepingConcept(c: ConceptItem | undefined): boolean {
  const key = conceptSemanticKey(c);
  return key === "slot:budget_spent" || key === "slot:budget_remaining" || key === "slot:budget_pending";
}

function sortConceptIdsForTriad(ids: string[], byId: Map<string, ConceptItem>): string[] {
  return ids
    .slice()
    .sort((a, b) => {
      const ca = byId.get(a);
      const cb = byId.get(b);
      if (!ca || !cb) return a.localeCompare(b);
      return conceptScore(cb) - conceptScore(ca) || a.localeCompare(b);
    });
}

function sourceFamiliesForPattern(m: ConceptMotif, conceptById: Map<string, ConceptItem>): string[] {
  const ids = (m.conceptIds || []).slice();
  if (m.anchorConceptId) {
    const idx = ids.indexOf(m.anchorConceptId);
    if (idx >= 0) ids.splice(idx, 1);
  }
  return uniq(
    ids
      .map((id) => canonicalConceptFamily(conceptById.get(id)))
      .filter(Boolean)
      .sort(),
    6
  );
}

function inferCausalOperator(m: ConceptMotif): MotifCausalOperator {
  const dep = motifDependencyClass(m);
  if (dep === "enable") return m.motifType === "triad" ? "mediated_causation" : "direct_causation";
  if (dep === "constraint") return "confounding";
  if (dep === "determine") return "intervention";
  return "contradiction";
}

function semanticMotifType(dep: EdgeType): SemanticMotifType {
  if (dep === "constraint") return "constraint";
  if (dep === "determine") return "determine";
  return "enable";
}

function conceptTitleOf(id: string, conceptById: Map<string, ConceptItem>): string {
  return cleanText(conceptById.get(id)?.title, 28) || cleanText(id, 28) || "C";
}

function causalFormula(m: ConceptMotif, conceptById: Map<string, ConceptItem>): string {
  const sourceIds = motifSourceIds(m);
  const anchorId = m.anchorConceptId || (m.conceptIds || [])[m.conceptIds.length - 1] || "";
  const target = conceptTitleOf(anchorId, conceptById);
  const a = sourceIds[0] ? conceptTitleOf(sourceIds[0], conceptById) : "A";
  const b = sourceIds[1] ? conceptTitleOf(sourceIds[1], conceptById) : "B";
  const op = inferCausalOperator(m);
  if (op === "direct_causation") return `${a} -> ${target}`;
  if (op === "mediated_causation") return `${a} -> ${b} -> ${target}`;
  if (op === "confounding") return sourceIds.length >= 2 ? `${a} <- ${b} -> ${target}` : `C -> ${target}`;
  if (op === "intervention") return `do(${a}) -> ${target}`;
  return `${a} x ${target}`;
}

function motifDependencyTypes(dep: EdgeType): MotifDependencyType[] {
  if (dep === "constraint" || dep === "determine" || dep === "enable") return [dep];
  return ["constraint"];
}

function motifTypeRoleSchema(m: ConceptMotif, conceptById: Map<string, ConceptItem>): MotifTypeRoleSchema {
  const driverFamilies = uniq(
    motifSourceIds(m)
      .map((id) => canonicalConceptFamily(conceptById.get(id)))
      .filter(Boolean),
    6
  );
  const targetFamilies = uniq([canonicalConceptFamily(conceptById.get(m.anchorConceptId))].filter(Boolean), 2);
  return {
    drivers: driverFamilies.length ? driverFamilies : ["driver"],
    target: targetFamilies.length ? targetFamilies : ["target"],
  };
}

function motifTypeTitle(m: ConceptMotif, conceptById: Map<string, ConceptItem>, locale?: AppLocale): string {
  const dep = motifDependencyClass(m);
  const schema = motifTypeRoleSchema(m, conceptById);
  const drivers = schema.drivers.map((x) => familyLabel(x as any, locale)).join(" + ");
  const target = schema.target.map((x) => familyLabel(x as any, locale)).join(" + ");
  if (drivers && target) return cleanText(`${drivers} ${relationLabel(dep, locale)} ${target}`, 160);
  return cleanText(m.title, 160) || cleanText(m.templateKey, 160) || "MotifType";
}

function motifTypeReusableDescription(
  m: ConceptMotif,
  conceptById: Map<string, ConceptItem>,
  locale?: AppLocale
): string {
  const dep = motifDependencyClass(m);
  const schema = motifTypeRoleSchema(m, conceptById);
  const drivers = schema.drivers.map((x) => familyLabel(x as any, locale)).join(" + ") || t(locale, "驱动概念", "driver concepts");
  const target = schema.target.map((x) => familyLabel(x as any, locale)).join(" + ") || t(locale, "目标概念", "target concept");
  return cleanText(
    t(
      locale,
      `可复用依赖模板：当 ${drivers} 发生变化时，通常会对 ${target} 形成 ${relationLabel(dep, locale)} 关系。`,
      `Reusable dependency schema: when ${drivers} change, they tend to ${relationLabel(dep, locale)} ${target}.`
    ),
    220
  );
}

function motifEvidenceFromConcepts(conceptIds: string[], conceptById: Map<string, ConceptItem>): MotifEvidenceItem[] {
  const out: MotifEvidenceItem[] = [];
  const seen = new Set<string>();
  for (const cid of conceptIds || []) {
    const c = conceptById.get(cid);
    if (!c) continue;
    const quote = cleanText((c.evidenceTerms || [])[0] || c.title, 90);
    if (!quote || seen.has(quote)) continue;
    seen.add(quote);
    out.push({
      quote,
      source: cleanText((c.sourceMsgIds || [])[0], 80) || undefined,
      conceptId: cid,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function motifContext(
  m: ConceptMotif,
  conceptById: Map<string, ConceptItem>,
  scope: string,
  locale?: AppLocale
): string {
  const dep = motifDependencyClass(m);
  const destinations = uniq(
    (m.conceptIds || [])
      .map((cid) => conceptById.get(cid))
      .filter(Boolean)
      .filter((c) => canonicalConceptFamily(c) === "destination")
      .map((c) => cleanText(c!.title, 40).replace(/^目的地[:：]\s*/i, "")),
    2
  );
  const stage =
    dep === "constraint"
      ? t(locale, "风险过滤阶段", "risk-filtering stage")
      : dep === "determine"
      ? t(locale, "决策锁定阶段", "decision-commitment stage")
      : dep === "enable"
      ? t(locale, "可行性展开阶段", "feasibility-enabling stage")
      : t(locale, "冲突澄清阶段", "conflict-clarification stage");
  if (destinations.length) return cleanText(`${destinations.join(" / ")} / ${stage}`, 120);
  if (scope && scope !== "global") return cleanText(`${scope} / ${stage}`, 120);
  return cleanText(t(locale, `当前任务 / ${stage}`, `current task / ${stage}`), 120);
}

function motifRationale(
  m: ConceptMotif,
  conceptById: Map<string, ConceptItem>,
  dep: EdgeType,
  locale?: AppLocale
): string {
  const sourceFamilies = sourceFamiliesForPattern(m, conceptById).map((x) => familyLabel(x as any, locale)).join(" + ");
  const targetFamily = familyLabel(canonicalConceptFamily(conceptById.get(m.anchorConceptId)) as any, locale);
  return cleanText(
    t(
      locale,
      `该实例将 ${sourceFamilies || "驱动概念"} 与 ${targetFamily} 的 ${relationLabel(dep, locale)} 关系显式化，用于后续推理复用。`,
      `This instance makes the ${relationLabel(dep, locale)} relation explicit from ${
        sourceFamilies || "driver concepts"
      } to ${targetFamily} for downstream reusable reasoning.`
    ),
    220
  );
}

function withCausalSemantics(
  m: ConceptMotif,
  conceptById: Map<string, ConceptItem>,
  locale?: AppLocale
): ConceptMotif {
  const dep = motifDependencyClass(m);
  const op = inferCausalOperator(m);
  const conceptIds = uniq(m.conceptIds || [], 24);
  const anchorConceptId = cleanText(m.anchorConceptId, 100) || conceptIds[conceptIds.length - 1] || "";
  const sourceIds = conceptIds.filter((id) => id !== anchorConceptId);
  const scope = uniq(
    conceptIds
      .map((id) => cleanText((conceptById.get(id) as any)?.scope, 48))
      .filter(Boolean),
    4
  ).join("|") || "global";
  const aliases = uniq([...(m.aliases || []), cleanText(m.id, 120), cleanText((m as any)?.motif_id, 120)], 24);
  const providedOp = cleanText(m.causalOperator, 40);
  const opCompatible =
    !providedOp ||
    (dep === "enable" && (providedOp === "direct_causation" || providedOp === "mediated_causation")) ||
    (dep === "constraint" && providedOp === "confounding") ||
    (dep === "determine" && providedOp === "intervention") ||
    (dep === "conflicts_with" && providedOp === "contradiction");
  let guardedStatus: MotifLifecycleStatus = normalizeMotifLifecycleStatus(opCompatible ? m.status : "uncertain");
  let guardedReason = opCompatible
    ? cleanText(m.statusReason, 180)
    : appendReason(cleanText(m.statusReason, 180), "semantic_mapping_guard");

  const grounding = motifGroundingClass(conceptIds, conceptById);
  const hasAssistantOnly = conceptIds.some((cid) => conceptGroundingClass(conceptById.get(cid)) === "assistant_only");
  if (hasAssistantOnly) {
    guardedStatus = "cancelled";
    guardedReason = appendReason(guardedReason, "assistant_only_concept_grounding");
  } else if (grounding !== "user_grounded") {
    guardedReason = appendReason(guardedReason, `grounding_${grounding}`);
  }

  const motifTypeSignature = motifPatternSignature(
    {
      ...m,
      relation: dep,
      dependencyClass: dep,
      conceptIds,
      anchorConceptId,
    },
    conceptById
  );
  const motifTypeId = cleanText((m as any)?.motif_type_id, 140) || stableMotifTypeId(`pattern:${motifTypeSignature}`);
  const roleSchema = motifTypeRoleSchema(
    {
      ...m,
      relation: dep,
      dependencyClass: dep,
      conceptIds,
      anchorConceptId,
    },
    conceptById
  );

  const motifInstanceStatus = normalizeMotifInstanceStatus((m as any)?.motif_instance_status || guardedStatus);
  const motifEvidence = motifEvidenceFromConcepts(conceptIds, conceptById);
  const context = cleanText((m as any)?.context, 120) || motifContext(m, conceptById, scope, locale);

  return {
    ...m,
    motif_id: cleanText((m as any)?.motif_id, 120) || m.id,
    motif_type: semanticMotifType(dep),
    roles: {
      sources: sourceIds,
      target: anchorConceptId,
    },
    scope,
    aliases,
    concept_bindings: conceptIds,
    conceptIds,
    anchorConceptId,
    status: guardedStatus,
    statusReason: guardedReason,
    dependencyClass: dep,
    causalOperator: op,
    causalFormula: causalFormula(m, conceptById),
    reuseClass: m.reuseClass === "context_specific" ? "context_specific" : "reusable",
    reuseReason: m.reuseClass === "context_specific" ? cleanText(m.reuseReason, 120) || undefined : undefined,
    description:
      cleanText(m.description, 220) ||
      cleanText(`${relationTheoryHint(dep, m.motifType, locale)} · ${causalFormula(m, conceptById)}`, 220),
    motif_type_id: motifTypeId,
    motif_type_title: cleanText((m as any)?.motif_type_title, 160) || motifTypeTitle(m, conceptById, locale),
    motif_type_dependency: motifDependencyTypes(dep),
    motif_type_role_schema: roleSchema,
    motif_type_reusable_description:
      cleanText((m as any)?.motif_type_reusable_description, 220) ||
      motifTypeReusableDescription(m, conceptById, locale),
    motif_instance_id: cleanText((m as any)?.motif_instance_id, 140) || cleanText((m as any)?.motif_id, 140) || m.id,
    motif_instance_status: motifInstanceStatus,
    context,
    bound_concepts: {
      drivers: sourceIds,
      target: anchorConceptId ? [anchorConceptId] : [],
    },
    evidence: motifEvidence.length ? motifEvidence : undefined,
    rationale: cleanText((m as any)?.rationale, 220) || motifRationale(m, conceptById, dep, locale),
  };
}

function motifPatternSignature(m: ConceptMotif, conceptById: Map<string, ConceptItem>): string {
  const tokenForPattern = (c: ConceptItem | undefined) => {
    const key = conceptSemanticKey(c);
    if (key.startsWith("slot:constraint:limiting:") || key === "slot:health" || key === "slot:language") {
      return sourceSignatureToken(c);
    }
    return canonicalConceptFamily(c) || sourceSignatureToken(c) || "other";
  };
  const sourceSig = uniq(
    motifSourceIds(m)
      .map((id) => tokenForPattern(conceptById.get(id)))
      .filter(Boolean)
      .sort(),
    8
  ).join("+");
  const anchorSig = tokenForPattern(conceptById.get(m.anchorConceptId));
  return `${m.motifType}|${motifDependencyClass(m)}|${sourceSig || "none"}->${anchorSig || "other"}`;
}

function relationTypeBoost(relation: EdgeType): number {
  if (relation === "constraint") return 0.03;
  if (relation === "determine") return 0.02;
  if (relation === "enable") return 0.01;
  return 0;
}

function titlePriorityForConcept(c: ConceptItem | undefined): number {
  if (!c) return 0;
  const family = canonicalConceptFamily(c);
  const key = conceptSemanticKey(c);
  const title = cleanText(c.title, 140).toLowerCase();

  if (family === "limiting_factor" || key.startsWith("slot:constraint:limiting:")) {
    if (/心脏|冠心|心血管|cardiac|heart|medical|health/.test(title)) return 140;
    if (/恐高|高空|高度|heights|acrophobia/.test(title)) return 138;
    if (/安全|风险|safety|risk/.test(title)) return 136;
    return 132;
  }
  if (family === "people" || key === "slot:people") return 128;
  if (key === "slot:language" || key.startsWith("slot:constraint:limiting:language")) return 126;
  if (family === "meeting_critical") return 120;
  if (family === "budget") return 112;
  if (family === "duration_total" || family === "duration_city") return 110;
  if (family === "lodging") return 108;
  if (family === "destination") return 102;
  return 90;
}

function sourceTitlesFromConcepts(conceptIds: string[], anchorId: string, conceptById: Map<string, ConceptItem>): string[] {
  const ids = conceptIds.filter((id) => id !== anchorId);
  return ids
    .slice()
    .sort((a, b) => {
      const ca = conceptById.get(a);
      const cb = conceptById.get(b);
      return (
        titlePriorityForConcept(cb) - titlePriorityForConcept(ca) ||
        conceptScore(cb || ({} as any)) - conceptScore(ca || ({} as any)) ||
        a.localeCompare(b)
      );
    })
    .map((id) => cleanText(conceptById.get(id)?.title, 44))
    .filter(Boolean);
}

function aggregateToPatternMotifs(
  instances: ConceptMotif[],
  concepts: ConceptItem[],
  locale?: AppLocale
): ConceptMotif[] {
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const groups = new Map<
    string,
    {
      signature: string;
      motifType: ConceptMotifType;
      relation: EdgeType;
      templateKey: string;
      concepts: Set<string>;
      anchors: Set<string>;
      supportEdgeIds: Set<string>;
      supportNodeIds: Set<string>;
      confidenceSum: number;
      confidenceMax: number;
      count: number;
    }
  >();

  for (const m of instances || []) {
    const signature = motifPatternSignature(m, byId);
    const base = groups.get(signature) || {
      signature,
      motifType: m.motifType,
      relation: m.relation,
      templateKey: m.templateKey,
      concepts: new Set<string>(),
      anchors: new Set<string>(),
      supportEdgeIds: new Set<string>(),
      supportNodeIds: new Set<string>(),
      confidenceSum: 0,
      confidenceMax: 0,
      count: 0,
    };
    for (const cid of m.conceptIds || []) if (cid) base.concepts.add(cid);
    if (m.anchorConceptId) base.anchors.add(m.anchorConceptId);
    for (const eid of m.supportEdgeIds || []) if (eid) base.supportEdgeIds.add(eid);
    for (const nid of m.supportNodeIds || []) if (nid) base.supportNodeIds.add(nid);
    base.confidenceSum += clamp01(m.confidence, 0.72);
    base.confidenceMax = Math.max(base.confidenceMax, clamp01(m.confidence, 0.72));
    base.count += 1;
    groups.set(signature, base);
  }

  const now = new Date().toISOString();
  const out: ConceptMotif[] = [];
  for (const g of groups.values()) {
    const conceptIds = uniq(Array.from(g.concepts), 24);
    if (!conceptIds.length) continue;
    const anchorId =
      Array.from(g.anchors)
        .sort((a, b) => {
          const ca = byId.get(a);
          const cb = byId.get(b);
          return conceptScore(cb || ({} as any)) - conceptScore(ca || ({} as any)) || a.localeCompare(b);
        })
        .find((id) => conceptIds.includes(id)) || conceptIds[conceptIds.length - 1];
    const anchorTitle =
      cleanText(byId.get(anchorId)?.title, 56) ||
      familyLabel(canonicalConceptFamily(byId.get(anchorId)) as any, locale);
    const sourceTitles = sourceTitlesFromConcepts(conceptIds, anchorId, byId);
    const srcA =
      sourceTitles[0] ||
      familyLabel(
        sourceFamiliesForPattern(
          { ...({} as any), conceptIds, anchorConceptId: anchorId } as any,
          byId
        )[0] as any,
        locale
      );
    const srcB = sourceTitles[1] || "";
    const srcC = sourceTitles[2] || "";
    const sourceTitleSummary = [srcA, srcB, srcC].filter(Boolean).join(" + ");
    const title =
      sourceTitles.length >= 2 || g.motifType === "triad"
        ? `${sourceTitleSummary} ${relationLabel(g.relation, locale)} ${anchorTitle}`
        : `${srcA} ${relationLabel(g.relation, locale)} ${anchorTitle}`;

    const sourceFamilyText = sourceFamiliesForPattern(
      { ...({} as any), conceptIds, anchorConceptId: anchorId } as any,
      byId
    )
      .map((x) => familyLabel(x as any, locale))
      .join(" + ");
    const anchorFamilyText = familyLabel(canonicalConceptFamily(byId.get(anchorId)) as any, locale);
    const avg = g.confidenceSum / Math.max(1, g.count);
    const confidence = clamp01(g.confidenceMax * 0.68 + avg * 0.32 + relationTypeBoost(g.relation), 0.72);
    out.push({
      id: stableId(`pattern:${g.signature}`),
      templateKey: `pattern:${g.signature}`,
      motifType: g.motifType,
      relation: g.relation,
      conceptIds,
      anchorConceptId: anchorId,
      title: cleanText(title, 160),
      description: cleanText(
        t(
          locale,
          `模式：${sourceFamilyText || "概念"} ${relationLabel(g.relation, locale)} ${anchorFamilyText}（${relationTheoryHint(
            g.relation,
            g.motifType,
            locale
          )}）`,
          `Pattern: ${sourceFamilyText || "Concept"} ${relationLabel(
            g.relation,
            locale
          )} ${anchorFamilyText} (${relationTheoryHint(g.relation, g.motifType, locale)})`
        ),
        220
      ),
      confidence,
      supportEdgeIds: uniq(Array.from(g.supportEdgeIds), 72),
      supportNodeIds: uniq(Array.from(g.supportNodeIds), 72),
      status: "active",
      novelty: "new",
      updatedAt: now,
      reuseClass: "reusable",
    });
  }
  return out;
}

type PairAccum = {
  fromId: string;
  toId: string;
  relation: EdgeType;
  templateKey: string;
  confidenceSum: number;
  count: number;
  supportEdgeIds: string[];
  supportNodeIds: string[];
};

function buildNodeToConcepts(concepts: ConceptItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of concepts || []) {
    const ids = Array.isArray(c.nodeIds) ? c.nodeIds : [];
    for (const nodeId of ids) {
      const nid = cleanText(nodeId, 64);
      if (!nid) continue;
      if (!out.has(nid)) out.set(nid, []);
      out.get(nid)!.push(c.id);
    }
  }
  for (const [k, v] of out.entries()) out.set(k, uniq(v, 12));
  return out;
}

function shouldSkipPairByGrounding(fromConcept: ConceptItem, toConcept: ConceptItem): boolean {
  const fromGrounding = conceptGroundingClass(fromConcept);
  const toGrounding = conceptGroundingClass(toConcept);
  return fromGrounding === "assistant_only" || toGrounding === "assistant_only";
}

function shouldSkipPairAsNonExplanatory(fromConcept: ConceptItem, toConcept: ConceptItem): boolean {
  const fromKey = conceptSemanticKey(fromConcept);
  const toKey = conceptSemanticKey(toConcept);
  const fromTokens = semanticTokens(`${fromConcept.title} ${fromConcept.description}`);
  const toTokens = semanticTokens(`${toConcept.title} ${toConcept.description}`);
  const sim = tokenJaccard(fromTokens, toTokens);
  if (!!fromKey && !!toKey && fromKey === toKey && sim >= 0.95) return true;

  const fromFamily = canonicalConceptFamily(fromConcept);
  const toFamily = canonicalConceptFamily(toConcept);
  if (fromFamily !== toFamily) return false;
  return sim >= 0.86;
}

function buildPairMotifs(graph: CDG, concepts: ConceptItem[], locale?: AppLocale): ConceptMotif[] {
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const nodeToConcepts = buildNodeToConcepts(concepts);
  const bucket = new Map<string, PairAccum>();
  const now = new Date().toISOString();

  for (const e of graph.edges || []) {
    if (e.type === "conflicts_with") continue;
    const fromConceptIds = nodeToConcepts.get(e.from) || [];
    const toConceptIds = nodeToConcepts.get(e.to) || [];
    if (!fromConceptIds.length || !toConceptIds.length) continue;

    for (const fromId of fromConceptIds) {
      for (const toId of toConceptIds) {
        if (!fromId || !toId || fromId === toId) continue;
        const fromConcept = byId.get(fromId);
        const toConcept = byId.get(toId);
        if (!fromConcept || !toConcept) continue;
        if (isBudgetBookkeepingConcept(fromConcept) || isBudgetBookkeepingConcept(toConcept)) continue;
        if (shouldSkipPairByGrounding(fromConcept, toConcept)) continue;
        if (shouldSkipPairAsNonExplanatory(fromConcept, toConcept)) continue;

        const templateKey = `${e.type}:${fromConcept.family}->${toConcept.family}`;
        const key = `${templateKey}:${fromId}->${toId}`;
        const cur = bucket.get(key) || {
          fromId,
          toId,
          relation: e.type,
          templateKey,
          confidenceSum: 0,
          count: 0,
          supportEdgeIds: [],
          supportNodeIds: [],
        };
        cur.confidenceSum += clamp01(e.confidence, 0.72);
        cur.count += 1;
        cur.supportEdgeIds.push(e.id);
        cur.supportNodeIds.push(e.from, e.to);
        bucket.set(key, cur);
      }
    }
  }

  const out: ConceptMotif[] = [];
  for (const pair of bucket.values()) {
    const fromConcept = byId.get(pair.fromId);
    const toConcept = byId.get(pair.toId);
    if (!fromConcept || !toConcept) continue;

    const avgEdgeConfidence = pair.confidenceSum / Math.max(1, pair.count);
    const confidence = clamp01(
      avgEdgeConfidence * 0.58 + conceptScore(fromConcept) * 0.2 + conceptScore(toConcept) * 0.22,
      0.68
    );

    out.push({
      id: stableId(`${pair.templateKey}:${pair.fromId}->${pair.toId}`),
      templateKey: pair.templateKey,
      motifType: "pair",
      relation: pair.relation,
      conceptIds: [pair.fromId, pair.toId],
      anchorConceptId: pair.toId,
      title: `${fromConcept.title} ${relationLabel(pair.relation, locale)} ${toConcept.title}`,
      description: t(
        locale,
        `${familyLabel(fromConcept.family, locale)} ${relationLabel(pair.relation, locale)} ${familyLabel(
          toConcept.family,
          locale
        )}（${relationTheoryHint(pair.relation, "pair", locale)}）`,
        `${familyLabel(fromConcept.family, locale)} ${relationLabel(pair.relation, locale)} ${familyLabel(
          toConcept.family,
          locale
        )} (${relationTheoryHint(pair.relation, "pair", locale)})`
      ),
      confidence,
      supportEdgeIds: uniq(pair.supportEdgeIds, 32),
      supportNodeIds: uniq(pair.supportNodeIds, 32),
      status: "active",
      novelty: "new",
      updatedAt: now,
      reuseClass: "reusable",
    });
  }
  return out;
}

function buildTriadMotifs(pairMotifs: ConceptMotif[], concepts: ConceptItem[], locale?: AppLocale): ConceptMotif[] {
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const incoming = new Map<string, ConceptMotif[]>();
  const now = new Date().toISOString();

  for (const m of pairMotifs) {
    const pairReuse = motifReuseInfo(m, byId);
    if (pairReuse.reuseClass !== "reusable") continue;
    const target = m.conceptIds[1];
    if (!target) continue;
    if (!incoming.has(target)) incoming.set(target, []);
    incoming.get(target)!.push(m);
  }

  const out: ConceptMotif[] = [];
  for (const [targetId, list] of incoming.entries()) {
    const target = byId.get(targetId);
    if (!target || list.length < 2) continue;

    const byRelation = new Map<EdgeType, ConceptMotif[]>();
    for (const m of list) {
      if (!byRelation.has(m.relation)) byRelation.set(m.relation, []);
      byRelation.get(m.relation)!.push(m);
    }

    for (const [relation, relList] of byRelation.entries()) {
      if (relList.length < 2) continue;
      const sorted = relList
        .slice()
        .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
      const top = sorted.slice(0, 2);
      const sourceIds = uniq(
        top.map((m) => cleanText(m.conceptIds[0], 80)).filter(Boolean),
        2
      );
      if (sourceIds.length < 2) continue;

      const sourceConcepts = sourceIds.map((id) => byId.get(id)).filter(Boolean) as ConceptItem[];
      if (sourceConcepts.length < 2) continue;
      const sourceFamilyCount = new Set(sourceConcepts.map((c) => canonicalConceptFamily(c))).size;
      if (sourceFamilyCount < 2) continue;

      const orderedSourceIds = sortConceptIdsForTriad(sourceIds, byId);
      const familySig = sourceConcepts
        .map((c) => canonicalConceptFamily(c))
        .sort()
        .join("+");
      const templateKey = `triad:${relation}:${familySig}->${target.family}`;
      const motifId = stableId(`${templateKey}:${orderedSourceIds.join("+")}->${target.id}`);
      const confidence = clamp01(
        (top[0].confidence + top[1].confidence + conceptScore(target)) / 3,
        0.7
      );

      out.push({
        id: motifId,
        templateKey,
        motifType: "triad",
        relation,
        conceptIds: [...orderedSourceIds, target.id],
        anchorConceptId: target.id,
        title: `${sourceConcepts[0].title} + ${sourceConcepts[1].title} ${relationLabel(
          relation,
          locale
        )} ${target.title}`,
        description: t(
          locale,
          `复合结构：${familyLabel(sourceConcepts[0].family, locale)} + ${familyLabel(
            sourceConcepts[1].family,
            locale
          )} ${relationLabel(relation, locale)} ${familyLabel(target.family, locale)}（${relationTheoryHint(
            relation,
            "triad",
            locale
          )}）`,
          `Composite: ${familyLabel(sourceConcepts[0].family, locale)} + ${familyLabel(
            sourceConcepts[1].family,
            locale
          )} ${relationLabel(relation, locale)} ${familyLabel(target.family, locale)} (${relationTheoryHint(
            relation,
            "triad",
            locale
          )})`
        ),
        confidence,
        supportEdgeIds: uniq(top.flatMap((m) => m.supportEdgeIds), 36),
        supportNodeIds: uniq(top.flatMap((m) => m.supportNodeIds), 36),
        status: "active",
        novelty: "new",
        updatedAt: now,
        reuseClass: "reusable",
      });
    }
  }

  return out;
}

function normalizeMotifs(input: any): ConceptMotif[] {
  const arr = Array.isArray(input) ? input : [];
  const out: ConceptMotif[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const id = cleanText((raw as any)?.id, 140);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const relationRaw = cleanText((raw as any)?.relation, 40);
    const relation =
      relationRaw === "constraint" || relationRaw === "enable" || relationRaw === "determine" || relationRaw === "conflicts_with"
        ? (relationRaw as EdgeType)
        : "enable";
    const dependencyClass = normalizeDependencyClass((raw as any)?.dependencyClass, relation);
    const motifType = cleanText((raw as any)?.motifType, 20) as ConceptMotifType;
    const statusRaw = cleanText((raw as any)?.status, 24).toLowerCase();
    const motifInstanceStatusRaw = cleanText((raw as any)?.motif_instance_status, 24).toLowerCase();
    const noveltyRaw = cleanText((raw as any)?.novelty, 24).toLowerCase();
    const changeSourceRaw = cleanText((raw as any)?.change_source, 24).toLowerCase();
    const causalRaw = cleanText((raw as any)?.causalOperator, 40).toLowerCase();
    const reuseClassRaw = cleanText((raw as any)?.reuseClass, 32).toLowerCase();
    const coverageOriginRaw = cleanText((raw as any)?.coverage_origin, 24).toLowerCase();
    const subgraphVerifiedRaw = (raw as any)?.subgraph_verified;
    const resolved = !!(raw as any)?.resolved;
    const resolvedByRaw = cleanText((raw as any)?.resolvedBy, 24).toLowerCase();
    const conceptIds = uniq(
      (Array.isArray((raw as any)?.conceptIds) ? (raw as any).conceptIds : []).map((x: any) => cleanText(x, 100)),
      8
    );
    const anchorConceptId = cleanText((raw as any)?.anchorConceptId, 100) || conceptIds[conceptIds.length - 1] || "";
    const normalizedStatus = normalizeMotifLifecycleStatus(statusRaw || motifInstanceStatusRaw || "active", "active");
    const motifInstanceStatus = normalizeMotifInstanceStatus(motifInstanceStatusRaw || normalizedStatus, "active");
    out.push({
      id,
      motif_id: cleanText((raw as any)?.motif_id, 140) || id,
      motif_type: semanticMotifType(dependencyClass),
      templateKey: cleanText((raw as any)?.templateKey, 180),
      motifType: motifType === "triad" ? "triad" : "pair",
      relation,
      roles: {
        sources: conceptIds.filter((cid) => cid !== anchorConceptId),
        target: anchorConceptId,
      },
      scope: cleanText((raw as any)?.scope, 64) || "global",
      aliases: uniq(
        [
          ...(Array.isArray((raw as any)?.aliases) ? (raw as any).aliases : []),
          cleanText((raw as any)?.id, 140),
          cleanText((raw as any)?.motif_id, 140),
        ].map((x: any) => cleanText(x, 120)),
        24
      ),
      concept_bindings: uniq(
        (Array.isArray((raw as any)?.concept_bindings) ? (raw as any).concept_bindings : conceptIds).map((x: any) =>
          cleanText(x, 100)
        ),
        24
      ),
      conceptIds,
      anchorConceptId,
      title: cleanText((raw as any)?.title, 160),
      description: cleanText((raw as any)?.description, 240),
      confidence: clamp01((raw as any)?.confidence, 0.7),
      supportEdgeIds: uniq(
        (Array.isArray((raw as any)?.supportEdgeIds) ? (raw as any).supportEdgeIds : []).map((x: any) =>
          cleanText(x, 80)
        ),
        48
      ),
      supportNodeIds: uniq(
        (Array.isArray((raw as any)?.supportNodeIds) ? (raw as any).supportNodeIds : []).map((x: any) =>
          cleanText(x, 80)
        ),
        48
      ),
      status: normalizedStatus,
      statusReason: statusRaw === "disabled" ? appendReason(cleanText((raw as any)?.statusReason, 180), "legacy_disabled") : cleanText((raw as any)?.statusReason, 180),
      resolved,
      resolvedAt: resolved ? cleanText((raw as any)?.resolvedAt, 40) || undefined : undefined,
      resolvedBy: resolved ? (resolvedByRaw === "user" ? "user" : "system") : undefined,
      causalOperator:
        causalRaw === "direct_causation" ||
        causalRaw === "mediated_causation" ||
        causalRaw === "confounding" ||
        causalRaw === "intervention" ||
        causalRaw === "contradiction"
          ? (causalRaw as MotifCausalOperator)
          : undefined,
      causalFormula: cleanText((raw as any)?.causalFormula, 180) || undefined,
      dependencyClass,
      history: Array.isArray((raw as any)?.history)
        ? (raw as any).history
            .map((h: any) => ({
              at: cleanText(h?.at, 40) || new Date().toISOString(),
              by: cleanText(h?.by, 20) === "user" ? "user" : "system",
              action:
                cleanText(h?.action, 40) === "resolved"
                  ? "resolved"
                  : cleanText(h?.action, 40) === "edited"
                  ? "edited"
                  : "status_changed",
              from:
                normalizeMotifLifecycleStatus(cleanText(h?.from, 24), "active"),
              to:
                normalizeMotifLifecycleStatus(cleanText(h?.to, 24), "active"),
              reason: cleanText(h?.reason, 120) || undefined,
            }))
            .slice(0, 20)
        : undefined,
      novelty: noveltyRaw === "updated" || noveltyRaw === "unchanged" ? (noveltyRaw as MotifChangeState) : "new",
      updatedAt: cleanText((raw as any)?.updatedAt, 40) || new Date().toISOString(),
      reuseClass: reuseClassRaw === "context_specific" ? "context_specific" : "reusable",
      reuseReason: cleanText((raw as any)?.reuseReason, 120) || undefined,
      motif_type_id: cleanText((raw as any)?.motif_type_id, 140) || undefined,
      motif_type_title: cleanText((raw as any)?.motif_type_title, 160) || undefined,
      motif_type_dependency: Array.isArray((raw as any)?.motif_type_dependency)
        ? (raw as any).motif_type_dependency
            .map((x: any) => cleanText(x, 24))
            .filter((x: string) => x === "enable" || x === "constraint" || x === "determine")
        : undefined,
      motif_type_role_schema:
        (raw as any)?.motif_type_role_schema && typeof (raw as any).motif_type_role_schema === "object"
          ? {
              drivers: uniq(
                (Array.isArray((raw as any).motif_type_role_schema?.drivers)
                  ? (raw as any).motif_type_role_schema.drivers
                  : []
                ).map((x: any) => cleanText(x, 80)),
                12
              ),
              target: uniq(
                (Array.isArray((raw as any).motif_type_role_schema?.target)
                  ? (raw as any).motif_type_role_schema.target
                  : []
                ).map((x: any) => cleanText(x, 80)),
                4
              ),
            }
          : undefined,
      motif_type_reusable_description: cleanText((raw as any)?.motif_type_reusable_description, 220) || undefined,
      motif_instance_id: cleanText((raw as any)?.motif_instance_id, 140) || id,
      motif_instance_status: motifInstanceStatus,
      context: cleanText((raw as any)?.context, 120) || undefined,
      bound_concepts:
        (raw as any)?.bound_concepts && typeof (raw as any).bound_concepts === "object"
          ? {
              drivers: uniq(
                (Array.isArray((raw as any).bound_concepts?.drivers) ? (raw as any).bound_concepts.drivers : []).map((x: any) =>
                  cleanText(x, 100)
                ),
                12
              ),
              target: uniq(
                (Array.isArray((raw as any).bound_concepts?.target) ? (raw as any).bound_concepts.target : []).map((x: any) =>
                  cleanText(x, 100)
                ),
                4
              ),
            }
          : undefined,
      evidence: Array.isArray((raw as any)?.evidence)
        ? (raw as any).evidence
            .map((ev: any) => ({
              quote: cleanText(ev?.quote, 90),
              source: cleanText(ev?.source, 80) || undefined,
              conceptId: cleanText(ev?.conceptId, 100) || undefined,
            }))
            .filter((ev: MotifEvidenceItem) => !!ev.quote)
            .slice(0, 8)
        : undefined,
      rationale: cleanText((raw as any)?.rationale, 220) || undefined,
      coverage_origin: coverageOriginRaw === "edge_repair" ? "edge_repair" : "native",
      subgraph_verified: typeof subgraphVerifiedRaw === "boolean" ? subgraphVerifiedRaw : undefined,
      transfer_confidence:
        Number.isFinite(Number((raw as any)?.transfer_confidence))
          ? clamp01((raw as any)?.transfer_confidence, 0.7)
          : undefined,
      injection_state:
        cleanText((raw as any)?.injection_state, 32) === "injected" ||
        cleanText((raw as any)?.injection_state, 32) === "pending_confirmation" ||
        cleanText((raw as any)?.injection_state, 32) === "disabled"
          ? (cleanText((raw as any)?.injection_state, 32) as any)
          : undefined,
      applied_from_task_id: cleanText((raw as any)?.applied_from_task_id, 80) || undefined,
      last_extracted_turn: Number.isFinite(Number((raw as any)?.last_extracted_turn))
        ? Number((raw as any)?.last_extracted_turn)
        : undefined,
      confidence_trace: Array.isArray((raw as any)?.confidence_trace)
        ? (raw as any).confidence_trace
            .map((x: any) => ({
              turn: Number.isFinite(Number(x?.turn)) ? Number(x.turn) : 0,
              confidence: clamp01(x?.confidence, 0.7),
            }))
            .filter((x: any) => Number.isFinite(x.turn) && x.turn > 0)
            .slice(-32)
        : undefined,
      change_source:
        changeSourceRaw === "new" ||
        changeSourceRaw === "updated" ||
        changeSourceRaw === "transferred" ||
        changeSourceRaw === "unchanged"
          ? (changeSourceRaw as MotifSilentChangeSource)
          : undefined,
      selection_score: Number.isFinite(Number((raw as any)?.selection_score))
        ? clamp01((raw as any)?.selection_score, 0.72)
        : undefined,
      uncertainty: Number.isFinite(Number((raw as any)?.uncertainty))
        ? clamp01((raw as any)?.uncertainty, 0.35)
        : undefined,
      state_transition_reason: cleanText((raw as any)?.state_transition_reason, 180) || undefined,
      support_count: Number.isFinite(Number((raw as any)?.support_count))
        ? Math.max(0, Math.min(999, Math.round(Number((raw as any)?.support_count))))
        : undefined,
    });
  }
  return out;
}

function isSupportChanged(prev: ConceptMotif, next: ConceptMotif): boolean {
  const prevSupport = `${prev.supportEdgeIds.slice().sort().join("|")}::${prev.supportNodeIds.slice().sort().join("|")}`;
  const nextSupport = `${next.supportEdgeIds.slice().sort().join("|")}::${next.supportNodeIds.slice().sort().join("|")}`;
  return prevSupport !== nextSupport;
}

function sourceFamilySignature(m: ConceptMotif, conceptById: Map<string, ConceptItem>): string {
  const ids = (m.conceptIds || []).slice();
  if (m.anchorConceptId) {
    const idx = ids.indexOf(m.anchorConceptId);
    if (idx >= 0) ids.splice(idx, 1);
  }
  const families = ids
    .map((id) => sourceSignatureToken(conceptById.get(id)))
    .sort();
  return families.join("+") || "none";
}

function statusRank(s: MotifLifecycleStatus): number {
  if (s === "deprecated") return 5;
  if (s === "uncertain") return 4;
  if (s === "active") return 3;
  if (s === "disabled") return 1;
  return 1;
}

export function motifLifecycleTransition(params: {
  current: MotifLifecycleStatus;
  event: MotifLifecycleEvent;
  fallbackReason?: string;
}): { status: MotifLifecycleStatus; reason: string } {
  const current = normalizeMotifLifecycleStatus(params.current, "active");
  const reason = cleanText(params.fallbackReason, 180) || params.event;
  if (params.event === "manual_disable") return { status: "cancelled", reason };
  if (params.event === "transfer_failure") return { status: "uncertain", reason };
  if (params.event === "explicit_negation") return { status: "deprecated", reason };
  if (params.event === "conflict_resolved") {
    if (current === "deprecated" || current === "uncertain") return { status: "active", reason };
    return { status: current, reason };
  }
  if (params.event === "evidence_down") {
    if (current === "active") return { status: "uncertain", reason };
    if (current === "uncertain") return { status: "deprecated", reason };
    return { status: current, reason };
  }
  if (params.event === "evidence_up") {
    if (current === "active") return { status: "active", reason: "" };
    if (current === "deprecated" || current === "uncertain") return { status: "active", reason };
    return { status: current, reason };
  }
  return { status: current, reason };
}

function inferBaseStatus(m: ConceptMotif, prev: ConceptMotif | undefined, conceptById: Map<string, ConceptItem>) {
  if (
    prev?.resolved &&
    prev?.resolvedBy === "user" &&
    (prev.status === "active" || prev.status === "cancelled" || prev.status === "disabled")
  ) {
    return {
      status: normalizeMotifLifecycleStatus(prev.status, "cancelled"),
      reason: prev.statusReason || "user_resolved",
    };
  }
  if (m.relation === "conflicts_with") return { status: "deprecated" as MotifLifecycleStatus, reason: "relation_conflicts_with" };

  const hasConcepts = (m.conceptIds || []).length > 0;
  const allPaused =
    hasConcepts &&
    (m.conceptIds || []).every((cid) => {
      const c = conceptById.get(cid);
      return !!c?.paused;
    });
  if (allPaused) {
    return motifLifecycleTransition({
      current: normalizeMotifLifecycleStatus(prev?.status, "active"),
      event: "manual_disable",
      fallbackReason: "all_related_concepts_paused",
    });
  }

  if (prev?.status === "disabled" && !!prev.resolved && !allPaused) {
    return motifLifecycleTransition({
      current: "cancelled",
      event: "manual_disable",
      fallbackReason: prev.statusReason || "legacy_user_disabled",
    });
  }
  const dep = motifDependencyClass(m);
  const threshold = motifLowConfidenceThreshold(dep);
  if (isMotifLowConfidence(m.confidence, dep)) {
    return motifLifecycleTransition({
      current: normalizeMotifLifecycleStatus(prev?.status, "active"),
      event: "evidence_down",
      fallbackReason: `low_confidence:${dep}:${threshold.toFixed(2)}`,
    });
  }
  return motifLifecycleTransition({
    current: normalizeMotifLifecycleStatus(prev?.status, "active"),
    event: "evidence_up",
    fallbackReason: "evidence_stable",
  });
}

function isUserEditableStatus(status: MotifLifecycleStatus | undefined): status is "active" | "cancelled" {
  const s = normalizeMotifLifecycleStatus(status, "active");
  return s === "active" || s === "cancelled";
}

function sanitizeMotifStructure(params: {
  conceptIds: string[];
  anchorConceptId?: string;
  conceptById: Map<string, ConceptItem>;
}): { conceptIds: string[]; anchorConceptId: string; sourceIds: string[] } | null {
  const conceptIds = uniq(
    (params.conceptIds || [])
      .map((id) => cleanText(id, 100))
      .filter((id) => id && params.conceptById.has(id)),
    12
  );
  if (conceptIds.length < 2) return null;

  let anchorConceptId = cleanText(params.anchorConceptId, 100);
  if (!anchorConceptId || !conceptIds.includes(anchorConceptId)) {
    anchorConceptId = conceptIds[conceptIds.length - 1];
  }
  const sourceIds = conceptIds.filter((id) => id !== anchorConceptId);
  if (!sourceIds.length) return null;
  return { conceptIds, anchorConceptId, sourceIds };
}

function motifEditableSignature(m: ConceptMotif | undefined): string {
  if (!m) return "none";
  return [
    cleanText(m.title, 160),
    cleanText(m.description, 220),
    cleanText(m.relation, 40),
    cleanText(m.causalOperator, 40),
    cleanText(m.status, 24),
    cleanText(m.statusReason, 120),
    cleanText(m.anchorConceptId, 120),
    (m.conceptIds || []).slice().sort().join("|"),
  ].join("::");
}

function applyUserEditableOverlay(params: {
  current: ConceptMotif;
  prev?: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
}): ConceptMotif {
  const { current, prev, conceptById } = params;
  if (!prev || prev.resolvedBy !== "user" || !prev.resolved) return current;

  const structure = sanitizeMotifStructure({
    conceptIds: (prev.conceptIds || prev.concept_bindings || []).slice(),
    anchorConceptId: prev.anchorConceptId,
    conceptById,
  });
  if (!structure) return current;

  const relation = normalizeDependencyClass(prev.dependencyClass || prev.relation, current.relation);
  const prevStatus = normalizeMotifLifecycleStatus(prev.status, normalizeMotifLifecycleStatus(current.status, "active"));
  const nextStatus: MotifLifecycleStatus = isUserEditableStatus(prevStatus)
    ? prevStatus
    : normalizeMotifLifecycleStatus(current.status, "active");
  const nextStatusReason =
    nextStatus === current.status
      ? current.statusReason
      : cleanText(prev.statusReason, 180) || `user_status_${nextStatus}`;

  return {
    ...current,
    title: cleanText(prev.title, 160) || current.title,
    description: cleanText(prev.description, 240) || current.description,
    relation,
    dependencyClass: relation,
    causalOperator: prev.causalOperator || current.causalOperator,
    motifType: structure.conceptIds.length >= 3 ? "triad" : "pair",
    conceptIds: structure.conceptIds,
    concept_bindings: structure.conceptIds,
    anchorConceptId: structure.anchorConceptId,
    roles: {
      sources: structure.sourceIds,
      target: structure.anchorConceptId,
    },
    status: nextStatus,
    statusReason: nextStatusReason,
    resolved: true,
    resolvedBy: "user",
    resolvedAt: prev.resolvedAt || current.updatedAt || new Date().toISOString(),
  };
}

function shouldPersistUserManualMotif(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
}): boolean {
  const { motif, conceptById } = params;
  if (motif.resolvedBy !== "user") return false;
  if (!motif.resolved && !isUserEditableStatus(motif.status)) return false;
  const structure = sanitizeMotifStructure({
    conceptIds: (motif.conceptIds || motif.concept_bindings || []).slice(),
    anchorConceptId: motif.anchorConceptId,
    conceptById,
  });
  if (!structure) return false;
  const relation = normalizeDependencyClass(motif.dependencyClass || motif.relation, "enable");
  return relation !== "conflicts_with";
}

function motifPriorityScore(m: ConceptMotif): number {
  const dep = motifDependencyClass(m);
  const relationBoost =
    dep === "constraint"
      ? 0.03
      : dep === "determine"
      ? 0.02
      : dep === "enable"
      ? 0.01
      : 0;
  const typeBoost = m.motifType === "pair" ? 0.015 : 0;
  return m.confidence + relationBoost + typeBoost;
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

const SEMANTIC_NOISE_TOKENS = new Set([
  "我",
  "我们",
  "你",
  "你们",
  "想",
  "想去",
  "要",
  "我要",
  "需要",
  "希望",
  "计划",
  "安排",
  "行程",
  "旅行",
  "旅游",
  "旅程",
  "出游",
  "目的地",
  "去",
  "到",
  "前往",
  "trip",
  "travel",
  "itinerary",
  "plan",
  "planning",
  "schedule",
  "journey",
  "destination",
  "visit",
  "go",
  "to",
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "of",
  "in",
  "on",
]);

function normalizeSemanticSurface(text: string): string {
  return cleanText(text, 260)
    .toLowerCase()
    .replace(/[_:]/g, " ")
    .replace(
      /(我想|想去|我要|需要|希望|准备|计划|打算|去|到|前往|trip|travel|itinerary|plan|planning|schedule|journey|visit|go to)/gi,
      " "
    )
    .replace(/(行程|旅行|旅游|旅程|出游|安排|方案|路线|攻略)/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticTokens(text: string): string[] {
  const chunks = normalizeSemanticSurface(text).match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of chunks) {
    const token = cleanText(raw, 24).toLowerCase();
    if (!token || SEMANTIC_NOISE_TOKENS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 16) break;
  }
  return out;
}

function tokenJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  if (!union) return 0;
  return inter / union;
}

function semanticCoreFromSlotKey(rawKey: string): string {
  const key = cleanText(rawKey, 200).toLowerCase();
  if (!key || !key.startsWith("slot:")) return "";

  if (key.startsWith("slot:destination:")) {
    const city = semanticTokens(key.slice("slot:destination:".length).replace(/_/g, " ")).join("_");
    return `destination:${city || "unknown"}`;
  }
  if (key.startsWith("slot:duration_city:")) {
    const city = semanticTokens(key.slice("slot:duration_city:".length).replace(/_/g, " ")).join("_");
    return `duration_city:${city || "unknown"}`;
  }
  if (key.startsWith("slot:sub_location:")) {
    const rest = key.slice("slot:sub_location:".length).split(":");
    const root = semanticTokens((rest[0] || "").replace(/_/g, " ")).join("_");
    const sub = semanticTokens(rest.slice(1).join(" ").replace(/_/g, " ")).join("_");
    return `sub_location:${root || "root"}:${sub || "loc"}`;
  }
  if (key.startsWith("slot:constraint:limiting:")) {
    const kind = cleanText(key.slice("slot:constraint:limiting:".length).split(":")[0], 28).toLowerCase();
    return `constraint:limiting:${kind || "other"}`;
  }
  if (key.startsWith("slot:freeform:")) {
    const parts = key.split(":");
    const tail = parts.slice(3).join(" ").replace(/_/g, " ");
    const sig = semanticTokens(tail).join("_");
    return `freeform:${sig || "node"}`;
  }
  return key;
}

function semanticCoreFromConcept(c: ConceptItem | undefined): string {
  if (!c) return "";
  const keyCore = semanticCoreFromSlotKey(conceptSemanticKey(c));
  if (keyCore) return keyCore;
  const titleCore = semanticTokens(cleanText(c.title, 120)).join("_");
  const family = canonicalConceptFamily(c) || "other";
  return titleCore ? `${family}:${titleCore}` : family;
}

function semanticFamilyGroup(c: ConceptItem | undefined): string {
  const family = canonicalConceptFamily(c) || "other";
  const core = semanticCoreFromConcept(c);
  if (core.startsWith("destination:")) return "destination";
  if (core.startsWith("duration_city:")) return "duration_city";
  if (core.startsWith("sub_location:")) return "sub_location";
  if (core.startsWith("constraint:limiting:")) return "limiting_factor";
  if (family !== "other") return family;
  const title = cleanText(c?.title, 140);
  if (/去|到|前往|destination|visit|go to/i.test(title) && /(行程|旅行|旅游|trip|travel|itinerary)/i.test(title)) {
    return "destination";
  }
  return family;
}

type MotifPathSemanticMeta = {
  id: string;
  dep: EdgeType;
  sourceFamilies: string[];
  sourceFamilySignature: string;
  anchorFamily: string;
  sourceCores: string[];
  anchorCore: string;
  intentTokens: string[];
};

function motifPathSemanticMeta(m: ConceptMotif, conceptById: Map<string, ConceptItem>): MotifPathSemanticMeta {
  const sourceIds = motifSourceIds(m);
  const sourceFamilies = uniq(
    sourceIds
      .map((id) => semanticFamilyGroup(conceptById.get(id)))
      .filter(Boolean)
      .sort(),
    8
  );
  const anchor = conceptById.get(m.anchorConceptId);
  return {
    id: m.id,
    dep: motifDependencyClass(m),
    sourceFamilies,
    sourceFamilySignature: sourceFamilies.join("+") || "none",
    anchorFamily: semanticFamilyGroup(anchor) || canonicalConceptFamily(anchor) || "other",
    sourceCores: uniq(
      sourceIds
        .map((id) => semanticCoreFromConcept(conceptById.get(id)))
        .filter(Boolean)
        .sort(),
      8
    ),
    anchorCore: semanticCoreFromConcept(anchor),
    intentTokens: semanticTokens(`${m.title} ${m.description} ${m.causalFormula || ""}`),
  };
}

function crossAnchorDuplicateScore(a: MotifPathSemanticMeta, b: MotifPathSemanticMeta): number {
  const sourceFamilyScore =
    a.sourceFamilySignature === b.sourceFamilySignature ? 1 : tokenJaccard(a.sourceFamilies, b.sourceFamilies);
  const anchorFamilyScore = a.anchorFamily === b.anchorFamily ? 1 : 0;
  const sourceCoreScore = tokenJaccard(
    a.sourceCores.flatMap((x) => semanticTokens(x)),
    b.sourceCores.flatMap((x) => semanticTokens(x))
  );
  const anchorCoreScore = tokenJaccard(semanticTokens(a.anchorCore), semanticTokens(b.anchorCore));
  const intentScore = tokenJaccard(a.intentTokens, b.intentTokens);
  return sourceFamilyScore * 0.28 + anchorFamilyScore * 0.16 + sourceCoreScore * 0.24 + anchorCoreScore * 0.22 + intentScore * 0.1;
}

function motifStrengthScore(m: ConceptMotif): number {
  return motifPriorityScore(m) + (m.supportEdgeIds?.length || 0) * 0.002 + (m.supportNodeIds?.length || 0) * 0.001;
}

function conceptInfoTokens(c: ConceptItem | undefined): string[] {
  if (!c) return [];
  return uniq(
    [
      ...semanticTokens(cleanText(c.title, 120)),
      ...semanticTokens(conceptSemanticKey(c)),
      ...semanticTokens((c.evidenceTerms || []).join(" ")),
    ],
    16
  );
}

function isLowInformationRelayConcept(
  relay: ConceptItem | undefined,
  source: ConceptItem | undefined,
  target: ConceptItem | undefined
): boolean {
  if (!relay) return false;
  const relayTokens = conceptInfoTokens(relay);
  if (!relayTokens.length) return true;
  const sourceSet = new Set(conceptInfoTokens(source));
  const targetSet = new Set(conceptInfoTokens(target));
  let novel = 0;
  for (const token of relayTokens) if (!sourceSet.has(token) && !targetSet.has(token)) novel += 1;
  const infoGain = novel / Math.max(1, relayTokens.length);
  const relayCore = semanticCoreFromConcept(relay);
  const sourceCore = semanticCoreFromConcept(source);
  const targetCore = semanticCoreFromConcept(target);
  const sameAsNeighbor = !!relayCore && (relayCore === sourceCore || relayCore === targetCore);
  const relayFamily = semanticFamilyGroup(relay);
  const genericRelay = relayFamily === "other" || relayFamily === "generic_constraint";
  return infoGain <= 0.34 && (conceptScore(relay) <= 0.8 || sameAsNeighbor || genericRelay);
}

function applyRedundancyDeprecation(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  const groups = new Map<string, ConceptMotif[]>();
  for (const m of motifs) {
    if (m.resolved) continue;
    if (normalizeMotifLifecycleStatus(m.status, "active") === "cancelled") continue;
    if (!m.anchorConceptId) continue;
    const signature = `${motifDependencyClass(m)}|${m.anchorConceptId}|${sourceFamilySignature(m, conceptById)}`;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature)!.push(m);
  }

  const patch = new Map<string, { status: MotifLifecycleStatus; reason: string }>();
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const sorted = list
      .slice()
      .sort((a, b) => motifPriorityScore(b) - motifPriorityScore(a) || a.id.localeCompare(b.id));
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      patch.set(loser.id, {
        status: "deprecated",
        reason: `redundant_with:${winner.id}`,
      });
    }
  }

  return motifs.map((m) => {
    const p = patch.get(m.id);
    if (!p) return m;
    return {
      ...m,
      status: p.status,
      statusReason: p.reason,
    };
  });
}

function arraysIntersect(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (setA.has(x)) return true;
  return false;
}

function normalizeSimilarityText(text: string): string {
  return cleanText(text, 260)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function motifTextSimilarity(a: ConceptMotif, b: ConceptMotif): number {
  const textA = cleanText(`${a.title} ${a.description} ${a.causalFormula || ""}`, 260).toLowerCase();
  const textB = cleanText(`${b.title} ${b.description} ${b.causalFormula || ""}`, 260).toLowerCase();
  const setA = new Set((textA.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || []).filter(Boolean));
  const setB = new Set((textB.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]{2,24}/g) || []).filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  if (!union) return 0;
  return inter / union;
}

function hasNegationSignal(text: string): boolean {
  return /(不|不能|不要|避免|别|禁止|must not|cannot|avoid|no )/i.test(cleanText(text, 180));
}

function hasExplicitConflictSignal(text: string): boolean {
  return /(冲突|矛盾|互斥|incompatible|contradict|conflict|versus|vs\.)/i.test(cleanText(text, 200));
}

function applyRelationConflictDeprecation(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  const candidates = motifs.filter(
    (m) =>
      !m.resolved &&
      normalizeMotifLifecycleStatus(m.status, "active") !== "cancelled" &&
      m.status !== "deprecated" &&
      !!m.anchorConceptId
  );
  if (candidates.length < 2) return motifs;

  const patch = new Map<string, { status: MotifLifecycleStatus; reason: string }>();
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (!a.anchorConceptId || a.anchorConceptId !== b.anchorConceptId) continue;
      if (a.relation === b.relation) continue;

      const relationPair = new Set([motifDependencyClass(a), motifDependencyClass(b)]);
      const isPotentialConflict =
        (relationPair.has("constraint") && relationPair.has("determine")) ||
        (relationPair.has("constraint") && relationPair.has("enable"));
      if (!isPotentialConflict) continue;

      const srcA = sourceFamiliesForPattern(a, conceptById);
      const srcB = sourceFamiliesForPattern(b, conceptById);
      const familyOverlap = arraysIntersect(srcA, srcB);
      const negA = hasNegationSignal(a.title) || hasNegationSignal(a.description);
      const negB = hasNegationSignal(b.title) || hasNegationSignal(b.description);
      if (!familyOverlap) continue;

      const explicitConflict =
        negA !== negB ||
        hasExplicitConflictSignal(a.title) ||
        hasExplicitConflictSignal(a.description) ||
        hasExplicitConflictSignal(b.title) ||
        hasExplicitConflictSignal(b.description);

      const winner = motifPriorityScore(a) >= motifPriorityScore(b) ? a : b;
      const loser = winner.id === a.id ? b : a;
      if (loser.resolved) continue;
      patch.set(loser.id, {
        status: explicitConflict ? "deprecated" : "cancelled",
        reason: explicitConflict ? `relation_conflict_with:${winner.id}` : `relation_shadowed_by:${winner.id}`,
      });
    }
  }

  if (!patch.size) return motifs;
  return motifs.map((m) => {
    const p = patch.get(m.id);
    if (!p) return m;
    return {
      ...m,
      status: p.status,
      statusReason: p.reason,
      novelty: m.novelty === "new" ? "new" : "updated",
      resolved: false,
      resolvedAt: undefined,
      resolvedBy: undefined,
    };
  });
}

function isSubsetOf(a: string[], b: string[]): boolean {
  if (!a.length) return true;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}

function applyTriadSubsumption(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  const triads = motifs.filter((m) => m.motifType === "triad" && m.status === "active" && !m.resolved);
  if (!triads.length) return motifs;
  const triadMeta = triads.map((t) => ({
    id: t.id,
    relation: motifDependencyClass(t),
    anchor: t.anchorConceptId,
    sourceFamilies: sourceFamiliesForPattern(t, conceptById),
    confidence: t.confidence,
  }));

  return motifs.map((m) => {
    if (m.motifType !== "pair" || m.status !== "active" || m.resolved) return m;
    const pairFamilies = sourceFamiliesForPattern(m, conceptById);
    const covering = triadMeta.find(
      (t) =>
        t.relation === motifDependencyClass(m) &&
        t.anchor === m.anchorConceptId &&
        isSubsetOf(pairFamilies, t.sourceFamilies) &&
        t.confidence + 0.08 >= m.confidence
    );
    if (!covering) return m;
    return {
      ...m,
      status: "deprecated",
      statusReason: `subsumed_by:${covering.id}`,
      novelty: m.novelty === "new" ? "new" : "updated",
      resolved: false,
      resolvedAt: undefined,
      resolvedBy: undefined,
    };
  });
}

function applyHighSimilarityCancellation(motifs: ConceptMotif[]): ConceptMotif[] {
  const candidates = motifs.filter(
    (m) =>
      !m.resolved &&
      m.status === "active" &&
      !!m.anchorConceptId
  );
  if (candidates.length < 2) return motifs;

  const patch = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (!a.anchorConceptId || a.anchorConceptId !== b.anchorConceptId) continue;
      if (motifDependencyClass(a) !== motifDependencyClass(b)) continue;
      const titleA = normalizeSimilarityText(a.title);
      const titleB = normalizeSimilarityText(b.title);
      const titleSame = !!titleA && titleA === titleB;
      const textSim = motifTextSimilarity(a, b);
      if (!titleSame && textSim < 0.9) continue;

      const winner = motifPriorityScore(a) >= motifPriorityScore(b) ? a : b;
      const loser = winner.id === a.id ? b : a;
      if (loser.resolved) continue;
      if (patch.has(loser.id)) continue;
      patch.set(loser.id, `high_similarity_with:${winner.id}`);
    }
  }
  if (!patch.size) return motifs;
  return motifs.map((m) => {
    const reason = patch.get(m.id);
    if (!reason) return m;
    return {
      ...m,
      status: "cancelled",
      statusReason: reason,
      novelty: m.novelty === "new" ? "new" : "updated",
      resolved: true,
      resolvedBy: "system",
      resolvedAt: m.updatedAt || new Date().toISOString(),
    };
  });
}

function applyCrossAnchorPathDedup(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  const candidates = motifs.filter((m) => !m.resolved && m.status === "active" && !!m.anchorConceptId);
  if (candidates.length < 2) return motifs;

  const metaById = new Map<string, MotifPathSemanticMeta>();
  const buckets = new Map<string, ConceptMotif[]>();
  for (const m of candidates) {
    const meta = motifPathSemanticMeta(m, conceptById);
    metaById.set(m.id, meta);
    const key = `${meta.dep}|${meta.sourceFamilySignature}|${meta.anchorFamily}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(m);
  }

  const patch = new Map<string, string>();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const sorted = list
      .slice()
      .sort((a, b) => motifStrengthScore(b) - motifStrengthScore(a) || a.id.localeCompare(b.id));
    const survivors: ConceptMotif[] = [];

    for (const motif of sorted) {
      if (patch.has(motif.id)) continue;
      const meta = metaById.get(motif.id);
      if (!meta) {
        survivors.push(motif);
        continue;
      }

      let duplicatedBy = "";
      for (const keep of survivors) {
        if (motif.anchorConceptId === keep.anchorConceptId) continue;
        const keepMeta = metaById.get(keep.id);
        if (!keepMeta) continue;

        const pathScore = crossAnchorDuplicateScore(meta, keepMeta);
        const textScore = motifTextSimilarity(motif, keep);
        const anchorCoreScore = tokenJaccard(semanticTokens(meta.anchorCore), semanticTokens(keepMeta.anchorCore));
        const intentScore = tokenJaccard(meta.intentTokens, keepMeta.intentTokens);

        const semanticDuplicate =
          pathScore >= 0.84 ||
          (pathScore >= 0.76 && textScore >= 0.72) ||
          (anchorCoreScore >= 0.88 && intentScore >= 0.55 && textScore >= 0.64);
        if (!semanticDuplicate) continue;
        duplicatedBy = keep.id;
        break;
      }

      if (duplicatedBy) {
        patch.set(motif.id, `cross_anchor_duplicate_of:${duplicatedBy}`);
        continue;
      }
      survivors.push(motif);
    }
  }

  if (!patch.size) return motifs;
  return motifs.map((m) => {
    const reason = patch.get(m.id);
    if (!reason) return m;
    return {
      ...m,
      status: "cancelled",
      statusReason: reason,
      novelty: m.novelty === "new" ? "new" : "updated",
      resolved: true,
      resolvedBy: "system",
      resolvedAt: m.updatedAt || new Date().toISOString(),
    };
  });
}

function applyRelayChainCompression(
  motifs: ConceptMotif[],
  conceptById: Map<string, ConceptItem>,
  locale?: AppLocale
): ConceptMotif[] {
  const candidates = motifs.filter((m) => {
    if (m.status !== "active" || m.resolved || m.motifType !== "pair") return false;
    if ((m.reuseClass || "reusable") !== "reusable") return false;
    if (!m.anchorConceptId || m.relation === "conflicts_with") return false;
    const sources = motifSourceIds(m);
    return sources.length === 1 && !!sources[0];
  });
  if (candidates.length < 2) return motifs;

  const incoming = new Map<string, ConceptMotif[]>();
  const outgoing = new Map<string, ConceptMotif[]>();
  for (const m of candidates) {
    const source = motifSourceIds(m)[0];
    const target = m.anchorConceptId;
    if (!source || !target) continue;
    if (!incoming.has(target)) incoming.set(target, []);
    if (!outgoing.has(source)) outgoing.set(source, []);
    incoming.get(target)!.push(m);
    outgoing.get(source)!.push(m);
  }

  type ChainCandidate = {
    left: ConceptMotif;
    right: ConceptMotif;
    sourceId: string;
    relayId: string;
    targetId: string;
    dep: EdgeType;
    score: number;
  };

  const chains: ChainCandidate[] = [];
  for (const [relayId, leftList] of incoming.entries()) {
    const rightList = outgoing.get(relayId) || [];
    if (leftList.length !== 1 || rightList.length !== 1) continue;
    const left = leftList[0];
    const right = rightList[0];
    if (left.id === right.id) continue;
    if (left.relation !== right.relation) continue;
    const dep = motifDependencyClass(left);
    if (dep !== motifDependencyClass(right) || dep === "conflicts_with") continue;

    const sourceId = motifSourceIds(left)[0];
    const targetId = right.anchorConceptId;
    if (!sourceId || !targetId || sourceId === relayId || targetId === relayId || sourceId === targetId) continue;
    if (
      !isLowInformationRelayConcept(
        conceptById.get(relayId),
        conceptById.get(sourceId),
        conceptById.get(targetId)
      )
    ) {
      continue;
    }

    chains.push({
      left,
      right,
      sourceId,
      relayId,
      targetId,
      dep,
      score: motifStrengthScore(left) + motifStrengthScore(right),
    });
  }
  if (!chains.length) return motifs;

  const sortedChains = chains
    .slice()
    .sort((a, b) => b.score - a.score || a.left.id.localeCompare(b.left.id) || a.right.id.localeCompare(b.right.id));
  const consumed = new Set<string>();
  const patch = new Map<string, string>();
  const composites: ConceptMotif[] = [];
  const now = new Date().toISOString();

  for (const chain of sortedChains) {
    if (consumed.has(chain.left.id) || consumed.has(chain.right.id)) continue;

    const existingDirect = motifs.find((m) => {
      if (m.id === chain.left.id || m.id === chain.right.id) return false;
      if (m.status !== "active" || m.resolved) return false;
      if ((m.reuseClass || "reusable") !== "reusable") return false;
      if (motifDependencyClass(m) !== chain.dep) return false;
      if (m.anchorConceptId !== chain.targetId) return false;
      const sources = motifSourceIds(m);
      return sources.includes(chain.sourceId);
    });

    const sourceConcept = conceptById.get(chain.sourceId);
    const relayConcept = conceptById.get(chain.relayId);
    const targetConcept = conceptById.get(chain.targetId);

    const compositeId = existingDirect?.id || stableId(`chain:${chain.dep}:${chain.sourceId}->${chain.relayId}->${chain.targetId}`);
    if (!existingDirect) {
      const relation = chain.left.relation;
      const sourceTitle = cleanText(sourceConcept?.title, 44) || conceptTitleOf(chain.sourceId, conceptById);
      const relayTitle = cleanText(relayConcept?.title, 44) || conceptTitleOf(chain.relayId, conceptById);
      const targetTitle = cleanText(targetConcept?.title, 44) || conceptTitleOf(chain.targetId, conceptById);
      const conceptIds = uniq([chain.sourceId, chain.relayId, chain.targetId], 8);
      const confidence = clamp01(
        ((chain.left.confidence + chain.right.confidence) / 2) * 0.72 +
          Math.max(chain.left.confidence, chain.right.confidence) * 0.28 +
          0.01,
        0.72
      );
      composites.push({
        id: compositeId,
        motif_id: compositeId,
        motif_type: semanticMotifType(chain.dep),
        templateKey: `chain:${chain.dep}:${sourceSignatureToken(sourceConcept)}+${sourceSignatureToken(
          relayConcept
        )}->${sourceSignatureToken(targetConcept)}`,
        motifType: "triad",
        relation,
        roles: {
          sources: [chain.sourceId, chain.relayId],
          target: chain.targetId,
        },
        scope: "global",
        aliases: uniq([compositeId, chain.left.id, chain.right.id], 24),
        concept_bindings: conceptIds,
        conceptIds,
        anchorConceptId: chain.targetId,
        title: cleanText(`${sourceTitle} ${relationLabel(relation, locale)} ${targetTitle}`, 160),
        description: cleanText(
          t(
            locale,
            `链路压缩：${sourceTitle} -> ${relayTitle} -> ${targetTitle}（中继概念信息增益低）`,
            `Chain compression: ${sourceTitle} -> ${relayTitle} -> ${targetTitle} (relay concept has low information gain)`
          ),
          220
        ),
        confidence,
        supportEdgeIds: uniq([...chain.left.supportEdgeIds, ...chain.right.supportEdgeIds], 64),
        supportNodeIds: uniq([...chain.left.supportNodeIds, ...chain.right.supportNodeIds], 64),
        status: "active",
        statusReason: `chain_composite:${chain.left.id}+${chain.right.id}`,
        resolved: false,
        dependencyClass: chain.dep,
        reuseClass: "reusable",
        novelty: "new",
        updatedAt: now,
      });
    }

    patch.set(chain.left.id, `chain_compressed_by:${compositeId}`);
    patch.set(chain.right.id, `chain_compressed_by:${compositeId}`);
    consumed.add(chain.left.id);
    consumed.add(chain.right.id);
  }

  if (!patch.size && !composites.length) return motifs;
  const patched = motifs.map((m) => {
    const reason = patch.get(m.id);
    if (!reason) return m;
    return {
      ...m,
      status: "cancelled",
      statusReason: reason,
      novelty: m.novelty === "new" ? "new" : "updated",
      resolved: true,
      resolvedBy: "system",
      resolvedAt: now,
    };
  });
  if (!composites.length) return patched;
  const existingIds = new Set(patched.map((m) => m.id));
  const additions = composites.filter((m) => !existingIds.has(m.id));
  return additions.length ? [...patched, ...additions] : patched;
}

function capActiveMotifsPerAnchor(motifs: ConceptMotif[]): ConceptMotif[] {
  const groups = new Map<string, ConceptMotif[]>();
  for (const m of motifs) {
    if (!m.anchorConceptId || m.status !== "active" || m.resolved) continue;
    if (!groups.has(m.anchorConceptId)) groups.set(m.anchorConceptId, []);
    groups.get(m.anchorConceptId)!.push(m);
  }

  const patch = new Map<string, string>();
  for (const list of groups.values()) {
    if (list.length <= MAX_ACTIVE_MOTIFS_PER_ANCHOR) continue;
    const sorted = list
      .slice()
      .sort((a, b) => motifPriorityScore(b) - motifPriorityScore(a) || a.id.localeCompare(b.id));
    for (const m of sorted.slice(MAX_ACTIVE_MOTIFS_PER_ANCHOR)) {
      patch.set(m.id, `density_pruned:max_${MAX_ACTIVE_MOTIFS_PER_ANCHOR}`);
    }
  }

  if (!patch.size) return motifs;
  return motifs.map((m) =>
    patch.has(m.id)
      ? {
          ...m,
          status: "deprecated",
          statusReason: patch.get(m.id),
          novelty: m.novelty === "new" ? "new" : "updated",
        }
      : m
  );
}

function isSoftPruneReason(reason: string): boolean {
  const r = cleanText(reason, 180).toLowerCase();
  return (
    r.startsWith("redundant_with:") ||
    r.startsWith("subsumed_by:") ||
    r.startsWith("density_pruned:") ||
    r.startsWith("relation_shadowed_by:")
  );
}

function isSystemRedundantCancelledReason(reason: string): boolean {
  const r = cleanText(reason, 220).toLowerCase();
  return (
    isSoftPruneReason(r) ||
    r.startsWith("cross_anchor_duplicate_of:") ||
    r.startsWith("high_similarity_with:") ||
    r.startsWith("chain_compressed_by:") ||
    r.startsWith("non_reusable_context_specific:") ||
    r.startsWith("not_supported_by_current_graph")
  );
}

function shouldExposeMotifInOutput(motif: ConceptMotif): boolean {
  const status = normalizeMotifLifecycleStatus(motif.status, "active");
  if (status !== "cancelled") return true;
  const reason = cleanText(motif.statusReason, 220).toLowerCase();
  if (!reason) return motif.resolvedBy === "user";
  if (motif.resolvedBy === "user") return true;
  if (reason.startsWith("user_")) return true;
  if (reason === "all_related_concepts_paused" || reason === "legacy_user_disabled") return true;
  return !isSystemRedundantCancelledReason(reason);
}

function convertSoftDeprecationsToCancelled(motifs: ConceptMotif[]): ConceptMotif[] {
  return motifs.map((m) => {
    if (m.status !== "deprecated") return m;
    if (!isSoftPruneReason(m.statusReason || "")) return m;
    return {
      ...m,
      status: "cancelled",
      statusReason: cleanText(m.statusReason, 180) || "soft_pruned",
      resolved: true,
      resolvedBy: "system",
      resolvedAt: m.updatedAt || new Date().toISOString(),
      novelty: m.novelty === "new" ? "new" : "updated",
    };
  });
}

function appendStatusHistory(next: ConceptMotif, prev?: ConceptMotif): ConceptMotif {
  const prevHistory = Array.isArray(prev?.history) ? prev!.history!.slice(0, 19) : [];
  const statusChanged = !prev || prev.status !== next.status || cleanText(prev.statusReason, 120) !== cleanText(next.statusReason, 120);
  if (!statusChanged) {
    return {
      ...next,
      history: prevHistory.length ? prevHistory : next.history,
    };
  }
  const event = {
    at: next.updatedAt || new Date().toISOString(),
    by: (next.resolvedBy === "user" ? "user" : "system") as "system" | "user",
    action: "status_changed" as const,
    from: prev ? normalizeMotifLifecycleStatus(prev.status, "active") : undefined,
    to: normalizeMotifLifecycleStatus(next.status, "active"),
    reason: cleanText(next.statusReason, 120) || undefined,
  };
  return {
    ...next,
    history: [event, ...prevHistory].slice(0, 20),
  };
}

function motifCoverageComponent(m: ConceptMotif): number {
  if (m.coverage_origin === "edge_repair") return 1;
  const edgeSupport = Math.min(1, (m.supportEdgeIds || []).length / 2);
  const nodeSupport = Math.min(1, (m.supportNodeIds || []).length / 6);
  return clamp01(edgeSupport * 0.68 + nodeSupport * 0.32, 0.6);
}

function motifTransferabilityComponent(m: ConceptMotif): number {
  if ((m.reuseClass || "reusable") === "reusable") return 1;
  return m.motifType === "triad" ? 0.52 : 0.44;
}

function motifConflictPenalty(m: ConceptMotif): number {
  const reason = cleanText(m.statusReason, 160).toLowerCase();
  if (reason.startsWith("relation_conflict_with:") || m.relation === "conflicts_with") return 1;
  if (m.status === "deprecated") return 0.8;
  if (m.status === "uncertain") return 0.35;
  return 0.1;
}

function motifRedundancyPenalty(keyCount: number): number {
  if (keyCount <= 1) return 0;
  return Math.min(1, (keyCount - 1) * 0.42);
}

export function motifObjectiveScore(params: {
  motif: ConceptMotif;
  redundancyGroupSize: number;
}): number {
  const coverage = motifCoverageComponent(params.motif);
  const confidence = clamp01(params.motif.confidence, 0.7);
  const transferability = motifTransferabilityComponent(params.motif);
  const redundancy = motifRedundancyPenalty(params.redundancyGroupSize);
  const conflictPenalty = motifConflictPenalty(params.motif);
  return Number(
    clamp01(
      coverage * 0.45 + confidence * 0.22 + transferability * 0.14 - redundancy * 0.11 - conflictPenalty * 0.08,
      confidence
    ).toFixed(4)
  );
}

export function selectMotifSetGreedy(motifs: ConceptMotif[], conceptById: Map<string, ConceptItem>): ConceptMotif[] {
  if (!motifs.length) return motifs;
  const sourceSigById = new Map<string, string>();
  const keyCount = new Map<string, number>();
  for (const m of motifs) {
    const sourceSig = sourceFamilySignature(m, conceptById) || "none";
    sourceSigById.set(m.id, sourceSig);
    const key = `${motifDependencyClass(m)}|${cleanText(m.anchorConceptId, 120)}|${sourceSig}`;
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }

  const withScore = motifs.map((m) => {
    const sourceSig = sourceSigById.get(m.id) || "none";
    const key = `${motifDependencyClass(m)}|${cleanText(m.anchorConceptId, 120)}|${sourceSig}`;
    const selectionScore = motifObjectiveScore({
      motif: m,
      redundancyGroupSize: Number(keyCount.get(key) || 1),
    });
    return {
      ...m,
      selection_score: selectionScore,
      uncertainty: Number((1 - clamp01(m.confidence, 0.7)).toFixed(4)),
      support_count: (m.supportEdgeIds || []).length + (m.supportNodeIds || []).length,
    };
  });

  const hardConflictIds = new Set(
    withScore
      .filter((m) => cleanText(m.statusReason, 120).toLowerCase().startsWith("relation_conflict_with:"))
      .map((m) => m.id)
  );
  const selected = new Set<string>();
  const selectedByAnchor = new Map<string, number>();
  const selectedKey = new Set<string>();

  const candidates = withScore
    .filter((m) => m.status === "active" && !m.resolved && m.status !== "cancelled")
    .slice()
    .sort(
      (a, b) =>
        Number(b.selection_score || 0) - Number(a.selection_score || 0) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id)
    );

  for (const motif of candidates) {
    const anchor = cleanText(motif.anchorConceptId, 120) || "none";
    const current = Number(selectedByAnchor.get(anchor) || 0);
    if (current >= MAX_ACTIVE_MOTIFS_PER_ANCHOR) continue;
    const sourceSig = sourceSigById.get(motif.id) || "none";
    const dedupKey = `${motifDependencyClass(motif)}|${anchor}|${sourceSig}`;
    if (selectedKey.has(dedupKey)) continue;
    selected.add(motif.id);
    selectedKey.add(dedupKey);
    selectedByAnchor.set(anchor, current + 1);
  }

  return withScore.map((m) => {
    if (m.status !== "active") return m;
    if (selected.has(m.id)) return m;
    if (hardConflictIds.has(m.id)) return m;
    return {
      ...m,
      status: "deprecated",
      statusReason: appendReason(m.statusReason, "objective_pruned"),
      state_transition_reason: "objective_pruned",
      novelty: m.novelty === "new" ? "new" : "updated",
    };
  });
}

type RequiredCausalCoverageEdge = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeType;
  edgeConfidence: number;
  fromConceptIds: string[];
  toConceptIds: string[];
  reasoningScore: number;
};

const COVERAGE_CAUSAL_RELATIONS: EdgeType[] = ["enable", "constraint", "determine"];

function isCoverageRelation(type: EdgeType): boolean {
  return type === "enable" || type === "constraint" || type === "determine";
}

function isDurationFamily(family: string): boolean {
  return family === "duration_total" || family === "duration_city";
}

function isMetadataFamily(family: string): boolean {
  return family === "destination" || family === "duration_city" || family === "sub_location" || family === "other";
}

function shouldForceSkipCoveragePair(params: {
  relation: EdgeType;
  sourceFamily: string;
  targetFamily: string;
}): string | null {
  const sourceFamily = params.sourceFamily;
  const targetFamily = params.targetFamily;
  if (!sourceFamily || !targetFamily) return "pair_family_missing";

  // Known itinerary metadata bindings, not reusable reasoning.
  if ((sourceFamily === "destination" || sourceFamily === "sub_location") && isDurationFamily(targetFamily)) {
    return "metadata_destination_duration";
  }

  if (sourceFamily === "duration_city" && (targetFamily === "destination" || targetFamily === "duration_total")) {
    return "metadata_city_duration_binding";
  }

  if (sourceFamily === "meeting_critical" && targetFamily === "destination") {
    return "metadata_critical_day_binding";
  }

  if (isMetadataFamily(sourceFamily) && isMetadataFamily(targetFamily)) {
    return "metadata_pair";
  }

  if (sourceFamily === "goal" && targetFamily === "goal") {
    return "goal_self_binding";
  }

  return null;
}

function familyCompatibilityScore(params: {
  relation: EdgeType;
  sourceFamily: string;
  targetFamily: string;
}): number {
  const sourceFamily = params.sourceFamily;
  const targetFamily = params.targetFamily;
  if (!sourceFamily || !targetFamily) return 0;
  const reuseMatrix = REUSE_MATRIX[params.relation as "constraint" | "determine" | "enable"];
  if (
    reuseMatrix &&
    reuseMatrix.sources.has(sourceFamily) &&
    reuseMatrix.targets.has(targetFamily) &&
    REUSABLE_FAMILIES.has(sourceFamily) &&
    REUSABLE_FAMILIES.has(targetFamily)
  ) {
    return 1;
  }

  if (sourceFamily === "limiting_factor" && ["activity_preference", "lodging", "goal", "generic_constraint"].includes(targetFamily)) {
    return 0.95;
  }
  if (sourceFamily === "generic_constraint" && ["goal", "lodging", "activity_preference"].includes(targetFamily)) {
    return 0.82;
  }
  if (sourceFamily === "budget" && ["goal", "lodging", "duration_total"].includes(targetFamily)) {
    return 0.86;
  }
  if (sourceFamily === "people" && ["goal", "lodging", "activity_preference"].includes(targetFamily)) {
    return 0.8;
  }
  if (sourceFamily === "duration_total" && ["goal", "activity_preference", "lodging"].includes(targetFamily)) {
    return 0.8;
  }
  if (sourceFamily === "scenic_preference" && targetFamily === "goal") return 0.72;
  if (sourceFamily === "activity_preference" && targetFamily === "goal") return 0.72;
  if (sourceFamily === "lodging" && targetFamily === "goal") return 0.72;
  if (sourceFamily === "destination" && targetFamily === "goal") return 0.55;
  if (targetFamily === "goal" && !isMetadataFamily(sourceFamily)) return 0.62;
  if (isMetadataFamily(sourceFamily) || isMetadataFamily(targetFamily)) return 0.28;
  return 0.46;
}

function lexicalTokens(input: string): string[] {
  const text = cleanText(input, 220).toLowerCase();
  if (!text) return [];
  const raw = text.match(/[\u4e00-\u9fff]{1,4}|[a-z0-9]{2,24}/g) || [];
  return Array.from(new Set(raw)).slice(0, 16);
}

function tokenOverlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

function lexicalEntailmentScore(fromConcept: ConceptItem | undefined, toConcept: ConceptItem | undefined): number {
  const sourceTokens = lexicalTokens(`${fromConcept?.title || ""} ${fromConcept?.description || ""}`);
  const targetTokens = lexicalTokens(`${toConcept?.title || ""} ${toConcept?.description || ""}`);
  const overlap = tokenOverlapScore(sourceTokens, targetTokens);
  if (!sourceTokens.length || !targetTokens.length) return 0.42;
  return clamp01(0.32 + overlap * 0.9, 0.42);
}

function groundingStrengthScore(fromConcept: ConceptItem | undefined, toConcept: ConceptItem | undefined): number {
  const clsToScore = (x: ConceptGroundingClass): number => {
    if (x === "user") return 1;
    if (x === "unknown") return 0.56;
    return 0.18;
  };
  const source = clsToScore(conceptGroundingClass(fromConcept));
  const target = clsToScore(conceptGroundingClass(toConcept));
  return clamp01((source + target) / 2, 0.5);
}

function historyAgreementScore(fromConcept: ConceptItem | undefined, toConcept: ConceptItem | undefined): number {
  const sourceTokens = uniq(
    [...(fromConcept?.support_sources || []), ...((fromConcept?.sourceMsgIds || []).map((x) => cleanText(x, 40)))],
    16
  );
  const targetTokens = uniq(
    [...(toConcept?.support_sources || []), ...((toConcept?.sourceMsgIds || []).map((x) => cleanText(x, 40)))],
    16
  );
  const overlap = tokenOverlapScore(sourceTokens, targetTokens);
  if (!sourceTokens.length || !targetTokens.length) return 0.62;
  return clamp01(0.4 + overlap * 0.6, 0.62);
}

function topologySupportScore(params: {
  edgeConfidence: number;
  fromConceptIds: string[];
  toConceptIds: string[];
}): number {
  const conf = clamp01(params.edgeConfidence, 0.74);
  const multiplicityPenalty =
    params.fromConceptIds.length > 2 || params.toConceptIds.length > 2
      ? 0.1
      : params.fromConceptIds.length > 1 || params.toConceptIds.length > 1
      ? 0.05
      : 0;
  return clamp01(conf - multiplicityPenalty, 0.72);
}

function edgeReasoningScore(params: {
  relation: EdgeType;
  edgeConfidence: number;
  fromConceptIds: string[];
  toConceptIds: string[];
  fromConcept: ConceptItem | undefined;
  toConcept: ConceptItem | undefined;
}): number {
  const sourceFamily = canonicalConceptFamily(params.fromConcept);
  const targetFamily = canonicalConceptFamily(params.toConcept);
  const family = familyCompatibilityScore({
    relation: params.relation,
    sourceFamily,
    targetFamily,
  });
  const grounding = groundingStrengthScore(params.fromConcept, params.toConcept);
  const lexical = lexicalEntailmentScore(params.fromConcept, params.toConcept);
  const topology = topologySupportScore({
    edgeConfidence: params.edgeConfidence,
    fromConceptIds: params.fromConceptIds,
    toConceptIds: params.toConceptIds,
  });
  const history = historyAgreementScore(params.fromConcept, params.toConcept);
  if (!isAlgoV3Enabled()) {
    return clamp01(family * 0.42 + grounding * 0.24 + lexical * 0.14 + topology * 0.2, 0.62);
  }
  return clamp01(family * 0.4 + grounding * 0.22 + lexical * 0.16 + topology * 0.12 + history * 0.1, 0.62);
}

function reasoningScoreThreshold(relation: EdgeType): number {
  if (!isAlgoV3Enabled()) {
    if (relation === "determine") return 0.68;
    if (relation === "constraint") return 0.64;
    return 0.62;
  }
  if (relation === "determine") return 0.69;
  if (relation === "constraint") return 0.65;
  return 0.63;
}

function shouldRunBoundaryValidation(score: number, relation: EdgeType): boolean {
  const thr = reasoningScoreThreshold(relation);
  if (!isAlgoV3Enabled()) return score >= thr - 0.08 && score <= thr + 0.07;
  return score >= thr - 0.06 && score <= thr + 0.06;
}

type CoverageEligibilityDecision = {
  eligible: boolean;
  reason: string;
  score: number;
  boundaryChecked: boolean;
  boundaryLlmCalled: boolean;
  highImpact: boolean;
  llmValidated: boolean;
  llmRejected: boolean;
};

function impactRelationWeight(relation: EdgeType): number {
  if (relation === "determine") return 1;
  if (relation === "constraint") return 0.86;
  return 0.72;
}

function isHighImpactEdge(params: {
  relation: EdgeType;
  score: number;
  fromConcept: ConceptItem | undefined;
  toConcept: ConceptItem | undefined;
  p80Centrality: number;
  conceptCentralityById: Map<string, number>;
}): boolean {
  const fromCentrality = Number(params.conceptCentralityById.get(cleanText(params.fromConcept?.id, 120)) || 0);
  const toCentrality = Number(params.conceptCentralityById.get(cleanText(params.toConcept?.id, 120)) || 0);
  const centrality = (fromCentrality + toCentrality) / 2;
  const impact = centrality * impactRelationWeight(params.relation) * (1 + (1 - params.score) * 0.4);
  return centrality >= params.p80Centrality && impact >= 0.72;
}

function isCoverageEligiblePair(params: {
  relation: EdgeType;
  fromConcept: ConceptItem | undefined;
  toConcept: ConceptItem | undefined;
  edgeConfidence: number;
  fromConceptIds: string[];
  toConceptIds: string[];
  p80Centrality: number;
  conceptCentralityById: Map<string, number>;
}): CoverageEligibilityDecision {
  const sourceFamily = canonicalConceptFamily(params.fromConcept);
  const targetFamily = canonicalConceptFamily(params.toConcept);
  const forceSkipReason = shouldForceSkipCoveragePair({
    relation: params.relation,
    sourceFamily,
    targetFamily,
  });
  if (forceSkipReason) {
    return {
      eligible: false,
      reason: forceSkipReason,
      score: 0,
      boundaryChecked: false,
      boundaryLlmCalled: false,
      highImpact: false,
      llmValidated: false,
      llmRejected: false,
    };
  }

  const score = edgeReasoningScore({
    relation: params.relation,
    edgeConfidence: params.edgeConfidence,
    fromConceptIds: params.fromConceptIds,
    toConceptIds: params.toConceptIds,
    fromConcept: params.fromConcept,
    toConcept: params.toConcept,
  });
  const threshold = reasoningScoreThreshold(params.relation);
  const highImpact = isHighImpactEdge({
    relation: params.relation,
    score,
    fromConcept: params.fromConcept,
    toConcept: params.toConcept,
    p80Centrality: params.p80Centrality,
    conceptCentralityById: params.conceptCentralityById,
  });
  if (score >= threshold) {
    return {
      eligible: true,
      reason: "reasoning_score_pass",
      score,
      boundaryChecked: false,
      boundaryLlmCalled: false,
      highImpact,
      llmValidated: false,
      llmRejected: false,
    };
  }

  if (shouldRunBoundaryValidation(score, params.relation)) {
    const historyAgreement = historyAgreementScore(params.fromConcept, params.toConcept);
    const boundary = validateBoundaryReasoningEdge({
      relation: params.relation,
      sourceFamily,
      targetFamily,
      sourceText: cleanText(params.fromConcept?.title || "", 220),
      targetText: cleanText(params.toConcept?.title || "", 220),
      score,
      edgeConfidence: params.edgeConfidence,
      highImpact,
      historyAgreement,
    });
    return {
      eligible: boundary.accepted,
      reason: boundary.reason,
      score,
      boundaryChecked: true,
      boundaryLlmCalled: boundary.validator === "llm",
      highImpact,
      llmValidated: boundary.validator === "llm" && boundary.accepted,
      llmRejected: boundary.validator === "llm" && !boundary.accepted,
    };
  }

  return {
    eligible: false,
    reason: "reasoning_score_low",
    score,
    boundaryChecked: false,
    boundaryLlmCalled: false,
    highImpact,
    llmValidated: false,
    llmRejected: false,
  };
}

function collectRequiredCausalCoverageEdges(params: {
  graph: CDG;
  concepts: ConceptItem[];
}): {
  required: RequiredCausalCoverageEdge[];
  excludedByReason: Record<string, number>;
  excludedNonReasoningEdges: number;
  boundaryChecks: number;
  boundaryLlmCalls: number;
  highImpactEdges: number;
  llmValidatedEdges: number;
  llmRejectedEdges: number;
} {
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const nodeToConcepts = buildNodeToConcepts(params.concepts);
  const nodeDegree = new Map<string, number>();
  for (const n of params.graph.nodes || []) nodeDegree.set(n.id, 0);
  for (const e of params.graph.edges || []) {
    nodeDegree.set(e.from, (nodeDegree.get(e.from) || 0) + 1);
    nodeDegree.set(e.to, (nodeDegree.get(e.to) || 0) + 1);
  }
  const conceptCentralityById = new Map<string, number>();
  for (const c of params.concepts || []) {
    const avgDegree =
      (c.nodeIds || []).reduce((sum, id) => sum + Number(nodeDegree.get(id) || 0), 0) /
      Math.max(1, (c.nodeIds || []).length || 1);
    conceptCentralityById.set(c.id, clamp01(avgDegree / 3, 0));
  }
  const centralityValues = Array.from(conceptCentralityById.values()).sort((a, b) => a - b);
  const p80Index = centralityValues.length ? Math.max(0, Math.floor((centralityValues.length - 1) * 0.8)) : 0;
  const p80Centrality = centralityValues.length ? centralityValues[p80Index] : 0.72;
  const required: RequiredCausalCoverageEdge[] = [];
  const excludedByReason: Record<string, number> = {};
  let excludedNonReasoningEdges = 0;
  let boundaryChecks = 0;
  let boundaryLlmCalls = 0;
  let highImpactEdges = 0;
  let llmValidatedEdges = 0;
  let llmRejectedEdges = 0;
  const bumpReason = (reason: string) => {
    const key = cleanText(reason || "unknown", 60) || "unknown";
    excludedByReason[key] = (excludedByReason[key] || 0) + 1;
  };
  for (const edge of params.graph.edges || []) {
    if (!isCoverageRelation(edge.type)) continue;
    const fromConceptIds = uniq(nodeToConcepts.get(edge.from) || [], 24);
    const toConceptIds = uniq(nodeToConcepts.get(edge.to) || [], 24);
    if (!fromConceptIds.length || !toConceptIds.length) {
      excludedNonReasoningEdges += 1;
      bumpReason("edge_concept_unmapped");
      continue;
    }

    const eligiblePairs: Array<{ fromId: string; toId: string; score: number }> = [];
    for (const fromId of fromConceptIds) {
      for (const toId of toConceptIds) {
        const decision = isCoverageEligiblePair({
          relation: edge.type,
          fromConcept: conceptById.get(fromId),
          toConcept: conceptById.get(toId),
          edgeConfidence: clamp01(edge.confidence, 0.78),
          fromConceptIds,
          toConceptIds,
          p80Centrality,
          conceptCentralityById,
        });
        if (decision.boundaryChecked) boundaryChecks += 1;
        if (decision.boundaryLlmCalled) boundaryLlmCalls += 1;
        if (decision.highImpact) highImpactEdges += 1;
        if (decision.llmValidated) llmValidatedEdges += 1;
        if (decision.llmRejected) llmRejectedEdges += 1;
        if (decision.eligible) {
          eligiblePairs.push({ fromId, toId, score: decision.score });
        } else {
          bumpReason(decision.reason);
        }
      }
    }
    if (!eligiblePairs.length) {
      excludedNonReasoningEdges += 1;
      continue;
    }

    const eligibleFromIds = uniq(eligiblePairs.map((x) => x.fromId), 24);
    const eligibleToIds = uniq(eligiblePairs.map((x) => x.toId), 24);
    const bestScore = eligiblePairs.reduce((acc, x) => Math.max(acc, x.score), 0);
    required.push({
      edgeId: cleanText(edge.id, 120) || stableId(`edge:${edge.from}->${edge.to}:${edge.type}`),
      fromNodeId: cleanText(edge.from, 120),
      toNodeId: cleanText(edge.to, 120),
      relation: edge.type,
      edgeConfidence: clamp01(edge.confidence, 0.78),
      fromConceptIds: eligibleFromIds,
      toConceptIds: eligibleToIds,
      reasoningScore: clamp01(bestScore, 0.7),
    });
  }
  return {
    required,
    excludedByReason,
    excludedNonReasoningEdges,
    boundaryChecks,
    boundaryLlmCalls,
    highImpactEdges,
    llmValidatedEdges,
    llmRejectedEdges,
  };
}

function motifSourceIdsForCoverage(motif: ConceptMotif): string[] {
  return uniq(
    ((motif.roles?.sources || []).length
      ? motif.roles.sources
      : (motif.conceptIds || []).filter((id) => id !== motif.anchorConceptId)
    ).map((id) => cleanText(id, 120)),
    12
  );
}

function edgeCoveredByMotifs(edge: RequiredCausalCoverageEdge, motifs: ConceptMotif[]): boolean {
  for (const motif of motifs || []) {
    if (motif.status === "cancelled") continue;
    const relation = normalizeDependencyClass(motif.dependencyClass || motif.relation, motif.relation);
    if (relation !== edge.relation) continue;
    const target = cleanText(motif.anchorConceptId, 120);
    if (!target || !edge.toConceptIds.includes(target)) continue;
    const sources = motifSourceIdsForCoverage(motif);
    if (!sources.length) continue;
    if (sources.some((sid) => edge.fromConceptIds.includes(sid))) return true;
  }
  return false;
}

function buildConceptPairRelationIndex(params: {
  graph: CDG;
  concepts: ConceptItem[];
}): Set<string> {
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const nodeToConcepts = buildNodeToConcepts(params.concepts);
  const conceptCentralityById = new Map<string, number>();
  for (const c of params.concepts || []) {
    conceptCentralityById.set(c.id, clamp01((c.nodeIds || []).length / 3, 0.4));
  }
  const p80Centrality = 0.72;
  const pairs = new Set<string>();
  for (const edge of params.graph.edges || []) {
    if (!isCoverageRelation(edge.type)) continue;
    const fromConceptIds = uniq(nodeToConcepts.get(edge.from) || [], 24);
    const toConceptIds = uniq(nodeToConcepts.get(edge.to) || [], 24);
    const edgeConfidence = clamp01(edge.confidence, 0.78);
    for (const fromId of fromConceptIds) {
      for (const toId of toConceptIds) {
        const fid = cleanText(fromId, 120);
        const tid = cleanText(toId, 120);
        if (!fid || !tid || fid === tid) continue;
        const decision = isCoverageEligiblePair({
          relation: edge.type,
          fromConcept: conceptById.get(fid),
          toConcept: conceptById.get(tid),
          edgeConfidence,
          fromConceptIds,
          toConceptIds,
          p80Centrality,
          conceptCentralityById,
        });
        if (!decision.eligible) {
          continue;
        }
        pairs.add(`${edge.type}:${fid}->${tid}`);
      }
    }
  }
  return pairs;
}

function verifyMotifSubgraph(params: {
  motif: ConceptMotif;
  pairIndex: Set<string>;
}): boolean {
  const relation = normalizeDependencyClass(params.motif.dependencyClass || params.motif.relation, params.motif.relation);
  if (!isCoverageRelation(relation)) return true;
  const target = cleanText(params.motif.anchorConceptId, 120);
  const sources = motifSourceIdsForCoverage(params.motif);
  if (!target || !sources.length) return false;
  for (const source of sources) {
    if (!params.pairIndex.has(`${relation}:${source}->${target}`)) return false;
  }
  return true;
}

function bestConceptIdByScore(ids: string[], conceptById: Map<string, ConceptItem>): string {
  return (
    ids
      .slice()
      .sort((a, b) => {
        const ca = conceptById.get(a);
        const cb = conceptById.get(b);
        return conceptScore(cb || ({} as any)) - conceptScore(ca || ({} as any)) || a.localeCompare(b);
      })
      .find(Boolean) || ""
  );
}

function causalOperatorFromRelation(relation: EdgeType): MotifCausalOperator {
  if (relation === "constraint") return "confounding";
  if (relation === "determine") return "intervention";
  return "direct_causation";
}

function buildEdgeRepairMotif(params: {
  edge: RequiredCausalCoverageEdge;
  conceptById: Map<string, ConceptItem>;
  locale?: AppLocale;
}): ConceptMotif | null {
  const sourceId = bestConceptIdByScore(params.edge.fromConceptIds, params.conceptById);
  const targetId = bestConceptIdByScore(params.edge.toConceptIds, params.conceptById);
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = params.conceptById.get(sourceId);
  const target = params.conceptById.get(targetId);
  if (!source || !target) return null;

  const motifId = stableId(`repair:${params.edge.edgeId}:${params.edge.relation}:${sourceId}->${targetId}`);
  const templateKey = `coverage_repair:${params.edge.relation}:${source.family}->${target.family}`;
  const now = new Date().toISOString();
  return {
    id: motifId,
    motif_id: motifId,
    motif_type: semanticMotifType(params.edge.relation),
    templateKey,
    motifType: "pair",
    relation: params.edge.relation,
    roles: {
      sources: [sourceId],
      target: targetId,
    },
    scope: "global",
    aliases: uniq([motifId, `repair:${params.edge.edgeId}`], 24),
    concept_bindings: [sourceId, targetId],
    conceptIds: [sourceId, targetId],
    anchorConceptId: targetId,
    title: cleanText(`${source.title} ${relationLabel(params.edge.relation, params.locale)} ${target.title}`, 160),
    description: cleanText(
      t(
        params.locale,
        `Coverage repair: ${source.title} ${relationLabel(params.edge.relation, params.locale)} ${target.title}`,
        `Coverage repair: ${source.title} ${relationLabel(params.edge.relation, params.locale)} ${target.title}`
      ),
      220
    ),
    confidence: clamp01(params.edge.edgeConfidence, 0.82),
    supportEdgeIds: [params.edge.edgeId],
    supportNodeIds: [params.edge.fromNodeId, params.edge.toNodeId],
    status: "active",
    statusReason: `coverage_repair:${params.edge.edgeId}`,
    resolved: false,
    causalOperator: causalOperatorFromRelation(params.edge.relation),
    causalFormula: cleanText(`${sourceId} -> ${targetId}`, 120),
    dependencyClass: params.edge.relation,
    novelty: "updated",
    updatedAt: now,
    reuseClass: "reusable",
    coverage_origin: "edge_repair",
    subgraph_verified: true,
  };
}

function motifComponentCount(motifs: ConceptMotif[]): number {
  const activeIds = uniq(
    (motifs || [])
      .filter((m) => m.status !== "cancelled")
      .map((m) => cleanText(m.id, 120))
      .filter(Boolean),
    1000
  );
  if (!activeIds.length) return 0;
  const adj = new Map<string, Set<string>>();
  for (const id of activeIds) adj.set(id, new Set<string>());
  const motifsByConcept = new Map<string, string[]>();
  for (const motif of motifs || []) {
    if (motif.status === "cancelled") continue;
    for (const cid of motif.conceptIds || []) {
      const conceptId = cleanText(cid, 120);
      if (!conceptId) continue;
      if (!motifsByConcept.has(conceptId)) motifsByConcept.set(conceptId, []);
      motifsByConcept.get(conceptId)!.push(motif.id);
    }
  }
  for (const ids of motifsByConcept.values()) {
    const uniqIds = uniq(ids, 80);
    for (let i = 0; i < uniqIds.length; i += 1) {
      for (let j = i + 1; j < uniqIds.length; j += 1) {
        const a = uniqIds[i];
        const b = uniqIds[j];
        if (!adj.has(a) || !adj.has(b)) continue;
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
      }
    }
  }
  const seen = new Set<string>();
  let components = 0;
  for (const id of activeIds) {
    if (seen.has(id)) continue;
    components += 1;
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) || []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return components;
}

export function enforceCausalEdgeCoverage(params: {
  graph: CDG;
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  locale?: AppLocale;
  maxRounds?: number;
}): { motifs: ConceptMotif[]; report: MotifCoverageInvariantReport } {
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));
  const coverage = collectRequiredCausalCoverageEdges({
    graph: params.graph,
    concepts: params.concepts,
  });
  const required = coverage.required;
  const maxRounds = Math.max(0, Math.min(6, Number(params.maxRounds) || 2));
  let motifs = (params.motifs || []).slice();
  let repairedMotifCount = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const uncovered = required.filter((edge) => !edgeCoveredByMotifs(edge, motifs));
    if (!uncovered.length) break;
    const existingIds = new Set(motifs.map((m) => m.id));
    const additions: ConceptMotif[] = [];
    for (const edge of uncovered) {
      const repair = buildEdgeRepairMotif({
        edge,
        conceptById,
        locale: params.locale,
      });
      if (!repair || existingIds.has(repair.id)) continue;
      existingIds.add(repair.id);
      additions.push(repair);
    }
    if (!additions.length) break;
    repairedMotifCount += additions.length;
    motifs = [...motifs, ...additions];
  }

  const pairIndex = buildConceptPairRelationIndex({
    graph: params.graph,
    concepts: params.concepts,
  });
  motifs = motifs.map((motif) => {
    const coverageOrigin: MotifCoverageOrigin = motif.coverage_origin === "edge_repair" ? "edge_repair" : "native";
    const relation = normalizeDependencyClass(motif.dependencyClass || motif.relation, motif.relation);
    const target = cleanText(motif.anchorConceptId, 120);
    const sources = motifSourceIdsForCoverage(motif);
    const reasoningEligible =
      isCoverageRelation(relation) &&
      !!target &&
      !!sources.length &&
      sources.every((source) => pairIndex.has(`${relation}:${source}->${target}`));
    return {
      ...motif,
      coverage_origin: coverageOrigin,
      reasoning_eligible: reasoningEligible,
      coverage_skip_reason:
        reasoningEligible || !isCoverageRelation(relation)
          ? undefined
          : "no_reasoning_pair_support",
      subgraph_verified:
        coverageOrigin === "edge_repair"
          ? true
          : verifyMotifSubgraph({
              motif,
              pairIndex,
            }),
    };
  });

  const coveredCausalEdges = required.reduce(
    (acc, edge) => (edgeCoveredByMotifs(edge, motifs) ? acc + 1 : acc),
    0
  );

  return {
    motifs,
    report: {
      requiredCausalEdges: required.length,
      coveredCausalEdges,
      uncoveredCausalEdges: Math.max(0, required.length - coveredCausalEdges),
      repairedMotifCount,
      repairRatio: required.length ? Number((repairedMotifCount / required.length).toFixed(4)) : 0,
      componentCount: motifComponentCount(motifs),
      excludedNonReasoningEdges: coverage.excludedNonReasoningEdges,
      excludedByReason: coverage.excludedByReason,
      boundaryChecks: coverage.boundaryChecks,
      boundaryLlmCalls: coverage.boundaryLlmCalls,
      highImpactEdges: coverage.highImpactEdges,
      llmValidatedEdges: coverage.llmValidatedEdges,
      llmRejectedEdges: coverage.llmRejectedEdges,
    },
  };
}

export function reconcileMotifsWithGraph(params: {
  graph: CDG;
  concepts: ConceptItem[];
  baseMotifs?: any;
  locale?: AppLocale;
}): ConceptMotif[] {
  const now = new Date().toISOString();
  const pairInstances = buildPairMotifs(params.graph, params.concepts, params.locale);
  const triadInstances = buildTriadMotifs(pairInstances, params.concepts, params.locale);
  const derived = aggregateToPatternMotifs(
    [...pairInstances, ...triadInstances],
    params.concepts,
    params.locale
  );
  const base = normalizeMotifs(params.baseMotifs);
  const baseById = new Map(base.map((m) => [m.id, m]));
  const conceptById = new Map((params.concepts || []).map((c) => [c.id, c]));

  const mergedDerived = derived.map((m) => {
    const prev = baseById.get(m.id);
    const inferred = inferBaseStatus(m, prev, conceptById);
    const status = inferred.status;
    const preferDerivedTitle = isEnglishLocale(params.locale) && hasCjk(prev?.title || "");
    const preferDerivedDescription =
      isEnglishLocale(params.locale) &&
      (hasCjk(prev?.description || "") ||
        /模式：|复合结构：|限制|支持|决定|冲突/.test(cleanText(prev?.description, 160)));
    const baseMerged = {
      ...m,
      title: prev?.title && !preferDerivedTitle ? prev.title : m.title,
      description:
        prev?.description && !preferDerivedDescription ? prev.description : m.description,
      status,
      statusReason: inferred.reason || prev?.statusReason,
      state_transition_reason: inferred.reason || undefined,
      resolved: !!prev?.resolved && status !== "deprecated",
      resolvedAt: prev?.resolvedAt,
      resolvedBy: prev?.resolvedBy,
      updatedAt: now,
    };
    const withUserOverlay = applyUserEditableOverlay({
      current: baseMerged,
      prev,
      conceptById,
    });
    const changed =
      !!prev &&
      (Math.abs((prev.confidence || 0) - (withUserOverlay.confidence || 0)) >= 0.04 ||
        isSupportChanged(prev, withUserOverlay) ||
        motifEditableSignature(prev) !== motifEditableSignature(withUserOverlay));
    return {
      ...withUserOverlay,
      novelty: prev ? (changed ? "updated" : "unchanged") : "new",
    };
  });

  const semanticMerged = applyReuseClassification(
    mergedDerived.map((m) => withCausalSemantics(m, conceptById, params.locale)),
    conceptById
  );
  const relationConflicted = applyRelationConflictDeprecation(semanticMerged, conceptById);
  const deprecationApplied = applyRedundancyDeprecation(relationConflicted, conceptById);
  const highSimilarityCollapsed = applyHighSimilarityCancellation(deprecationApplied);
  const crossAnchorDeduped = applyCrossAnchorPathDedup(highSimilarityCollapsed, conceptById);
  const triadSubsumed = applyTriadSubsumption(crossAnchorDeduped, conceptById);
  const chainCompressed = applyRelayChainCompression(triadSubsumed, conceptById, params.locale);
  const objectiveSelected = isAlgoV3Enabled()
    ? selectMotifSetGreedy(chainCompressed, conceptById)
    : chainCompressed;
  const densityCapped = capActiveMotifsPerAnchor(objectiveSelected);
  const softPrunedCollapsed = convertSoftDeprecationsToCancelled(densityCapped).map((m) => {
    if (m.status !== "deprecated" && m.status !== "cancelled") return m;
    if (m.novelty === "new") return m;
    if (m.status === "cancelled") {
      return { ...m, novelty: "updated" as MotifChangeState };
    }
    return { ...m, novelty: "updated" as MotifChangeState, resolved: false, resolvedAt: undefined, resolvedBy: undefined };
  });

  const derivedIds = new Set(softPrunedCollapsed.map((m) => m.id));
  const manualPersistedFromHistory: ConceptMotif[] = [];
  const cancelledFromHistory: ConceptMotif[] = [];
  for (const old of base) {
    if (derivedIds.has(old.id)) continue;
    const shouldPersist = shouldPersistUserManualMotif({ motif: old, conceptById });
    if (!shouldPersist) {
      cancelledFromHistory.push({
        ...old,
        status: "cancelled",
        statusReason: "not_supported_by_current_graph",
        novelty: "updated",
        updatedAt: now,
      });
      continue;
    }

    const structure = sanitizeMotifStructure({
      conceptIds: (old.conceptIds || old.concept_bindings || []).slice(),
      anchorConceptId: old.anchorConceptId,
      conceptById,
    });
    if (!structure) continue;
    const relation = normalizeDependencyClass(old.dependencyClass || old.relation, "enable");
    const normalizedOldStatus = normalizeMotifLifecycleStatus(old.status, "active");
    const keptStatus: MotifLifecycleStatus = isUserEditableStatus(normalizedOldStatus) ? normalizedOldStatus : "active";
    manualPersistedFromHistory.push({
      ...old,
      relation,
      dependencyClass: relation,
      conceptIds: structure.conceptIds,
      concept_bindings: structure.conceptIds,
      anchorConceptId: structure.anchorConceptId,
      roles: {
        sources: structure.sourceIds,
        target: structure.anchorConceptId,
      },
      motifType: structure.conceptIds.length >= 3 ? "triad" : "pair",
      status: keptStatus,
      statusReason: cleanText(old.statusReason, 180) || "user_manual_motif_persisted",
      resolved: true,
      resolvedBy: "user",
      resolvedAt: old.resolvedAt || now,
      novelty: "updated",
      updatedAt: now,
    });
  }

  const all = [...softPrunedCollapsed, ...manualPersistedFromHistory, ...cancelledFromHistory]
    .map((m) => withCausalSemantics(m, conceptById, params.locale))
    .map((m) => applyMotifReuseClassification(m, conceptById))
    .map((m) => appendStatusHistory(m, baseById.get(m.id)));
  return all
    .filter((m) => shouldExposeMotifInOutput(m))
    .slice()
    .sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 320);
}

export function attachMotifIdsToConcepts(concepts: ConceptItem[], motifs: ConceptMotif[]): ConceptItem[] {
  const motifIdsByConcept = new Map<string, string[]>();
  for (const m of motifs || []) {
    if (m.status === "cancelled") continue;
    for (const cid of m.conceptIds || []) {
      if (!motifIdsByConcept.has(cid)) motifIdsByConcept.set(cid, []);
      motifIdsByConcept.get(cid)!.push(m.id);
    }
  }

  return (concepts || []).map((c) => ({
    ...c,
    motifIds: uniq(motifIdsByConcept.get(c.id) || [], 48),
  }));
}
