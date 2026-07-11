# Issue #118 — Scheme: running flow/pipeline as a visual GROUP with on-canvas stage override

## Task statement

On the scheme board, every session belonging to a running flow or pipeline
(implementer, headless reviewer rounds, run-stage children) must read as ONE
marked visual group — a distinct outline/halo/tinted region carrying the
flow/pipeline name, readable at map zoom. From that group (or the existing
PipelineHub) the operator opens on-canvas stage-override controls that steer a
running flow/pipeline WITHOUT recreating it: change the next-stage/round
model·effort·engine, edit the next-round prompt note / next-stage prompt,
extend/limit rounds, and drive retry/cancel/skip/pause/resume/close. Controls
wire to the existing `PATCH /api/flows` actions (extend, set-round-limit,
retry-round, cancel-round, pause, resume) and the pipelines API, with small
backend additions only where an action is missing. The group dissolves when the
flow/pipeline closes. Build on `src/components/scheme/agentLinks.ts`
(FlowLink/PipelineHub rails from PR #100/#93). Respect existing board placement
and PR #115 tombstone/close semantics (do NOT touch them).

## Acceptance criteria

- AC1: A running flow renders one group halo enclosing its implementer node and
  its reviewer round deck; a running pipeline renders one halo enclosing every
  materialized stage session (run-stage agent nodes; a review-loop stage's flow
  implementer + folded deck) and their placed children.
- AC2: Each group's halo is visually distinct per flow/pipeline (a stable,
  reload-deterministic hue derived from its id) and shows the flow/pipeline name.
- AC3: The group label stays readable when the board is zoomed out to the map
  (counter-scaled via `--inv-z`), and the halo still renders on the lite map.
- AC4: The halo region is inert (never intercepts clicks on the cards it frames);
  only the label chip (and its open panel) take pointer events, and the chip is
  passive on the hand tool / during a selection session / on the lite map.
- AC5: A flow embedded in a pipeline via a review-loop stage is drawn inside the
  pipeline's halo only — it does not also get its own standalone flow halo.
- AC6: A group dissolves when its flow/pipeline closes (closed entities produce
  no group). Board placement logic and PR #115 tombstone/close semantics are
  unchanged.
- AC7: The group label opens on-canvas override controls. For a flow: reconfigure
  the next reviewer engine/model/effort, edit the next-round note, extend rounds,
  set the round limit, retry-round, cancel-round, pause/resume, close. For a
  pipeline: reconfigure a not-yet-started stage's engine/model/effort/prompt,
  retry-stage, skip-stage, pause/resume, close.
- AC8: Override controls wire to existing PATCH actions; new backend additions are
  minimal and future-only — flows `set-roles` (partial reviewer/implementer role
  override that a running round does not adopt) and pipelines `override-stage`
  (edits a stage with no attempt yet; 409 once it has started; keeps the stage
  input fields consistent with `effectiveRole` and re-validates the combination
  so an invalid model is a 400, not a 500).
- AC9: Membership derivation reuses the same anchor resolution as the links, so a
  halo can never enclose a board key the layout does not draw.
- AC10: DOM regression tests cover grouping (membership, embedded-flow
  subsumption, dissolve-on-close, geometry, label/hue rendering, interactive vs
  passive chip) and the override panel (flow controls + next-unstarted-stage
  editing). Backend tests cover `set-roles` and `override-stage`. `bun test` and
  `bunx tsc --noEmit` pass.

## Non-goals / out of scope

- Group collapse when idle-approved (#112): groups dissolve on close only here.
- Conveyor/orchestrator UI reuse (#114) is a downstream consumer, not built here.
