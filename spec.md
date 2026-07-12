# Issue 23: change model, reasoning effort, and speed of a running agent

## Task statement

Allow an operator to change the model, reasoning-effort level, and Codex speed tier of a running conversation from its pane header. Apply the selection to subsequent turns through the engine-specific resume flags while preserving the active turn.

## Acceptance criteria

- AC1: A running root conversation exposes editable model and reasoning-effort controls in its pane header.
- AC2: A running Codex conversation also exposes the Fast speed toggle; Claude conversations omit that control.
- AC3: Model and effort choices are constrained to the known models and valid effort scale for the selected engine/model pair.
- AC4: A request made during a busy or uncertain turn leaves the live pane untouched, displays a pending state, and retries after the turn reaches a positively identified idle composer.
- AC5: An idle change resumes the existing conversation with the selected model and effort flags plus Codex `service_tier=priority|standard`.
- AC6: Pane termination uses registry-owned tmux host evidence, the per-session operation lock, exact process identity checks, and verified process death before resuming.
- AC7: The selected values and pending/confirmation phase survive a browser reload for the stable Viewer conversation identity.
- AC8: The control reports completion only after scanner-observed model, effort, and Codex speed match the requested values; the existing header identity and effort bars continue to use scanner evidence.
- AC9: Existing spawn-time model, effort, and speed selection remains unchanged.
- AC10: Focused tests cover per-engine validation and rendering, including the Claude speed omission.
- AC11: `bun test` passes.
- AC12: `bunx tsc --noEmit` passes.
- AC13: `git diff --check` passes.
