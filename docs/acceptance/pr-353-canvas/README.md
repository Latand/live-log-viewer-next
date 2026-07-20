# #353 acceptance — real conversation nodes inside the board group + bounded, faithful preflight

This pass finishes the product surface on top of the durable graph, exactly-once
relay, and board projection already shipped in **#417** and **#439**, preserving
their runtime semantics.

## What changed

### The compact colored group IS the canvas (operator correction)

Production regressed to a useful compact `PipelineGroup` header (#451) sitting
above a large, mostly-empty white `PipelineStageGraph` panel — a **detached**
surface plus a **fixed-height slab**. This pass unifies them:

- The declared stage graph — every conversation-card shell — now mounts **inside
  the compact colored `PipelineGroup` body** (`PipelineGroupBody`), not as a
  detached halo strip. The detached `data-scheme-group-strip` is gone from
  `GroupsLayer`; the halo keeps only its framing region and title chip.
- The group body **sizes to its actual cards** (`maxHeight`, not a fixed height),
  so a short pipeline never leaves an empty white slab below its cards. Task
  anchoring, drag pins, the compact collapsed header, and history chips from #451
  are untouched.
- **Mobile**: chat stays primary. The phone keeps its compact `MobilePipelineDock`
  disclosure (collapsed to a 44px row by default); the heavy desktop graph is
  never mounted in the conversation viewport.

### Canvas is the editor (AC4 / AC6 / AC7)

- Every stage renders as a conversation-card shell (`PipelineStageGraph`, from
  #439). The **compact in-node popover** edits **role · model · effort · access ·
  stage prompt** — the access selector (run stages only; review-loop stays
  read-only, enforced by the role resolver) and an editable stage-prompt field.
  It is a compact grid, not a tall field stack, and carries the pass/fail
  **Connections** pickers so direct links and bounded repair cycles are drawn
  from the node itself. This replaces the tall nested-scroll stage form on the
  primary editor path.
- A compact **on-canvas action bar** (`data-stage-graph-actions`) adds a
  conversation node or a review cycle straight from the canvas for a draft, and
  each draft node popover carries a **Remove** control (`data-remove-stage`) — so
  nodes are created and removed directly on the canvas. Both mirror the server
  guards (draft-only; the last stage is reconfigured, never removed; a removal
  that would orphan a review-loop is withheld) via `optimisticAddStage` /
  `optimisticRemoveStage`.

### Bounded, fidelity-preserving preflight (AC1 / AC2 / AC3)

- **No duplicate Git probes** (`preflight.ts`): a short-TTL, bounded cache of
  *successful* preflights, keyed by both the request path and the canonical
  `repoDir` it resolves to. The picker warms it; creation reuses it. Only
  successes are cached, so a transient failure always re-probes.
- **Fidelity** (`classifyGitProbe`): a probe is reported `not_git` **only** when
  Git definitively says so (a non-zero exit carrying the "not a git repository"
  message). A spawn/exec failure, a **timeout**, or a transient non-zero exit
  becomes a distinct `probe_failed` that preserves the underlying stderr — a
  hiccup never masquerades as `not_git`. Git probes run under a bounded
  ~4s deadline; a killed probe surfaces as `probe_failed`, not a false verdict.

## Timing evidence (before / after)

Production baseline recorded on the reopened issue (2026-07-20): a picker
preflight `1.108s`, then a duplicate draft-creation preflight (draft POST
`1.301s`) for the same unchanged repository, plus a transient run that waited
`3.505s` and returned a false `not_git`.

`preflight-timing.ts` models a repository probe as a fixed-latency exec and
measures the probe work creation pays, before and after the cache:

```
bun docs/acceptance/pr-353-canvas/preflight-timing.ts
```

| | Git probes | wall time (120ms/probe) |
|---|---|---|
| before (picker + duplicate creation probe) | 4 | 480 ms |
| after (picker warms cache; creation reuses it) | 2 | 240 ms |

Creation pays **zero additional Git probes** — the duplicate chain the trace
measured is eliminated, so a valid draft appears without re-paying preflight.

## Frames

Two viewable, byte-stable depiction frames — `canvas-composition-desktop.svg` and
`canvas-composition-390.svg` — plus a reproducible **real-build** capture that
renders the actual shipped components and verifies the same composition.

### Real-build capture (reproducible)

`capture.tsx` renders the REAL React components — `PipelineGroupBody` (which
mounts `PipelineStageGraph`) and the phone `MobilePipelineDock` — with the app's
own production-built CSS (`.next/static/css`) and rasterizes them in headless
Chrome, gating each frame on the composition invariants before writing the PNG:

```
next build          # produces .next/static/css consumed by the capture
bun docs/acceptance/pr-353-canvas/capture.tsx
```

The gates it enforces (and that were verified on the real render):

- desktop: exactly one `data-pipeline-stage-graph` inside the `PipelineGroupBody`,
  no detached `data-scheme-group-strip`, no fixed-height slab wrapper.
- 390px: `document.documentElement.scrollWidth === innerWidth` (no document
  horizontal overflow), and NO `data-pipeline-stage-graph` in the phone frame
  (the large desktop graph is never mounted).

The raster PNGs are intentionally **not committed**: a headless-Chrome PNG is not
byte-reproducible, so it cannot carry the deterministic provenance the privacy
publication gate requires. The committed frames below are the deterministic,
GitHub-renderable depictions of what that capture produces.

### Depiction frames (committed, deterministic)

- `canvas-composition-desktop.svg` — the compact colored `PipelineGroup` container
  hosts every declared stage as its real conversation-card shell: a passed `plan`,
  the live `build`, a pending `review` placeholder, roles, statuses, and the
  directed pass/fail links (including the bounded review→build repair loop),
  followed by only the compact lifecycle controls. The body sizes to its cards —
  no empty fixed-height slab, no detached strip.
- `canvas-composition-390.svg` — the phone: the conversation is the dominant
  surface and the pipeline is the compact `MobilePipelineDock` disclosure row at
  the foot. The large desktop graph is never mounted and the document stays within
  the 390px viewport.

Every stage id, task, model, and path is fabricated — no live capture, project
name, filesystem path, account, or transcript. The SVGs are static text
(byte-stable) with no raster provenance surface.

## Behavioural reverification

The behaviour is reverified on the real surfaces by focused suites:

```
bun test src/lib/pipelines/preflight.test.ts \
         src/lib/pipelines/engine.test.ts \
         src/components/scheme/PipelineStageGraph.dom.test.tsx \
         src/components/scheme/PipelineGroupBody.dom.test.tsx \
         src/components/scheme/GroupsLayer.render.test.tsx \
         src/components/mobile/MobilePipelineDock.render.test.tsx \
         src/components/pipelines/pipelineModel.test.ts
```

- `PipelineGroupBody.dom.test.tsx` — the compact colored group body mounts exactly
  one conversation-card graph for every declared stage, emits no fixed-height slab
  wrapper and no detached strip, and carries the state's lifecycle controls plus
  the draft metadata beside its cards.
- `GroupsLayer.render.test.tsx` — the halo frames its members with a title chip
  but no detached `data-scheme-group-strip` / `data-pipeline-stage-graph`.
- `MobilePipelineDock.render.test.tsx` — the phone dock never mounts the large
  desktop graph (`data-pipeline-stage-graph` / `data-stage-graph-node`).
- `PipelineStageGraph.dom.test.tsx` — additionally, a draft node popover removes
  its node on the canvas, and the lone stage / running pipeline never expose the
  remove control.

- `preflight.test.ts` — probe fidelity (spawn/timeout/transient → `probe_failed`,
  genuine → `not_git`) and the cache (reuse on the canonical `repoDir`, failures
  never cached, opt-in only).
- `engine.test.ts` — `override-stage` flips a run stage's access, preserves it
  across a role swap, rejects `read-write` on a review-loop, and 400s a bad value.
- `PipelineStageGraph.dom.test.tsx` — the popover exposes an editable prompt and
  submits an access override; a review popover never offers read-write access;
  the draft graph adds a conversation node on the canvas; a running graph shows
  no add controls.
- `pipelineModel.test.ts` — `stageOverrideBody` sends access only when it changed
  and reassembles an edited prompt while leaving an untouched one byte-identical.

Keyboard, screen-reader (`role`/`aria` on every new control), reduced-motion
(new controls add no animation; existing `motion-reduce` transitions are
unchanged), and the 44px/`min-h-8` touch targets are preserved.
