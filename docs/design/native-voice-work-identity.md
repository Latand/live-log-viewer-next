# Native Voice: authoritative work identity

Originating requirement, 2026-09-10, controller assignment for parent issue 1629:

> Question: what authoritative identity does installed Codex0.154.0 carry from backing work into MCP tool calls, and how can native realtime handoff/item/bidi IDs be joined to that work?

> Deliver: precise fields and sample SYNTHETIC protocol envelopes; tested positive/negative comparisons; smallest integration design using existing Viewer identity/journal/control seams, covering A/B overlap, unrelated later textturn, hangup/reconnect and authoritative completion. If exact correlation is unsupported, specify a truthful non-actionable boundary and what a future authorized live capture would need. Preserve native operation semantics; no second scheduler/persistence framework or model guesses as authority.

## Finding and decision

Installed Codex **0.154.0 carries the native backing turn ID into actual MCP calls** in `params._meta["x-codex-turn-metadata"].turn_id`. The same object carries `thread_id`; `params._meta.threadId` repeats that native thread identity. Eighteen successful calls in three clean, serial fixture runs establish this behavior. Viewer currently drops the SDK's request metadata before dispatching its service call.

This enables a narrow improvement to request attribution. It does **not establish exact selected-card ownership for each realtime handoff**. Native V3 can steer multiple handoffs into one backing turn. The installed core discards the incoming bidi identity, routes handoff content as text, and emits its handoff notification without the accepted backing turn ID. The bundled app reconstructs an association in its UI state for lifecycle analytics. That reconstruction is insufficient authority for automatic target selection.

Decision: carry and validate native work metadata through existing Viewer seams; keep automatic voice selection non-actionable wherever either the utterance-to-handoff edge or handoff-to-work edge lacks authoritative evidence. An unqualified request in that state receives a typed refusal. Explicit targeting continues through the existing target validation and authority rules. This document authorizes no product changes or release.

## Evidence scope and provenance

The inspected Viewer HEAD is `016271376270bb306839ed2ea6b38199ea2de61c`. Its merge base is `22ca45579f01bb0088b753cc2cf7b84c93422f58`; a read-only remote main query confirmed that same main commit during this investigation. The independent review of this HEAD supplies the existing A/B leakage, duplicate/late handoff, and ten-minute retention reproductions. This investigation inspected their retained evidence without rerunning the product reproductions.

The executed interpreter was the installed Linux x64 Codex binary reporting `codex-cli 0.154.0`, SHA-256 `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022`. The separately inspected app is version `26.903.61454`, with bundled backend **0.153.4**. Its JavaScript bundle SHA-256 is `2a200058c034d70daeb6874c40e8b708879dd1060c9419c6271d91b0bfdc818f`. App-source observations must retain that version distinction.

Local schemas, app excerpts, installed code, and private review evidence were inspected first. Missing core implementation was then fetched from official OpenAI source: tag `rust-v0.154.0`, resolved commit **`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`**. This is source corroboration of the installed behavior; no reproducible-build equivalence is claimed. Relevant immutable source links appear beside the findings below. The official [app-server documentation](https://learn.chatgpt.com/docs/app-server) was also consulted for the thread/turn/item and request/notification model; it does not supply the missing inbound handoff ownership receipt.

Five transcript queries used project-scoped and unscoped phrasings. Three relevant conversations were opened through `conversation_messages`: the September 10 Voice writer, its September 10 independent reviewer, and the July 31 realtime continuity repair. The writer's queue-reset and time-retention claims are superseded by the independent review. The older continuity repair concerns transcript history and supplies no MCP work binding. A fourth historical conversation was opened but its returned page concerned unrelated seat recovery. A search for the exact metadata key found only this investigation, so no prior solution was adopted. Private transcript pointers and readbacks remain with the investigation artifacts.

Authoritative fixture artifacts are `run-09-clean`, `run-10-clean`, and `run-11-clean`; `verification.json` records **126 passing capture assertions**. Each run used fresh HOME, CODEX_HOME, XDG config/cache/data/state, temporary and Viewer state directories, an allowlisted environment, a fresh synthetic repository, and `project_doc_max_bytes = 0`. No operator auth/config was copied. Early exploratory runs discovered ancestor project instructions; those captures are excluded from the conclusions. The retained clean captures verify that no ancestor `AGENTS.md` instructions reached the synthetic Responses requests.

The Responses endpoint was loopback HTTP; MCP was a generated stdio server exposing only harmless `get_context`. The realtime probe used a loopback WebSocket server under pinned Bun **1.4.0**, with no microphone, audio frames, provider execution, or existing call access. Native realtime requires a nonempty auth-shaped value even for this endpoint, so the fixture supplied a generated inert literal to satisfy local validation and sent it only to loopback. No valid credential was used. Evidence covers WebSocket protocol behavior; WebRTC/media and production calls were not exercised. All scripts, logs, isolated state, upstream source copies, and failed attempts remain private outside the checkout.

## Actual MCP fields

The clean captures include the following fields. Field availability may differ across native execution modes; the table records the tested configuration.

| Wire location | Observed meaning and lifetime | Authority boundary |
| --- | --- | --- |
| JSON-RPC `id` | Client request counter: tool requests 2 through 7 in each fixture connection | Transport request/reply correlation; can repeat after a new connection |
| `params._meta.progressToken` | Progress counter: 1 through 6 for those calls | Transport progress correlation; no work ownership |
| `params._meta.threadId` | Same native thread across both turns | Core-supplied on this native connection; validate against the host's registered thread |
| `_meta["x-codex-turn-metadata"].thread_id` | Matches `_meta.threadId` | Same cross-check; never treat an arbitrary client's claim as a principal |
| `_meta["x-codex-turn-metadata"].session_id` | Equals the native thread in these fresh runs | Native execution/session metadata; **not the realtime session ID** |
| `_meta["x-codex-turn-metadata"].turn_id` | Stable across all calls in a turn; changes on a new turn; unchanged by steering | Core's backing work identity, within an authenticated/native-host-bound transport |
| `_meta["x-codex-turn-metadata"].turn_started_at_unix_ms` | Stable per turn in these runs | Timing evidence, unsuitable as an identity or completion signal |
| `_meta["x-codex-turn-metadata"].turn_trigger` | `"realtime"` on the native realtime-started backing turn; absent on the later text turn | Describes turn origin; cannot identify a particular handoff or steer |
| `params._meta.callId` | Copies Responses `function_call.call_id`; matches app-server `item.id` for the MCP call | Identifies a call occurrence within the native turn; value originates in the provider response |
| `params._meta.itemId` | Copies Responses `function_call.id` | Identifies the tool's provider output item; **not an inbound realtime delegation item** |
| `params.arguments.*` | Harmless labels and intentionally forged identity strings arrive unchanged | Model/provider-controlled tool input; confers no work authority |

Other captured turn-metadata fields were `workspaces`, `sandbox`, `sandbox_mode`, `auto_review_enabled`, `node_repl_auto_review_required`, `node_repl_disabled`, `model`, and `codex_version`. Workspace entries contain paths, so raw metadata must not enter public evidence. No MCP metadata key naming a realtime admission/session, inbound `handoff_id`, `user_bidi_turn_id`, or selected card appeared in the clean captures. Neither a top-level `_meta.turnId` nor `_meta["openai/turnId"]` appeared. Only the latter name deliberately placed **inside arguments** existed in the spoof case.

The exact source constructs `callId` and the turn-metadata object in `build_mcp_tool_call_request_meta`, then adds `threadId` and the optional originating tool `itemId` in `with_mcp_tool_call_ids_meta`. It constructs a separate metadata map rather than promoting tool arguments. See [MCP request construction](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/mcp_tool_call.rs#L1238), [turn metadata construction](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/turn_metadata.rs#L391), and [RMCP dispatch](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/rmcp-client/src/rmcp_client.rs#L794).

SYNTHETIC normalized excerpt of an actual MCP request. IDs are replaced consistently and ancillary metadata is omitted:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_context",
    "arguments": {
      "label": "turn-A-call-2",
      "turnId": "forged-turn",
      "threadId": "forged-thread",
      "_meta": {"openai/turnId": "forged-vendor-turn"}
    },
    "_meta": {
      "callId": "call_fixture_2",
      "threadId": "thread-synthetic",
      "itemId": "fc_fixture_2",
      "progressToken": 2,
      "x-codex-turn-metadata": {
        "session_id": "thread-synthetic",
        "thread_id": "thread-synthetic",
        "turn_id": "turn-A",
        "codex_version": "0.154.0"
      }
    }
  }
}
```

Its independently captured native `item/started` notification has `params.threadId = thread-synthetic`, `params.turnId = turn-A`, and `params.item = {type: "mcpToolCall", id: "call_fixture_2", server: "fixture", tool: "get_context", ...}`. The provider output item was `{type: "function_call", namespace: "mcp__fixture", name: "get_context", id: "fc_fixture_2", call_id: "call_fixture_2", arguments: "..."}`. The fixture selected both provider identifiers, proving that their presence in `_meta` does not make their value a native-generated work ID.

MCP server requests have a separate identity space. In the clean elicitation fixture, the MCP server sent this SYNTHETIC envelope while one tool call was pending:

```json
{"jsonrpc":"2.0","id":"synthetic-server-request","method":"elicitation/create","params":{"message":"Synthetic fixture confirmation","requestedSchema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}}
```

Native emitted an app-server request, with IDs normalized here:

```json
{"method":"mcpServer/elicitation/request","id":0,"params":{"threadId":"thread-synthetic","turnId":"turn-A","serverName":"fixture","mode":"form","_meta":null,"message":"Synthetic fixture confirmation","requestedSchema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}}
```

The harness returned `action: "cancel"`; native replied to MCP using the original string request ID. The app-server request carried thread/turn identity but no tool `callId`. Its `id: 0` is distinct from the pending MCP tool request counter and the server's string ID. A separate exploratory `approval_policy = "never"` run declined the elicitation automatically; it did not create an app-server question. No human interaction or product action occurred.

## Realtime joins and their limits

For the bundled app, the path is:

1. Its direct data-channel parsers accept `conversation.handoff.requested` with `handoff_id`, `item_id`, `user_bidi_turn_id`, or `delegation.created` carrying those identities under `item`.
2. The lifecycle tracker joins a `realtimeItemId` to an accepted Codex thread/turn pair.
3. On `thread/realtime/itemAdded`, the controller parses `item.item_id`, checks the current app turn is `inProgress`, and requires an item named `realtime-delegation-<item_id>` in that turn before recording the accepted association.
4. `observeRealtimeHandoffContext` feeds the lifecycle analytics tracker. Start/end analytics include realtime session, bidi, handoff, Codex thread and Codex turn IDs. This method injects no selected context into backing work.

These observations are from bundle offsets 2938120 (generated delegation item name), 2941145 (UI steering projection), 9555491 (lifecycle tracker), 9574934 (data-channel parsers), and 9611659 (context observer and preceding native-notification join). No raw bundled app source is reproduced here.

The generated `realtime-delegation-…` name is an app projection. In the installed 0.154.0 realtime fixture, native backing user-message items had generated IDs and `clientId: null`; none had that prefix. The first handoff notification also arrived **before** `turn/started`. Thus neither “the active turn when itemAdded arrives” nor the app's synthetic item label constitutes a native acceptance receipt available to Viewer.

The clean realtime fixture deliberately made all three incoming IDs different. This SYNTHETIC WebSocket event was actually submitted:

```json
{"type":"delegation.created","item":{"id":"delegation-A","type":"delegation","target":"client","handoff_id":"handoff-A","user_bidi_turn_id":"bidi-A","content":[{"type":"input_text","text":"Synthetic realtime input A."}]}}
```

Native emitted this normalized app-server envelope:

```json
{"method":"thread/realtime/itemAdded","params":{"threadId":"thread-synthetic","item":{"type":"handoff_request","handoff_id":"delegation-A","item_id":"delegation-A","input_transcript":"Synthetic realtime input A.","active_transcript":[{"role":"user","text":"Synthetic realtime input A."}]}}}
```

There is no backing turn ID or bidi ID in that event. The [V3 parser](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs#L83) explicitly uses `item.id` for both native `handoff_id` and `item_id`. The [app-server event adapter](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/bespoke_event_handling.rs#L609) emits the reduced handoff record. The raw data-channel handoff ID and normalized core handoff ID therefore need distinct names in an integration.

Synthetic `input_transcript.added` and `turn.done` events included source item/bidi identifiers. Native emitted canonical transcript events with role/text and separate generated transcript-segment IDs. Those incoming identifiers were absent. This proves loss through this parser, while leaving actual production event contents unverified. Canonical `thread/realtime/item/*` IDs and `realtimeSessionId` are useful for durable transcript/session history; they supply no demonstrated edge to an inbound handoff.

Core's [realtime fanout](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/realtime_conversation.rs#L1609) converts each handoff into delegation text and calls `route_realtime_text_input(text)`. That [routing method](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input.rs#L463) uses `StartOrSteer`; internally the result distinguishes `Started` from `Steered`. It discards that successful result and returns no identity-bearing receipt. This is the smallest upstream seam for a future authoritative handoff acceptance event: retain the incoming delegation identity through routing and emit the actual accepted turn/input association. Event order or text equality cannot recover the discarded relationship safely.

Native `bemItemPromoted` history contains an explicit backing `turnId` and `itemId`. It identifies backing output promoted into realtime presentation. It does not identify which inbound speech/handoff owns a later tool call. See [canonical realtime item types](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L35).

## Tested comparisons

| Comparison | Actual clean native result | Consequence |
| --- | --- | --- |
| Three calls in A, then three in B | Turn ID stable within each group; different between groups | Per-turn context can be isolated once its binding is authoritative |
| Forged argument thread/turn and vendor-looking metadata | Arguments preserved; native `_meta` unchanged | Read the transport metadata, validate it, and keep it outside argument merging |
| Provider tool `id` versus `call_id` | MCP `itemId` and `callId` remain distinct; native MCP item uses `callId` | Neither identifies an inbound speech item |
| New fixture connection | JSON-RPC and progress counters restart | Do not use either as durable work identity |
| A running, text B steered, further tool calls | B consumed in A's turn; same MCP turn metadata | Turn identity is coarser than an input or handoff |
| Native realtime A running, delegation B arrives | Both inputs consumed by one turn; MCP has `turn_trigger: realtime` and no handoff/bidi | Same-turn handoffs cannot select different cards by turn ID alone |
| Stop and reconnect while backing response is held | Realtime closes, new realtime session starts, then the original backing turn continues and completes | Hangup and reconnect are independent of work completion |
| Unrelated text turn after stop | New native turn ID; no realtime trigger | Never inherit the previous voice reference from conversation-level state |
| Transcript input with injected bidi/source item fields | Fields absent from native transcript output | These canonical events cannot currently prove the speech-to-handoff edge |
| Native server elicitation during MCP call | App-server thread/turn present; server request, app request and tool call have distinct IDs | Preserve each namespace; no inferred call ownership from request number |

The capture assertions test native protocol behavior. They do not implement or validate the proposed Viewer authorization changes. Duplicate/late handoff refusal and elapsed-time retention are requirements derived from the independent product review; no new product correctness claim is made for them.

## Smallest Viewer integration

Reuse the existing caller admission, runtime event journal, control hop, and MCP request binding. Add no scheduler, polling worker, lease manager, or separate context database.

1. At `createViewerMcpServer` in `src/lib/mcp/server.ts`, parse the SDK callback's `extra._meta` into a narrow request-context field. The inspected SDK sets it directly from `request.params._meta`; `extra.requestId` is separate. Preserve only the required native thread, turn, call and originating tool-item identifiers, with a version/provenance marker. Reject inconsistent thread fields, malformed metadata, and unsupported caller transports for automatic voice selection. Today the adapter forwards only deadline and cancellation information.
2. Resolve the caller through the existing process/registry/spawn-capability admission in `src/lib/mcp/bindings.ts`. Cross-check its provider thread against the claimed native thread and the host's authoritative turn/item events. Metadata narrows an already admitted caller; it grants no additional permission. Generic HTTP clients and model-supplied body fields cannot assert this transport provenance. Preserve the trusted origin across the existing MCP-to-control hop, rather than accepting an equivalent arbitrary request body.
3. Use `CodexAppServerHost`'s existing `eventStore.append(threadId, event)` and the shared runtime journal to record/replay the accepted association when such a native receipt exists. The host already owns provider thread identity and terminal turn events; `src/lib/runtime/codex.ts` normalizes turn/item notifications. An MCP `callId` can corroborate a recorded tool occurrence within that turn. A missing or delayed journal event means unavailable evidence; timestamps cannot repair it.
4. Extend `McpToolCallContext`, `voiceUtteranceLookup`, and the existing `utteranceContext` control action to carry expected work identity. Current lookup sends only `conversationId`, and current control reads `voiceUtteranceContext(conversationId)`. Resolve an immutable accepted reference for the expected work instead of the conversation's latest reference. `selectedContextTarget.ts` should receive a typed state indicating exact, ambiguous, absent, terminal, or unavailable evidence. These proposed states require implementation.
5. Bind a successfully admitted operation once through existing request/operation binding records. Preserve its reference and origin through retries and downstream recovery. Do not reinterpret the same operation's `clientRequestId` against a later selected card. `clientRequestId` remains model-supplied idempotency input, with no authority to choose work.

A minimal logical association contains existing caller/conversation identity, provider thread/turn, realtime admission identity, canonical delegation item, immutable selected-context reference, and journal evidence of acceptance/completion. Keep each observed identity in its own field. The metadata `session_id` cannot fill the realtime admission field. The tool output `itemId` cannot fill the delegation field. Store only proven edges; an incomplete association remains non-actionable.

For distinct native turns A and B, an accepted A operation keeps A after B joins. For multiple inputs/handoffs in one native turn, existing metadata lacks the finer ownership discriminator. Refuse new implicit targeting when more than one candidate or any unproven candidate can apply. An operation already immutably admitted to A may complete under its existing binding; a new call cannot claim A or B by inventing a handoff argument. Do not change native StartOrSteer behavior merely to manufacture separate turn IDs.

Late or duplicate handoffs must be deduplicated against their admitted realtime generation and canonical identity. Repeated identical evidence changes nothing; conflicting evidence preserves ambiguity. Never clear an ambiguous queue and treat a subsequent arrival as proof that the uncertainty ended. Closing or reconnecting a call closes admission for new observations in that generation and preserves earlier work records; late messages cannot acquire a new generation's reference.

Retain accepted context until authoritative terminal work evidence, including recovery when delivery is unknown. The clean native fixture proves that the voice call can close and restart before its backing turn ends. Use the matching native terminal turn event and the existing operation completion/recovery records to close the relevant work; do not retire a whole turn on one tool's completion. Hangup, socket loss, silence, ten minutes, a new text input, and an idle-looking UI are insufficient terminal evidence. A storage bound may make an unresolved lookup unavailable, while preserving its uncertainty/tombstone; it cannot authorize rebinding. No duration beyond ten minutes was run in this bounded investigation.

Required future integration tests must drive the real SDK-to-service-to-control reader: A/B independent turns, same-turn steering, absent/forged/mismatched metadata, repeated call IDs scoped to different turns, duplicate and delayed handoffs across ambiguity, unrelated later text, hangup/reconnect during work, recovery past ten minutes, and exact authoritative completion. Corrupt or missing binding evidence must produce zero implicit-target effects.

## Non-actionable boundary and future capture

No fully authoritative path from selected utterance through bidi/handoff to each backing tool call is established for this installed version. The smallest safe current behavior is a typed refusal for implicit voice-selected targeting, with explicit target selection available through existing controls. Native conversation, role, tools, interrupts, steering, speech and backing execution retain their semantics.

A future separately authorized live capture would need a single admitted call's raw input transcript/bidi events, both handoff event forms, native acceptance with the exact backing turn/input result, subsequent MCP metadata, and terminal events. It must cover A/B overlap, a duplicate and delayed handoff, hangup/reconnect, and a later text turn. It must establish which raw identity links the selected-reference capture to speech and which execution identity reaches every tool call. Capture only approved synthetic speech and cards, redact credentials, and correlate source IDs without text matching. If native still emits no acceptance receipt or per-input execution identity, a live recording alone cannot create the missing authority; the routing seam needs upstream support.

## Deferred — not currently justified

- A second handoff scheduler, new persistence framework, analytics retry service, or browser queue reconstruction. Existing controllers and journals already own execution and recovery.
- Treating app lifecycle analytics, BEM output promotion, one-outstanding-utterance order, or a time window as permission to select a card.
- Native/core source changes, private API emulation, full WebRTC/media testing, actual microphone capture, and real-provider calls. This assignment permits bounded protocol research only.
- A new ADR. No hard-to-reverse implementation choice is being made here.

Validation against the originating requirement: actual native MCP work metadata and its trust boundary are captured; handoff/bidi loss and same-turn overlap are demonstrated; the existing integration seams are identified; unsupported correlation has an explicit non-actionable outcome. The research contract is complete. Product implementation and exact utterance authority remain outside the demonstrated boundary.
