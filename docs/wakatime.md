# WakaTime activity integration

Agent Log Viewer can publish observed Claude and Codex turn activity to your
WakaTime account. The integration starts only when the Viewer process has
`LLV_WAKATIME_ENABLED=1`.

The integration has two independent accounting products:

| Product | Purpose | Storage and network behavior |
| --- | --- | --- |
| Viewer activity analytics (#473) | Shows observed Claude/Codex execution and Viewer engagement in WakaTime. | Writes `agent-log-viewer/...` heartbeats and uses `wakatime-state.json`. |
| Operator worktime rollups (#763) | Produces deterministic, project-scoped daily drafts from proven operator input plus real editor evidence. | Reads raw WakaTime heartbeats, stores a local privacy-minimized ledger in `worktime-state.json`, and sends no worktime projection to WakaTime. |

Every `agent-log-viewer/...` entity and the reserved boundary project are
synthetic Viewer analytics. The worktime calculator excludes them from editor
evidence, including historical engagement streams created by #473.

## Setup

The key file is the supported credential source. This keeps the credential out
of shell history, process arguments, and process environments.

```bash
install -d -m 700 "${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer"
umask 077
read -r -s -p "WakaTime API key: " LLV_WAKATIME_KEY_INPUT
printf '\n'
printf '%s\n' "$LLV_WAKATIME_KEY_INPUT" > "${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer/wakatime-api-key"
unset LLV_WAKATIME_KEY_INPUT
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer/wakatime-api-key"
```

Set `LLV_WAKATIME_ENABLED=1` in the environment that starts Agent Log Viewer,
then restart the Viewer. The Viewer accepts the key file only when it is a
directly opened regular file with exact mode `0600`. Symlinks are rejected
before credential bytes are read.

The Viewer reads credentials in its Node process. It sends the key only in the
HTTPS `Authorization` header for `api.wakatime.com`. Browser payloads, local
state, request bodies, URLs, diagnostics, and transcripts exclude it. At
startup the Viewer discards any legacy `WAKATIME_API_KEY` value without reading
it, before any agent, reviewer, tmux pane, runtime host, or copied environment
snapshot is created. Resolved Compose snapshots, deployment commands, and
candidate container metadata also exclude the legacy variable. Replacing the
key file is detected on the next delivery tick, including after a Viewer
restart.

## Activity mapping

Each observed agent turn and direct operator engagement interval becomes a
WakaTime `app` heartbeat stream:

| WakaTime field | Value |
| --- | --- |
| Project | The Viewer's canonical project attribution, including parent-repository grouping for worktrees. |
| Entity | An opaque, stable per-interval identifier such as `agent-log-viewer/codex/0123abcd…`. |
| Category | `ai coding`. |
| Language | Omitted because transcript activity does not identify a source-file language. |
| Time | Interval start, 120-second active samples, and an exact interval-boundary marker at the end. |
| AI session | An opaque SHA-256 interval identifier. |

Project names, engine names, opaque turn identifiers, the category, and
timestamps leave the machine. Titles, prompts, responses, transcript paths,
working directories, model names, account ids, source contents, and branch
names stay local.

A direct operator action contributes a ten-minute engagement interval sampled
at the same 120-second cadence. Viewer-structured Codex input and Claude input
classified as human are eligible. Legacy bare Claude input is eligible in root
conversations; delegated launch input remains agent-only. Harness, spawn,
command, notification, SDK, peer, and coordinator envelopes do not create
operator intervals. These intervals union with agent turns on the same
timeline. Short turns retain the engagement tail, while long and silent agent
turns continue through their full observed execution.

The first enabled start creates a forward-only boundary. Completed work from
before that timestamp remains local. A turn that crosses the boundary begins
at the enable timestamp. The reserved `agent-log-viewer-boundary` project
contains interval-boundary markers. WakaTime assigns sub-timeout gaps to those
markers, keeping each canonical project limited to observed active spans.
Overlapping turns in one project contribute their wall-clock union. Exclude the
reserved project when reading project totals.

Open transcripts advance only while the scanner confirms a live agent process
and no idle composer or input gate. Abrupt exits, stale transcripts, and idle
composers freeze at the last proven activity timestamp. A live process remains
authoritative during silent long-running tool calls.

## Deterministic operator worktime

### Canonical local events

Composer, realtime speech, and API-human ingress attach a stable source event
ID. Structured runtime commands, held delivery, retry, resume, and Codex
transcript markers preserve this provenance. A direct occurrence counts once
at every conversation depth. Forwarded and fan-out occurrences retain the
source ID with `relation=copy`, so they add evidence while contributing zero
operator time.

The ledger hashes source IDs, occurrence IDs, lineage, and attribution
evidence before persistence. It stores the source class, earliest server
timestamp, project decision, ambiguity, and deduplication counts. Transcript
text, transcript paths, account identifiers, chat identifiers, and credentials
stay outside the state file.

Historical import walks an uncapped inventory of every configured Claude/Codex
account root and accepts explicit human provenance from each stable transcript.
Native stable IDs take precedence. Records without one use a SHA-256 fallback
over normalized content and the canonical lineage root, with a 30-second match
window. SDK, system, command, sidechain, compact-summary, tool-result, and
unprovenanced agent records are excluded. An incomplete global inventory,
per-entry derivation, or transcript read causes the whole day to remain
untouched; that pass performs no state write or credential-backed editor fetch.

### Editor evidence and calculation

For a requested Europe/Kyiv day, the reader fetches raw WakaTime heartbeats for
the adjacent UTC-date envelope and clips them to the exact local day. Entity
paths are used transiently for grouping and filtering, then replaced by
evidence digests. `agent-log-viewer/...` entities and
`agent-log-viewer-boundary` contribute only to the excluded-synthetic audit
counter.

The calculator applies these rules deterministically:

1. Deduplicated operator events with adjacent gaps of at most 30 minutes form one episode.
2. Each episode spans `max(last event - first event, 10 minutes)`.
3. Project episodes union with real editor intervals.
4. Cross-project overlap follows `LLV_WORKTIME_PROJECT_PRIORITY`, a comma-separated highest-first list.
5. Equal-priority overlap enters the ambiguity bucket independent of scan order.
6. Each project total rounds to the nearest 0.5 hour with a 0.5-hour minimum for positive work.

The rollup exposes raw minutes, rounded hours, canonical interval boundaries,
evidence counts, deduplication counts, excluded synthetic duration, and
ambiguous duration. Silent tools, process lifetime, transcript mtime, and
background execution never extend an operator episode.

### Catch-up, export, and delivery receipts

The WakaTime sidecar also owns a separately leased 15-minute worktime catch-up
pass. It walks every unprocessed complete Kyiv day in order. A failed day stops
the pass, and a later healthy pass resumes there. The first enable boundary is
persisted only after a complete inventory scan.

The model-free local export is:

```text
GET /api/worktime?day=YYYY-MM-DD
```

The route applies the loopback same-origin gate and refuses callers presenting
an agent conversation capability. Its JSON contains `rollup` plus the separate
`calculated_at`, `drafted_at`, `delivery_attempted_at`, `delivered_at`,
`destination`, `receipt_id`, `last_error`, and `payload_digest` lifecycle.

The delivery seam defaults to `private-draft`. Completion requires a transport
receipt whose destination and payload digest are confirmed by read-back.
Failed attempts retain an empty `delivered_at` and remain retryable; a confirmed
day is idempotent. This repository currently has no approved private-draft
transport adapter, so the scheduler calculates and exports drafts while
`delivered_at` remains empty. Wiring an external destination requires its own
transport ownership and receipt/read-back implementation. Group publication
has no implicit path.

Worktime state lives at
`${XDG_CONFIG_HOME:-~/.config}/agent-log-viewer/state/worktime-state.json` with
mode `0600` inside the existing `0700` state directory.

## Delivery and local state

The Viewer persists work to
`${XDG_CONFIG_HOME:-~/.config}/agent-log-viewer/state/wakatime-state.json`
before sending it. The state directory uses mode `0700`; the state file uses
mode `0600`. The outbox survives Viewer restarts and contains payload metadata,
including project names and timestamps. It also stores a nonsecret hashed
credential-generation marker derived from key-file metadata. It contains no
credential, raw key-file stamp, or raw conversation identifier.

One scheduler tick sends up to 25 heartbeats. Each outer `201` or `202` bulk
response is validated item by item. Successful items leave the outbox,
transient item failures remain under backoff, permanent item failures increment
the rejection count, and missing or malformed item lists retain the full batch.
Response bodies and error details stay out of diagnostics and state. The
five-second request deadline covers headers and response-body consumption, and
shutdown aborts either phase. Network errors, timeouts, WakaTime server
failures, and rate limits retain the batch under durable exponential backoff.
Outer HTTP 408, 409, and 425 responses also retain the full batch. The
scheduler honors `Retry-After` for HTTP 302 and 429 responses. HTTP 401 and 403
open a 15-minute circuit; replacing the key file retries with the new key on
the next tick. Other permanent HTTP 4xx responses remove the attempted batch
and increment a local count.

The outbox retains at most 10,000 events and 5,000 streams. During a long
outage, the Viewer compacts interior samples to ten-minute spacing and can
drop the oldest whole streams to stay within those bounds. Scanner requests,
agent execution, and browser responses do not wait for WakaTime delivery.
Compact retired watermarks keep delivered stream cursors for 30 days after a
stream-cap eviction, preventing a visible transcript from replaying its
already delivered history. Finalized boundary state also prevents later tail
changes from creating delayed boundaries for settled overlaps.

Blue-green releases coordinate through a process-shared scheduler lease in the
common state directory. The live owner retains that fence through promotion,
rollback, active request shutdown, and final settlement. A successor begins
work after it acquires the released or restart-recovered lease.

WakaTime's Heartbeats endpoint provides no idempotency key. Delivery therefore
has an at-least-once window: a process exit after WakaTime accepts a request
and before the Viewer records that acceptance can replay the in-flight batch
of up to 25 heartbeats. Other restart paths coalesce events through stable
local keys.

Back up `wakatime-state.json` with its file mode intact if you need to preserve
an undelivered queue. A corrupt file starts a new forward-only boundary and
emits a count-only server diagnostic; unreadable pending records cannot be
recovered without a backup.

## Verification

After restart, inspect server diagnostics for `[wakatime]` startup or failure
transitions. Repeated failures are rate-limited. Diagnostics contain outcome
classes, HTTP status values, retry timestamps, and counts.

Run one short turn and one turn longer than two minutes. In the WakaTime
dashboard, confirm the canonical project, `AI coding` category, active span,
and idle gap after excluding `agent-log-viewer-boundary`. Stop network access for one tick, restore it, and confirm that the
queued activity arrives after recovery. Restart the Viewer during queued work
to exercise durable resume.

## Disablement

Unset `LLV_WAKATIME_ENABLED` and restart Agent Log Viewer. The scheduler stays
inactive and the outbox remains dormant on disk. Remove the key file when you
also want to revoke the Viewer's local credential access:

```bash
rm "${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer/wakatime-api-key"
```

Removing the local file does not revoke the key at WakaTime. Rotate or revoke
it from your WakaTime account when credential exposure is possible.
