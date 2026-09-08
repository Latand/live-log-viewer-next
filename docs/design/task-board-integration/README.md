# Task history integration checkpoint

Stage status: incomplete. This patch adds production task-history navigation and preserves a corrected board artifact. The complete production board redesign required by #1453, #1446 and #1546 remains open.

## Production change

The Scheme board toolbar opens task history. A task retains its assignments, every attempt of each explicitly linked execution, planned stages, embedded review rounds and returned findings. Missing launches and transcripts stay visible without an invented open action. Direct worker assignments can establish a relation; a shared manager or matching title cannot. Completed tasks remain inspectable. Unlinked work is scoped to the active project; explicit task references can still reach a worker in another project. Publication and merge evidence retain their own recorded state, and missing release associations are labelled.

The history list renders at most thirty records per page. The last of one thousand workers is reachable. Opening a record uses the existing native conversation navigation. Both supported locales carry the new labels.

Source ownership in this change:

- `src/components/tasks/taskWorkflowModel.ts` and its focused test.
- `src/components/tasks/TaskWorkflowPanel.tsx` and its focused DOM test.
- `src/components/scheme/SchemeBoard.tsx`: toolbar and panel integration.
- `src/lib/i18n/en.ts` and `uk.ts`: frontend labels.
- This design directory: adopted artifact and bounded browser checks.

No runtime, backend, host or deployment source is changed. Task-history projection runs only while its panel is open; camera-only updates retain the panel’s stable props.

## Recovered evidence and artifact adoption

The existing task and canonical issues were read through their current APIs. Five initial transcript queries covered board workflow, NativeSlot, revision 3, the verifier and the task. The initial name-based project filters returned no hits; unscoped results supplied the actual project key. The original critic and latest independent verifier were read through Viewer conversation_messages, including the September 8 00:49 and 00:51 messages and completed command evidence. The recovered workflow model in the adjacent design directory supplies the production projection rules. A follow-up VoiceComposerHost search found an older primary-place placeholder race; current voiceSlots already binds props to the selected place. That correction does not establish hidden delivery/view separation.

Every entry of the predecessor revision-3 manifest matched: 27 source entries and 89 evidence entries. Its manifest SHA-256 was `d52b322d49fd47894c72bd41a0d314044f1e99c1bcf7e180301bf313d75bbc5e`. Originals and old worktrees remain untouched. `artifact/ADOPTED-HASHES.json` records the selected sources at adoption, before corrections.

The adopted artifact adds an outer memoization boundary that freezes hidden NativeSlot props, excludes offscreen summaries before building their elements, and respects existing pins in aggregate placement. The independent probe counts the outer wrapper and summary functions directly. It rebuilds the retained predecessor into a separate output directory for the red comparison.

| Artifact workload | Retained predecessor | Adopted correction |
| --- | --- | --- |
| 24 conversations, 20 pans | 480 hidden wrapper entries | 0 |
| 100 conversations, 20 pans | 2,000 hidden wrapper entries | 0 |
| 1,000 conversations, 20 pans | 20,000 hidden wrapper entries | 0 |
| Offscreen rich summary, 20 pans | 20 summary calls | 0 |
| Aggregate task drag, requested 70 × 35 px | 0 × 0 px displayed movement | 70 × 35 px |

Each wrapper workload also ingests 100 messages and idles for 21 seconds. These measurements use the artifact's sample transport. They do not establish production subscription, delivery or deployment behavior. The larger artifact fixtures retain six tasks; the pure production-model tests separately exercise 1,000 workers across 250 tasks.

## Executed checks

- 44 focused tests across task projection, paginated history, existing board camera/selection and locale coverage: passed, 5,161 assertions.
- Adopted layout: 1,596 containment/collision cases and 4,240 pin cases, including aggregate task pins: passed.
- Retained-predecessor/adopted-correction browser regression: both expected outcomes reproduced; before/after screenshots inspected visually.
- Production Viewer, SchemeBoard, task panel, useLogTail and logBus: native navigation and actual polling callsites exercised at 1280, 1440 and 1920 pixels, light and dark. HTTP responses were synthetic; the runtime bus was disabled. Six cases passed with no browser errors.
- Whole-repository TypeScript produced the same 12 diagnostics on the research HEAD and this change with the same installed dependencies: missing PDF dependency/types and existing account-test/runtime-host type errors. It is not a green TypeScript gate. No diagnostics remain in the changed source or adopted artifact.
- Whole-diff privacy gate from `88e5a9508be2802266734056d6436f3168201cad`, including commit checks: passed.
- Adopted browser geometry/arrow matrix: 276 cases passed. Nine native artifact behavior groups passed, including retained draft/selection/scroll anchor and controlled original-key delivery.
- Production CSS was generated from the current source for those frames. The visual pass found a minimap overlap; the corrected panel sits below the attention control and above the minimap.

The test environment isolates HOME, XDG_CONFIG_HOME, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR and a short TMPDIR. Evidence remains outside publication surfaces or under ignored `artifact/out/` and `artifact/assets/` directories. No live lifecycle action or deployment was executed.

## Unfinished acceptance

1. The corrected graph layout and native-owner boundary are still confined to the artifact. Production SchemeBoard continues to render its existing graph. The new history panel is one integrated frontend slice.
2. Production hidden-work instrumentation and suppression are unfinished. `VoiceComposerHost` retains a composer without a card only for a live voice call; withdrawing the card slot can unmount its composer. Receipt reconciliation and dispatch effects still live in TmuxComposerCore. Applying Activity around the native card without separating those responsibilities would not prove durable delivery continuity.
3. Production full-window rendering still creates another BranchPane. The retained single-owner portal, draft/selection/anchor restoration and original-key accepted/unknown/terminal tests have artifact evidence only.
4. Production aggregate pins, dynamic group footprints, sibling separation, arrow endpoints and keyboard/Return behavior need the integrated geometry and real-component matrix. No complete-board performance claim is made here.
5. The current task schema has no general typed successor, PR or deployment association. The initial history view uses recorded task/attempt/flow relations. Complete historical associations require the automation/API owner to add revision-fenced relation evidence through #1446. Backend ownership remains external to this change.

These gaps prevent stage approval and prevent declaring the redesign ready for deployment.

## Repeatable checks

Run the named tests with the isolated environment described above:

```sh
bun test src/components/tasks/taskWorkflowModel.test.ts src/components/tasks/TaskWorkflowPanel.dom.test.tsx src/components/scheme/SchemeBoard.camera.dom.test.tsx src/components/scheme/SchemeBoard.selection.dom.test.tsx src/lib/i18n/i18n.test.ts
bun docs/design/task-board-integration/artifact/verify-layout.ts
BOARD_COUNTERS=1 bun docs/design/task-board-integration/artifact/build-renderer.mjs
node docs/design/task-board-integration/artifact/verify-residual.mjs
```

The browser harness requires BOARD_CHROME to name an installed Chromium executable. Set BOARD_ARTIFACT_ROOT to the retained predecessor and BOARD_BUILD_OUT to a separate evidence directory to build the red subject; pass that bundle through BOARD_BUNDLE with BOARD_EXPECT_RED=1. Never select an output inside the original artifact.

BOARD_PRODUCTION=1 omits the board substitution, memory-log hook and composer admission substitution. Its browser check uses the real production modules with fixture HTTP responses. Generate `artifact/assets/production.css` from `src/app/globals.css` using the repository PostCSS/Tailwind configuration before running `verify-production-history.mjs`. Runtime transport coverage remains an explicit unfinished gate.
