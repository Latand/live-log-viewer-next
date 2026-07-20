# #353 — restore the colored pipeline halo with real conversation cards

The colored `SchemeGroup` halo is the **sole** desktop pipeline region. Every
declared stage projects into exactly one surface: the current live stage keeps a
full `BranchPane` conversation, terminal/prior stages fold into compact navigable
history (off the minimap / Fit All bounds until opened), and future stages hold
`StagePlaceholderPane` shells. A single compact header (title, progress,
lifecycle, disclosure) is attached to the halo. A live review-loop reviewer keeps
its own conversation card (the pipeline folds its flow deck out of the layout),
and pass/fail/loop edges route inside the halo between the real cards and the
placeholders. The detached `PipelineGroup` body, the duplicate stage graph, the
tall draft form, and the large white empty panel are gone.

## Evidence

`scripts/capture-pr-353-halo.ts` captures the built Viewer with production
`next start` over the disposable demo fixture home and locally cached Chromium.
The real screenshots stay in `/tmp/llv-pr353-halo` for direct visual review. The
script overlays one pipeline onto synthetic `atlas` transcripts, so the capture
contains fixture values only. The repository retains the privacy-safe SVG
composition and deterministic DOM evidence.

| Artifact | Shows |
| --- | --- |
| `halo-composition-desktop.svg` | Privacy-safe public composition of one colored halo owning its live conversation pane and future-stage placeholders. |
| `/tmp/llv-pr353-halo/halo-composition-desktop.png` | Private 1360×860 capture visually reviewed by the agent without OCR: of the five declared stages only the live `verify` stage is a full conversation pane; the passed `architect`/`builder` stages are compact history off the scene (the capture asserts their panes are absent), and `polish`/`review` are future conversation shells with prompt previews. Exactly three marked stage surfaces (`verify`, `polish`, `review`), the `3/5` header, and the handoff rails are visible; cards do not overlap. |
| `/tmp/llv-pr353-halo/halo-composition-390.png` | Private 390×820 capture visually reviewed without OCR: chat remains the primary surface, pipeline chrome stays compact above it, the composer remains visible, and the capture assertion proves `scrollWidth === innerWidth === 390`. |

To regenerate (needs the cached Chromium and a short tmux socket dir on a deep
checkout):

```
LLV_DEMO_TMUX_TMPDIR=/tmp/halo-tmux bun scripts/capture-pr-353-halo.ts
```

The composition is *also* asserted deterministically against the **shipped
components** by:

- `src/components/scheme/SchemeBoard.pipelineComposition.dom.test.tsx` — assembles
  the production scene for a five-stage running pipeline (via
  `compactPipelineArtifactPaths` + `excludeCompactPipelineArtifacts`) and asserts
  only the live `/verify` pane survives inside one `data-scheme-group="pipeline"`
  halo — the passed `/arch` and `/build` stages are compacted off the scene — plus
  the `slot::pipe-1::polish` and `slot::pipe-1::review` shells, for exactly three
  `data-pipeline-stage-card` surfaces. It also checks the absence of any detached
  body (`data-pipeline-group-body`), control card (`data-pipeline-group`), or
  duplicate graph (`data-scheme-group-strip`, `data-pipeline-stage-graph`).
- `src/components/pipelines/pipelineModel.test.ts` — `compactPipelineArtifactPaths`
  keeps only the cursor stage's live pane; every terminal stage and prior retry
  compacts, and a live reviewer keeps its transcript pane while the implementer it
  reviews compacts.
- `src/components/scheme/layout.test.ts` — the halo geometry encloses both the
  materialized node and its future-stage placeholders, and a materialized stage's
  pass edge routes a pipeline rail into the next stage's placeholder slot.
- `src/components/scheme/agentLinks.test.ts` — `derivePipelineLinks` routes
  pass/fail/loop edges into a future stage's placeholder slot, and a materialized
  review-loop reviewer resolves through its own `agentPath` card (builder→reviewer
  and reviewer→placeholder edges, one hub, reviewer a direct halo member) with the
  folded-deck and future-slot fallbacks preserved.
- `src/components/scheme/GroupsLayer.render.test.tsx` — the halo carries only its
  compact header (title, progress `k/n`, lifecycle, disclosure) and no stage graph.
- `src/components/scheme/SchemeBoard.builderReveal.dom.test.tsx` — targeting a fresh
  draft reveals its halo but never auto-opens the tall editor; configuration
  discloses only on an explicit header tap.
- `src/components/pipelines/pipelinePlaceholderStages.test.ts` — future stages with
  zero attempts become placeholders; launched stages keep a real pane or stage
  history, and terminal / zero-stage pipelines grow no future shells.
- `src/components/pipelines/StagePlaceholderPane.dom.test.tsx` — a future shell
  defaults to a transcript-style preview of the prompt the pipeline will send;
  role/model/effort/prompt controls disclose in place from its compact header.
- `src/components/mobile/MobileFocusView.viewport.dom.test.tsx` — the phone shell
  keeps the chat-first budget and the `overflow-x-clip` / `max-w-[100dvw]` root.
