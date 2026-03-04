# CogInstrument Backend Algorithms (Aligned Spec)

Last updated: 2026-03-04

This document describes the live backend algorithm after strict AGENTS alignment. It is implementation-oriented and only documents behaviors currently implemented in the backend.

## 1. Scope and Source Modules

Primary implementation modules:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/cognitiveModel.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/concepts.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/conceptMotifs.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifLinks.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/reasoningView.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/contexts.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/planningState.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/routes/conversations.ts`

## 2. Runtime Chain (Turn-Level)

For each user turn, the runtime flow is:

1. Update/normalize graph snapshot and apply guarded patch operations.
2. Run cognitive chain in fixed order:
   - `concepts`
   - `motifs`
   - `motif links`
   - `reasoning view`
   - `contexts`
3. Gate unresolved hard motif conflicts (`deprecated` + unresolved) before normal generation.
4. Build/update `travel_plan_state` from graph + turns + current model.
5. Build/update planning-layer states:
   - `task_detection`
   - `cognitive_state`
   - `portfolio_document_state`
6. Persist all states in conversation record and stream/return payload.

The canonical cognitive pipeline entrypoint is `runMotifGenerationChain(...)` in `cognitiveModel.ts`.

## 3. Three-Layer Boundary Contract

### 3.1 User-Grounded Cognitive Layer

Contains only user-grounded evidence:

- Concepts extracted from user evidence.
- Typed dependencies among those concepts.
- Motif instances built on those dependencies.

Assistant proposal content must not be written directly as user-grounded concept evidence.

### 3.2 Assistant Planning Layer

Contains assistant-generated and co-authored planning content:

- Itinerary drafts
- Alternatives
- Risk notes
- Transport/stay/food proposals
- Versioned plan text

All plan text is maintained in `travel_plan_state` continuously, not only at export time.

### 3.3 Portfolio/PDF Layer

Contains cross-task aggregation:

- Multi-trip sections (`trips`)
- Export order and combined outline
- Combined export text

Final PDF is generated from `portfolio_document_state` (single-trip is a degenerate case).

## 4. Concept Model

Concepts remain atomic and typed:

- `belief`
- `constraint`
- `preference`
- `factual_assertion`

Concept extraction and normalization remain deterministic over graph evidence with strict schema adapters. Planning-layer suggestion text is not auto-promoted to concept evidence.

## 5. Motif Generation and Semantics

## 5.1 Chain Order

Motif generation always follows:

1. Build pair motifs from typed graph edges.
2. Build triad motifs from shared anchors.
3. Aggregate to reusable pattern motifs.
4. Apply status inference and conflict/redundancy gates.
5. Enrich motif with causal + reusable schema metadata.

## 5.2 Typed Dependency Classes

Only three dependency classes are used for reusable cognitive dependency:

- `enable`
- `constraint`
- `determine`

`conflicts_with` is treated as conflict relation, not reusable planning dependency.

## 5.3 Motif Pattern vs Instance

The data model explicitly separates:

- Pattern fields: `motif_type_id`, `motif_type_title`, `motif_type_dependency`, role schema, reusable description.
- Instance fields: `motif_instance_id`, `motif_instance_status`, bound concepts, context, evidence, rationale.

## 5.4 Status Model

Cognitive status set:

- `active`
- `uncertain`
- `deprecated`
- `cancelled`

Compatibility handling:

- legacy/UI `disabled` is normalized to `cancelled` in reasoning semantics.
- `deprecated` is reserved for explicit contradiction-like conflicts.
- soft pruning reasons are converted to `cancelled`.

## 5.5 Evidence Boundary in Motif Build

Assistant-only grounded concepts are excluded or downgraded in motif generation:

- assistant-only concept pairs are skipped.
- motifs with assistant-only grounding become `cancelled` with grounding reason.

## 6. Motif Link Graph and Reasoning

## 6.1 Motif Links

Canonical motif link types:

- `precedes`
- `supports`
- `conflicts_with`
- `refines`

Link reconciliation rules:

- merge auto links + user links
- preserve user link intent
- remap alias motif IDs to canonical IDs
- cap total links

## 6.2 Transitive Reduction

System-generated non-conflict links are reduced with bounded alternate-path search.

For candidate edge `(u -> v)`, remove if an alternate path exists with comparable minimum confidence and edge is not user-authored.

## 6.3 Reasoning Order with SCC Condensation

Reasoning steps are not naive topological sort only.

Algorithm:

1. Build motif DAG view (excluding invalid self edges).
2. Detect SCCs via Tarjan.
3. Condense SCCs and perform priority-aware DAG ordering.
4. Rank nodes inside SCC by influence score.

Influence score combines confidence, status, indegree/outdegree, and concept coverage.

## 7. Planning State (`travel_plan_state`)

Each task maintains a versioned `travel_plan_state` containing:

- scope/duration/travelers
- candidate options and day-by-day plan
- transport/stay/food/risk/budget notes
- open questions and rationale refs
- `source_map`
- export-ready text
- changelog

Key rules:

1. Assistant proposals enter planning layer immediately.
2. `source_map` defaults to `assistant_proposed`.
3. Only user-confirmed evidence upgrades item source to `user_confirmed`.
4. `rationale_refs` prioritizes active motif/concept references.

## 8. Task Detection and Multi-Task State

`task_detection` evaluates whether current update is:

- same-task refinement
- likely task switch

Multi-task persistence rules:

- old task segments are not overwritten.
- new task segment gets new task identity/version track.
- historical segments remain in portfolio trips.

`cognitive_state.tasks` includes current task and historical task fragments used for portfolio continuity.

## 9. Portfolio and PDF Export

`portfolio_document_state` is the export source of truth:

- `trips`: per-task sections
- `export_order`
- `combined_outline`
- `combined_export_ready_text`

PDF export behavior:

- prefer portfolio export structure
- render cover + overview + per-trip sections
- retain single-trip compatibility when only one section exists

## 10. Conflict Gate

Response generation is blocked when unresolved hard conflicts remain:

- unresolved `deprecated` motifs trigger gate payload
- users are asked to keep/cancel before plan advice generation continues

## 11. Regression Baseline

The backend must pass at least:

- `npm run test:motif-pipeline`
- `npm run test:prd-realignment`
- `npm run test:motif-compression`
- `npm run test:graph-regression`

Plus build/compat checks for planning and PDF export paths.
