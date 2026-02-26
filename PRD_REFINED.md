# CogInstrument PRD Refined (Execution-Oriented)

Last updated: 2026-02-26

This refined spec translates the latest PRD into implementation constraints for the current codebase.
It prioritizes interaction correctness, motif stability, and known bug prevention.

## 1. Product Core

CogInstrument is a cognition-centric system:

- User language is transformed into explicit cognitive structures.
- The structure is the primary working object.
- LLM outputs are conditioned by that structure, not by prompt text alone.

Target hierarchy:

1. **Concept**: atomic cognitive unit (belief / constraint / preference / factual assertion).
2. **Motif**: reusable dependency pattern among concepts.
3. **Context**: task-level situation composed by motifs + concrete concept instances.

## 2. Mandatory Interaction Loop

For each user turn:

1. Parse and normalize concept candidates.
2. Update concept set (add / merge / revise / pause / lock / delete).
3. Reconcile motif set from updated concept graph.
4. Recompute motif status and motif links (reasoning structure).
5. Decide whether proactive clarification is needed.
6. Render:
   - Concept list view
   - Motif list view
   - Concept graph canvas
   - Motif reasoning canvas
7. Use active motif structure to condition next LLM response.

## 3. Concept Layer Requirements

Concept extraction must support:

- Identification (system)
- Disambiguation (system)
- Validation / confirmation (system + user)

Each concept must support user controls:

- Lock (`locked`)
- Pause/enable (`paused`)
- Edit (title, description, confidence, importance, metadata)

Required concept semantics:

- Never treat generic safety wording as destination.
- Never promote sub-location to top-level destination unless explicit.
- Budget total, spent, pending, remaining are separate concepts.

## 4. Motif Layer Requirements

## 4.1 Dependency Types

Motif dependencies are constrained to:

- `enable` (direct / mediated causation)
- `constraint` (confounding-style restriction)
- `determine` (intervention / commitment)

`conflicts_with` is conflict annotation, not stable causal dependency.

## 4.2 Motif Status Model

Allowed statuses:

- `active`: currently used in reasoning.
- `uncertain`: low confidence, requires clarification.
- `deprecated`: true unresolved conflict.
- `disabled`: manually paused by user.
- `cancelled`: historical or superseded motif, not active conflict.

Normative rule:

- Red conflict state (`deprecated`) is **only** for unresolved semantic contradictions.
- Red must not be used for soft dedupe, density pruning, or shadowing.

## 4.3 Motif Interaction Operations

Must support both system and user updates:

- Add motif
- Revise motif internal structure (concept nodes + relation)
- Adjust scope (global / local context)
- Save motif for reuse
- Resolve conflict by keep/disable/merge

## 5. Proactive Query Policy

System should ask only when uncertainty blocks progress:

- Unresolved `deprecated` motif
- Critical ambiguity in hard constraints
- Date/budget ambiguity with execution impact

System should not repeatedly ask already-resolved confirmations.

## 6. Bug-Oriented Guardrails (from observed regressions)

## 6.1 Budget Bugs

- Budget updates must follow a ledger state machine.
- Only user-confirmed spending becomes committed cost.
- Remaining budget must be recomputed after each ledger event.
- FX conversions must keep snapshot evidence.

## 6.2 Duration / Destination Bugs

- Canonical destination count must remove noise phrases.
- Duration-density conflict is forbidden when canonical destinations < 2.
- Segment durations must not overwrite total duration unless higher-confidence.

## 6.3 Motif Red/Green Coexistence Bugs

- If two motifs are semantically equivalent, keep one active and cancel others.
- Softly removed motifs become `cancelled`, not `deprecated`.
- Active motif count is bounded per anchor to avoid motif explosion.

## 6.4 PDF Quality Bugs

- Export must be human-readable final plan, not duplicated traces.
- Remove repeated confirmation prompts and template placeholders.
- Keep appendix evidence separate from executable itinerary.

## 7. Dual-Language Contract

Chinese and English modes must be parallel implementations:

- Same feature surface
- Same state machine behavior
- Same bug guardrails
- Locale-specific prompts and labels

No cross-language fallback that silently translates one mode into the other as the primary logic.

## 8. Acceptance Criteria

A build is acceptable only if all conditions hold:

1. No false destination-density conflict in single-destination scenario.
2. Budget total/spent/remaining match ledger replay.
3. Duplicate-meaning motifs do not appear as simultaneous red/green conflicts.
4. Deprecated motifs trigger explicit resolution UI flow.
5. Motif reasoning canvas reflects motif-link updates after each turn.
6. Exported plan is readable and non-redundant.

## 9. Non-Goals (Current Phase)

- Full task-general ontology beyond travel still experimental.
- Automatic user personality profiling is out of scope.
- Full autonomous planning without user confirmation is out of scope.

---

This file is an implementation-facing refinement layer over the research PRD.
