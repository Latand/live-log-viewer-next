# Recurring conversation monitor — issue #741

A scheduled job that reads what the operator asked for, checks whether the
machine is actually tracking it, and puts the gaps on the board.

## What it replaces, and why that mattered

A half-hourly watchdog already existed. It:

- read `state/pipelines.json` off disk instead of asking the API,
- counted pipelines in `running` / `needs_decision` / `queued` and sent one
  fixed nudge,
- addressed that nudge to a **hard-coded transcript path**, and
- wrote nothing on success.

Two of those are fatal on their own. The hard-coded path belonged to a
predecessor orchestrator whose session had had no live host for over a day, so
every fire delivered into a conversation nobody was reading while the live
orchestrator got nothing. And because a successful run wrote no output, its log
looked exactly the same whether it had worked perfectly or died on the first
call — there was no artifact that could tell the two apart.

Everything below is shaped by closing those two holes.

## Resolving the orchestrator

`GET /api/orchestrator/seat?project=…` returns the project's active seat: the
orchestrator's **stable viewer conversation id**, its settled transcript path,
and whether that transcript still exists.

The monitor resolves through that record and addresses the orchestrator **by
conversation id**, never by path. That is what makes a rollover, a restart or a
model swap survivable: the conversation id is the identity that follows the
orchestrator across generations, while a path is a fact about one generation
that stops being true the moment anything moves.

Resolving the address is not enough — somebody has to be listening. The record
is followed by a read-only host probe (`GET /api/tmux?path=…`, using the path
the record itself names, not a path anyone typed). Two reasons this is not
optional: the watchdog this replaces spent a day nudging a conversation with no
live host, and a send into a hostless conversation would **resume** it, which is
not the monitor's business.

**Unproven is not resolved.** The sin being corrected is a monitor that believed
it had delivered when it had not, so every path that cannot demonstrate a live
audience reports the condition instead of assuming one:

| Resolution | Meaning | Run outcome |
| --- | --- | --- |
| `resolved` | active seat present, transcript on disk, a host demonstrably owns it | `clean`, report delivered |
| `missing-record` | the project has no active orchestrator seat | `failed` |
| `stale-record` | the seated conversation's transcript is gone | `failed` |
| `unavailable` | the seat is unreadable, has no settled path to probe, the probe errored, or nothing hosts the conversation | `failed` |

That includes the two cases an earlier draft waved through: a **path-pending**
record (a spawn still adopting — nothing to probe, so nothing proven) and a
probe that **errored** (an unprovable host is not a live one, and delivering
anyway risks the resume this probe exists to avoid).

The last guard is on the far side of the send. If delivery reports that it
booted a host after the probe said one was there, the conversation had no live
audience when the report was written: the run records `delivered: false` and
finishes **failed**. A run that had to resurrect its own audience does not get
to call itself clean.

A failure to resolve is **reportable**, not a no-op: the run still scans and
still materializes board work, then raises a card carrying the fixed ref
`orchestrator-unresolved` (so it surfaces once, not every half hour), writes a
`failed` audit line, and exits non-zero.

## Reading operator requests

Source: `GET /api/conversations` for the catalog, `GET /api/session` for each
transcript touched inside the window. Three things get told apart:

1. **Operator text vs. everything else** — only `kind: "message"` with
   `role: "user"` counts. Assistant prose, reasoning and tool results are full
   of imperative language and would otherwise read as requests.
2. **Operator text vs. the harness** — injected context, caveats and interrupt
   notices arrive on the same `user` records. `taskTextFromPrompt`
   (`src/lib/tasks/inboxScanner.ts`) already recognizes those shapes and doubles
   as the concrete-request test: it answers with a title only for a prompt that
   is neither harness noise nor conversational chatter.
3. **Operator text vs. the monitor** — every delivered report opens with
   `⟦conversation-monitor⟧`, and a delivered message lands in the target
   transcript as a `user` record. Without that marker the monitor would read its
   own report back and materialize cards for the gaps it just reported.

Each surviving request gets a **fingerprint**: a sha256 prefix over the
lowercased, punctuation-stripped head of the text. Same ask typed twice, one
fingerprint.

## Correlation and classification

Evidence comes from the board (`GET /api/tasks`), pipelines, flows, and — when
`gh` can answer — pull requests and issues. Each source maps its own vocabulary
to `terminal` / `active` / `inert` in `evidence.ts`, so the matcher never learns
a pipeline state.

**Correlation is project-scoped.** An item answers only for requests made on its
own board; another project's card must never suppress a request here. Pull
requests and issues are repository-wide and carry no project, so they are
admitted only for a reference the operator named themselves.

Matching is shared-meaningful-word overlap against the smaller token set, plus
an explicit `#N`. Deliberately blunt: every card the monitor creates is a claim
that nothing correlated, so the operator has to be able to see why.

| Score | Verdict |
| --- | --- |
| ≥ 0.5 | correlated; state follows the evidence |
| 0.3 – 0.5 | too weak to call → `awaiting-confirmation` |
| < 0.3 | nothing correlates → `untracked` |

**A reference named in passing settles nothing.** "Ship the exporter before #741
lands" mentions an issue while asking for something else, and reading that
issue's closed state as terminal would retire a request nobody has done. So a
reference match reports whether the wording corroborates it; an uncorroborated
one (`contextual-reference`) goes straight to `awaiting-confirmation`.

States: `completed` (terminal evidence), `in-flight` (live evidence, owner named
when there is one), `stalled` (parked evidence, or live evidence that has not
moved past the stall threshold), `untracked`, `awaiting-confirmation`.

**Staleness is judged on movement, not on age.** A pipeline's last movement is
its newest stage-attempt or pause/resume instant and a flow's is its newest
round instant — never the container's `createdAt`, which would make every
container older than the threshold read as stalled however recently its stage
moved. A container whose payload carries no movement evidence reports unknown
freshness, and unknown is treated conservatively: still in flight, never
declared stalled on the strength of a missing field.

**GitHub issues are never created.** A request that asks for one classifies as
`awaiting-confirmation` and gets a card that says, in as many words, that no
issue was opened and the operator has to confirm first.

## Materializing gaps, idempotently

`untracked` and `awaiting-confirmation` become board cards through
`POST /api/tasks` (`placement: unplaced`). Everything else already has tracked
work and is reported, not duplicated.

**A card summarizes; it never quotes.** The body carries a short derived label
and monitor-authored context — no `> …` block of what the operator actually
typed. A card is pasted, screenshotted and pushed, and the publication gate
cannot help here: it inspects committed files, and a card is produced at
runtime. Everything emitted passes `redactMonitorText` first, which removes
credentials, email addresses, home directories, absolute paths down to two
segments, and the percent- and dash-encoded path forms that survive a plain
slash rule.

Each card carries a trailing `monitor-ref: <fingerprint>` line. That line is the
whole idempotency story: the next run reads the board back through the API, sees
the ref, and correlates the request **to the monitor's own card** — which is why
a re-run over the same window creates nothing further, and why a paraphrase of
the same request also lands on the existing card rather than a twin. The create
call additionally carries a deterministic `clientRequestId`
(`monitor-741:<fingerprint>`), so a retry inside the viewer's replay window is a
replay rather than a second card.

A per-run card budget (default 5) caps a pathological window; the overflow is
recorded as `card-budget` skips and picked up next run.

## Audit trail

One line per run, written through `POST /api/monitor/runs` and read back through
`GET /api/monitor/runs`. The **viewer** owns the file
(`state/conversation-monitor/runs.ndjson`, override with
`LLV_MONITOR_AUDIT_FILE`, retained to the last 200 runs); the monitor process
opens nothing. The route sanitizes every record to the audit fields it is
allowed to carry, so the privacy promise is structural rather than a convention
the caller is trusted to keep.

A run whose audit line cannot be written reports `audited: false` and exits
non-zero: a run nobody could record reads exactly like a run that never
happened, which is the ambiguity this whole mechanism exists to remove.

Outcomes are distinguishable by construction:

- `clean` — ran end to end. A run that found nothing is still `clean`, with
  zero counts. "No line" now means "no run".
- `failed` — the orchestrator could not be resolved, a required source refused,
  a card could not be created, or the report could not be delivered.
- `skipped` — the single-flight lock was held, or could not be granted. Two
  overlapping runs would race to create the same cards, so the loser records a
  decision rather than exiting silently, and a lock the viewer cannot answer for
  is treated as held rather than as free.

The lock lives behind `POST /api/monitor/lock` and is **atomic**: an `O_EXCL`
create serialized through the repo's file transaction, so two contenders cannot
both observe "free". Four racing processes are used to prove it, because an
in-process test cannot. The winner holds a token, and only that token releases —
a superseded run cannot free the lock its successor now holds. A holder whose
pid is provably gone, or whose claim is older than thirty minutes, is reclaimed.

The record carries fingerprints, counts, machine ids and states — **no
transcript text, no filesystem path, no account identity**. The classified
requests (which do carry operator wording) live only in the delivered report and
never reach the journal or stdout.

## Constraints held

- Read-only on conversations and worktrees; the only writes are board cards.
- Spawns nothing, resumes nothing, kills nothing. Surfacing is the scope;
  deciding and delegating stays with the orchestrator.
- Every read and write goes through the Viewer API — including the audit journal
  and the single-flight lock, whose files belong to the viewer and are reached
  over `/api/monitor/runs` and `/api/monitor/lock`.
- Everything emitted passes through `redactMonitorText` (secrets by the shared
  hardened redactor, then home directories and absolute paths).

## Running it

```sh
bun scripts/conversation-monitor.ts --window-hours 6          # a live run
bun scripts/conversation-monitor.ts --dry-run --json          # classify only
bun scripts/conversation-monitor.ts --status 5                # last five runs
```

Exit status is 0 for a clean or skipped run and 1 for a failed one, so the
schedule's own log distinguishes the three without reading the journal.

Scheduled from the viewer checkout, half-hourly:

```cron
*/30 * * * * cd <viewer-checkout> && bun scripts/conversation-monitor.ts --window-hours 6 >> <log-path> 2>&1
```

Flags: `--base-url` (defaults to `LLV_VIEWER_CONTROL_URL`, else the loopback
viewer), `--project`, `--max-conversations`, `--max-cards`, `--stall-hours`,
`--no-github`, `--deliver-when-empty`.

Without `--deliver-when-empty` a window that produced nothing delivers nothing —
a quiet half hour should not put a heartbeat in the operator's conversation. The
audit line is written either way.

## Tests

Run by path, against an isolated `HOME` / `XDG_CONFIG_HOME` / `TMPDIR` /
`LLV_STATE_DIR`; nothing here touches the shared registry.

```sh
bun test src/lib/monitor/ src/app/api/monitor/ scripts/conversation-monitor.test.ts
```
