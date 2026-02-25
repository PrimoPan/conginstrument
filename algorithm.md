# CogInstrument Graph Construction Algorithm (Current Implementation)

Last updated: 2026-02-25

This document is the implementation-level algorithm spec for the current backend pipeline.
It reflects the actual code path from dialogue input to graph update and travel-plan export.

## 1. Source-of-Truth Files

Primary files:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/routes/conversations.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/llm.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/signalSanitizer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/budgetLedger.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/conflictAnalyzer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotGraphCompiler.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifGrounding.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/patchGuard.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/patchApply.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/common.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/topology.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`

---

## 2. End-to-End Pipeline

The live pipeline is a two-stage system:

1. Slot State Machine (semantic structuring)
2. Graph Compiler + Topology Rebalancer (graph shaping)

```
user turn
  -> assistant text generation (short context)
  -> generateGraphPatch
       -> deterministic signal extraction
       -> optional function-call slot extraction
       -> geo resolution
       -> signal sanitization
       -> budget-ledger replay (long user history)
       -> slot state machine
       -> slot graph compiler
       -> motif grounding + strict patch sanitization
  -> applyPatchWithGuards
       -> apply ops
       -> structured-node pruning
       -> singleton-slot compaction
       -> topology rebalance (A* anchor, Tarjan cycle break, transitive reduction, connectivity repair)
  -> persist graph + concepts/motifs/contexts + travelPlanState
```

---

## 3. Context Strategy (Short vs Long)

The system intentionally uses two context windows:

- Assistant response context: short recent turns (typically latest ~10 turns)
- State/graph context: long user-only history (typically 80–160 user turns)

This prevents:

- budget deltas being forgotten in later turns
- duration/destination rollback from short-window truncation

---

## 4. Signal Extraction Layer

`IntentSignals` are extracted by combining:

- deterministic parser (`intentSignals.ts`)
- optional function-call schema extraction (`slotFunctionCall.ts`)

Merge policy:

- deterministic signals remain authoritative for core scalar conflicts (duration/budget)
- function-call extraction fills missing structure and improves semantics

Then `signalSanitizer.ts` performs canonicalization and denoising:

- destination noise filtering
- sub-location parent remapping
- duration reconciliation between total and segmented evidence
- constraint confirmation normalization

---

## 5. Budget Ledger State Machine

Implemented in `budgetLedger.ts`.

### 5.1 Event Types

- `budget_set`
- `budget_adjust`
- `expense_commit`
- `expense_refund`
- `expense_pending`

### 5.2 Accounting Rules

- Only user-confirmed spending is committed.
- Unconfirmed deductions go to `expense_pending`.
- FX conversion uses snapshot rates (`CI_FX_<CUR>_TO_CNY` override supported).

### 5.3 Replay Equations

```
total := undefined
spent := 0
pending := 0

for ev in events (chronological):
  if ev.type == budget_set:
     total = ev.amount
  if ev.type == budget_adjust:
     total = (total ?? 0) + ev.amount
  if ev.type == expense_commit:
     spent = (ev.mode == absolute) ? ev.amount : spent + ev.amount
  if ev.type == expense_refund:
     spent = max(spent - ev.amount, 0)
  if ev.type == expense_pending:
     pending += ev.amount

remaining = (total is defined) ? max(total - spent, 0) : undefined
```

Ledger output overrides weak/noisy per-turn budget signals.

---

## 6. Slot State Machine (Structured Graph State)

Implemented in `slotStateMachine.ts`.

Output:

- `nodes: SlotNodeSpec[]`
- `edges: SlotEdgeSpec[]`

### 6.1 Goal Alignment

`slot:goal` is always generated.
Its statement is forced to align with the consensus total duration to avoid split titles such as “goal=6 days, duration node=3 days”.

### 6.2 Duration Consensus

Candidates:

- explicit total duration
- sum of city segments
- max segment

Consensus is weighted median + rule correction.

```
totalDays = weightedMedian(explicit_total, city_sum, max_segment)

if multi-city and travel segments exist:
   prefer city_sum when consensus underestimates

if explicit total is an outlier without explicit-total cue:
   fallback to city_sum
```

This is the main safeguard against duration explosions.

### 6.3 Budget Slot Family

Current budget slots:

- `slot:budget` (total budget)
- `slot:budget_spent` (committed spend)
- `slot:budget_pending` (pending spend)
- `slot:budget_remaining` (remaining budget)

Remaining budget node is derived as:

```
remainingByCalc   = max(totalBudget - spentBudget, 0)
remainingBySignal = normalized signal remaining
remainingBudget   = max(remainingByCalc, remainingBySignal)
```

Dependency edges:

- `budget -> budget_remaining (determine)`
- `budget_spent -> budget_remaining (determine)`
- `budget_pending -> budget_remaining (determine)`
- `budget_remaining -> goal (constraint)`

### 6.4 Unified Limiting Factors

Health/language/diet/religion/safety/legal/logistics are mapped into one normalized limiting-factor family:

- `slot:constraint:limiting:<kind>:<text>`

Hard/soft class decides edge polarity (`constraint` vs `determine`).

### 6.5 Critical Day and Sub-Location Handling

- Critical-day nodes are risk-layer hard constraints.
- If city matches a destination, critical day attaches to destination; otherwise to goal.
- Sub-locations are attached under parent destination, not promoted to top-level destinations.

---

## 7. Conflict Analyzer

Implemented in `conflictAnalyzer.ts`.

### 7.1 Destination Guard (False Positive Fix)

Before duration-density conflict checks:

- canonical destination normalization
- noise phrase filtering
- near-duplicate compaction

Conflict `duration_destination_density` is only allowed when canonical destination count is at least 2.

### 7.2 Current Conflict Rules

- budget vs luxury lodging
- destination density vs total duration
- high-intensity preference vs mobility/health limits
- too many hard constraints under short duration

Conflict nodes are emitted as `slot:conflict:*` and connected by:

- `conflict -> goal (constraint)`
- `conflict -> related_slots (conflicts_with)`

---

## 8. Slot Graph Compiler

Implemented in `slotGraphCompiler.ts`.

### 8.1 Slot Winner Election

For each slot key group:

1. status rank
2. confidence
3. importance

### 8.2 Stale/Duplicate Cleanup

- unlocked stale nodes: removed
- locked stale nodes: downgraded (`rejected`, `stale_slot`, `auto_cleaned`)
- incident edges are removed for stale duplicates

### 8.3 Slot-Target Alignment

Slots not present in the latest state machine output are aggressively cleaned to prevent historical noise leakage.

---

## 9. Motif Grounding + Patch Guard

Implemented in:

- `motifGrounding.ts`
- `patchGuard.ts`

Patch pre-application chain:

```
rawPatch
  -> enrichPatchWithMotifFoundation
  -> sanitizeGraphPatchStrict
```

Motif grounding auto-fills:

- `motifType`
- `claim`
- `priority`
- `revisionHistory`

Patch guard enforces op/type/schema safety and numeric clamps.

---

## 10. Topology Rebalancer (Graph-Theoretic Core)

Implemented in:

- `patchApply.ts`
- `core/graph/topology.ts`

Execution order after patch application:

1. prune invalid structured nodes
2. prune noisy total-duration outliers
3. compact singleton slots
4. rebalance topology

### 10.1 A* Anchor Assignment (Prominent Formula)

For non-slot nodes, anchor selection uses an A*-style objective:

```
a* = argmin_a [ g(root -> a) + h(node, a) ]
```

Where:

```
travelCost(edge) = typeBias(edge.type) + 0.35 * (1 - edge.confidence)

typeBias(determine) = 1.08
typeBias(enable)    = 0.95
typeBias(constraint)= 0.88

h(node,a) = (1 - Jaccard(tokens_node, tokens_a))
          + slotDistancePenalty
          + typePenalty
          + riskPenalty
```

Final anchor score:

```
score(a) = g(root -> a) + h(node,a)
```

### 10.2 Adaptive Topology Tuning (Prominent Formula)

```
density   = |E| / (|V| * log2(|V| + 1))
cycleRate = (#nodes in SCC cycles) / |V|

lambda = clip(0.38 + 0.24*tanh(density - 1) + 0.36*cycleRate, 0, 1)
```

Derived controls:

```
maxRootIncoming = clip(round(9 - 4*lambda), 4, 10)
maxAStarSteps   = clip(round(30 + |V|*(0.28 + (1-lambda)*0.35)), 20, 96)
transitiveCutoff= clip(0.72 - 0.18*lambda, 0.48, 0.9)
```

### 10.3 Tarjan SCC Cycle Breaking (Prominent Formula)

SCC detection uses Tarjan on structural edges (excluding `conflicts_with`).

For each cyclic SCC, remove the weakest edge by keep score:

```
keepScore(e) = typeScore(e.type)
             + 0.9 * confidence(e)
             + 0.65 * avgImportance(endpoints)
             + touchedBonus
             + toRootBonus
             + riskBonus
```

The minimum keep-score edge in each SCC is removed iteratively until acyclic or iteration cap.

### 10.4 Approximate Transitive Reduction + Connectivity Repair

An edge is removable only if:

1. an alternate path still exists from source to target,
2. source can still reach root after removal,
3. keep score is below threshold shaped by adaptive `lambda`.

Disconnected nodes are repaired by adding an inferred root edge:

```
if not Reach(node, root):
   add node -> root with inferred edge type
```

---

## 11. TravelPlan Hidden State and PDF Export

Implemented in:

- `travelPlan/state.ts`
- `travelPlan/pdf.ts`

### 11.1 Budget Source Priority

`travelPlanState.budgetSummary` prioritizes ledger replay over weak graph slots:

- `totalCny`
- `spentCny`
- `remainingCny`
- `pendingCny`

### 11.2 Narrative Cleanup

- repeated confirmation-question filtering
- paragraph-level deduplication
- normalized constraint phrasing

### 11.3 PDF Layout

Current export structure:

1. Summary
2. Overview
3. Executable itinerary
4. Budget event ledger
5. Key constraints
6. Evidence appendix

---

## 12. Runtime Controls

- `CI_GRAPH_USE_FUNCTION_SLOTS`
- `CI_GRAPH_MODEL`
- `CI_ALLOW_DELETE`
- `CI_DATE_RANGE_BOUNDARY_MODE`
- `CI_FX_<CUR>_TO_CNY`
- `CI_PDF_FONT_PATH`

Note: delete behavior is guarded in both patch-sanitization and graph-apply layers; keep environment configuration consistent in production.

---

## 13. Bugs Explicitly Covered by Current Design

1. Budget update drops (`5000 + 5000` not reflected)
2. False duration-density conflict under single canonical destination
3. Stale slot duplication polluting later rounds
4. Duration outliers (e.g., phantom 14-day totals)
5. Repetitive/noisy PDF narrative blocks

---

## 14. Recommended Next Strengthening

1. Explicit pending->commit transition with user-confirmed event IDs
2. Conflict nodes with resolution provenance (`resolvedBy=user/system`)
3. Stronger geo hierarchy cache for city/region/venue disambiguation
4. Dual export modes: concise execution sheet vs appendix-rich report

