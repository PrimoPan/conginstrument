---
name: motif-foundation
description: Use this skill when building motif-grounded graph infrastructure, including motif typing, claim grounding, revision metadata, and motif catalog extraction.
---

# Motif Foundation

Use this skill for foundational motif plumbing before advanced UI features.

## Scope

- Ensure nodes have stable motif metadata (`motifType`, `claim`, `revisionHistory`, `priority`)
- Build motif catalog for reuse/transfer analysis
- Keep implementation task-agnostic (not travel-only)

## Target Files

- `src/services/motif/types.ts`
- `src/services/motif/motifGrounding.ts`
- `src/services/motif/motifCatalog.ts`
- `src/services/graphUpdater.ts`

## Minimal Invariants

1. Every added node has motif type.
2. Every added/updated node has a concise claim.
3. Revision metadata is attached for traceability.
4. Motif catalog groups semantically equivalent claims into reusable entries.

## Review Checklist

- Motif fields survive patch sanitization.
- No coupling to specific city names or travel-only keywords.
- Catalog sorting is stable across repeated runs.

