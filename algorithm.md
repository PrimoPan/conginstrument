# CogInstrument Graph Algorithms (Implementation Spec)

Last updated: 2026-02-26

This document describes the current backend algorithm pipeline used in production code.
It focuses on the two-stage graph engine, motif logic, budget state machine, and topology optimization.

## 1. Source-of-Truth Files

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/routes/conversations.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/llm.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/signalSanitizer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/conflictAnalyzer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotGraphCompiler.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/budgetLedger.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifGrounding.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/patchGuard.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/patchApply.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/topology.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`

## 2. End-to-End Runtime Pipeline

1. User turn arrives.
2. Assistant text is generated using short recent context.
3. Graph patch is generated from deterministic + function-call signals.
4. Slot state machine compiles canonical slot state.
5. Slot graph compiler resolves duplicates and stale nodes.
6. Motif grounding enriches semantic metadata.
7. Patch guard sanitizes operations.
8. Patch is applied with topology rebalance.
9. Graph + Concept + Motif + Context + TravelPlanState are persisted.

## 3. Context Windows

- **Short context**: for assistant response fluency (typically latest ~10 turns).
- **Long user context**: for state reconstruction (typically 80-160 user turns).

This prevents budget/duration rollbacks caused by short-window truncation.

## 4. Signal Layer

Signals are merged from:

- Deterministic parser (`intentSignals.ts`)
- Function-call slot extraction (`slotFunctionCall.ts`)

Merge policy:

- Deterministic parser is authoritative for scalar stability (budget, duration).
- Function-call extraction fills structural gaps.

Then `signalSanitizer.ts` performs:

- destination canonicalization and noise filtering
- sub-location parent remapping
- duration reconciliation between total and segmented evidence
- confirmation statement normalization

## 5. Budget Ledger State Machine

Implemented in `budgetLedger.ts`.

### 5.1 Event Types

- `budget_set`
- `budget_adjust`
- `expense_commit`
- `expense_refund`
- `expense_pending`

### 5.2 Accounting Policy

- Only **user-confirmed** spending contributes to committed cost.
- Unconfirmed deductions stay pending.
- FX conversion stores a snapshot rate per event for reproducibility.

### 5.3 Replay Equations

$$
\text{total}_0 = \varnothing,\quad
\text{spent}_0 = 0,\quad
\text{pending}_0 = 0
$$

For each event `e_t` in chronological order:

$$
\text{total}_{t+1} =
\begin{cases}
e_t.\text{amount} & \text{if } e_t.\text{type}=\texttt{budget\_set}\\
(\text{total}_t \text{ or } 0) + e_t.\text{amount} & \text{if } e_t.\text{type}=\texttt{budget\_adjust}\\
\text{total}_t & \text{otherwise}
\end{cases}
$$

$$
\text{spent}_{t+1} =
\begin{cases}
e_t.\text{amount} & \text{if } e_t.\text{type}=\texttt{expense\_commit}\land e_t.\text{mode}=\texttt{absolute}\\
\text{spent}_t + e_t.\text{amount} & \text{if } e_t.\text{type}=\texttt{expense\_commit}\land e_t.\text{mode}=\texttt{incremental}\\
\max(\text{spent}_t - e_t.\text{amount}, 0) & \text{if } e_t.\text{type}=\texttt{expense\_refund}\\
\text{spent}_t & \text{otherwise}
\end{cases}
$$

$$
\text{pending}_{t+1} =
\begin{cases}
\text{pending}_t + e_t.\text{amount} & \text{if } e_t.\text{type}=\texttt{expense\_pending}\\
\text{pending}_t & \text{otherwise}
\end{cases}
$$

$$
\text{remaining}=
\begin{cases}
\max(\text{total}-\text{spent}, 0) & \text{if total is defined}\\
\varnothing & \text{otherwise}
\end{cases}
$$

## 6. Slot State Machine

Implemented in `slotStateMachine.ts`.

Output:

- canonical slot nodes
- canonical slot edges

### 6.1 Duration Consensus

Candidates:

- explicit total duration
- city segment sum
- maximum segment duration

$$
d^\* = \operatorname{WeightedMedian}\!\left(d_{\text{explicit}}, d_{\text{city-sum}}, d_{\text{max-seg}}\right)
$$

Rule corrections:

- If multi-city travel exists and consensus underestimates coverage, prefer `d_city-sum`.
- If explicit total is an outlier without explicit-total cue, downgrade it.

### 6.2 Budget Slot Family

Current slot family:

- `slot:budget`
- `slot:budget_spent`
- `slot:budget_pending`
- `slot:budget_remaining`

$$
b_{\text{remaining}} = \max\!\left(b_{\text{total}}-b_{\text{spent}},\,0\right)
$$

If both derived and weak textual remaining signals exist:

$$
b_{\text{remaining}}^{\text{final}} = \max\!\left(b_{\text{remaining}}^{\text{calc}},\, b_{\text{remaining}}^{\text{signal}}\right)
$$

### 6.3 Unified Limiting Factors

Health/language/diet/religion/safety/legal/logistics are normalized into one constraint family:

- `slot:constraint:limiting:<kind>:<detail>`

This avoids category fragmentation and improves portability beyond travel scenarios.

## 7. Conflict Analyzer

Implemented in `conflictAnalyzer.ts`.

### 7.1 False-Positive Guard

Duration-density conflict is blocked when canonical destination count is less than 2:

$$
|D_{\text{canonical}}| < 2 \Rightarrow \text{skip duration-density conflict emission}
$$

### 7.2 Active Rules

- budget vs luxury lodging mismatch
- destination density vs total duration
- high-intensity preference vs mobility/health constraints
- hard-constraint overload under short duration

## 8. Slot Graph Compiler

Implemented in `slotGraphCompiler.ts`.

For each slot group:

1. winner election by status rank, confidence, importance
2. stale node cleanup
3. stale edge detachment
4. alignment to latest slot state

## 9. Motif Grounding + Patch Guard

Implemented in:

- `motifGrounding.ts`
- `patchGuard.ts`

Patch chain:

$$
\text{rawPatch}
\rightarrow
\text{motifFoundation}
\rightarrow
\text{strictSanitization}
\rightarrow
\text{safePatch}
$$

Auto-enriched motif fields include `motifType`, `claim`, `priority`, and `revisionHistory`.

## 10. Topology Rebalancer (Graph-Theoretic Core)

Implemented in:

- `patchApply.ts`
- `core/graph/topology.ts`

Execution order:

1. prune invalid structured nodes
2. prune noisy duration outliers
3. compact singleton slot duplicates
4. run topology rebalance

### 10.1 A*-Style Anchor Assignment

For non-slot nodes, anchor assignment minimizes travel + heuristic cost:

$$
a^\* = \arg\min_{a \in \mathcal{A}} \left[g(x,a) + h(x,a)\right]
$$

Edge travel cost:

$$
\operatorname{travelCost}(e)=b_{\text{type}(e)} + 0.35\cdot\left(1-c_e\right)
$$

With:

$$
b_{\texttt{determine}}=1.08,\quad
b_{\texttt{enable}}=0.95,\quad
b_{\texttt{constraint}}=0.88
$$

Heuristic term:

$$
h(x,a)=\left(1-\operatorname{Jaccard}(T_x,T_a)\right)+\Delta_{\text{slot}}+\Delta_{\text{type}}+\Delta_{\text{risk}}
$$

Final score:

$$
\operatorname{score}(a)=g(x,a)+h(x,a)
$$

### 10.2 Adaptive Topology Control

Graph density and cycle pressure control rebalancing aggressiveness:

$$
\rho=\frac{|E|}{|V|\cdot\log_2(|V|+1)},\qquad
\kappa=\frac{|V_{\text{SCC-cycle}}|}{|V|}
$$

$$
\lambda=\operatorname{clip}\!\left(0.38+0.24\tanh(\rho-1)+0.36\kappa,\ 0,\ 1\right)
$$

Derived runtime controls:

$$
\text{maxRootIncoming}=\operatorname{clip}\!\left(\operatorname{round}(9-4\lambda),\ 4,\ 10\right)
$$

$$
\text{maxAStarSteps}=\operatorname{clip}\!\left(\operatorname{round}\!\left(30+|V|\cdot(0.28+(1-\lambda)\cdot0.35)\right),\ 20,\ 96\right)
$$

$$
\text{transitiveCutoff}=\operatorname{clip}(0.72-0.18\lambda,\ 0.48,\ 0.9)
$$

### 10.3 Tarjan SCC Cycle Breaking

Tarjan SCC is run on structural edges (excluding `conflicts_with`).

For each cyclic SCC, the weakest edge by keep score is removed:

$$
\operatorname{keepScore}(e)=
s_{\text{type}}(e)+0.9\,c_e+0.65\,\overline{i}_e+b_{\text{touch}}+b_{\text{root}}+b_{\text{risk}}
$$

Iteration continues until acyclic or max-iteration limit.

### 10.4 Approximate Transitive Reduction + Connectivity Repair

Edge `u -> v` is removable only when:

1. alternate path `u =>* v` still exists
2. root reachability is preserved
3. keep score is below adaptive cutoff

Disconnected node repair:

$$
\neg \operatorname{Reach}(n,\text{root}) \Rightarrow \text{add inferred edge } n \to \text{root}
$$

## 11. TravelPlan State + PDF Export

Implemented in `travelPlan/state.ts` and `travelPlan/pdf.ts`.

Export structure:

1. Summary
2. Executable itinerary (day-by-day)
3. Budget ledger
4. Key constraints
5. Evidence appendix (deduplicated)

Deduplication includes:

- repeated paragraph hash removal
- repeated confirmation-question suppression

## 12. Runtime Flags

- `CI_GRAPH_USE_FUNCTION_SLOTS`
- `CI_GRAPH_MODEL`
- `CI_ALLOW_DELETE`
- `CI_DATE_RANGE_BOUNDARY_MODE`
- `CI_FX_<CUR>_TO_CNY`
- `CI_PDF_FONT_PATH`

## 13. Covered Failure Modes

1. Budget delta loss (`5000 + 5000` not reflected)
2. Single-destination false conflict (`2 destinations / 3 days`)
3. Stale slot duplication across rounds
4. Duration outlier explosions
5. Repeated/noisy export text blocks

## 14. Next Strengthening Targets

1. explicit pending-to-commit transition by event ID
2. conflict resolution provenance (`resolvedBy`, `resolvedAt`)
3. stronger geo hierarchy cache for venue-to-city grounding
4. export modes: concise executive vs appendix-rich trace
