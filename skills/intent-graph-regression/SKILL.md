---
name: intent-graph-regression
description: Use this skill when multi-turn intent graphs degrade, including duplicate slots, wrong city hierarchy, duration conflicts, or stale nodes not being downgraded.
---

# Intent Graph Regression

Use this skill for backend graph quality regression triage.

## Trigger Signals

- Duplicate destination/city-duration nodes appear after a few turns
- Sub-location is promoted to destination (e.g., venue becomes city)
- Total duration conflicts with city-duration segments
- Old slot value is not replaced/downgraded after user correction

## Workflow

1. Run type check for backend:

```bash
cd /Users/primopan/UISTcoginstrument/app/conginstrument
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --esModuleInterop $(find src -name '*.ts' -maxdepth 5 | tr '\n' ' ')
```

2. Verify slot extraction and sanitization:

- `src/services/graphUpdater/slotFunctionCall.ts`
- `src/services/graphUpdater/intentSignals.ts`
- `src/services/graphUpdater/signalSanitizer.ts`
- `src/services/graphUpdater/geoResolver.ts`

3. Verify compiler and graph canonicalization:

- `src/services/graphUpdater/slotStateMachine.ts`
- `src/services/graphUpdater/slotGraphCompiler.ts`
- `src/core/graph.ts`

4. Validate core scenarios:

- `去巴塞罗那5天；之前去米兰3天` => total should converge to `8天`
- Venue mention under a city should stay as `sub_location`, not destination
- Slot update (e.g., budget 10000 -> 15000) should produce winner replacement and stale-node downgrade

## Output Format

Report findings as:

1. Repro dialogue snippet
2. Expected slot state
3. Actual graph diff (nodes + edges)
4. Fix location (`file + function`)

