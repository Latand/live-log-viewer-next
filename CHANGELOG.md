# Changelog

All notable changes to `agent-log-viewer` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/) (0.x — the API may still move).

## [Unreleased]

### Fixed
- Two #507 final-review repairs. (1) An aged-idle passed stage on a
  cursor-bearing active pipeline stays the ONE real stage conversation card. The
  board ran two independent derivations over the same scan — the idle-worker
  auto-collapse (#112) folding quiet pipeline-stage transcripts into the pipeline
  stack, and the #507 F2 rule keeping every current stage's latest transcript
  full-size — and they disagreed, so a passed stage's card could vanish or
  duplicate beside the stack. `pipelineFullPanePaths` now exposes exactly the
  active-pipeline full-pane set, and `ProjectDashboard` protects it from
  collapse, so each stage projects one surface (a five-stage graph reads as five
  real/placeholder cards) with no worker-stack duplicate; older retries and
  completed/closed pipelines still compact. (2) The mobile stage editor is now a
  real modal that owns keyboard focus. Opened above the phone pipeline dock
  sheet, Tab and Shift+Tab stay inside the editor, Escape closes only the editor
  and returns focus to its trigger, and the sheet beneath yields — coordinated
  through a shared modal-layer stack (`useModalLayer`) so only the topmost layer
  traps focus and answers Escape.

### Changed
- Completed the on-canvas pipeline editor visual contract (#507 review). Three
  repairs finish the pivot to composing the whole pipeline on the canvas as real
  cards: (1) desktop stage editing no longer has a nested form/scroller — the
  pipeline group's override panel keeps only pipeline-level controls (draft
  task/spec/repo, lifecycle, retry/skip) and points to the canvas, so every
  per-stage edit (role, model, prompt, order, connections) happens on the real
  conversation/placeholder cards. (2) A completed stage of an active pipeline now
  stays a full conversation card inside the colored group — `compactPipelineArtifactPaths`
  keeps every current stage's latest transcript full-size and folds only
  superseded retries (and completed/closed pipeline history), and an idle
  completed stage whose transcript is no longer surfaced as a live node stands in
  as a full-size completed card that shows the prompt it ran and opens its
  transcript. A five-stage graph now renders as five real/placeholder cards, not
  one live pane beside compact history stubs. (3) The mobile stage editor now
  portals above the phone pipeline dock sheet (z-[80] over the sheet's z-[70]),
  so it is visible and usable at 390px instead of painting under the backdrop.

### Added
- On-canvas pipeline stage reordering (#507). A draft's stage cards carry their
  own move-earlier / move-later controls, so the whole conversation graph is
  composed in place on the canvas — no nested form. Each move is offered only
  when it keeps the chain startable (no review-loop ahead of the first run,
  matching the server guard) and rides the shipped optimistic PATCH echo through
  the new `optimisticReorderStage`, which relinks intentional pass/fail edges by
  identity exactly as the server's reorder does. The on-canvas add affordance now
  extends the chain up to the full 8-stage limit (previously capped at 4), and
  the placeholder card body renders the stage prompt as a bounded, clamped
  preview with no nested scrollbar — the full prompt stays editable in the card's
  configuration disclosure.
- Inferred spawn lineage (#341). `POST /api/spawn` no longer requires `src`
  from authenticated agent callers: the durable parent is inferred from the
  caller's own capability-bound conversation, persisted as registry lineage
  (receipt + edge) with a `parentSource` attribution (`explicit` /
  `inferred-caller`), and exposed in the spawn response as `parent`. An
  explicit `src` still wins and is still rejected when it does not resolve to
  the caller; operator-capability callers without `src` proceed as silent
  roots. Lineage stays conversation-id-keyed, so restart, resume, account
  switch, handoff, and the board projection are unchanged.
- Pathless retry for failed task launches (#334). `POST
  /api/tasks/{id}/spawn` accepts `retryOfLaunchId`, relaunching a failed
  assignment from its durable receipt shape (engine, directory, model,
  effort, pinned account) with a server-minted fresh attempt id — the
  terminal receipt is never replayed and the failed audit assignment is
  preserved. The task card's failed assignment chip and the mobile task
  sheet gain a compact retry-launch control that needs no transcript path.
- Reviewer isolation and bounded, tracked agent nesting (#393). Reviewer and
  verifier sessions keep full filesystem, shell, GitHub, and browser access but
  have zero child-spawn capability: every launch they originate — direct
  `/api/spawn`, pipeline creation, or any future MCP surface routed through the
  registry — is terminally rejected before a child transcript or process
  exists, with a durable typed rejection receipt (`reviewer_origin_spawn` /
  `nesting_depth_exceeded`) and actionable guidance. Every delegated launch
  durably records its role and delegation depth (plus parent, membership,
  account, and engine) before execution, and a new operator-only
  `maxAgentNestingDepth` setting (`GET`/`PATCH /api/spawn/policy`,
  conservative default 2) bounds delegation chains. Resume, restart adoption,
  account switch, and stage retries conserve the recorded identity; reviewer
  resume profiles always deny native multi-agent tools.
- Demo motion pipeline (`bun run demo:motion`, stage B of the demo media
  effort): storyboard-as-data recordings of the four key flows rendered as
  loopable GIFs plus a stitched `docs/media/demo.mp4`, reusing the stage A
  fixture, browser image, and pixel gates. The README now leads with the hero
  GIF and a feature tour; regeneration commands live in
  `docs/media/README.md`.

### Fixed
- Stale structured launches now converge while the server runs (#334): a
  bounded, idempotent reaper-cycle pass turns dead-evidence pending launches
  (no live admission owner, host entry, or runtime session past the timeout)
  into the durable retry-safe `failed` state — recovering instead when strong
  delivery evidence exists — so permanent placeholder spinners and blocked
  composers no longer wait for a replay request or a restart.
- `viewer.snapshot` resolves `spawn:<launchId>` visible paths (#342): a
  materialized launch returns its real conversation (annotated with
  `resolvedFrom`), an unresolved one returns a typed `spawn-stub` with the
  durable launch state in the additive `stubs` array, and `omittedCount`
  covers only genuine budget truncation instead of silently dropping spawn
  placeholders.
- Terminal spawn placeholders retire from the board projection after 24 hours
  (#342): a pure read-model bound (no registry writes, no deletions, restart-
  invariant) that converges the accumulated placeholder baseline while
  receipts, conversations, lineage, transcripts, tasks, and active pane-less
  agents stay intact; recent terminal launches keep their prominent card and
  launch-history tiers.

### Changed
- Current product prose, static page metadata, and the CLI startup banner use
  the `Agent Log Viewer` display name. Compatibility identifiers stay stable:
  the `agent-log-viewer` package and CLI, `LLV_*` variables, `llv_auth`, browser
  storage keys, supported legacy config/cache paths, and the existing repository URL.

## [0.11.2] — 2026-07-08

### Added
- Task curator API: `/api/tasks/curator` surfaces recent real user inputs with
  transcript context and accepts short curated proposals that become board
  tasks with source fingerprints. `GET` scopes to every project or one via
  `?project=`, and returns a `projects` discovery list — so an automation can
  poke the viewer from anywhere and capture all boards or a single one.
- Resource cleanup now has a guarded "kill all agents" control for a deliberate
  clean slate across tracked agent panes.

### Changed
- Automatic task inbox capture is opt-in through `LLV_ENABLE_AUTO_TASK_INBOX=1`.

### Fixed
- Finished Codex worktree sessions under `~/.codex/worktrees/<id>/<repo>` keep
  grouping under the parent repo after the ephemeral checkout disappears.
- Workflow setup no longer reports a just-launched command as "interrupted": a
  short settle window anchored on the launch artifact absorbs the spawn/exit
  race between the pid becoming visible and the exit-code trailer landing.

## [0.11.1] — 2026-07-08

### Added
- Composer send now has a compact context menu with a quick "Yes, continue"
  action, mirroring the microphone backend menu pattern.

### Fixed
- Orphaned workflow records no longer keep missing repositories visible in the
  project rail. A workflow is listed only when its workspace still exists or a
  linked transcript is present in the current scan.

## [0.10.0] — 2026-07-08

### Added
- Docker runtime: a `Dockerfile` and `docker-compose.yml` build `.next` inside
  the image from a clean environment and run the viewer with host parity — host
  network and PID namespace, the real `/home/latand` tree and tmux socket, and
  `nsenter` shims that exec the exact host `claude`/`codex`/`bun`/`uv`/`tmux`.
  Prod runs as the `viewer` service on `127.0.0.1:8898` with
  `restart: unless-stopped`; a `test` profile brings up a second instance on
  another port. Reproducibility, not isolation — see `docs/docker.md`.
- Idle conversation roots now appear in the quiet history list even when they
  head an active group, marked to set them apart from fully-quiet roots.

### Changed
- The prod deployment moved from the `agent-log-viewer.service` systemd user
  unit to Docker Compose; the systemd unit is disabled. `scripts/rebuild.sh`
  now rebuilds and redeploys the container (still verifying the served CSS the
  HTML references returns 200).
- Removed Codex companion-job support. The viewer no longer scans, links, or
  renders `~/.claude/plugins/data/codex-openai-codex/state` jobs — the
  `codex-jobs` root and its parentage linking are gone. Codex spawning was
  never routed through the companion plugin (it uses tmux directly), so
  spawn behavior is unchanged.

### Fixed
- Spawning an agent survives a deleted tmux server cwd: the pane receives an
  explicit `cd` into the target directory before the boot command, so a stale
  server working directory no longer aborts the launch.
- An archived project revives when an agent inside it is running again: an
  idle-but-running conversation un-hides its project instead of staying hidden.

## [0.9.3] — 2026-07-07

### Changed
- Task cards hand off instead of firing. Dropping a task's arrow onto a live
  agent (or clicking a routed target) now seeds that pane's composer with the
  task text and never auto-sends; a removable link records where it was routed,
  and a "detach" action unlinks an assignment. Quiet projects render on the
  canvas with a scheme/list view toggle. Message-feed images referenced by a
  local path embed inline instead of showing as bare links.
- Resumed sessions are matched to their running process. Transcript→pid
  attribution now recognizes `--resume <id>` and `codex resume <id>`, so a
  resumed pane is correctly identified in the viewer.

### Fixed
- Handoff assignments persist. The task store validator accepts the `handoff`
  state, so a task routed to a pane is no longer dropped on the next load.

### Security
- The local image proxy (`/api/image`) is hardened: it rejects cross-origin and
  DNS-rebind requests (same Host/Origin gate as the mutating routes), resolves
  symlinks and re-checks home containment before reading, and no longer serves
  SVG inline (which could run same-origin script).

## [0.9.1] — 2026-07-06

### Changed
- The codebase is English by default: hardcoded Ukrainian strings (API error
  responses, display labels, transcribe messages) and internal `kind`/`project`
  values are now English. The Ukrainian UI locale (`src/lib/i18n/uk.ts`) and the
  CLI's Ukrainian messages are unchanged, so a uk locale still gets a Ukrainian
  UI; only the default and the non-localized internals moved to English.

## [0.9.0] — 2026-07-06

### Fixed
- CLI no longer kills its own healthy server on startup. The readiness probe
  reused the 200 ms poll interval as its per-request socket timeout, but the
  probe hits `/api/files`, which scans every log under `~/.claude` and
  `~/.codex`; past a few hundred conversations that scan takes 250–600 ms, so
  every probe aborted early and the launcher declared a timeout after 15 s. The
  probe now has its own 5 s socket timeout.
- No more "nothing found" flash while the conversation list loads. The sidebar,
  switchboard and mobile focus view showed their empty state on first paint,
  before the first `/api/files` response arrived; they now show a loading
  spinner until the first fetch settles.

## [0.8.0] — 2026-07-06

### Added
- Mobile shell: trimmed pane chips, composer tools folded behind one toggle,
  attention badge in the header.
- Feed copy affordances: inline monospace chips copy themselves on click;
  code blocks and command outputs get a hover copy button, with a clipboard
  fallback for plain-http LAN origins.

### Changed
- Dictation starts faster: mic acquisition overlaps a prewarmed live token.

## [0.7.0] — 2026-07-06

The board fast path — the release that makes the scheme keep up with a dozen
live agents at once.

### Added
- Server-push log tailing: `GET /api/logs/stream` (SSE over `fs.watch` with a
  safety re-stat and heartbeat); the client falls back to batched polling
  automatically when the stream drops.
- Batched channels: one `POST /api/logs` per tick for every visible pane's
  forward read (byte-budgeted), one `POST /api/tmux/targets` for all pane
  target lookups.
- `ETag`/`If-None-Match` on `/api/files` — unchanged payloads come back as a
  bodyless 304.

### Changed
- Incremental feed parsing: each pane parses only appended transcript lines;
  cross-line effects land copy-on-write, so unchanged messages keep identity
  and skip markdown re-render entirely (measured 225× less parse work per
  tick on a 10 MB transcript).
- Panes sleep when they cannot be seen: off-viewport (IntersectionObserver)
  and behind the far-zoom identity labels. Activity dots, questions and
  notifications keep riding the files poll.
- Scanner discovery and link glob scans became cooperative: async walks with
  bounded concurrency and event-loop yields, so `/api/files` no longer stalls
  log responses behind it.
- One shared 128 KB tail read+parse per growing transcript per scan instead
  of 4–6; `/proc` and tmux pane-map memos now outlive the 10 s poll.
- Pane header reworked into two rows: identity + actions on top, metadata
  chips below; cleanup list names sessions by argv session uuid.

## [0.6.0] — 2026-07-06

### Added
- Reasoning level and codex fast/standard toggle on every new-agent surface.
- System resources panel: RAM/swap rail block with per-agent-session memory
  (over tmux pane trees) and a stale-session cleanup panel.
- Microphone engine menu (right-click): pick the transcription backend; a
  visible "starting" state while the recording pipeline connects.
- Chime when a new subagent or agent link appears.

## [0.5.0] — 2026-07-05

### Changed
- Viewer state moved out of `~/.claude` into `~/.config/agent-log-viewer`
  (atomic, retryable migration of the legacy directory).
- npm releases are published from CI on tag push via trusted publishing.

## [0.4.0] — 2026-07-05

### Added
- Agent workflows: multi-step templates (stage → fixer → PR body) with a
  state machine, provisioning, draft cards and a docked strip.
- Task handoff arrow: hand a board task to an agent by pulling an arrow.

### Fixed
- Anchored feed scroll across layout reshuffles.

## [0.3.0] — 2026-07-05

### Added
- Lasso multi-select with ephemeral bulk-action sessions on the scheme board.
- Board tasks: sticky cards over the panes with delivery to agents, mobile
  task sheet with STT/images, minimap task dots.
- Attention queue («needs me») with rail counts.
- Expand any conversation pane to the full window and collapse back.

## [0.2.0] — 2026-07-05

### Added
- i18n (English + Ukrainian) across the UI and CLI.
- Mobile mode: focused conversation, full-screen map, project drawer.
- Live dictation UI and TUI menu cards; the scanner parses waiting TUI menus
  and answers them by key.
- Archived projects.

### Changed
- Scheme-canvas jank cut with many agents: memoized feed, rAF camera,
  smaller panes.

## [0.1.1] — 2026-07-05

### Added
- In-app QR onboarding for phone access; hardened Tailscale flow.
- Unified config dirs; short-lived transcription tokens.

## [0.1.0] — 2026-07-04

Initial public release, packaged as `agent-log-viewer` with a `bunx` CLI.

- Local web UI that tails Codex / Claude Code transcripts into a live
  chat-style feed with a session parentage tree.
- Project scheme canvas: conversations as cards on a pannable, zoomable
  world with parent→child arrows, minimap, review-loop cycles.
- tmux composer: message, interrupt or kill any tracked agent; spawn new
  agents; codex spawn lineage survives process exit.
- Implement→review flows with fresh headless reviewer rounds.
- Remote access over Tailscale behind a token gate.

[Unreleased]: https://github.com/Latand/live-log-viewer-next/compare/v0.11.2...HEAD
[0.11.2]: https://github.com/Latand/live-log-viewer-next/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/Latand/live-log-viewer-next/compare/v0.10.0...v0.11.1
[0.10.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.1...v0.9.3
[0.9.1]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Latand/live-log-viewer-next/compare/714badd...v0.8.0
[0.7.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.6.0...714badd
[0.6.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Latand/live-log-viewer-next/compare/9608413...v0.4.0
[0.3.0]: https://github.com/Latand/live-log-viewer-next/compare/3e974b0...9608413
[0.2.0]: https://github.com/Latand/live-log-viewer-next/compare/fc7eccc...3e974b0
[0.1.1]: https://github.com/Latand/live-log-viewer-next/compare/1b5dd63...fc7eccc
[0.1.0]: https://github.com/Latand/live-log-viewer-next/commit/1b5dd63
