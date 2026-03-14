# CogInstrument Algorithm (AGENTS Strict Alignment v3)

Last updated: 2026-03-14
Algorithm version: `v3`

This document is the source-of-truth for runtime behavior, algorithm choices, and invariants.
It intentionally covers both high-level policy and the concrete classical algorithms still used in the codebase.

## 1. Runtime Chain (Per Turn)

Canonical entrypoint:

- `conginstrument/src/services/cognitiveModel.ts`

Pipeline stages (`algorithm_pipeline`):

1. `normalize_graph_schema`
2. `concept_probabilistic_fusion`
3. `motif_generation_and_selection`
4. `reasoning_edge_coverage`
5. `reasoning_view_projection`

The implementation in `cognitiveModel.ts` expands that into:

1. load graph snapshot and normalize schema
2. reconcile concepts with graph evidence
3. project concept state back to graph nodes
4. reconcile motif candidates and select active motifs
5. sync graph-level conflicts from motif state
6. rerun concept/motif reconciliation if the graph changed
7. enforce coverage over required causal edges
8. build reasoning steps and reasoning-view projection
9. project concept bindings back from motif view

Every turn response and graph-save response includes:

- `algorithm_version: "v3"`
- `algorithm_pipeline` snapshot

## 2. Three-Layer Boundary Contract

### 2.1 User-grounded cognitive layer

Contains only user-grounded cognition:

- concepts from user utterance or explicit user confirmation
- typed dependencies over those concepts
- motif instances derived from those dependencies

Assistant suggestions are not directly written into this layer.

### 2.2 Assistant planning layer

Contains assistant/co-authored planning state (`travel_plan_state`):

- itinerary drafts and alternatives
- transport/stay/food/risk/budget/open questions
- export-ready planning text

Default `source_map` is `assistant_proposed`.
Only explicit user confirmation upgrades to `user_confirmed`.

### 2.3 Portfolio/PDF layer

Contains task-level aggregation (`portfolio_document_state`):

- trip sections per task
- merged outline and combined export text
- final PDF metadata

Final export uses this layer instead of raw cognitive graph fragments.

## 3. Input Normalization and Parsing Algorithms

Implementation:

- `conginstrument/src/services/concepts.ts`
- `conginstrument/src/core/graph/common.ts`

### 3.1 Typed DFA first, freeform fallback

Semantic key normalization order:

1. typed slot DFA (`destination`, `duration`, `budget`, `constraint`, ...)
2. fallback freeform signature (`slot:freeform:*`)

The design goal is deterministic grounding first, and only then soft matching.

### 3.2 Language-aware tokenization

Several downstream algorithms reuse the same token-level view:

- English/alphanumeric tokens are segmented as word chunks with additional n-grams when useful.
- Chinese text is segmented as character chunks plus short n-grams.
- Whitespace and punctuation are normalized before scoring.

This tokenization supports:

- Jaccard similarity
- overlap scoring
- lexical specificity scoring
- transfer retrieval similarity
- topology anchor heuristics

### 3.3 Similarity and dedup primitives

The current system relies on lightweight classical text-similarity primitives rather than embeddings in the critical path:

- Jaccard set similarity
- normalized Levenshtein distance
- containment bonus (`A contains B` / `B contains A`)
- bucketed family/scope/polarity matching

These are used because they are:

- deterministic
- cheap to recompute every turn
- inspectable in regressions

## 4. Probabilistic Concept Fusion

Implementation:

- `conginstrument/src/services/concepts.ts`

### 4.1 Posterior formula

For each semantic bucket:

`P(concept) = σ(0.34*rule + 0.24*function_call + 0.18*history_consistency + 0.14*lexical_specificity + 0.10*topology_support - penalty_assistant_only)`

Where:

- `rule`: slot and statement score baseline from deterministic extraction
- `function_call`: function-slot extraction signal if a structured extractor fired
- `history_consistency`: pairwise textual consistency across evidence nodes in the bucket
- `lexical_specificity`: informativeness, numbers, concrete phrases, and lower genericity
- `topology_support`: local graph support from node degree structure
- `penalty_assistant_only`: down-weight when evidence is only assistant-side text

### 4.2 Feature computation details

`history_consistency` is computed from pairwise Jaccard agreement over normalized node statements.

`topology_support` uses average clipped local degree:

- node degree is clipped around `degree / 3`
- the bucket mean is remapped into a bounded support prior

`assistant_only_penalty` is applied before the final sigmoid, so it directly suppresses concepts that are not grounded in user evidence.

### 4.3 Posterior thresholds

- `P >= 0.72` -> `resolved`
- `0.55 <= P < 0.72` -> `pending`
- `P < 0.55` -> dropped unless locked

### 4.4 Alias clustering

Within the same `(family, scope, polarity)`:

- merge if `Jaccard >= 0.84`
- or merge if `normalized_levenshtein >= 0.90`
- some structured families allow slightly stricter thresholds

Additional concept fields:

- `posterior`
- `entropy`
- `alias_group_id`
- `support_sources`

## 5. Reasoning Edge Eligibility and Motif Construction

Implementation:

- `conginstrument/src/services/motif/conceptMotifs.ts`
- `conginstrument/src/services/motif/relationValidator.ts`

### 5.1 Edge score formula

`S_edge = 0.40*family + 0.22*grounding + 0.16*lexical + 0.12*topology + 0.10*history_agreement`

Thresholds:

- `enable >= 0.63`
- `constraint >= 0.65`
- `determine >= 0.69`

Boundary zone:

- `threshold ± 0.06` -> secondary boundary validation

### 5.2 Boundary handling

Boundary LLM adjudication is attempted only when all conditions hold:

- edge is in the boundary zone
- edge is high-impact
- feature flag enabled (`CI_EDGE_LLM_BOUNDARY=1`)

Default production path remains rule-first:

- `CI_EDGE_LLM_BOUNDARY=0`

### 5.3 Coverage invariant

Coverage is enforced only for reasoning-eligible causal edges:

- `enable`
- `constraint`
- `determine`

Uncovered required edges trigger deterministic `edge_repair` motifs.

`motifInvariantReport` includes:

- `repairRatio`
- `boundaryChecks`
- `boundaryLlmCalls`
- `highImpactEdges`
- legacy fields such as `required`, `covered`, `uncovered`, `repaired`

## 6. Motif Set Optimization and Lifecycle

Implementation:

- `conginstrument/src/services/motif/conceptMotifs.ts`

### 6.1 Greedy objective

For candidate motif set `M`:

`J(M) = 0.45*Coverage + 0.22*Confidence + 0.14*Transferability - 0.11*Redundancy - 0.08*ConflictPenalty`

Selection is greedy:

- compute score for each candidate motif
- sort descending
- accept while constraints remain satisfied

This is not a global ILP/DP solver; it is a deterministic greedy selector optimized for low latency and explainability.

### 6.2 Constraints

- max active motifs per anchor: `3`
- keep hard conflict motifs visible for conflict handling
- cancelled motifs do not participate in coverage

Additional motif fields:

- `selection_score`
- `uncertainty`
- `state_transition_reason`
- `support_count`

### 6.3 Lifecycle automaton

Implementation:

- `motifLifecycleTransition` in `conceptMotifs.ts`

States:

- `active`
- `uncertain`
- `deprecated`
- `cancelled`

Events:

- `evidence_up`
- `evidence_down`
- `explicit_negation`
- `conflict_resolved`
- `transfer_failure`
- `manual_disable`

All lifecycle transitions route through this explicit automaton rather than ad hoc UI-only rules.

## 7. Topology Algorithms Used in the Runtime

Implementation:

- `conginstrument/src/core/graph/topology.ts`

This file still contains several classical graph algorithms. `algorithm.md` used to only mention "topology"; this section makes those algorithms explicit again.

### 7.1 Root construction and slot winner election

Before heavy graph search, the system performs deterministic structure normalization:

- remove malformed destination/duration nodes
- choose or synthesize a single root goal node
- collapse duplicate slot competitors via a slot winner
- preserve user-touched nodes when possible

This stage is heuristic rather than algorithmically exotic, but it defines the graph that later algorithms operate on.

### 7.2 A* anchor selection for non-slot nodes

Used by:

- `chooseAnchorNodeIdAStar(...)`

Purpose:

- attach freeform or non-slot nodes to the best anchor in the existing graph
- avoid dumping every unmatched node directly onto the root

Search setup:

- start node: current root
- candidate anchors: root, slot winners, high-importance nodes, high-confidence nodes, constraint nodes
- graph: undirected adjacency over existing non-conflict edges
- edge cost: relation-type bias + confidence penalty
- heuristic: semantic penalty from lexical similarity, slot distance, type compatibility, and health/risk mismatch

Why A* here:

- we need a path-aware anchor search, not just the locally best lexical match
- the heuristic is informative enough to cut search while staying deterministic

Runtime controls:

- `maxAStarSteps` is dynamically tuned from graph size and sparsity

### 7.3 Tarjan SCC for cycle detection and cycle breaking

Used by:

- `tarjanSCC(...)`
- `breakCyclesByTarjan(...)`

Purpose:

- find strongly connected components in the directed intent graph
- identify real cycles rather than just local back-edges
- remove the weakest edge inside each cyclic component until the graph becomes acyclic enough

Edge removal policy:

- keep stronger edges by type, confidence, importance, touched-state, and risk relevance
- drop the lowest `edgeKeepScore(...)` candidate in each cyclic SCC round

Why Tarjan:

- SCC decomposition is linear in `O(V + E)`
- it cleanly handles multi-node cycles and self-loops
- it is stable and easy to regression-test

### 7.4 BFS reachability checks for transitive reduction

Used by:

- `hasDirectedPath(...)`
- `reduceTransitiveEdges(...)`

Purpose:

- prune low-value edges if another path already implies the same reachability
- keep the graph readable without disconnecting nodes from the root

Algorithmically, this is bounded breadth-first reachability:

- test whether `from -> to` still exists without the candidate edge
- test whether `from -> root` remains connected after removal

This is a practical transitive-reduction heuristic rather than a full minimal-DAG reduction.

### 7.5 Connectivity repair

Used by:

- `repairDisconnectedNodes(...)`

Purpose:

- ensure every non-root node has a directed path to the root goal
- add fallback edges for isolated nodes after pruning/cycle breaking

This step is deliberately conservative:

- it prefers graph completeness over perfect minimality
- it protects downstream motif generation from disconnected fragments

### 7.6 Adaptive topology tuning

Used by:

- `computeTopologyTuning(...)`

Inputs:

- node count
- edge count
- cycle ratio

Outputs:

- `lambdaSparsity`
- `maxRootIncoming`
- `maxAStarSteps`
- `transitiveCutoff`

This is a lightweight adaptive controller: denser or more cyclic graphs get more aggressive sparsification and more conservative root fan-in.

## 8. Reasoning-View Projection Algorithms

Implementation:

- `conginstrument/src/services/motif/reasoningView.ts`

### 8.1 Tarjan SCC again, now on the motif reasoning graph

The reasoning view runs a second SCC pass over motif-level nodes:

- `tarjanScc(...)`

This time the goal is not cycle breaking in the concept graph. The goal is to:

- condense cyclic motif regions
- derive a stable component-level ordering
- avoid unstable step order when motifs mutually reference one another

### 8.2 Kahn-style ordering over the condensed DAG

After SCC condensation, the view orders components by:

- indegree-zero queue expansion
- descending component priority

This is effectively a priority-biased topological ordering over the condensed DAG.

### 8.3 Influence scoring

Reasoning-step order is further biased by a node influence score built from:

- confidence
- status
- local topology (`indeg`, `outdeg`)
- number of bound concepts

The result is a stable reasoning walkthrough rather than a raw database order.

## 9. Clarification Question Planning

Implementation:

- `conginstrument/src/services/motif/questionPlanner.ts`

### 9.1 Impact-driven prioritization

Impact score:

`Impact = Uncertainty * BetweennessCentrality * CoverageGapWeight * TransferRisk`

In code, this is approximated with motif-centrality overlap and task-transfer risk rather than a full all-pairs centrality computation.

Priority order remains:

1. deprecated conflict
2. transfer mismatch / revision pending
3. uncertain motif

Rate limit remains one question per turn.

### 9.2 Template selection

Question templates are selected by dependency/operator shape:

- direct confirmation
- counterfactual probe
- mediation check

This is a rule-based strategy layer, not a generative planner.

## 10. Transfer Retrieval with MMR

Implementation:

- `conginstrument/src/services/motifTransfer/retrieval.ts`

Base retrieval score:

`R = 0.52*semantic_match + 0.20*structural_match + 0.18*usage_prior - 0.10*staleness_penalty`

Final top-k uses Maximum Marginal Relevance:

- `MMR = lambda * relevance - (1 - lambda) * redundancy`
- current `lambda = 0.72`

Purpose:

- keep transfer suggestions relevant
- reduce near-duplicate motif recommendations
- keep candidate count compact and inspectable

## 11. Classical Algorithms Currently Present

As of `v3`, the implementation still explicitly uses:

- DFA-style typed slot parsing
- Jaccard similarity
- normalized Levenshtein distance
- A* search
- Tarjan SCC
- BFS reachability
- greedy selection
- Kahn-style topological ordering
- MMR retrieval
- finite-state lifecycle automaton

So if you do not see `A*` or `Tarjan` named in a shorter summary, that does not mean they were removed; it usually means the document is focusing on stage-level behavior instead of implementation details.

## 12. Feature Flags

- `CI_ALGO_V3` (deployment gate for v3 rollout)
- `CI_EDGE_LLM_BOUNDARY` (optional boundary adjudication)

Recommended rollout:

1. `CI_ALGO_V3=1`, `CI_EDGE_LLM_BOUNDARY=0`
2. staged enable `CI_EDGE_LLM_BOUNDARY=1`

## 13. Complexity (Per Turn)

Let:

- `N` = concept nodes
- `E` = edges
- `M` = motifs
- `K` = transfer candidates after coarse filtering

Approximate bounds:

- concept derivation + posterior: `O(N + E)`
- alias clustering: `O(C^2)` per family bucket, with small `C` after bucketing
- motif build + dedup + greedy selection: `O(M log M)`
- Tarjan SCC on the graph: `O(N + E)`
- bounded A* anchor search: `O(E log E)` in practice because the open set is small and step-limited
- BFS reachability checks for transitive pruning: `O(E)` per tested edge with bounded depth
- MMR retrieval: `O(K^2)` for the top-k candidate set

The design principle is not "theoretically optimal global reasoning"; it is:

- deterministic enough for regressions
- expressive enough for cognitive structure
- cheap enough to run every turn

## 14. Regression Baseline

Backend:

- `npm run test:graph-regression`
- `npm run test:prd-realignment`
- `npm run test:motif-compression`
- `npm run test:motif-pipeline`
- `npm run test:motif-transfer-e2e`
- `npm run test:algorithm-v3`
- `npm run test:long-term-scenario`
- `npm run test:long-term-chinese-visual`
- `npm run test:long-term-mock-dialogue`

Frontend:

- `npm run build`
- existing Playwright E2E for Mode C / End Task

Acceptance focus:

- no evidence-boundary breakage: assistant text must not leak into user-grounded concepts
- lower repair ratio on stable tasks
- conflict gate remains functional under v3 selection
- transfer candidate list remains compact and less redundant
- long-term task switching does not leak prior-task state into the current task
