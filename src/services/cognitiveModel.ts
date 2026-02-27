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

export function buildCognitiveModel(params: {
  graph: CDG;
  prevConcepts?: any;
  baseConcepts?: any;
  baseMotifs?: any;
  baseMotifLinks?: any;
  baseContexts?: any;
  locale?: AppLocale;
}): CognitiveModel {
  const nextConceptsDraft = reconcileConceptsWithGraph({
    graph: params.graph,
    baseConcepts: params.baseConcepts,
  });
  const graphWithConceptState = applyConceptStateToGraph({
    graph: params.graph,
    prevConcepts: params.prevConcepts,
    nextConcepts: nextConceptsDraft,
  });
  const motifs = reconcileMotifsWithGraph({
    graph: graphWithConceptState,
    concepts: nextConceptsDraft,
    baseMotifs: params.baseMotifs,
    locale: params.locale,
  });
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
