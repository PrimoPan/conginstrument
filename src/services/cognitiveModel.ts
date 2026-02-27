import type { CDG } from "../core/graph.js";
import {
  applyConceptStateToGraph,
  reconcileConceptsWithGraph,
  type ConceptItem,
} from "./concepts.js";
import {
  attachMotifIdsToConcepts,
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
  concepts: ConceptItem[];
  motifs: ConceptMotif[];
  motifLinks: MotifLink[];
  motifReasoningView: MotifReasoningView;
  contexts: ContextItem[];
};

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

export function buildCognitiveModel(params: {
  graph: CDG;
  prevConcepts?: any;
  baseConcepts?: any;
  baseMotifs?: any;
  baseMotifLinks?: any;
  baseContexts?: any;
  locale?: AppLocale;
}): CognitiveModel {
  const nextConceptsDraftPass1 = reconcileConceptsWithGraph({
    graph: params.graph,
    baseConcepts: params.baseConcepts,
  });
  const graphWithConceptStatePass1 = applyConceptStateToGraph({
    graph: params.graph,
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

  const motifLinks = reconcileMotifLinks({
    motifs,
    baseLinks: params.baseMotifLinks,
  });
  const motifReasoningView = buildMotifReasoningView({
    concepts: nextConceptsDraft,
    motifs,
    motifLinks,
    locale: params.locale,
  });
  const concepts = attachMotifIdsToConcepts(nextConceptsDraft, motifs);
  const contexts = reconcileContextsWithGraph({
    graph: graphWithConceptState,
    concepts,
    motifs,
    baseContexts: params.baseContexts,
  });

  return {
    graph: graphWithConceptState,
    concepts,
    motifs,
    motifLinks,
    motifReasoningView,
    contexts,
  };
}
