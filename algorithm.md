# CogInstrument Algorithm (AGENTS Strict Alignment v3)

Last updated: 2026-03-06
Algorithm version: `v3`

This document is the source-of-truth for runtime behavior and invariants.

## 1. Runtime Chain (Per Turn)

Canonical entrypoint:

- `conginstrument/src/services/cognitiveModel.ts`

Pipeline stages (`algorithm_pipeline`):

1. `normalize_graph_schema`
2. `concept_probabilistic_fusion`
3. `motif_generation_and_selection`
4. `reasoning_edge_coverage`
5. `reasoning_view_projection`

Every turn response and graph-save response includes:

- `algorithm_version: "v3"`
- `algorithm_pipeline` snapshot

## 2. Three-Layer Boundary Contract

### 2.1 User-grounded cognitive layer

Contains only user-grounded cognition:

- concepts from user utterance/explicit user confirmation
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

## 3. Probabilistic Concept Fusion

Implementation:

- `conginstrument/src/services/concepts.ts`

### 3.1 Typed DFA first, freeform fallback

Semantic key normalization order:

1. typed slot DFA (`destination/duration/budget/constraint/...`)
2. fallback freeform signature (`slot:freeform:*`)

### 3.2 Posterior formula

For each semantic bucket:

`P(concept) = σ(0.34*rule + 0.24*function_call + 0.18*history_consistency + 0.14*lexical_specificity + 0.10*topology_support - penalty_assistant_only)`

Where:

- `rule`: slot + statement score baseline
- `function_call`: function-slot extraction signal
- `history_consistency`: cross-node textual consistency in bucket
- `lexical_specificity`: token informativeness and numeric specificity
- `topology_support`: local graph degree support
- `penalty_assistant_only`: down-weight if evidence only comes from assistant-side tokens

### 3.3 Posterior thresholds

- `P >= 0.72` -> `resolved`
- `0.55 <= P < 0.72` -> `pending`
- `P < 0.55` -> dropped (unless locked)

### 3.4 Alias clustering

Within same `(family, scope, polarity)`:

- merge if `Jaccard >= 0.84` OR `normalized_levenshtein >= 0.90`

Additional concept fields:

- `posterior`
- `entropy`
- `alias_group_id`
- `support_sources`

## 4. Reasoning Edge Eligibility (v3)

Implementation:

- `conginstrument/src/services/motif/conceptMotifs.ts`
- `conginstrument/src/services/motif/relationValidator.ts`

### 4.1 Edge score formula

`S_edge = 0.40*family + 0.22*grounding + 0.16*lexical + 0.12*topology + 0.10*history_agreement`

Thresholds:

- `enable >= 0.63`
- `constraint >= 0.65`
- `determine >= 0.69`

Boundary zone:

- `threshold ± 0.06` -> secondary boundary validation

### 4.2 High-impact gating + optional LLM adjudication

Boundary LLM adjudication is attempted only when all conditions hold:

- edge is in boundary zone
- edge is high-impact (top-centrality + coverage-gap weighted)
- feature flag enabled (`CI_EDGE_LLM_BOUNDARY=1`)

Default is rule-only path (`CI_EDGE_LLM_BOUNDARY=0`).

### 4.3 Coverage invariant

Coverage is enforced only for reasoning-eligible causal edges (`enable/constraint/determine`).
Uncovered required edges trigger deterministic `edge_repair` motifs.

`motifInvariantReport` now includes:

- `repairRatio`
- `boundaryChecks`
- `boundaryLlmCalls`
- `highImpactEdges`
- legacy fields (`required/covered/uncovered/repaired/...`)

## 5. Motif Set Optimization

Implementation:

- `conginstrument/src/services/motif/conceptMotifs.ts`

### 5.1 Objective

For candidate motif set `M`:

`J(M) = 0.45*Coverage + 0.22*Confidence + 0.14*Transferability - 0.11*Redundancy - 0.08*ConflictPenalty`

A greedy selector chooses active motifs by descending objective score with constraints.

### 5.2 Constraints

- max active motifs per anchor: `3`
- keep hard conflict motifs visible for conflict handling
- cancelled motifs do not participate in coverage

Additional motif fields:

- `selection_score`
- `uncertainty`
- `state_transition_reason`
- `support_count`

## 6. Lifecycle Automaton

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

All lifecycle transitions are routed through this explicit automaton.

## 7. IS2 Question Prioritization (Impact-Driven)

Implementation:

- `conginstrument/src/services/motif/questionPlanner.ts`

Impact score:

`Impact = Uncertainty * BetweennessCentrality * CoverageGapWeight * TransferRisk`

Question order remains:

1. deprecated conflict
2. transfer mismatch / revision pending
3. uncertain motif

Rate limit remains one question per turn.

## 8. Transfer Retrieval with MMR

Implementation:

- `conginstrument/src/services/motifTransfer/retrieval.ts`

Base retrieval score:

`R = 0.52*semantic_match + 0.20*structural_match + 0.18*usage_prior - 0.10*staleness_penalty`

Final top-k uses MMR (`lambda=0.72`) to reduce near-duplicate suggestions.

## 9. Feature Flags

- `CI_ALGO_V3` (deployment gate for v3 rollout)
- `CI_EDGE_LLM_BOUNDARY` (optional boundary adjudication)

Recommended rollout:

1. `CI_ALGO_V3=1`, `CI_EDGE_LLM_BOUNDARY=0`
2. staged enable `CI_EDGE_LLM_BOUNDARY=1`

## 10. Complexity (Per Turn)

Let:

- `N` = concept nodes
- `E` = edges
- `M` = motifs

Approximate bounds:

- concept derivation + posterior: `O(N + E)`
- alias clustering: `O(C^2)` per family bucket (small C after bucketing)
- motif build + dedup + selection: `O(M log M)`
- coverage eligibility scan: `O(E * k^2)` where `k` is mapped concept multiplicity (small in practice)
- MMR retrieval: `O(K^2)` for candidate top-k (k <= 4)

## 11. Regression Baseline

Backend:

- `npm run test:graph-regression`
- `npm run test:prd-realignment`
- `npm run test:motif-compression`
- `npm run test:motif-pipeline`
- `npm run test:motif-transfer-e2e`
- `npm run test:algorithm-v3`

Frontend:

- `npm run build`
- existing Playwright E2E for Mode C / End Task

Acceptance focus:

- no evidence-boundary breakage (assistant text not leaked as user-grounded concepts)
- lower repair ratio on stable tasks
- conflict gate remains functional under v3 selection
- transfer candidate list remains 2-4 and less redundant
