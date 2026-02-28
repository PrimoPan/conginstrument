# CogInstrument Backend Algorithms (English Spec)

Last updated: 2026-02-26

This document defines the current production algorithm for Concept–Motif–Context modeling, graph compilation, conflict control, and planning export.

## 1. Scope and Source Modules

Primary implementation files:

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/signalSanitizer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/conflictAnalyzer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotGraphCompiler.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/conceptMotifs.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifLinks.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/reasoningView.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/budgetLedger.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/patchApply.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/topology.ts`

## 2. End-to-End Runtime

For each turn:

1. Parse deterministic signals + function-call slots.
2. Sanitize and merge signals.
3. Build slot-state machine output.
4. Compile slot graph with stale-node cleanup.
5. Reconcile concepts from graph.
6. Reconcile motifs from concept graph.
7. Reconcile motif links and reasoning view.
8. Apply patch guard and topology rebalance.
9. Persist conversation, graph, concepts, motifs, contexts, travel plan state.

## 3. Concept–Motif–Context Data Semantics

## 3.1 Concept

Atomic cognitive unit:

- `belief`
- `constraint`
- `preference`
- `factual assertion`

Concept extraction pipeline is fixed to three stages:

1. **Identification** (system-automatic): detect candidate concept spans from dialogue/graph evidence.
2. **Disambiguation** (system-automatic): normalize, deduplicate, and map each candidate to exactly one of the four concept classes.
3. **Validation** (user-facing): trigger explicit confirmation only for low-confidence or conflicting candidates.

## 3.2 Motif

Reusable dependency pattern built from concepts:

- `enable` (direct/mediated causation)
- `constraint` (confounding-style restriction)
- `determine` (intervention/commitment)

## 3.3 Context

Task situation composed by motif instances and linked concept instantiations.

## 4. Budget Ledger State Machine

Budget is event-sourced and replayed; no direct scalar overwrite.

Event types:

- `budget_set`
- `budget_adjust`
- `expense_commit`
- `expense_refund`
- `expense_pending`

State variables:

$$
\text{total}_0 = \varnothing
$$

$$
\text{spent}_0 = 0
$$

$$
\text{pending}_0 = 0
$$

Replay update:

$$
\text{total}_{t+1} =
\begin{cases}
e_t.\text{amount}, & e_t=\texttt{budget\_set}\\
(\text{total}_t \text{ or } 0) + e_t.\text{amount}, & e_t=\texttt{budget\_adjust}\\
\text{total}_t, & \text{otherwise}
\end{cases}
$$

$$
\text{spent}_{t+1} =
\begin{cases}
e_t.\text{amount}, & e_t=\texttt{expense\_commit}\land \texttt{mode}=\texttt{absolute}\\
\text{spent}_t + e_t.\text{amount}, & e_t=\texttt{expense\_commit}\land \texttt{mode}=\texttt{incremental}\\
\max(\text{spent}_t - e_t.\text{amount}, 0), & e_t=\texttt{expense\_refund}\\
\text{spent}_t, & \text{otherwise}
\end{cases}
$$

$$
\text{pending}_{t+1} =
\begin{cases}
\text{pending}_t + e_t.\text{amount}, & e_t=\texttt{expense\_pending}\\
\text{pending}_t, & \text{otherwise}
\end{cases}
$$

$$
\text{remaining} =
\begin{cases}
\max(\text{total}-\text{spent}, 0), & \text{if total is defined}\\
\varnothing, & \text{otherwise}
\end{cases}
$$

Hard policy:

- Only user-confirmed spending enters `expense_commit`.
- Suggested costs stay pending until user commitment.
- FX conversion records rate snapshot as event evidence.

## 5. Duration and Destination Stability

Consensus duration:

$$
d^\* = \operatorname{WeightedMedian}
\left(
d_{\text{explicit}},
d_{\text{city-sum}},
d_{\text{max-segment}}
\right)
$$

Conflict guard:

$$
|D_{\text{canonical}}| < 2 \Rightarrow
\text{skip } \texttt{duration\_destination\_density}
$$

Destination canonicalization suppresses noise phrases (safety wording, procedural text, non-place action verbs).

## 6. Motif Reconciliation and Minimality

## 6.1 Motif Generation

Two-stage generation:

1. Pair motifs from concept edges.
2. Triad motifs from shared anchors.
3. Aggregate into pattern motifs.

Pattern signature:

$$
\sigma(m)=
\texttt{motifType}
\;|\;
\texttt{dependencyClass}
\;|\;
\texttt{sourceFamilies}
\rightarrow
\texttt{anchorFamily}
$$

## 6.2 Motif Priority

$$
P(m)=c_m+b_{\text{rel}}(m)+b_{\text{type}}(m)
$$

Where:

$$
b_{\text{rel}}=
\begin{cases}
0.03 & \text{constraint}\\
0.02 & \text{determine}\\
0.01 & \text{enable}\\
0 & \text{other}
\end{cases}
$$

$$
b_{\text{type}}=
\begin{cases}
0.015 & \text{pair}\\
0 & \text{triad}
\end{cases}
$$

## 6.3 Status Inference (5-state model)

States:

- `active`
- `uncertain`
- `deprecated`
- `disabled`
- `cancelled`

Status baseline:

$$
c_m < 0.7 \Rightarrow \texttt{uncertain}
$$

$$
\texttt{relation}=\texttt{conflicts\_with} \Rightarrow \texttt{deprecated}
$$

$$
\text{all related concepts paused} \Rightarrow \texttt{disabled}
$$

Otherwise active, unless user-resolved lock keeps prior decision.

## 6.4 Red Conflict Gate (strict)

`deprecated` is reserved for real semantic contradiction only.

For motifs \(m_i, m_j\) sharing anchor:

$$
\text{PotentialConflict}(m_i,m_j)=
\left[
\{\texttt{constraint},\texttt{determine}\}\subseteq R
\;\lor\;
\{\texttt{constraint},\texttt{enable}\}\subseteq R
\right]
$$

$$
\text{ExplicitConflict}(m_i,m_j)=
(\text{negation polarity differs})
\;\lor\;
(\text{explicit conflict lexicon hit})
$$

$$
\neg \text{ExplicitConflict} \Rightarrow
\text{loser status}=\texttt{cancelled}
$$

$$
\text{ExplicitConflict} \Rightarrow
\text{loser status}=\texttt{deprecated}
$$

## 6.5 Soft Pruning Policy

Soft reasons must never remain red:

- `redundant_with:*`
- `subsumed_by:*`
- `density_pruned:*`
- `relation_shadowed_by:*`

Mapping rule:

$$
\texttt{deprecated} \land \texttt{softReason}
\Rightarrow \texttt{cancelled}
$$

## 6.6 Active Motif Density Cap

Per anchor concept:

$$
N_{\text{active}}(a)\le 3
$$

Overflow motifs are soft-pruned and cancelled.

## 7. Motif Links and Reasoning Graph

Motif link types:

- `supports`
- `depends_on`
- `conflicts`
- `refines`

The motif reasoning canvas visualizes:

- motif internal structure (concept chain + dependency)
- motif status changes
- motif-to-motif structural propagation used by LLM reasoning

## 8. Topology Optimization (A* + Tarjan + Adaptive Control)

## 8.1 A*-style Anchor Assignment

$$
a^\*=
\arg\min_{a\in\mathcal{A}}
\left[
g(x,a)+h(x,a)
\right]
$$

Edge travel cost:

$$
\operatorname{travelCost}(e)=
b_{\text{type}(e)} + 0.35\cdot(1-c_e)
$$

$$
b_{\texttt{determine}}=1.08
$$

$$
b_{\texttt{enable}}=0.95
$$

$$
b_{\texttt{constraint}}=0.88
$$

Heuristic:

$$
h(x,a)=
\left(1-\operatorname{Jaccard}(T_x,T_a)\right)
\;+\;
\Delta_{\text{slot}}
\;+\;
\Delta_{\text{type}}
\;+\;
\Delta_{\text{risk}}
$$

## 8.2 Adaptive Control

$$
\rho=
\frac{|E|}
{|V|\cdot\log_2(|V|+1)}
$$

$$
\kappa=
\frac{|V_{\text{SCC-cycle}}|}{|V|}
$$

$$
\lambda=
\operatorname{clip}
\left(
0.38 + 0.24\tanh(\rho-1)+0.36\kappa,\;
0,\;1
\right)
$$

Runtime controls:

$$
\text{maxRootIncoming}=
\operatorname{clip}
\left(
\operatorname{round}(9-4\lambda),\;
4,\;10
\right)
$$

$$
\text{maxAStarSteps}=
\operatorname{clip}
\left(
\operatorname{round}
\left(
30+|V|\cdot(0.28+(1-\lambda)\cdot0.35)
\right),\;
20,\;96
\right)
$$

$$
\text{transitiveCutoff}=
\operatorname{clip}(0.72-0.18\lambda,\;0.48,\;0.90)
$$

## 8.3 Tarjan SCC Cycle Breaking

Cycles are detected with Tarjan SCC (excluding `conflicts_with`).

Weakest removable edge per SCC:

$$
\operatorname{keepScore}(e)=
s_{\text{type}}(e)
 + 0.9\,c_e
 + 0.65\,\overline{i}_e
 + b_{\text{touch}}
 + b_{\text{root}}
 + b_{\text{risk}}
$$

Edges with lower keep score are removed first until acyclic or iteration limit.

## 9. PDF Export Strategy

Export sections:

1. Summary
2. Executable itinerary (day-by-day)
3. Budget ledger trace
4. Key constraints
5. Evidence appendix

Deduplication:

$$
\text{drop paragraph } p_i
\iff
\operatorname{hash}(p_i)\in H_{\text{seen}}
$$

Confirmation-prompt suppression excludes repeated system clarification templates from final narrative.

## 10. Regression Requirements (must pass)

Minimum non-regression set:

1. Budget delta replay stability (e.g., \(5000+5000=10000\)).
2. Spent and remaining budgets stay ledger-consistent.
3. Single destination never triggers destination-density conflict.
4. Duplicate semantic motifs do not appear as red+green contradiction.
5. Soft-pruned motifs become `cancelled`, not `deprecated`.
6. Active motifs per anchor remain capped.

## 11. Known Next Steps

1. Stronger motif-level intervention simulation (`do(X)` probes before commitment).
2. Better motif scope control (global vs local context application).
3. Cross-domain ontology calibration for non-travel tasks.
