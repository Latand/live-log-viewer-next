# Changelog

All notable changes to `agent-log-viewer` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/), including its compatibility
guarantees for the 1.x series.

## [Unreleased]

### Added
- The Viewer ticks the orchestrator seat, so a rotation stops dropping the
  monitor (#1245). The monitor that had been driving orchestrator sessions was
  never a feature: it was a schedule an agent armed inside its own session, so
  nothing was written to disk, it died with the session, and every rotation
  silently dropped it — a successor started with no tick and no way to know one
  was missing. The clock now lives in the release that owns traffic, beside the
  controllers that already reconcile flows and retire hosts. A cheap check every
  few minutes reads durable state only — the seat, the open lanes, the board,
  the lifecycle journal past the seat's own cursor — and answers one of
  `wake`, `quiet`, `proactive`, `no-seat` or `skipped`; the model runs only on a
  wake, at most once an hour per project. Every check appends one sanitized line
  to `state/seat-tick/runs.ndjson`, so "no line" means "no check" and the
  absence of a tick is a readable fact rather than a silence. A tick that lands
  while the seat's turn is genuinely progressing is dropped, never queued.

### Changed
- The orchestrator mandate is at v11: the Viewer owns the clock, a seat never
  schedules itself, and a seat still holding a schedule drops it in the turn the
  mandate lands in rather than waiting to observe the replacement work (#1245).
  Waiting cannot work — a seat's own schedule keeps its turn open, so the
  Viewer's tick finds it busy and drops every check, and the two mechanisms
  deadlock. The handover paragraph is delivered with every mandate, whatever
  version the seat carries: a rotation hands the successor the incumbent's
  mandate and version, and a bespoke mandate never had the paragraph at all, so
  the seats most likely to be holding a schedule are exactly the ones a
  versioned-default-only paragraph would never reach. It is appended at most
  once, so a re-delivery after a host death reads the same. The checked-in
  conveyor playbook says the same thing the mandate does — it used to tell the
  seat to self-pace with wakeup checkpoints, which made the rule unenforceable
  by contradiction.
- Automatic host retirement ends a rotated-away orchestrator (#1245). Rotation
  revokes authority and nothing else, so a predecessor kept its host — and,
  while it was ticking itself, kept its transcript warm enough to clear the idle
  threshold forever, staying alive by the activity that should have disqualified
  it. The retirement predicate now tells a revoked seat from a live one and
  waives the idle threshold for it. A durable revocation stands on its own: a
  later designation that failed terminally stops masking it, and the standing
  follows an identity through a migration alias, so neither a failed
  re-designation nor a migrated id leaves a revoked seat protected. Everything
  protecting work in flight is unchanged: the turn still has to settle,
  questions still have to be answered, the queue still has to drain.

### Fixed
- Card activity now uses the structured turn-liveness evidence that governs
  recovery (#1296). A verified process with an open turn stays `live` only while
  transcript writes or recent CPU movement show progress; the measured flat
  100-second window projects `stalled`, and a recorded pid that has exited no
  longer projects `running`. The hand-over now releases registered structured
  engines before the incumbent Viewer exits. The target switch activates the
  candidate first; its adopter refuses the still-live engine process before it
  examines the separate Viewer writer claim. The incumbent previously reached
  its demotion poll, checkpointed state, and exited without calling the engine
  lifecycle, leaving the detached child alive in the host namespace. Demotion
  now records an exact PID/start-identity handoff, releases all registered hosts
  in one bounded window, and leaves the candidate's startup retry to publish one
  replacement. The hand-off marker carries its writer epoch, so a delayed
  incumbent state update cannot acknowledge its own release. A sliding CPU
  window also keeps recent work live across ordinary polls until a later full
  window supersedes that evidence. A CPU-flat stage is likewise terminated and
  retired through its exact structured identity before the pipeline marks it
  retryable.
- Whether a turn is being worked on is decided from evidence, so a redeploy no
  longer strands a lane nothing can recover (#1281, #1282, #1276). `live`,
  `idle` and `busy` are inherited words: a turn severed mid-flight kept reading
  busy forever, and a step that legitimately takes ten minutes read stalled. The
  decision now names what it read — the last transcript event and its kind, the
  artifact's own clock, whether the process the registry believes owns the turn
  still exists and is still that process, the CPU it has consumed since its own
  launch, and how long a delivery has been outstanding for it. A host writing or
  burning CPU is working however long the gap between messages; a host that has
  written nothing and burned none since its own launch, under a turn it
  inherited, is severed. Everything else answers `unknown`, and `unknown`
  authorises nothing. A transcript that cannot be read — corrupt, truncated,
  missing, or growing under the read — is answered before anything else is
  looked at, the recorded process included: a pid that is gone proves that pid
  is not running, which is just as true of a turn that finished hours ago under
  a row nobody updated as of one cut off mid-work, and only the transcript tells
  those apart. The cost of guessing is not symmetric — a kill lands the same way
  either way, but a retry re-runs work that may already be complete and a
  continuation nudge re-prompts a seat about a turn that is over — so the
  reading stops there and consumers are handed `unknown`. The registry's own
  `busy` or `terminal` word is never borrowed to fill the gap, and a pid whose
  recorded start identity cannot be revalidated is not evidence about the
  process the row was written about either. Two consequences follow. A pipeline stage whose host
  is proven severed leaves `running`, so `retry-stage` works without closing the
  pipeline — and a stage whose evidence is unreadable keeps its attempt instead.
  A kill on a host no delivery controller owns reaps the recorded process —
  fenced on its start identity, and only once the evidence says severed — so the
  registry row can retire instead of refusing forever and blocking every message
  queued behind it; an interrupt in the same state settles rather than holding
  its conversation's drain open.
- A Viewer restart messages only the orchestrator seats whose own turn was
  severed (#1276). The predicate was `live` or `idle`, and `idle` meant every
  dormant project was re-hosted and spent a paid turn answering "no change" on
  every redeploy — eleven seats, eleven hosts, eleven turns, and fresh activity
  stamped on projects nobody had touched in days. A seat is now nudged only when
  the evidence says a turn of its own was cut off, the surviving message names
  that turn by its last transcript event, and an idle seat gets no message and
  no process. The message no longer asks the seat to "re-arm any scheduled
  work": since #1245 the Viewer owns the clock, and a durable agent-managed
  monitor record is tracked in #1280.
- A boot that cannot read a transcript starts nothing and retires nothing for it
  (#1281). A tail read that comes back uncertain makes no observation, so the
  conversation kept the turn word the last writer left on the row — and that
  word launched a CLI process for the turn and, on Codex, spent a paid
  continuation telling the seat to resume it, for a turn that may have ended
  long ago. Such a row is now left exactly as it is: no host is launched from
  it, no continuation is sent, and it is held out of the demotion that retires
  skipped hosts, so whatever can read the artifact next is what decides. Work
  that is owed regardless still boots its host — a held delivery or a pending
  runtime operation is evidence of its own.
- Startup launches no structured host it cannot hand to a delivery controller
  (#1282). A pass with no runtime client has no publication to claim what it
  starts, and the check that catches an unclaimed host was behind that same
  condition, so such a pass adopted hosts and reported success while nothing
  owned them. Such a pass now defers its adoption: nothing is launched, the
  boot's own recovery evidence is kept, and the startup retry loop runs the pass
  again once a client exists. A host adopted by a pass that did have one, but
  which the controller never claimed, still fails the pass instead of being left
  running with no owner. And a startup completion that resumes
  inside a generation the publication has already left now hands its hosts to
  the successor; it used to answer "done" and register nothing, which is how a
  launched host ends up parked in `epoll_wait` for half an hour while every
  recovery verb is refused.
- The macOS argv reader's live-child test waits for the child to announce its
  exec before it reads. A pid exists before the image it will run does, and
  until the exec lands the kernel has no argument record for that image to hand
  back — the window the Claude login fence already polls through. The test read
  the moment `spawn` returned, so it asserted the result of a race, and one CI
  attempt lost it while the next attempt on the identical commit won: a red the
  tree could not explain. The read now happens after a byte only the executed
  script can have written. What the test requires is unchanged — one read, the
  exact exec-time argv of a live child, and `null` once that child is gone.

### Removed
- The conversation monitor's standalone CLI driver, its HTTP client and its
  cross-process lock (#1245): `scripts/conversation-monitor.ts`, `httpViewerApi`
  and `POST /api/monitor/lock`. They existed for an external process on a
  crontab that was never written on any machine, and one clock in one process
  needs no lock. The classification the CLI drove — evidence, GitHub
  correlation, the stall rule, board cards, redaction and the audit journal — is
  kept and is what the seat tick reuses; the operator-request transcript scan is
  kept in the tree, undriven, and now requires a caller to supply its own
  single-flight admission. `GET /api/monitor/runs` is unchanged.

### Fixed
- A review relay held on a provider limit now waits a wait that ends, and stops
  waiting when the provider said to retry (#611). Two gaps were left by the
  first fix. An account whose window reads spent with no reset the provider
  named was reported as no park at all, so recovery handed the live owned host
  back publish-ready and the relay enqueued into an account that could not start
  the turn — the original incident, reproduced by the one reading nobody can put
  a clock on. It is now reported as a park in its own right: nothing is
  enqueued, nothing is dropped, no retry budget is spent, the host keeps its
  process and its claim and the relay keeps the identity it would have been sent
  under — and the wait is bounded by the evidence that justified it. The reading
  only speaks for one freshness horizon, so the park names that instant as its
  recheck and lapses there on its own unless a fresher reading renews it against
  new evidence. The board says which account it waits on, that the reset is
  unknown, and when the account is looked at again, instead of showing a reset
  time nobody gave. And publish readiness no longer borrows the sixty-second
  grace that exists for liveness classification: it resumes at the provider's
  own deadline, where before a probe one millisecond past it was answered with a
  hold whose deadline had already passed, and every tick for the next minute
  re-decided the same hold.

## [1.0.0] — 2026-07-31

### Fixed
- A review relay no longer enqueues a continuation into an implementer whose
  account the provider has parked (#611). Publish-readiness treated a
  process-alive, claim-owned structured host as ready to receive a turn without
  asking whether the provider would take one, so findings relayed to a builder
  sitting at a quota-warning prompt went to a host that could not start the
  turn: the item stayed `queued`, the relay stopped, and the lane went on
  looking alive. Recovering it by hand cost a preserve-commit, a fresh pipeline
  and a reviewer re-attach, three times in one evening. Readiness now consults
  the runtime's own account state — the newest limits provenance and the
  durable quota observation the account controller records, never the
  transcript's prose — and a live host whose account is parked is handed back
  held instead of published; it keeps its process and its claim, because the
  park belongs to the account and a replacement host would start parked too.
  The relay withholds the verdict rather than queueing it and re-attempts at
  the provider's own deadline, so nothing is dropped, no timeout is widened, no
  retry budget is spent, and the message keeps the idempotent identity it would
  have been sent under. The wait is visible while it lasts: the round records
  what it waits on and until when, and the board blocks the flow with that
  deadline instead of drawing a lane that is quietly making no progress.
- An agent asking for the operator's attention reaches the desktop that is
  actually open, and the automatic focus lands (#688). Three things had to be
  true for that and none of them were. Presence — who is looking at the viewer —
  lived in one process's memory, written only by the server that receives the
  browser's heartbeat, so every other process on the machine (the MCP server,
  where the agent's tools run) read an empty map and concluded nobody was there;
  it is now mirrored to the shared state dir, which is also what stops
  `operator_snapshot` reporting no active view while the board is open. A raised
  request now names the views that are open at the moment it is raised, rather
  than filling that list in seconds later on some browser's next poll, so the
  answer the agent gets can say who it reached — a phone, a hidden tab and a
  long-silent view are still named by nobody, because none of them will move.
  And the move itself now finds conversations the board draws inside a container
  — a worker that folded into its parent's stack once it went quiet, a reviewer
  round drawn in its flow's deck — instead of reporting a card on the operator's
  screen as gone: the focus index resolves through the same layout the board's
  own links route through, and a conversation the layout left out entirely is
  asked for through the shell before the handoff gives up. A move that happens
  this way is recorded as the automatic follow it is, and leaves the Back
  control that returns the operator to where they were.
- Agent chips on the conversation canvas report the agent's real output, not
  the state of its process (#669). Chip activity now derives from how long ago
  the conversation's transcript last grew, so a lane appending records every
  few seconds reads as working however stale the snapshot's own activity
  verdict has become, and a host that stayed alive with nothing to say gets its
  own state — «alive but silent» after five minutes of transcript silence, a
  steady warning ring and its own tray dot, told apart from both working and
  finished. What the silence means is settled by the transcript's last turn,
  never by its age: a turn still open keeps the chip amber (an in-harness
  subagent owns no process of its own, so its open turn is what carries a
  six-minute tool call through), while a turn that ended cleanly reads as done
  even with the host still attached — so a delivered worker greys out instead
  of sitting amber beside a genuinely wedged one. The chips carry a ticking
  clock, so a state change settles in place: a wedged host leaves the working
  state with no reload and no new scan, and a batch change (several
  conversations killed at once) settles every chip from the one poll that
  carries it.
- The limits widget labels each quota window by the horizon its data actually
  carries (#606). Codex reports every rate-limit window with its own length, and
  a plan without a 5-hour limit sends its weekly window in the `primary` slot;
  ingestion filed windows by slot, so a weekly number was drawn under the "5h"
  label while the weekly window stayed empty and its chart said "no history
  yet". Windows are now routed by their declared length everywhere they enter —
  the app-server snapshot, the transcript fallback and the transcript backfill —
  with the reset horizon as the fallback evidence when a window declares no
  length, and a rounded length (a week reported as 10081 minutes) still reading
  as its horizon. Snapshots cached before the fix are relabelled on read.
  Rate-limit events carrying no windows at all — other limit families — no
  longer stand in for the account's snapshot, and only a snapshot that names
  some window can claim a horizon is unreported, so a windowless read still
  charts the history it has instead of a generic empty state.
- Multi-gigabyte active transcripts no longer starve the Viewer (#287). One
  process-wide scan coordinator now owns every catalog generation: the HTTP
  files cache, the pipeline watchdog, and the account controller join or queue
  behind a single scan instead of multiplying corpus reads, with pinned
  refreshes holding an exclusive lease so their pin overlay never leaks into
  the shared catalog. The remaining open-ended readers honor hard byte
  budgets — authorship proofs resume from persisted checkpoints at 4 MiB per
  path inside a 32 MiB cycle budget, and lineage needle scans cap one
  candidate at 1 MiB inside a 256 KiB generation budget — proven against
  logical 3 GiB transcripts. Transcript-derived metadata now caches by file
  identity alone, so project-state reconciliation recomputes only the
  project/worktree overlay instead of evicting the corpus-wide cache. Runtime
  host responses settle exactly once and every read-only host request carries
  the caller's abort signal, ending the late `socket.end` writes
  (`ERR_STREAM_ALREADY_FINISHED`) after client timeouts.
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
- A recurring conversation monitor that surfaces pending, stalled and untracked
  operator requests (#741). It resolves the current orchestrator through the
  durable single-instance record and addresses it by conversation id, so a
  rollover, restart or model swap cannot orphan it the way the hard-coded
  transcript path it replaces did. Resolution includes a read-only host probe,
  because the mechanism it replaces spent over a day nudging a conversation with
  no live host — and because a send into one would resume it. Unproven counts as
  unresolved: a record with no settled path, a probe that errored, and a send
  that had to resume its own audience all fail the run rather than reporting a
  delivery nobody received. Whenever no live orchestrator resolves, the
  condition lands on the board and the run exits non-zero, never a silent
  success. It reads operator-authored messages over a bounded recent window,
  telling them apart from assistant text, tool output and its own nudges (which
  carry a marker precisely so it cannot read its own report back as a request),
  correlates each concrete request against board cards, pipelines, flows, pull
  requests and issues, and classifies it as completed, in flight, stalled, never
  materialized, or awaiting operator confirmation — with correlation scoped to
  the project the request came from, so another board's work cannot suppress it,
  and an issue number named in passing never retires a request nobody did.
  Staleness is judged on genuine stage and round activity rather than a
  container's age. Gaps become board cards through the Viewer API, each stamped
  with the request's fingerprint, so re-running over the same window creates
  nothing further. Cards summarize and never quote the transcript: what leaves
  the monitor is redacted of credentials, email addresses, home directories and
  absolute paths, including the encoded forms. GitHub issues are never created
  from inferred intent — a request for one is surfaced as an unconfirmed
  candidate. Every run appends exactly one audit line, through the viewer's own
  `/api/monitor/runs`, that tells a clean run from a failed or skipped one,
  carrying fingerprints and counts but no transcript text, path or identity; the
  single-flight lock behind `/api/monitor/lock` is an atomic claim, so two
  overlapping runs can never both proceed. Scheduled with
  `bun scripts/conversation-monitor.ts`; design notes in
  `docs/design/conversation-monitor.md`.
- Background music in the Viewer, and one track across the call boundary
  (#732). The Audio settings now carry two independent switches sharing one
  level: music while using the Viewer, and music during a call — the latter the
  renamed old ambient setting, whose Ukrainian label read as an engineering term
  («фоновий шар») rather than as music. With both on, the same track simply
  keeps playing across the call edge in either direction: no teardown, no
  re-init, no position reset, and speech ducking applies for the duration of the
  call as before. With only one on, the edge that silences the music parks it —
  the voice fades out and the position it reached is retained, so the edge that
  brings it back resumes from there instead of replaying the same opening on
  every call — and the parked voice stays alive for its whole fade, so a call
  that ends inside it returns to that very voice instead of stacking a second
  one over the music still sounding. Only a device that wants no music at all
  (the sound master off, both switches off, no asset) tears the track down. The
  music ducks under whoever is talking, read off the transcript the call already
  produces, with the duck owned per mounted composer so a card nobody is
  speaking in cannot let the music back up over the one they are. Every line a
  call inherits is disqualified as speech the moment it goes live, so the line a
  dropped call left mid-sentence — never marked final, and kept on screen on
  purpose — cannot open the next call already ducked. Ambient
  ownership across conversation cards holds through a keyed card switch: React
  destroys the outgoing card's effects before creating the incoming one's, so
  the last lease going away is settled at the end of the tick rather than on the
  instant — a swipe between conversations never restarts, duplicates or drops
  the track.
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

[Unreleased]: https://github.com/Latand/live-log-viewer-next/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.11.7...v1.0.0
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
