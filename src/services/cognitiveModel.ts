import type { CDG } from "../core/graph.js";
import { conceptTypeMigration, normalizeValidationStatus, type ConceptValidationStatus } from "../core/graph/schemaAdapters.js";
import {
  applyConceptStateToGraph,
  reconcileConceptsWithGraph,
  type ConceptItem,
} from "./concepts.js";
import {
  attachMotifIdsToConcepts,
  enforceCausalEdgeCoverage,
  type MotifCoverageInvariantReport,
  reconcileMotifsWithGraph,
  type ConceptMotif,
} from "./motif/conceptMotifs.js";
import {
  reconcileMotifLinks,
  type MotifLink,
} from "./motif/motifLinks.js";
import {
  buildMotifReasoningView,
  type MotifReasoningView,
} from "./motif/reasoningView.js";
import {
  reconcileContextsWithGraph,
  type ContextItem,
} from "./contexts.js";
import type { AppLocale } from "../i18n/locale.js";

export type CognitiveModel = {
  graph: CDG;
  conceptGraph: CDG;
  motifGraph: {
    motifs: ConceptMotif[];
    motifLinks: MotifLink[];
  };
  concepts: ConceptItem[];
  validationStatus: ConceptValidationStatus;
  motifs: ConceptMotif[];
  motifLinks: MotifLink[];
  motifReasoningView: MotifReasoningView;
  motifInvariantReport?: MotifCoverageInvariantReport;
  contexts: ContextItem[];
};

export type MotifGenerationChain = {
  graph: CDG;
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  motifLinks: MotifLink[];
  motifReasoningView: MotifReasoningView;
  motifInvariantReport?: MotifCoverageInvariantReport;
  contexts: ContextItem[];
  validationStatus: ConceptValidationStatus;
};

function normalizeGraphConceptSchema(graph: CDG): CDG {
  const now = new Date().toISOString();
  const nodes = (graph.nodes || []).map((n) => {
    const migration = conceptTypeMigration((n as any)?.type);
    const value =
      n.value && typeof n.value === "object" && !Array.isArray(n.value)
        ? ({ ...(n.value as Record<string, any>) } as Record<string, any>)
        : {};
    const conceptState =
      value.conceptState && typeof value.conceptState === "object" && !Array.isArray(value.conceptState)
        ? ({ ...(value.conceptState as Record<string, any>) } as Record<string, any>)
        : {};
    const validationStatus = normalizeValidationStatus(
      migration.validationStatus || (n as any)?.validation_status || value.validation_status || conceptState.validation_status,
      "unasked"
    );
    const revisionHistory = Array.isArray((n as any)?.revisionHistory) ? [...((n as any).revisionHistory as any[])] : [];
    if (migration.note && migration.migratedFrom) {
      revisionHistory.unshift({
        at: now,
        action: "updated",
        by: "system",
        reason: `${migration.note}:${migration.migratedFrom}`,
      });
    }
    return {
      ...n,
      type: migration.type,
      validation_status: validationStatus,
      value: {
        ...value,
        conceptState: {
          ...conceptState,
          validation_status: validationStatus,
        },
      },
      revisionHistory: revisionHistory.slice(0, 20),
    };
  });
  return {
    ...graph,
    nodes,
  };
}

function deriveInteractionValidationStatus(concepts: ConceptItem[]): ConceptValidationStatus {
  if ((concepts || []).some((c) => c.validationStatus === "pending")) return "pending";
  if ((concepts || []).some((c) => c.validationStatus === "resolved")) return "resolved";
  return "unasked";
}

function isConflictNode(graphNode: any): boolean {
  const key = String(graphNode?.key || "").toLowerCase();
  const statement = String(graphNode?.statement || "").toLowerCase();
  return key.startsWith("slot:conflict:") || /^冲突提示[:：]/.test(statement) || /^conflict warning[:：]/.test(statement);
}

function syncGraphConflictsWithMotifs(graph: CDG, motifs: ConceptMotif[]): CDG {
  const hasUnresolvedMotifConflict = (motifs || []).some((m) => m.status === "deprecated" && !m.resolved);
  if (hasUnresolvedMotifConflict) return graph;

  const removable = new Set(
    (graph.nodes || [])
      .filter((n) => isConflictNode(n) && !n.locked)
      .map((n) => n.id)
  );
  if (!removable.size) return graph;

  const nodes = (graph.nodes || []).filter((n) => !removable.has(n.id));
  const edges = (graph.edges || []).filter((e) => !removable.has(e.from) && !removable.has(e.to));
  return {
    ...graph,
    nodes,
    edges,
  };
}

export function runMotifGenerationChain(params: {
  graph: CDG;
  prevConcepts?: any;
  baseConcepts?: any;
  baseMotifs?: any;
  baseMotifLinks?: any;
  baseContexts?: any;
  locale?: AppLocale;
}): MotifGenerationChain {
  const normalizedGraph = normalizeGraphConceptSchema(params.graph);

  // PRD pipeline:
  // 1) load+normalize -> 2) concept identify/disambiguate -> 3) dedup
  // 4) motif build/dedup -> 5) motif conflict gate -> 6) motif topology
  // 7) reasoning steps -> 8) concept projection from motif bindings.
  const nextConceptsDraftPass1 = reconcileConceptsWithGraph({
    graph: normalizedGraph,
    baseConcepts: params.baseConcepts,
  });
  const graphWithConceptStatePass1 = applyConceptStateToGraph({
    graph: normalizedGraph,
    prevConcepts: params.prevConcepts,
    nextConcepts: nextConceptsDraftPass1,
  });
  const motifsPass1 = reconcileMotifsWithGraph({
    graph: graphWithConceptStatePass1,
    concepts: nextConceptsDraftPass1,
    baseMotifs: params.baseMotifs,
    locale: params.locale,
  });

  const graphSynced = syncGraphConflictsWithMotifs(graphWithConceptStatePass1, motifsPass1);
  const graphChanged = graphSynced !== graphWithConceptStatePass1;

  const nextConceptsDraft = graphChanged
    ? reconcileConceptsWithGraph({
        graph: graphSynced,
        baseConcepts: params.baseConcepts,
      })
    : nextConceptsDraftPass1;
  const graphWithConceptState = graphChanged
    ? applyConceptStateToGraph({
        graph: graphSynced,
        prevConcepts: params.prevConcepts,
        nextConcepts: nextConceptsDraft,
      })
    : graphWithConceptStatePass1;
  const motifs = graphChanged
    ? reconcileMotifsWithGraph({
        graph: graphWithConceptState,
        concepts: nextConceptsDraft,
        baseMotifs: params.baseMotifs,
        locale: params.locale,
      })
    : motifsPass1;

  const covered = enforceCausalEdgeCoverage({
    graph: graphWithConceptState,
    concepts: nextConceptsDraft,
    motifs,
    locale: params.locale,
    maxRounds: 2,
  });
  const coveredMotifs = covered.motifs;
  const motifLinks = reconcileMotifLinks({
    motifs: coveredMotifs,
    baseLinks: params.baseMotifLinks,
  });
  const motifReasoningView = buildMotifReasoningView({
    concepts: nextConceptsDraft,
    motifs: coveredMotifs,
    motifLinks,
    locale: params.locale,
  });
  const concepts = attachMotifIdsToConcepts(nextConceptsDraft, coveredMotifs);
  const contexts = reconcileContextsWithGraph({
    graph: graphWithConceptState,
    concepts,
    motifs: coveredMotifs,
    baseContexts: params.baseContexts,
  });
  const validationStatus = deriveInteractionValidationStatus(concepts);

  return {
    graph: graphWithConceptState,
    concepts,
    validationStatus,
    motifs: coveredMotifs,
    motifLinks,
    motifReasoningView,
    motifInvariantReport: covered.report,
    contexts,
  };
}

export function buildCognitiveModel(params: {
  graph: CDG;
  prevConcepts?: any;
  baseConcepts?: any;
  baseMotifs?: any;
  baseMotifLinks?: any;
  baseContexts?: any;
  locale?: AppLocale;
}): CognitiveModel {
  const chain = runMotifGenerationChain(params);
  return {
    graph: chain.graph,
    conceptGraph: chain.graph,
    motifGraph: {
      motifs: chain.motifs,
      motifLinks: chain.motifLinks,
    },
    concepts: chain.concepts,
    validationStatus: chain.validationStatus,
    motifs: chain.motifs,
    motifLinks: chain.motifLinks,
    motifReasoningView: chain.motifReasoningView,
    motifInvariantReport: chain.motifInvariantReport,
    contexts: chain.contexts,
  };
}
