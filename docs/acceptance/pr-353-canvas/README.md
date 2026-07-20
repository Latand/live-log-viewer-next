# #353 acceptance — main-canvas conversation-node editing + bounded, faithful preflight

This pass finishes the product surface on top of the durable graph, exactly-once
relay, and board projection already shipped in **#417** and **#439**, preserving
their runtime semantics.

## What changed

### Canvas is the editor (AC4 / AC6 / AC7)

- Every stage already renders as a conversation-card shell on the main canvas
  (`PipelineStageGraph`, from #439). This pass completes the **compact in-node
  popover** so it edits **role · model · effort · access · stage prompt** — the
  access selector (run stages only; review-loop stays read-only, enforced by the
  role resolver) and an editable stage-prompt field were the missing controls.
  The popover is a compact grid, not a tall field stack, and carries the
  pass/fail **Connections** pickers so direct links and bounded repair cycles are
  drawn from the node itself.
- A compact **on-canvas action bar** (`data-stage-graph-actions`) adds a
  conversation node or a review cycle straight from the canvas for a draft — new
  nodes splice onto the chain and their placeholder window appears immediately
  through the optimistic echo (`optimisticAddStage`). It renders only for drafts.

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

- `canvas-node-editor-desktop.svg` — desktop (1400×560): draft group with the
  on-canvas add bar, a queued `implement` card, and an open compact popover
  editing role/model/effort/access/prompt with pass/fail Connections.
- `canvas-node-editor-390px.svg` — the same in a 390px mobile column; the
  document never exceeds the viewport (`scrollWidth === innerWidth === 390`) and
  the conversation keeps the full width.

Both frames are **deterministic synthetic** vector artifacts: hand-authored SVG
with fabricated stage ids and no live capture, project name, filesystem path,
account name, transcript, or personal data. They are static text (byte-stable by
construction) and carry no raster provenance surface.

## Behavioural reverification

The behaviour is reverified on the real surfaces by focused suites:

```
bun test src/lib/pipelines/preflight.test.ts \
         src/lib/pipelines/engine.test.ts \
         src/components/scheme/PipelineStageGraph.dom.test.tsx \
         src/components/pipelines/pipelineModel.test.ts
```

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
