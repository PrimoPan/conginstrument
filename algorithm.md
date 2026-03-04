# CogInstrument Algorithm (Strict AGENTS Alignment)

Last updated: 2026-03-04

This document describes the current implemented algorithm across backend and frontend for cognitive graphing, motif generation, planning state maintenance, and export.

## 1. Runtime Chain (Per Turn)

Backend turn processing is executed in a fixed chain:

1. Normalize graph snapshot and apply guarded graph patching.
2. Reconcile `concepts_from_user` from graph evidence.
3. Reconcile motif instances from concept dependencies.
4. Enforce motif coverage invariant over causal edges.
5. Reconcile motif links.
6. Build motif reasoning view.
7. Reconcile task contexts.
8. Update planning states (`travel_plan_state`, `task_detection`, `cognitive_state`, `portfolio_document_state`).
9. Apply conflict gate when unresolved hard conflicts exist.
10. Return payload for UI and persistence.

Canonical chain entrypoint:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/cognitiveModel.ts`

## 2. Three-Layer Boundary Contract

### 2.1 User-grounded cognitive layer

Contains only user-grounded evidence structures:

- `concepts_from_user`
- typed causal dependencies
- motif instances built from those dependencies

Assistant proposals are not directly written as user-grounded concepts.

### 2.2 Assistant planning layer

Contains assistant/co-authored plan artifacts:

- itinerary drafts
- transport/stay/food options
- risk and budget notes
- open questions
- export-ready plan text

These are maintained continuously in `travel_plan_state`, not only at PDF export time.

### 2.3 Portfolio/PDF layer

Contains multi-task aggregation for one user:

- trip sections (`trips`)
- export order and combined outline
- combined export-ready text and metadata

Final export is generated from `portfolio_document_state`.

## 3. Concept -> Motif -> Links -> Reasoning

### 3.1 Concepts

Concept extraction remains user-evidence-grounded and typed:

- `belief`
- `constraint`
- `preference`
- `factual_assertion`

### 3.2 Motif generation

Motifs are built from typed graph edges and triad composition:

- pair motifs from direct typed dependencies
- triad motifs from shared anchors and compositional structure
- pattern aggregation and status inference

Supported reusable dependency classes are:

- `enable`
- `constraint`
- `determine`

`conflicts_with` is conflict semantics and not treated as reusable dependency class.

### 3.3 Causal coverage invariant (hard rule)

After motif generation, the system enforces exact edge-level coverage for all causal edges:

- required edges: all graph edges with type in `{enable, constraint, determine}`
- edge `(u -> v, type)` is covered iff at least one motif has:
  - same dependency class `type`
  - `u` mapped in motif source role
  - `v` mapped in motif target role

If uncovered edges exist, the system auto-repairs by generating deterministic `edge_repair` motifs.

Convergence rule:

- max 2 rounds in chain integration (bounded repair)

Motif-level invariant metadata:

- `coverage_origin`: `native` | `edge_repair`
- `subgraph_verified`: boolean

Payload report:

- `motifInvariantReport.requiredCausalEdges`
- `motifInvariantReport.coveredCausalEdges`
- `motifInvariantReport.uncoveredCausalEdges`
- `motifInvariantReport.repairedMotifCount`
- `motifInvariantReport.componentCount`

### 3.4 Motif links

Link graph is reconciled with canonical link types:

- `precedes`
- `supports`
- `conflicts_with`
- `refines`

System performs bounded transitive reduction for non-user redundant edges.

### 3.5 Reasoning view

Reasoning view is produced from motifs + links and rendered as a motif forest.

- SCC condensation + topological ordering inside connected components
- component packing for multi-component forest
- stable deterministic ordering to reduce visual jitter

## 4. Forest Semantics and Layout

### 4.1 Concept graph

Concept canvas supports forest topology (multi-component DAG allowed):

- no single-root requirement
- connected-component decomposition
- per-component semantic layering
- component grid packing with stable order

### 4.2 Motif graph

Motif reasoning canvas supports motif forest:

- no single-root requirement
- component-local layered layout
- global packing with consistent whitespace
- edge routing tuned for readability

## 5. Planning State Update Algorithm

`travel_plan_state` is updated every relevant turn with versioned changelog:

- destination scope
- dates/duration
- travelers
- itinerary and options
- transport/stay/food/risk/budget notes
- open questions
- rationale references to active concepts/motifs
- source map labels

Source map rule:

- default: `assistant_proposed`
- only user confirmation upgrades to `user_confirmed`

## 6. Task/Portfolio State Machine

`task_detection` decides same-task refinement vs task switch.

On new task detection:

1. Previous task plan snapshot remains in portfolio trips.
2. New task state track is created.
3. Current task pointer is switched.
4. Existing trip sections are preserved (no overwrite).

`cognitive_state.tasks` keeps current and historical task fragments.

## 7. Save Interaction Rules (Frontend)

### 7.1 Default collapsed plan state panel

Plan state UI is collapsed by default.

### 7.2 Auto-save before send

If concept/motif graph has unsaved edits and user sends a new message:

1. frontend performs silent graph save first (`requestAdvice=false`, `saveReason=auto_before_turn`)
2. only on save success does the turn submission continue
3. on save failure, send is blocked and error is surfaced

### 7.3 Virtual structure message

After successful manual save or auto-before-turn save, frontend appends a virtual user message:

- `已更改coginstrument结构`

This message is frontend-only and not persisted as backend turn text.

### 7.4 Reasoning steps panel behavior

Reasoning steps panel:

- default expanded
- no idle auto-collapse
- manual collapse/expand only

## 8. Conflict Gate

When unresolved hard conflicts remain (typically unresolved `deprecated` motifs), normal advice generation is blocked and user conflict resolution is requested first.

## 9. PDF Export Semantics

PDF export uses `portfolio_document_state` as source of truth:

- cover and overview
- per-trip sections
- unresolved/open items grouped explicitly
- single-trip remains compatible as a degenerate portfolio

Route:

- `/api/conversations/:id/travel-plan/export`

## 10. Regression Baseline

Required backend checks:

- `npm run test:motif-pipeline`
- `npm run test:prd-realignment`
- `npm run test:motif-compression`
- `npm run test:graph-regression`

Required frontend checks:

- `npm run build`

Additional expected assertions in current baseline:

- every causal edge has motif coverage after repair
- isolated concepts without causal edges are not forced into motif coverage
- multi-component causal structures yield motif forest
- destination noise guard prevents high-building phrases from becoming destinations
