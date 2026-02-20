# CDG Algorithm Notes

This document summarizes the current graph-construction and graph-optimization pipeline implemented in:

- `src/core/graph.ts`
- `src/services/graphUpdater.ts`

The goal is to keep the intent graph stable, connected, sparse, and explainable across multi-turn dialogue.

## 1) Graph Definition

Let the concept dependency graph be:

$$
G=(V,E)
$$

- $V$: concept nodes (goal, constraint, preference, fact, belief, question)
- $E$: directed edges with type in \{enable, constraint, determine, conflicts\_with\}

Each node $v \in V$ has attributes:

- `confidence` $c_v \in [0,1]$
- `importance` $i_v \in [0,1]$
- optional `severity` in \{low, medium, high, critical\}

Each edge $e=(u\to v)$ has `confidence` $c_e \in [0,1]$ and edge type.

## 2) High-Level Pipeline

For each patch update, the backend runs:

1. patch sanitization + normalization
2. singleton slot compaction (deduplicate same slot nodes)
3. geo normalization (MCP bridge optional, Nominatim fallback)
4. signal sanitizer pass (destination/sub-location canonicalization + dedup + duration reconciliation)
4.5 limiting-factor unification (health/language/diet/religion/logistics -> unified `限制因素` constraint family)
4.6 conflict extraction pass (budget-duration-destination-preference-limiting-factor inconsistencies)
5. root-goal selection and root unification
6. structured skeleton edge construction (primary/secondary/limiting-factor slots)
7. A*-style anchor search for non-slot nodes
8. root fan-in control (sparsification)
9. Tarjan SCC cycle breaking
10. approximate transitive reduction
11. connectivity repair to keep all nodes connected to root

## 3) Slot Compaction (same-slot dedup)

For nodes in the same slot, winner selection is lexicographic by:

1. touched in latest patch
2. confirmed status
3. confidence
4. importance
5. numeric hint in statement (budget/day/people)
6. stable id fallback

This ensures replacement behavior like "budget 10000 -> budget 15000" keeps the newer/better slot representative.

## 4) Root Goal Selection

Among goal nodes, choose a single root by priority:

1. touched in latest patch
2. confirmed status
3. importance
4. confidence
5. shorter statement (prefer canonical concise goal)

All other goal nodes are removed and their incident edges are removed.

## 5) A*-Style Anchor Assignment

For each non-slot node $x$, choose a best anchor node $a$ (often slot node or root).

### 5.1 Objective

$$
a^*=\arg\min_{a \in \mathcal{A}} \left(g(a)+h(x,a)\right)
$$

- $g(a)$: path travel cost from root to anchor in current graph skeleton
- $h(x,a)$: semantic-slot heuristic penalty

### 5.2 Edge travel cost

$$
\text{travelCost}(e)=b_{\text{type}} + 0.35 \cdot (1-c_e)
$$

where

- $b_{\text{determine}}=1.08$
- $b_{\text{enable}}=0.95$
- $b_{\text{constraint}}=0.88$

### 5.3 Heuristic penalty

$$
h(x,a)=\left(1-\text{Jaccard}(T_x,T_a)\right)+\Delta_{\text{slot}}+\Delta_{\text{type}}+\Delta_{\text{risk}}
$$

- $T_x, T_a$: token sets from mixed CN/EN tokenization + n-grams
- $\Delta_{\text{slot}}$: slot distance penalty
- $\Delta_{\text{type}}=-0.06$ if same type else $+0.06$
- $\Delta_{\text{risk}}=0.2$ if health/risk text is attached to non-health slot

Slot distance penalty examples:

- same slot: 0
- budget-lodging / destination-scenic_preference: 0.12
- health-duration: 0.18
- unknown slot pair: 0.22
- general mismatch: 0.32

## 6) Adaptive Topology Tuning (self-balancing)

Graph sparsity parameter is automatically adapted from density + cyclicity.

### 6.1 Density and cycle ratio

$$
\rho=\frac{|E|}{|V|\log_2(|V|+1)}
$$

$$
r_{\text{cyc}}=\frac{\#\text{nodes in SCC cycles}}{|V|}
$$

### 6.2 Adaptive coefficient

$$
\lambda=\text{clip}\left(0.38 + 0.24\tanh(\rho-1) + 0.36r_{\text{cyc}},\ 0,\ 1\right)
$$

### 6.3 Derived runtime controls

$$
\text{maxRootIncoming}=\text{clip}_{[4,10]}(\text{round}(9-4\lambda))
$$

$$
\text{maxAStarSteps}=\text{clip}_{[20,96]}\left(\text{round}\left(30 + |V|\cdot(0.28 + (1-\lambda)\cdot0.35)\right)\right)
$$

$$
\text{transitiveCutoff}=\text{clip}_{[0.48,0.9]}(0.72-0.18\lambda)
$$

This is the current "auto-balance" mechanism for clutter control.

## 7) Root Fan-In Control

When root incoming edges exceed `maxRootIncoming`, optional non-primary edges are pruned by score ranking (keep high-value first), using slot priority + node importance/confidence/severity.

This prevents "starburst root" and over-connected center clutter.

## 8) Tarjan SCC Cycle Breaking

After edge construction, run Tarjan SCC on structural edges (excluding `conflicts_with`).

For each cyclic SCC, remove one weakest edge:

$$
e^*=\arg\min_{e \in SCC} S_{\text{keep}}(e)
$$

with keep score:

$$
S_{\text{keep}}(e)=w_{\text{type}} + 0.9c_e + 0.65\bar{i}_e + 0.32\mathbf{1}_{\text{touched}} + 0.26\mathbf{1}_{\text{toRoot}} + 0.32\mathbf{1}_{\text{risk}}
$$

- $w_{\text{determine}}=0.12,\ w_{\text{enable}}=0.44,\ w_{\text{constraint}}=0.92$
- $\bar{i}_e$: average endpoint importance

This process repeats until no cycle SCC remains or max rounds reached.

## 9) Approximate Transitive Reduction

For candidate edge $e=(u\to v)$, remove it if:

1. there exists alternate path $u \leadsto v$ without $e$
2. root reachability is still preserved after removing $e$
3. edge is low-value under current adaptive threshold

Formally:

$$
\exists P_{u\to v}^{\neg e}
\land
\text{Reach}_{G\setminus\{e\}}(u,\text{root})
\land
S_{\text{keep}}(e)<\tau(\lambda)
\Rightarrow
e \text{ removed}
$$

where:

$$
\tau(\lambda)=0.92+0.5(1-\lambda)
$$

Additional practical guards:

- do not remove strong root-binding non-determine edges
- do not remove edges touched in latest patch

## 10) Connectivity Repair

After reduction, for every node $v\neq root$:

$$
\neg \text{Reach}(v,root)\Rightarrow \text{add}(v\to root)
$$

Edge type is inferred by node semantics (`constraint`/`enable`/`determine`).

This enforces no isolated nodes in final DAG-like structure.

## 11) Domain Generalization Beyond Travel

Although current slots include travel-typical slots, the optimization core is domain-agnostic:

- A* anchor search depends on graph structure + token similarity, not only travel templates
- Tarjan SCC and transitive reduction are purely graph-theoretic
- adaptive $\lambda$ is data-driven by graph density/cycles

Extra generic hints are included for non-travel tasks:

- resource/cost constraints
- timeline/deadline constraints
- stakeholder/entity signals
- risk/compliance/safety signals

## 12) Complexity (current implementation)

- Tarjan SCC: $O(|V|+|E|)$
- each path existence check (BFS): $O(|V|+|E|)$
- transitive reduction loop: roughly $O(|E|(|V|+|E|))$ worst-case
- A* per node: bounded by `maxAStarSteps`

In practice, graph sizes in this project are small-to-medium, so latency remains acceptable.

## 13) Automatic Noise Slot Cleanup (new)

To prevent stale noisy slots from surviving across turns, the graph-application stage now runs automatic cleanup:

1. **Lexical invalidation** for structured nodes (`目的地`, `城市时长`)
2. **Duration outlier pruning** for inconsistent `总行程时长`

### 13.1 Lexical invalidation rule

For destination/city-duration city token $z$, remove node if:

$$
\text{Noise}(z)=1
$$

where `Noise` is triggered by:

- stopword/noise lexicon match (e.g., currency, planning verbs, discourse markers)
- malformed suffix/prefix (e.g., dangling 前/后)
- conjunction-packed pseudo-place (e.g., "A和B" as one city token)
- long narrative fragment instead of place name

### 13.2 Duration consistency + outlier rollback

Let valid city segments be $\{(c_i,d_i)\}_{i=1}^{k}$ and:

$$
S_{\text{all}}=\sum_{i=1}^{k} d_i,\quad
S_{\text{travel}}=\sum_{i\in \mathcal{T}} d_i,\quad
M=\max_i d_i
$$

Define preferred total:

$$
P=
\begin{cases}
S_{\text{all}}, & |\{c_i\}| \ge 2\\
S_{\text{travel}}, & S_{\text{travel}}>0\\
M, & \text{otherwise}
\end{cases}
$$

For current total-duration slot value $T$, detect outliers:

$$
\text{HighOutlier}(T)=\left[T>\max(P+3,\lceil1.45P\rceil)\right]
$$

$$
\text{LowOutlier}(T)=\left[T<\max(M,\lfloor0.72P\rfloor)\right]
$$

Rollback rule:

$$
(\text{HighOutlier}(T)\ \lor\ \text{LowOutlier}(T))
\Rightarrow
T \leftarrow P
$$

This directly suppresses stale inflated totals (e.g., historical `14天`) when segmented evidence indicates `7天` or `8天`.

## 14) Limiting-Factor Unification (new)

To keep graph semantics stable, hard constraints from different sources are mapped into one common node family:

- health
- language
- diet
- religion
- legal/safety/mobility/logistics/other

All are rendered as:

$$
\text{statement} = \text{"限制因素: "} + \text{text}
$$

### 14.1 Merge by normalized text

For raw constraint candidates $\mathcal{C}$, group by normalized text key $k=\text{norm}(c.\text{text})$:

$$
L_k = \{c \in \mathcal{C} \mid \text{norm}(c.\text{text}) = k\}
$$

Merged limiting-factor attributes:

$$
i_k = \max_{c \in L_k} i_c,\quad
h_k = \max_{c \in L_k} h_c
$$

where $i_c$ is importance and $h_c \in \{0,1\}$ is hard/soft indicator.

Severity merges by rank:

$$
\sigma_k = \max_{c \in L_k} \sigma_c,\quad
\text{rank}(\text{critical})>\text{rank}(\text{high})>\text{rank}(\text{medium})
$$

This gives one consistent constraint family in the graph while preserving detailed tags (`health/language/diet/religion/...`) for explanation.

## 15) Conflict-Aware Constraint Graph (new)

After slot construction, the system adds conflict nodes and `conflicts_with` edges.

Let slot set be $\mathcal{S}$ and conflict hypotheses be $\mathcal{Q}$.
For each $q\in\mathcal{Q}$, create node $v_q$ and connect:

$$
v_q \to v_{\text{goal}} \quad (\text{type}=\text{constraint})
$$

and for related slots $s\in R(q)$:

$$
v_q \to v_s \quad (\text{type}=\text{conflicts\_with})
$$

### 15.1 Conflict score template

$$
\text{score}(q)=\alpha \cdot \hat{i}_q + \beta \cdot \hat{\sigma}_q + \gamma \cdot \hat{h}_q
$$

- $\hat{i}_q$: normalized importance
- $\hat{\sigma}_q$: normalized severity rank
- $\hat{h}_q$: hard-constraint indicator

Current implementation uses rule-triggered $\text{score}(q)$ proxies for:

- budget vs luxury lodging
- destination count vs total duration density
- high-intensity preference vs mobility/health limits
- too many hard limits under short schedule

### 15.2 Example: budget-lodging inconsistency

Given total budget $B$, duration $D$, people count $P$:

$$
b_{\text{ppd}}=\frac{B}{\max(1,D)\cdot\max(1,P)}
$$

If lodging preference is luxury and $b_{\text{ppd}}<\tau$ (dynamic threshold), trigger conflict node.

This adds explicit machine-readable tension, instead of silently overwriting one slot by another.

## 16) Current Limitations

- transitive reduction is approximate (not exact minimum equivalent graph)
- heuristic weights are hand-tuned, not learned end-to-end
- slot schema is still partially travel-biased in extraction layer

These are acceptable for current interactive planning, and leave room for future learned weighting or GNN-based scoring.

## 17) Uncertainty-Driven Clarification Flow (new)

To align with proactive disambiguation in the paper, each turn now computes node-level uncertainty and asks one targeted question.

Node uncertainty score:

`U(v) = w1*(1-c_v) + w2*status(v) + w3*edgeUncertainty(v) + w4*evidenceGap(v) + w5*layerWeight(v)`

where:

- `c_v`: node confidence
- `status(v)`: proposed/disputed nodes receive positive penalty; confirmed receives slight discount
- `edgeUncertainty(v)`: boosted by low-confidence `constraint`/`conflicts_with` edges
- `evidenceGap(v)`: positive penalty when no `evidenceIds`
- `layerWeight(v)`: `risk` / `requirement` prioritized over lower-impact layers

Question selection:

`q* = argmax_{q in Q(U_top)} novelty(q, recent_turns)`

- `Q(U_top)`: template candidates generated from top uncertain slot family (duration/budget/destination/critical_day/limiting_factor)
- `novelty`: repetition guard against last 3-4 assistant turns

This avoids generic questions and pushes one high-impact clarification per turn.

## 18) Motif Foundation Layer (new)

Before strict patch sanitization, the system now grounds motif metadata on patch ops:

1. infer `motifType` if missing (`expectation/hypothesis/belief/cognitive_step`)
2. derive concise `claim` from statement if missing
3. align `priority` with `importance` when absent
4. append minimal `revisionHistory` record for traceability

Patch pipeline:

`rawPatch -> motifGrounding -> sanitizeGraphPatchStrict -> applyPatchWithGuards`

Additionally, motif catalog aggregation groups semantically equivalent nodes:

`key = motifType + ":" + normalize(claim)`

For each key:

- count
- average confidence
- average importance
- representative node id

This is the base layer for next-step motif transfer and conflict explanation panels.
