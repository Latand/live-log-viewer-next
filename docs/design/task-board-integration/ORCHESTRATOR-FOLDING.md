# Orchestrator folding and pipeline zoom correction

Fixes #1572 and #1573. Source base: `01601310a5c887bf41bfd317caa7996b74ddde69`. The operator image was inspected visually without OCR. It shows overlapping pipeline header pills, small stage labels and native-sized empty envelopes around compact cards at 34%. It is failure evidence.

## Verified integration map

| Layer | Verified evidence | Scope |
| --- | --- | --- |
| Preserved Astra revision 3 | All 17 `artifact/ADOPTED-HASHES.json` entries match the preserved original sources | Separate custom board, semantic layout, synthetic relationships and native-component adapter. The original correction report and critic were read through conversation messages. |
| Accepted production integration | `041aeab659b0cdc9050370ab25c1a09778f2d1b6`; all 77 `SOURCE-HASHES.json` entries match | Task projection/history, displayed task footprints, routed edges, overview pins, dormant native readers, retained composer ownership and tool chronology. The manifest excludes itself; the package has 78 files including the manifest. |
| Merge | Additive integration `88adecbebeb258eadae997d3c8148809116029cd`, squash `c2007627f8afc941b72981c32eaf24bdb34cf53d` | All 77 manifest entries remain identical at the squash. |
| Serving revision | `84885e7127f2c819ac423191cabca009aacf92b6` | Successful terminal deployment ledger and container revision label agree. All 40 manifested `src/` files match inside that container. All eight JS/CSS assets referenced by the actual serving root match that container byte-for-byte. |
| This lane's starting tree | `01601310a5c887bf41bfd317caa7996b74ddde69` | All 77 historical manifest entries still match before this correction. |

The original artifact's branching diagram, task/role copy, synthetic review-return relationships and custom visual styling are separate from the production renderer. `artifact/build-renderer.mjs` substitutes `board.tsx` only outside `BOARD_PRODUCTION=1`. Production imports `src/components/scheme/SchemeBoard.tsx`; the presence of prototype files in Git establishes no rendered behavior.

The integration condition selected `layoutTaskBoard` only when linked board tasks existed. A pipeline-only board retained the legacy native-pane geometry and far labels. Its group header independently counter-scaled without a container-width constraint. The prior production browser transport supplied no pipelines, so its task geometry sweep did not exercise this scene.

The original prototype's left-to-right stages, child-derived bounds and readable essential labels support this narrow correction. This change reuses the existing production layout for pipeline-only boards, caps each header within its envelope, reduces pipeline heading reservation, and reserves readable rail-control spacing. Stage badges and rail controls counter-scale; rails retain screen thickness. Native status vocabulary replaces raw summary state text. Task pins and persistence records retain their existing owners.

## Remaining design and data boundaries

The full original visual design is not established as shipped. The custom prototype topology, wording, styles and sample relations remain a distinct artifact. Production task history renders recorded relations and unlinked work.

Durable typed successor, review, PR and release relations remain with the automation/API work under #1446 and `../task-workflow-model/INTEGRATION.md`. Missing historical links cannot be recovered authoritatively from titles or verdict prose. They explain incomplete history associations; they do not explain or excuse the geometric defect. No backend schema, runtime, tick, server, package or deployment code changes belong to this correction.

## Tool presentation

`OrchestratorConversation` supplies a collapsed policy around its existing `LogFeed`. There is no additional reader or data-fetch path. The default policy preserves the board's current active/error behavior and inline expanded bodies.

Dock groups, individual calls, owned wait/stdin children and statically parsed nested exec calls start closed. Each mounted disclosure stores the user's choice; incoming data and live-to-settled transitions do not reset it. New children start closed. Reload/remount starts closed. Literal exec nesting is parsed without evaluating source; existing parsing bounds remain, with an eight-level recursion guard. Dynamic input and per-child outcome remain unknown. Outer status, error counts, output and delivery controls remain available.

## Executed evidence

- Actual production Viewer browser fixture: one two-stage and two one-stage pipelines, three widths (1280/1440/1920), both themes, 34%. Baseline has one overlapping header pair in each case. Corrected cases have zero, contained headers and 10.5px stage text. Pipeline envelopes are 240px tall around 160px displayed summaries; baseline reserves 311px around approximately 45px far labels.
- Production pipeline geometry: 14 zoom/reader cases from 7% through 100%, zero containment, sibling-overlap or endpoint findings.
- Actual dock and board for the same conversation: closed dock group; level-by-level nested exec expansion; third-call arrival preserves open ancestors and starts the new call closed; board expansion retains inline full detail; reload and actual dock remount start closed. Runtime transport and production log bus are enabled with isolated responses.
- All 334 focused tests across 14 files pass, covering parser, disclosure, board geometry, MCP status, live chronology, orchestrator panel and original-key/dead-host delivery. The mobile disclosure fixture now uses the production breakpoint constant; its old 767px stub failed identically on the source base.
- Nonincremental TypeScript and production Next/MCP build pass with the complete existing dependency installation. The build retains the existing CSS highlight warning.
- The older `SchemeBoard.pipelineRegions.dom.test.tsx` fails identically on exported production source before geometry assertions because its attempts omit `effectiveRole`. It remains an explicitly unverified legacy suite; this lane uses real-shaped production browser fixtures and the focused displayed-layout tests.

Reproduce with the existing build harness and `BOARD_PRODUCTION=1 BOARD_COUNTERS=1`. Run `artifact/verify-pipeline-zoom.mjs` with `BOARD_EXPECT_FIXED=1`, and `artifact/verify-tool-surfaces.mjs` with `BOARD_RUNTIME=1`. Supply persistent private `BOARD_BUILD_OUT`, `BOARD_BUNDLE`, `BOARD_REPORT_OUT` and installed `BOARD_CHROME`. Test processes use isolated HOME, configuration/state/provider homes and a short TMPDIR. Synthetic screenshots and command logs remain in private evidence storage. Original prototype, drafts, worktrees and pins were preserved. No deployment or live lifecycle action occurred.
