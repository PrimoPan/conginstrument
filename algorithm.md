# CogInstrument Algorithm (AGENTS Strict Alignment v2)

Last updated: 2026-03-05

This document describes the implemented runtime and invariants for:

- concepts -> motifs -> motif links -> reasoning
- planning state and portfolio export
- frontend save and visualization behavior

## 1. Runtime Chain (Per Turn)

Canonical entrypoint:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/cognitiveModel.ts`

Processing order:

1. Normalize graph schema and concept node state.
2. Reconcile `concepts_from_user` from graph + user evidence.
3. Build pair/triad motifs from typed dependencies.
4. Enforce motif coverage invariant on reasoning-eligible edges only.
5. Reconcile motif links.
6. Build motif reasoning view.
7. Reconcile contexts.
8. Update planning states (`travel_plan_state`, `task_detection`, `cognitive_state`, `portfolio_document_state`).
9. Apply conflict gate if unresolved hard conflicts exist.

Coverage convergence is bounded (`maxRounds=2`) to avoid repair loops.

## 2. Three-Layer Boundary Contract

### 2.1 User-grounded cognitive layer

Contains only user-grounded structures:

- concepts extracted from user messages (or explicit user confirmation)
- typed dependencies among these concepts
- motif instances built from these dependencies

Assistant suggestions are not written directly into this layer.

### 2.2 Assistant planning layer

Contains assistant/co-authored planning artifacts in `travel_plan_state`:

- itinerary drafts and options
- transport/stay/food/risk/budget notes
- open questions
- export-ready text

`source_map` default is `assistant_proposed`.
Only explicit user confirmation upgrades items to `user_confirmed`.

### 2.3 Portfolio/PDF layer

Contains multi-task aggregation (`portfolio_document_state`):

- per-task trip sections
- merged export order and outline
- combined export-ready text and metadata

Final export uses portfolio sections (single-trip remains compatible).

## 3. Concepts -> Motifs -> Links -> Reasoning

### 3.1 Concept extraction

Concepts remain typed and user-evidence-bounded:

- `belief`
- `constraint`
- `preference`
- `factual_assertion`

When evidence is uncertain, concepts stay uncertain or become clarification targets instead of forced user-grounded facts.

### 3.2 Motif generation

Motifs are reconciled from graph dependencies and compression rules:

- pair motifs from direct typed dependencies
- triad motifs from compositional structures
- redundancy pruning / chain compression / conflict semantics

User edits are preserved through overlay logic.

### 3.3 Reasoning-eligible coverage invariant

Coverage is NOT enforced on all causal edges.
It is enforced only on reasoning-eligible edges.

Covered relations:

- `enable`
- `constraint`
- `determine`

#### Eligibility pipeline

Implemented in:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/conceptMotifs.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/relationValidator.ts`

For each edge candidate:

1. Hard skip rules remove metadata-only/non-reasoning pairs (for example destination/sub-location to duration bookkeeping patterns).
2. Deterministic score is computed:
   - family compatibility
   - grounding strength
   - lexical entailment
   - topology support
3. If score is in boundary zone, validator performs secondary decision (`validateBoundaryReasoningEdge`).
4. Only accepted edges enter required coverage set.

#### Edge-level coverage condition

For required edge `(u -> v, type)`, coverage holds iff at least one non-cancelled motif has:

- same relation class `type`
- `u` in source role
- `v` in target role

Uncovered required edges trigger deterministic `edge_repair` motifs.

#### Invariant report

`motifInvariantReport` now includes:

- `requiredCausalEdges`
- `coveredCausalEdges`
- `uncoveredCausalEdges`
- `repairedMotifCount`
- `componentCount`
- `excludedNonReasoningEdges`
- `excludedByReason`
- `llmValidatedEdges`
- `llmRejectedEdges`

`ConceptMotif` metadata includes:

- `coverage_origin` (`native` | `edge_repair`)
- `subgraph_verified`
- `reasoning_eligible`
- `coverage_skip_reason`

### 3.4 Travel strategy subtree linking (multi-family)

Implemented in:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`

When limiting factors exist, strategy nodes are linked as directed subtrees by semantic family:

- `health -> activity/diet/lodging` (medical constraints driving execution strategy)
- `mobility -> activity/lodging` (low-hassle, low-fatigue, senior-friendly execution)
- `safety -> lodging/strategy constraints` (safer area/night-risk mitigation)
- `language -> logistics/lodging` (communication barriers driving transport simplicity)
- `logistics -> lodging/pace` (transfer complexity constraining itinerary execution)
- `religion/diet/legal -> corresponding operational constraints`

Direction is fixed from limiting factor root to strategy targets.
Forest is allowed: each family can form its own subtree component.

### 3.5 Function-call assisted graph accuracy

Function-call slot extraction is used to improve graph precision before state-machine linking:

- constraints now support semantic `kind` hints (`legal/safety/mobility/logistics/diet/religion/other`)
- prompts explicitly instruct extraction of subtree-critical patterns:
  - low-hassle / not-too-tiring / senior-friendly
  - safer lodging area / avoid scams
  - near-metro / transfer-light transport convenience
- deterministic parser remains primary; function-call output fills semantic gaps.

## 4. Forest Semantics and Stable Layout

Motif graph is allowed to be a forest (multi-component DAG, no single root required).

Frontend layout:

- component decomposition
- SCC compression + layered order inside component
- component packing grid
- stable node position cache by `motifId` to prevent full reflow on hide/show

Implemented in:

- `/Users/primopan/UISTcoginstrument/app/conginstrument-web/src/components/flow/MotifReasoningCanvas.tsx`

## 5. Save Interaction Rules (Frontend)

### 5.1 Plan state panel

- default collapsed
- collapsed state must not consume composer area

### 5.2 Auto-save before send

If graph edits are unsaved and user sends a new turn:

1. run silent save first (`saveReason=auto_before_turn`, `requestAdvice=false`)
2. continue turn only on save success
3. block send on save failure

### 5.3 Virtual structure message policy

- manual save: append frontend-only user message `已更改coginstrument结构`
- auto-before-turn save: do NOT append this message

Implemented in:

- `/Users/primopan/UISTcoginstrument/app/conginstrument-web/src/App.tsx`
- `/Users/primopan/UISTcoginstrument/app/conginstrument-web/src/components/FlowPanel.tsx`

## 6. Task and Portfolio State

- task switch creates a new task track and new portfolio trip section
- previous trip sections are preserved (no overwrite)
- final PDF export uses portfolio aggregation by trip sections

## 7. Conflict Gate

Unresolved hard conflicts block normal advice generation until clarified/resolved.

## 8. Regression Baseline

Backend:

- `npm run test:motif-pipeline`
- `npm run test:prd-realignment`
- `npm run test:motif-compression`
- `npm run test:graph-regression`

Frontend:

- `npm run build`

Acceptance focus:

- non-reasoning edges (example metadata destination/duration bindings) are excluded from repair
- health subtree remains stable across turns
- motif hide/show does not wipe reasoning forest
- collapsed plan panel does not push chat input area
