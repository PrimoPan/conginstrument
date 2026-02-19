# Intent Graph Regression Skill

## Purpose

Use this skill when intent graph quality degrades in multi-turn dialogue.

Focus checks:

1. duplicate destination nodes (e.g., `巴塞罗那` vs `巴塞罗那的巴塞罗那`)
2. sub-location promoted to destination (e.g., `圣西罗` becomes city)
3. total duration conflicts with city segments
4. critical-day constraints accidentally overwriting total duration

## Workflow

1. Confirm backend compile:

```bash
cd /Users/primopan/UISTcoginstrument/app/conginstrument
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --esModuleInterop $(find src -name '*.ts' -maxdepth 5 | tr '\n' ' ')
```

2. Verify slot extraction + cleanup path:

- `slotFunctionCall.ts` (function-call slot output -> signal mapping)
- `geoResolver.ts` (MCP/OSM geo normalization + parent-city repair)
- `signalSanitizer.ts` (final dedup/canonicalization)

3. Verify graph canonicalization:

- `graphUpdater.ts` (pipeline order)
- `core/graph.ts` (`slotKeyOfNode`, singleton compaction, invalid structured-node pruning)

4. Regression scenarios (must pass):

- `去巴塞罗那5天；之前去米兰3天` -> total 8 days, two sibling destinations.
- `周日到圣西罗看球` while trip includes Milan -> `圣西罗` should be sub-location under Milan.
- update constraints (`预算10000 -> 15000`) -> old budget node downgraded/replaced.

## Output standard

When reporting results, include:

1. failing dialogue snippet
2. expected slot state
3. actual graph nodes/edges diff
4. fix location (file + function)
