# WakaTime activity integration

Agent Log Viewer can publish project-scoped operator engagement from Claude
and Codex conversations to your WakaTime account. The integration starts only
when the Viewer process has
`LLV_WAKATIME_ENABLED=1`.

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

Each canonical direct operator action becomes a ten-minute WakaTime `app`
heartbeat stream:

| WakaTime field | Value |
| --- | --- |
| Project | The Viewer's canonical project attribution, including parent-repository grouping for worktrees. |
| Entity | An opaque, stable per-action identifier such as `agent-log-viewer/codex/0123abcd…`. |
| Category | `ai coding`. |
| Language | Omitted because transcript activity does not identify a source-file language. |
| Time | Engagement start, 120-second samples, and an exact ten-minute boundary marker. |
| AI session | An opaque SHA-256 action identifier. |

Project names, engine names, opaque action identifiers, the category, and
timestamps leave the machine. Titles, prompts, responses, transcript paths,
working directories, model names, account ids, source contents, and branch
names stay local.

A direct operator action contributes a ten-minute engagement interval sampled
at the same 120-second cadence. Viewer-structured Codex input and Claude input
classified as human are eligible. Legacy bare Claude input is eligible in root
conversations. Delegated launch input, harness messages, spawn instructions,
commands, notifications, SDK traffic, peer messages, and coordinator envelopes
contribute zero time. Agent execution, tool calls, and transcript churn also
contribute zero time without a direct root operator action.

The first enabled start creates a forward-only boundary. Engagement ending
before that timestamp remains local. An engagement interval that crosses the
boundary begins at the enable timestamp. The reserved `agent-log-viewer-boundary` project
contains interval-boundary markers. WakaTime assigns sub-timeout gaps to those
markers, keeping each canonical project limited to observed active spans.
Overlapping engagement intervals in one project contribute their wall-clock
union. Exclude the reserved project when reading project totals.

Resume and account-path rotation reuse the canonical conversation identity and
action timestamp. Copied fan-out input belongs to delegated conversations and
adds zero time. Repeated scans and delivery retries reuse durable event keys.
If durable project ownership settles after an event was queued, the Viewer
rewrites that undelivered activity to the authoritative project before sending.

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

On the first complete scan after upgrading from turn-based accounting, the
Viewer tags operator streams that are still provable from current transcripts
and retires untagged legacy agent streams and their queued rows before
delivery. Incomplete scans leave the outbox unchanged.

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

Send one direct operator message in a root conversation. In the WakaTime
dashboard, confirm the canonical project, `AI coding` category, ten-minute
engagement span, and idle gap after excluding `agent-log-viewer-boundary`.
Allow an agent tool call to continue beyond that interval and confirm that it
adds no project time. Stop network access for one tick, restore it, and confirm
that the queued activity arrives after recovery. Restart the Viewer during
queued work to exercise durable resume.

## Disablement

Unset `LLV_WAKATIME_ENABLED` and restart Agent Log Viewer. The scheduler stays
inactive and the outbox remains dormant on disk. Remove the key file when you
also want to revoke the Viewer's local credential access:

```bash
rm "${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer/wakatime-api-key"
```

Removing the local file does not revoke the key at WakaTime. Rotate or revoke
it from your WakaTime account when credential exposure is possible.
