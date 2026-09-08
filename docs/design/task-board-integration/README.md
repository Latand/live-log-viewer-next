# Production task board and tool chronology

The board now lays out recorded task membership with native conversation readers, dynamic group envelopes and routed edges. Task history keeps completed tasks, failed/pathless launches, planned stages, review findings and every recorded worker reachable. Existing pipeline and flow controls open from that history.

A warmed conversation keeps one native reader and composer through board/full-window navigation. Hidden presentation disconnects its subscriptions and effects; the delivery controller remains mounted and receives receipt/outbox changes. The outer memo boundary retains stable hidden props. Camera pans query geometry without waking hidden readers. Scanner generation changes still reach the durable composer owner. It derives dead-host and disabled-send guards from its own capability snapshot, including terminal supersedence; a pane prop is not required to enforce them. A red/green mounted regression covers this integration seam.

Task pins are applied at overview scale, including 7%. Drag previews and commits share the collision decision. Existing conflicting pins remain unchanged and expose their targets; an infeasible reader expansion uses the full-window owner. Card footprints, group bounds, hit targets and edge endpoints share the final layout.

## Chronology repair (#1565)

The frontend runtime reducer discarded item-envelope timestamps. Calls outside the bounded canonical transcript window therefore lost both identity claims and the time evidence needed to retire them. The reducer now retains occurrence/recording time for reconciliation. Live tool rows continue to omit transport-derived clocks and durations.

The operator screenshot was inspected visually. Viewer normalized messages place its old calls in an earlier turn. A private replay joins 67 real item envelopes with the later canonical user/reply/two-action window: exact main leaves 23 stale tool rows; the corrected reducer leaves zero. A mounted LogFeed regression separately proves first-turn visibility, older-row retirement and preservation of a current running call. The original records and screenshots remain private.

An August 31 review had already identified this timestamp regression. Its later builder kept the null-timestamp assertion, which reached main. This change preserves the original display-time restriction while restoring the internal ordering evidence that review requested.

## Ownership and source manifest

Product changes are confined to frontend components/hooks, locale strings and focused tests. Runtime host, server parser, deployment and automation persistence files are unchanged. `SOURCE-HASHES.json` lists the complete source delta against base `88e5a9508be2802266734056d6436f3168201cad`, excluding the manifest itself. The preceding builder commit is `5b60ad910b2ed41862a6c29ac26276a9f7046d81`.

The interrupted builder's scoped dirty files were copied into the successor checkout. Its worktree, the earlier prototype, transcripts and screenshots were preserved. The September 8 operator amendment requires working alone and no additional independent review. No review worker, merge or deployment was started here.

## Executed checks

All commands use private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR and a short TMPDIR. Browser transport blocks external requests and exercises actual production Viewer, SchemeBoard, BranchPane, LogFeed, logBus/useLogTail, runtimeBus and TmuxComposer/outbox modules with controlled endpoint responses. These are local production-component checks; no live agent is sent a message.

| Check | Result |
| --- | --- |
| Geometry / workflow / handoff unit files | 60 passed |
| Board camera, selection, continuation chips and task-history DOM | 24 passed |
| Task-card controls | 15 passed |
| Composer original-key retry/remount, readiness and hoisted capability guards | 11 passed |
| Chronology reducer, mounted feed and tool timing display | 40 passed |
| Voice owner and composer viewport/dictation | 22 passed |
| Log tail, runtime bus and durable outbox | 112 passed |
| Original-scene DOM geometry | 420 cases, zero failures |
| Multi-task DOM geometry | 2,016 cases, zero failures; 24 readers × 14 zooms × three widths × two themes |
| Dormancy and delivery at 24 / 100 / 1,000 conversations | Three warmed readers; 20 pans, 100 incoming messages, 21 seconds idle; zero hidden wrapper/pane/header/feed/source-parser/log-callback/timer/DOM changes |
| Hidden full-window siblings and aggregate readers | Zero per-reader UI changes while 100 messages arrive and 21 seconds elapse in each mode |
| Hidden receipt transitions | Queued → uncertain → delivered, one original key, one transport attempt; unknown retains outbox identity; reentry restores draft selection and scroll anchor |
| Exact-main production negative control | 48 hidden native updates at 24 conversations |
| Preserved prototype negative controls | 480 / 2,000 / 20,000 hidden wrapper entries; 20 hidden summary parses; saved 7% pin has zero displayed displacement |
| Failed pin persistence | Display restores its prior coordinate and exposes the save error |
| Worker reachability | Last worker opened in all 6 / 25 / 250 task groups at 24 / 100 / 1,000 conversations |
| Production 7% pin | Display moved 70 × 35 CSS px; persisted world coordinate survives zoom and reload |
| TypeScript | Current source and exact exported base both exit 0 with the same installed dependencies |
| Production build | `bun run build` passed, including Next TypeScript and MCP bundle |

The earlier twelve diagnostics comprised four missing `pdfjs-dist` imports, one consequent PDF task-null diagnostic, six readonly `fs.lstatSync` assignments in account tests, and one EventEmitter `once` import diagnostic. None is changed by the frontend delta. All twelve disappear on both exact base and candidate with TypeScript 5.9.3, Node declarations 26.4.0 and pdfjs-dist 6.2.108. The earlier installation was incomplete; this run does not attribute each vanished diagnostic to a specific dependency change. No out-of-scope source repair was needed. The pan probe records twenty frame delays per scale. Candidate median/p95 were 15/15.5 ms, 13.4/14.1 ms and 19.5/39.3 ms at 24/100/1,000 conversations on a concurrently used machine. The exact-main 1,000-conversation page did not finish readiness within the existing 30-second browser deadline, so no comparable baseline timing or speedup is claimed at that scale. The CSS optimizer emits its existing `::highlight(tts-karaoke)` warning; compilation succeeds.

Reproducible browser entry points:

- `BOARD_PRODUCTION=1 BOARD_COUNTERS=1 BOARD_BUILD_OUT=<private-output> bun docs/design/task-board-integration/artifact/build-renderer.mjs`
- `BOARD_PRODUCTION=1 BOARD_RUNTIME=1 BOARD_SCENE=multi-1000 BOARD_BUNDLE=<private-output>/viewer.js node docs/design/task-board-integration/artifact/verify-production-board.mjs`
- `BOARD_PRODUCTION=1 BOARD_BUNDLE=<private-output>/viewer.js node docs/design/task-board-integration/artifact/verify-production-geometry.mjs`
- `BOARD_PRODUCTION=1 BOARD_BUNDLE=<private-output>/viewer.js node docs/design/task-board-integration/artifact/verify-production-navigation.mjs`

Set BOARD_CHROME to an installed Chromium executable and BOARD_REPORT_OUT to a persistent private report directory. BOARD_SOURCE_ROOT allows a separately exported exact base; BOARD_ARTIFACT_ROOT with a separate output reads the retained prototype. The builder compiles production CSS from that source. Counter probes instrument module entries without replacing production subscriptions or delivery logic.

## Evidence limits

Historical successor/PR/release associations that were never persisted cannot be reconstructed authoritatively by this frontend. The task projection uses recorded relations and labels missing or unlinked evidence; it does not parse titles or verdict prose into membership. Durable typed relations remain owned by the automation/API lane described in `../task-workflow-model/INTEGRATION.md`.

Local Chromium checks do not establish production deployment, a real host restart, cross-browser or physical input-device behavior. Existing outbox/runtime tests cover restart/remount and stale-response predicates under isolation. Root owns combined release qualification and deployment. Prototype counts and production-component counts are reported separately.
