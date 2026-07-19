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

- `stage-graph-desktop.png` — desktop stage-graph frame (1400×560).
- `stage-graph-390px.png` — the same graph framed in a 390px mobile column
  (390×760).

Both frames are **deterministic synthetic** media: abstract, privacy-safe skeletons
carrying no live capture, project name, filesystem path, account name, transcript,
or personal data. They are emitted by the approved deterministic generator and
bound by the co-located `privacy-manifest.json` (schema version 2,
classification `synthetic`, source `deterministic-generator`), which the privacy
publication gate reproduces byte-for-byte from the trusted generator.

Regenerate (identical bytes on every run) with:

```
bun run privacy:placeholders
```

The generator pins Bun 1.3.3, synthesises the PNG bytes directly (no browser, no
compiled CSS, no network), and rewrites both the frames and the schema-v2
`privacy-manifest.json` provenance.

## Behavioural reverification

The navigation behaviour itself is reverified on the actual UI surface by the
component DOM suite, which renders `PipelineStageGraph` and drives every case —
primary, retry, implementer, reviewer, path-only, and unavailable:

```
bun test src/components/scheme/PipelineStageGraph.dom.test.tsx \
         src/components/pipelines/pipelineModel.test.ts
```
