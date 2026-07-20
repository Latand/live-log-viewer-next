# PR #439 visual evidence — pipeline stage graph navigation repair

The stage graph resolves each attempt through a `StageNavTarget` that carries both
the stable conversation id and the transcript path recorded at launch. Navigation
precedence is strict: a conversation id resolves **only** to its current
(non-archived) generation, and an id that survives solely as an archived
predecessor yields nothing so a valid `agentPath` fallback opens instead. This
repairs two reviewed gaps — a **path-only** attempt (a launch that recorded a
transcript path but never adopted a stable id) now navigates across every surface
(primary nodes, retry stacks, review-cycle implementer/reviewer), and a migrated
attempt whose id folded into an archived predecessor opens the live transcript
rather than the predecessor. Attempts with neither id nor path stay the truly
unavailable disabled state, and the prior good graph / editable-stage behaviour is
unchanged.

## Frames

- `stage-graph-desktop.svg` — desktop stage-graph frame (1400×560).
- `stage-graph-390px.svg` — the same graph framed in a 390px mobile column
  (390×760).

Both frames are **deterministic synthetic** vector artifacts: hand-authored SVG
skeletons with fabricated stage ids and no live capture, project name, filesystem
path, account name, transcript, or personal data. They are static text files
(byte-stable by construction), so they publish without any raster provenance
manifest and carry no live-capture surface.

## Behavioural reverification

The navigation behaviour itself is reverified on the actual UI surface by the
component DOM suite, which renders `PipelineStageGraph` and drives every case —
primary, retry, implementer, reviewer, path-only, and unavailable:

```
bun test src/components/scheme/PipelineStageGraph.dom.test.tsx \
         src/components/pipelines/pipelineModel.test.ts
```
