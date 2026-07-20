# WakaTime activity integration

Agent Log Viewer can publish observed Claude and Codex turn activity to your
WakaTime account. The integration starts only when the Viewer process has
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
snapshot is created. Replacing the key file is detected on the next delivery
tick.

## Activity mapping

Each observed agent turn becomes a WakaTime `app` heartbeat stream:

| WakaTime field | Value |
| --- | --- |
| Project | The Viewer's canonical project attribution, including parent-repository grouping for worktrees. |
| Entity | An opaque, stable per-turn identifier such as `agent-log-viewer/codex/0123abcd…`. |
| Category | `ai coding`. |
| Language | Omitted because transcript activity does not identify a source-file language. |
| Time | Turn start, 120-second active samples, and an exact interval-boundary marker at the end. |
| AI session | An opaque SHA-256 turn identifier. |

Project names, engine names, opaque turn identifiers, the category, and
timestamps leave the machine. Titles, prompts, responses, transcript paths,
working directories, model names, account ids, source contents, and branch
names stay local.

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

## Delivery and local state

The Viewer persists work to
`${XDG_CONFIG_HOME:-~/.config}/agent-log-viewer/state/wakatime-state.json`
before sending it. The state directory uses mode `0700`; the state file uses
mode `0600`. The outbox survives Viewer restarts and contains payload metadata,
including project names and timestamps. It contains no credential or raw
conversation identifier.

One scheduler tick sends up to 25 heartbeats. Each outer `201` or `202` bulk
response is validated item by item. Successful items leave the outbox,
transient item failures remain under backoff, permanent item failures increment
the rejection count, and missing or malformed item lists retain the full batch.
Response bodies and error details stay out of diagnostics and state. Network errors, five-second
timeouts, WakaTime server failures, and rate limits retain the batch under
durable exponential backoff. The scheduler honors `Retry-After` for HTTP 302
and 429 responses. HTTP 401 and 403 open a 15-minute circuit; replacing the
key file retries with the new key on the next tick. Permanent HTTP 4xx
responses remove the attempted batch and increment a local count.

The outbox retains at most 10,000 events and 5,000 streams. During a long
outage, the Viewer compacts interior samples to ten-minute spacing and can
drop the oldest whole streams to stay within those bounds. Scanner requests,
agent execution, and browser responses do not wait for WakaTime delivery.

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
