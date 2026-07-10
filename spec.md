# PR #100 — Pipeline chain builder + progress UI (issue #93)

## Task statement

Build the front-end for agent **pipelines** (linear chains of stages) on top of the
already-merged backend from PR #96 (`/api/pipelines`, engine, `PipelineStrip`/`PipelineHub`/
`derivePipelineLinks`) and the role registry from PR #95 (`GET /api/roles`), following the
approved Fable design attached to issue #93 (`ARCHITECTURE_READY` comment). Two surfaces:

1. **Chain builder** — a modal to author a pipeline (ordered stages, each Run or Review-loop,
   with role/params/access/prompt), reachable from board toolbar, dashboard header, and a node
   action that prefills the source transcript.
2. **Chain progress** — interactive stage strip, verdict popover, board rail with a single
   interactive hub, control hub, and a mobile chain row.

No mocks — everything wires to the real backend endpoints and existing engine types.

## Acceptance criteria

- **AC1 — Builder dialog.** `PipelineDialog` renders a modal (patterned on `FlowDialog`) with
  task, optional pinned spec, repository combobox, client templates, and inline validation that
  mirrors the API. Stage `id`/`next` are derived by the dialog so the linear-chain invariant is
  owned client-side and never shown to the user. Draft persists to
  `sessionStorage` under `llvPipelineDraft:<project>`.
- **AC2 — StageRow.** Each stage exposes a kind toggle (Review-loop **disabled on stage 1**),
  role select + typed params (reusing PR #95 role UI) with runtime autofill, a collapsed runtime
  line with `[edit]`, access radios (hidden for review-loop), and a prompt field with
  `{{task}}`/`{{prev.output}}` insert chips (`{{prev.output}}` disabled on stage 1). Keyboard
  `↑`/`↓` reorder and delete, delete disabled at the 2-stage floor.
- **AC3 — Entry points.** Builder opens from board toolbar, dashboard orchestration header, and a
  "Start pipeline from here" node action that prefills `src` from the node's transcript.
- **AC4 — PipelineStrip v2.** Stage chips implement the §3 state matrix using glyph + tone
  (never color alone): review-loop round counter, attempt-count suffix, verdict glyph, parked
  first-finding summary. Chips focus the stage conversation; the verdict glyph opens the popover.
- **AC5 — VerdictPopover.** Shows status badge, confidence bar, bounded findings (first 8 +
  `+N more`), prior-attempt audit lines, open-transcript / open-review actions, and inline
  Retry/Skip when parked.
- **AC6 — Board rail + hub.** `derivePipelineLinks` carries per-edge tone keyed off the target
  stage, marks exactly one edge (into the current stage) as the interactive hub, and badges the
  rest. `AgentLinksLayer` draws a straight chevroned rail distinct from spawn/flow links,
  animated on the active edge. `PipelineHub` v2 is a single control hub (pause/resume,
  retry/skip when parked, close).
- **AC7 — Mobile.** `MobileFocusView` shows a pipeline chain row over the focused stage pane with
  prev/next hop.
- **AC8 — i18n + a11y.** Full en + uk parity for all new `pipeline*` namespaces (plural forms for
  finding counts). Real radio groups, `role="group"` + aria labels, glyph-redundant states,
  Escape-closes-popover, disabled-with-hint affordances.
- **AC9 — Quality gates.** `bun test` green, `bunx tsc --noEmit` clean, `bun run lint` clean.
  New unit tests cover the state matrix, id/next derivation, template invariants, dialog render,
  and the agentLinks tone/hub/geometry logic.
