# Realtime V3 voice scaffold: unblocked — MVP proven 2026-07-24

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
