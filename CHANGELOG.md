# Changelog

All notable changes to `agent-log-viewer` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/) (0.x — the API may still move).

## [Unreleased]

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

[Unreleased]: https://github.com/Latand/live-log-viewer-next/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Latand/live-log-viewer-next/compare/714badd...v0.8.0
[0.7.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.6.0...714badd
[0.6.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Latand/live-log-viewer-next/compare/9608413...v0.4.0
[0.3.0]: https://github.com/Latand/live-log-viewer-next/compare/3e974b0...9608413
[0.2.0]: https://github.com/Latand/live-log-viewer-next/compare/fc7eccc...3e974b0
[0.1.1]: https://github.com/Latand/live-log-viewer-next/compare/1b5dd63...fc7eccc
[0.1.0]: https://github.com/Latand/live-log-viewer-next/commit/1b5dd63
