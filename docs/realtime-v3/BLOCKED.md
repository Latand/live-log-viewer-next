# Realtime V3 voice: a call runs two models, and only one of them holds the microphone

Verified 2026-09-10 against `codex-cli 0.154.0` (bundled app-server in the
current Linux ChatGPT build: `0.153.4`; the two agree on every field of the
contracts below). Everything under this heading is reproducible with
`python3 docs/design/codex-api-update/voice_probe.py`, which needs no credential,
no account and no network: it points the configured model provider at a local
fixture, so realtime call creation is captured verbatim instead of sent.

| | Model | Instructions it runs on | Tools |
|---|---|---|---|
| Spoken | `gpt-live-1-codex` | the `prompt` parameter of `thread/realtime/start`, and nothing else | none — a realtime session carries no tool inventory |
| Backing | the thread's own agent | the thread's own instructions, plus session-scoped `realtimeStartInstructions` | the thread's whole MCP inventory |

**The defect this cost us (#1629).** The Viewer wrote its voice persona into the
thread with `thread/inject_items` and left `prompt` unset. An injected item
reaches only the backing model, so the persona was delivered to the one model
that did not need it and withheld from the one that had nothing else — the
spoken model ran Codex's stock realtime persona, which introduces itself as a
general-purpose assistant, and whose `<startup_context>` block states in its own
words that it excludes repo memory instructions and AGENTS files. Enabling voice
on the operator's own orchestrator therefore produced a voice with no role, no
knowledge of what the thread behind it could reach, and a habit of answering for
itself. Meanwhile the injected item is appended to an append-only transcript and
never withdrawn, so every thread accumulated a permanent copy of the
spoken-delivery rules and kept answering in two-sentence spoken register long
after the microphone closed.

The probe establishes each half separately, on a thread carrying a synthetic
developer role/tool mandate:

- the mandate reaches the backing model, and does **not** reach the spoken
  session, whose instructions are the stock 5.7 kB persona;
- supplying `prompt` replaces those instructions;
- the spoken session body carries `instructions`, `model`, `audio` and
  `delegation` — and no tool list, in either case;
- `prompt`, `realtimeStartInstructions`, `realtimeEndInstructions` and
  `flushTranscriptTailOnSessionEnd` are deserialized, while an unknown field is
  accepted silently — so "the call succeeded" proves nothing about a parameter
  and the ill-typed control is what proves it is in the contract;
- none of the three session-scoped strings is written to canonical history,
  while an injected item is.

**What the Viewer sends now.** The persona is the session's `prompt`; the
role-preserving framing (and, for a session created to be the voice front, the
relay mandate) is the backing model's `realtimeStartInstructions`; hanging up
withdraws it with `realtimeEndInstructions`. `flushTranscriptTailOnSessionEnd`
is set, so the last thing said before a hangup is routed through Codex rather
than dropped. Nothing is written to the thread.

**What this does not establish.** No live provider call was made for any of it.
The probe proves what leaves the app-server and what the app-server persists; it
cannot prove what the provider does with a session body, that audio flows, or
that a live call keeps its role for its whole length. That needs a call on a
real account and is not something an implementation agent can produce.

**Where the Viewer still differs from the native app**, deliberately and with
the difference understood:

| | native Codex app | Viewer |
|---|---|---|
| `includeStartupContext` | `false` — it supplies its own continuity window | `true` — Codex's own curated context, plus the durable tail only when a streamed response has no committed item |
| transport | client-owned call, handed over as `existingCall` | server-created WebRTC |
| `clientManagedHandoffs` | not set at the frontend call site | `true` — client-managed delegation is what streams worker progress into the call |

Two of those are transport-ownership choices and neither is a defect. The startup-context
difference is a real one: a wider `initialItems` continuity window (native bounds
it at 128 items and 8,192 estimated tokens) would give the spoken model more of
the conversation than the latest turn, and overlaps with what startup context
already carries. Neither has been measured against a live call, so neither was
changed on the strength of the schema.

---

# Superseded reading (2026-07): "working — the cutoff was the alpha model default"

The measurements below stand and the model fix stands. What the table at the
bottom of this section reads as settled — that the handoff flags "turned out not
to be the problem" — was true of the 9-second cutoff and says nothing about the
persona split above, which nobody was looking for at the time. Keep the
incident; the section above is the current architecture.

## Realtime V3 voice: working — the cutoff was the alpha model default

`thread/realtime/start` sent no `model`, so the backend assigned
`gpt-live-1-boulder-alpha`, and every call on it was killed 9.0-9.4 seconds
after the sideband websocket connected with

```json
{"type":"error","error":{"type":"rate_limit_error","code":"rate_limit_exceeded",
 "message":"You have reached your usage limit."}}
```

Naming `gpt-live-1-codex` — the model Codex Desktop asks for — removes the
cutoff. A viewer call on that model has since run **16 minutes** with 20
delegation events and no error.

## Why the message cost a whole evening

Two of the three accounts tested were genuinely at
`x-codex-primary-used-percent: 100`, so for them the text was literally true.
The third sat at **5%**, its `POST /backend-api/codex/realtime/calls` returned
`201 Created` echoing that headroom, and it was cut at the same 9-second mark.
That third account is the only datapoint that mattered, and it took the whole
comparison table to isolate it. Credits (`x-codex-credits-balance: 0`) are the
top-up bought *after* a window is exhausted and explain nothing on an account
with 95% of its window free.

The decisive comparison was Codex Desktop pointed at that same account, on the
same machine and the same `codex` binary:

| | viewer (cut at 9s) | Codex Desktop (46s, clean close) |
|---|---|---|
| `model` | *(none — backend chose `gpt-live-1-boulder-alpha`)* | `gpt-live-1-codex` |
| `client_managed_handoffs` | true | false |
| `codex_responses_as_items` | true | false |
| `codex_response_handoff_mode` | Thinking | BemTags |
| `include_startup_context` | true | false |
| sideband `wss://api.openai.com/v1/live/…` | opened | never opened |

Only the model was changed. The handoff flags stay as they are — client-managed
delegation is what streams worker progress into the call — and they turned out
not to be the problem.

## What to keep in mind

- **The failure text is not a diagnosis.** The backend reports an entitlement
  cutoff and an exhausted window with the same sentence. Check
  `x-codex-primary-used-percent` on the call-creation response before believing
  it, and note that the app-server logs every one of those headers.
- **One realtime call per account at a time.** A second concurrent call is cut
  the same way; a stray Codex Desktop pointed at the same `CODEX_HOME` competes
  for the slot.
- `bun scripts/probe-realtime-v3.ts` reruns the evidence pass. Compare any new
  failure against the 9-second signature before assuming a quota.
- The reason now reaches the operator verbatim: a live call's
  `thread/realtime/error` is retained by the host and surfaced in the voice
  panel instead of the browser reporting only a dead transport.

---

# Superseded reading (2026-07-24): "unblocked — MVP proven"

The probe pass below was read as a success whose session merely "ended when the
account hit its usage limit". The 9-second measurements above show that ending
was the cutoff, not a quota. Keep the handshake documentation; discard the
conclusion.

The historical blocker below is resolved. The backend now admits realtime V3
calls for this account, and `scripts/probe-realtime-v3.ts` proved the complete
MVP against codex-cli 0.145.0:

- `thread/realtime/start` returned an SDP answer (audio + `oai-events` data
  channel m-lines) with no 404; `thread/realtime/started` reported `v3` with a
  realtime session id (probe runs `019f93e8-…debbb` and `019f93e9-…1884`).
- The live session ran on model `gpt-live-1-boulder-alpha` with
  `delegation: { type: "client" }`, exchanged spoken turns both ways with
  server VAD (`transcript/delta`, `transcript/done`, inbound audio bytes), and
  ended through `thread/realtime/error` + `closed` when the account hit its
  usage limit — a quota condition, separate from admission.
- The hosted thread carried the viewer MCP server with its full 23-tool
  inventory (`mcpServerStatus/list` scoped to the same thread), configured via
  the production `headlessCodexThreadConfig` path.

One host-side fix was required: the per-thread `features` override replaced the
app-server's global feature table, silently dropping the
`realtime_conversation` flag that `--enable` had set — every hosted thread then
failed locally with "thread does not support realtime conversation".
`headlessCodexThreadConfig` now restates the flag.

`bun scripts/probe-realtime-v3.ts` reruns the automated evidence pass;
`--interactive` opens a visible Chrome window on the real microphone for a
hands-on call. Probe output masks SDP bodies, tokens, and account ids.

---

# Historical blocker (2026-07, resolved)

This scaffold adds an independent conversational voice control beside the
existing composer dictation. It brokers Codex realtime V3 through the hosted
Codex app-server thread and keeps ChatGPT subscription credentials on the
server.

## Extracted subscription handshake

1. The browser creates an `RTCPeerConnection`, adds the microphone track, opens
   the `oai-events` data channel, and sends its SDP offer to the Viewer runtime.
2. The Viewer calls:

   ```json
   {
     "method": "thread/realtime/start",
     "params": {
       "threadId": "<active Codex thread>",
       "version": "v3",
       "outputModality": "audio",
       "transport": { "type": "webrtc", "sdp": "<browser offer>" },
       "clientManagedHandoffs": true,
       "codexResponsesAsItems": true,
       "includeStartupContext": true
     }
   }
   ```

3. Codex 0.145.0 creates the ChatGPT-subscription call with:

   ```text
   POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas
   Authorization: (masked) — the ChatGPT subscription bearer token
   ChatGPT-Account-ID: (masked) — the workspace account
   openai-alpha: quicksilver=v2
   x-session-id: <session id>
   x-oai-attestation: <Desktop attestation, when available>
   ```

   The request body carries the SDP and the V3 session configuration, including
   model `gpt-live-1-boulder-alpha` and client-managed delegation.
4. A successful response returns the remote SDP and call ID. Codex then opens
   `wss://api.openai.com/v1/live/<call-id>` for the authenticated sideband.
5. The app-server publishes `thread/realtime/sdp` and
   `thread/realtime/started`; the browser applies the SDP answer and keeps the
   duplex session open. Worker progress is forwarded through
   `delegation.context.append`.

## Current blocker

The Main ChatGPT account/environment receives a masked `404 Not Found` during
call creation. Confirmed request IDs:

- `e0afbe92-a159-…-c9a694dc8b67`
- `5d2266cb-3624-…-17cfc3067ce0`

The second reproduction included valid ChatGPT subscription authentication and
a Desktop-compatible fallback `x-oai-attestation`, with the same 404 result.
The current Codex Desktop build enables device attestation on macOS and Windows.
The Linux Desktop port reports `deviceAttestation=false`; Apple Silicon uses
the signed native `devicecheck.node` provider.

Resume after the ChatGPT realtime rollout admits this account/environment and
the deployment has a supported device-attestation path. Re-run
`scripts/probe-realtime-v3.ts` before enabling or merging the UI.
