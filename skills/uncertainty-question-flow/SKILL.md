---
name: uncertainty-question-flow
description: Use this skill when implementing or tuning uncertainty-driven clarification questions so each turn asks one high-value targeted question instead of generic follow-ups.
---

# Uncertainty Question Flow

Use this skill to maintain cognition-centric proactive disambiguation.

## Scope

- Score graph uncertainty per node
- Select one high-impact clarification target
- Generate one short targeted question
- Avoid repeated generic questions across turns

## Target Files

- `src/services/uncertainty/questionPlanner.ts`
- `src/services/chatResponder.ts`
- `src/core/graph.ts` (if node metadata support is needed)

## Scoring Baseline

Use:

`U(v)=w1*(1-confidence)+w2*status_penalty+w3*edge_uncertainty+w4*evidence_gap+w5*layer_weight`

Where:

- disputed/proposed nodes increase uncertainty
- `conflicts_with` / low-confidence edges increase uncertainty
- missing evidence increases uncertainty
- risk/requirement layers get higher weight

## Quality Gates

1. Response contains concrete plan first.
2. Exactly one targeted clarification question at the end.
3. Question is tied to the top uncertain slot (budget/duration/destination/critical day/limiting factor).
4. Repetition guard: do not ask near-identical question from last 3-4 assistant turns.

## Regression Check

Use two-turn simulation:

1. user provides mixed constraints (duration + city segments + critical day)
2. assistant should ask one conflict-resolving question, not a broad “还有什么需求吗？”

