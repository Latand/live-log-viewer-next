> **Originating requirement — 2026-09-08, operator assignment relayed by the orchestrator, canonical board task `[board task identifier redacted]`:**
>
> Separate Astra explicitly requested by operator: investigate ALL new relevant Codex API/features, especially message addition without steer, and plan correct integration. Work alone no helpers. Read AGENTS/openai-docs/orchestration skills. Local installed CLI/app-server code/schema first, then current official OpenAI release/docs/source verification. Pin installed/upstream versions/dates/flags. Search3-5 prior transcript queries scoped then unscoped, read actual turns via conversation_messages. Do not assume rumored method exists. Inventory append/queue/inject vs turn/start/steer semantics active/idle, persistence/events/ack/compaction/attachments/interruption/auth/approvals; map new features to current Viewer code and user outcomes. Verify with isolated probes only, clean homes/state, never operator sessions or live lifecycle. Source-ground each claim, label experimental/unavailable. Preserve immutable payload/operation keys and terminal delivery/recovery semantics, no blind retry. Deliver compatibility matrix, useful features, concrete integration slices/tests/rollback and existing canonical issue links; read-only GitHub discovery, no publication. Write only docs/design/codex-api-update. No product edits/commits/push/deploy/paid fallback. Integration is authorized after concrete findings with independent review; do not stop at generic recommendations. Finish report/artifacts and fenced JSON verdict. Canonical board [board task identifier redacted]. Other owners: board builder7b75cb8e prototype; auditor5fe29902 incident. No overlap.

The originating text is reproduced above with the internal board resource identifier redacted for this public repository. Source transcript identifiers below retain only their suffix.

# Codex API adoption design

**Corrected research candidate; product integration remains owed after review and file release.** The installed CLI already provides history injection without a new turn. Its acknowledgments and item identifiers are insufficient for Viewer's delivery guarantees. Keep ordinary messages on the existing journal and queue. Adopt working pagination and nonblocking question semantics first; add history-only input as a distinct, fenced operation only when its user-facing intent is explicit.

The continuation authorizes this sanitized research PR and the linked implementation issues; the earlier read-only discovery mandate above is historical.

This report covers all 155 installed request methods, the feature-flag listing, changed request/notification contracts since 0.151.0, and the relevant unreleased source delta. The [complete catalog](METHOD-CATALOG.md) records a disposition for every method. CLI editor conveniences, remote management, installation mutations, and account spending are accounted for without expanding this implementation scope.

## Evidence and version boundary

| Subject | Verified pin | Evidence and limit |
|---|---|---|
| Viewer | `88e5a9508be2802266734056d6436f3168201cad` | Clean dedicated branch started from freshly fetched `origin/main` at this SHA. Product files remain unchanged. |
| Installed CLI | `codex-cli 0.153.4`, Linux x64 | CLI version, installed package metadata, generated default and `--experimental` schemas, and isolated stdio probes. Package metadata alone does not prove binary/source equivalence. |
| Latest stable release | `rust-v0.153.4`, published `2026-09-04T23:25:48Z`; commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` | Official release API and tagged source, independently matched to local method inventory. [Release][release] |
| Baseline for “new” | `rust-v0.151.0`, published `2026-08-29T09:55:39Z` | Version implicated in the existing pagination incident [#1332][i1332]. Compared official schemas and protocol declarations. This is a research baseline, not a claim about every deployed account binary. |
| Newer prerelease | `rust-v0.154.0-alpha.6`, published `2026-09-07T18:03:36Z` | Release listing verified; release body contains no substantive changelog. Binary not installed or executed. [Prerelease][alpha] |
| Upstream main | `54e04f25dbfe342bf84809d1880dbca32cb43cf6`, commit time `2026-09-08T04:47:42Z` | Pinned protocol, implementation and test source. Source availability only; not a released or locally exercised contract. [Main pin][main] |
| Public documentation | Retrieved 2026-09-08 | Codex URLs redirect to ChatGPT Learn. Docs and local schema differ in coverage: queue and `isBlocking` are absent from the prose guide. Tagged schema/source and the probe resolve those questions. [App-server guide][guide] |

`generate-json-schema` exposes 99 default methods and 56 additional experimental methods. “Default” below means included without schema-generation `--experimental`; account access, feature configuration, model capabilities and individual experimental fields remain separate checks. The stdio protocol's initialization response reports a user-agent/version, platform and Codex home; it does not enumerate every supported method. Viewer currently sends `experimentalApi: true` globally at `codexAppServerHost.ts:1276` and enables `realtime_conversation` on launch at line 1250. Neither setting is evidence that every experimental feature works. See [selected schemas](evidence/selected-schemas.json) and [installed feature states](evidence/installed-features.txt).

The probe uses private `HOME`, `CODEX_HOME`, XDG config/cache/data roots, `LLV_STATE_DIR`, `TMPDIR`, and workspace outside the checkout under a short private temporary directory. Environment variables are allowlisted; operator credentials and configuration are never copied. A loopback HTTP fixture supplies synthetic Responses SSE. No external model service, subscription session, live Viewer lifecycle, tool execution, or paid fallback is involved. Results establish local app-server behavior; live model consumption, hosted authorization and production reliability remain unverified.

## Prior work checked against current source

Five initial search phrasings were issued in the required scoped-then-unscoped order: `Codex message inject`, `turn/steer`, `"thread/inject_items"`, `"message" "steer"`, and `"Codex" "API" "queue"`. The initial scope used a historical path-shaped project name and returned zero matches. Unscoped hits exposed the canonical project key; a sixth corrective scoped injection query then returned 26 matches. The broad final query mostly matched other projects and was discarded. This scope correction prevents treating those initial empty results as proof that no prior work existed.

Actual turns were read with `conversation_messages` at the returned transcript paths:

| Prior record, identified without private paths | Finding read | Current-main check |
|---|---|---|
| Injection review, 2026-08-02 07:06:28Z; transcript suffix `…a4d0f6a1eb2a`, record `953587` | Injection timeout escaped the mutation fence; item detection depended on serializer order; absent canonical path lost restart identity. | `MUTATING_RPC_METHODS` now contains `thread/inject_items` (`codexAppServerHost.ts:354`); bootstrap obtains a canonical path and scans before insertion (`:1905–1998`). Reuse that safety intent. The historical finding is not presented as a current defect. |
| Queue review, 2026-07-13 17:26:40Z; transcript suffix `…bda205e3da2b`, record `1347359` | A lost explicit-null turn fence let retry steer into an unrelated turn. | `structuredDeliveryQueue.ts:224` preserves `null`; the dispatch path carries the recorded fence (`:801–824`). New operations must preserve this distinction through recovery. |

These historical reviews predate the installed CLI. The isolated findings below and the current source control this design. GitHub discovery read issue bodies and states; nothing was posted or changed.

Follow-up searches for `isBlocking` and `perTurnModel` in the canonical project, then `request_user_input_async` unscoped, found no earlier independent solution. The `isBlocking` matches were this investigation and its contemporaneous relay; the relay was read through `conversation_messages` and excluded as independent evidence.

## Input compatibility matrix

Evidence keys: **P** = installed CLI probe; **S** = pinned official source/schema; **D** = current official prose. Model-side consequences inferred from pending-input source are marked explicitly.

| Operation | Idle thread | Active thread | Acknowledgment, persistence and events | Viewer decision |
|---|---|---|---|---|
| Viewer `policy: queue` | Existing controller dispatches a durable send | Waits for idle | Viewer operation ID, content digest, writer claim and terminal receipt remain authoritative. Ordinary send confirmation reads canonical user evidence. | Keep as default ordinary-send behavior. Current `structuredDeliveryQueue.ts:801–824`, `codexAppServerHost.ts:1420–1509`. |
| `turn/start` — default | Starts generation; returns initial turn | **Can append to the existing active turn.** P returned the same turn ID. | `clientUserMessageId` is carried into a user item's `clientId`; returned turn is admission evidence. Pending input can remain unapplied. S/P. | Retain Viewer's idle fence and serialization. Never use `turn/start` as an unconditional next-turn API. |
| `turn/steer` — default | Refuses: no active turn | Requires matching `expectedTurnId`; matching call returns that turn ID | No new turn boundary. Accepted pending input still needs canonical delivery confirmation. P stale/matching cases; [turn processor][turn-source]. | Explicit steer intent only. No fallback into a new turn after a stale-turn rejection. |
| `thread/inject_items` — default | Appends raw Responses history without generating a turn | Enqueues raw response items into active pending input; subsequent model requests may incorporate them | Returns `{}`. Idle path records and flushes rollout. Active path can acknowledge while items remain only pending; P accepted active injection, then interrupted, and found no corresponding canonical marker. No `turn/started` or ordinary user-item event attributable to idle injection in P. [Core injection][inject-source], [flush boundary][thread-core]. | Separate history-only operation, initially restricted to proven idle ownership. Do not replace ordinary sends or claim the model has read the input. |
| `thread/queue/add` — experimental | Automatically wakes a loaded idle thread | Persists queue entry for later dispatch | Returns server-generated submission ID plus input and client ID. Queue changes produce a lightweight `thread/queue/changed` notification; read list for contents. **Same client ID creates another entry.** P/S. | Do not enable native dispatch behind Viewer's existing scheduler. Evaluation remains separate; no queue migration in this plan. |
| `thread/queue/list/update/delete/reorder` — experimental | CRUD on durable queue | CRUD remains available subject to dispatch race | List is paginated; update preserves client ID while changing content. List absence can mean dispatch or deletion. No terminal delivery receipt is returned. [Queue processor][queue-processor], [service][queue-service]. | Read/list may support future diagnostics. Updating an admitted payload conflicts with immutable Viewer operations; create a distinct operation only after definitive cancellation of its predecessor. |
| `thread/queue/start` — experimental | Starts selected item or head | Refuses active/pending turn; preserves queue | Started item is deleted from queue after `start_turn_if_idle` accepts. It is not a receipt archive. P/S. | Cannot establish exactly-once recovery from queue absence. Keep disabled for Viewer delivery. |
| `turn/start.toolOutput` — default | Starts generation from standalone tool output with `input: []` | Queues tool output for active turn | Raw tool output remains tool output in history. Named output and ordinary user input are mutually exclusive. D/S; no live tool-result probe. | Useful future external-tool result path, under the same original operation and call identity. Do not mislabel human messages as tool results. |
| `thread/realtime/appendText`, `appendAudio`, `appendSpeech` — experimental | Requires a live realtime session | Realtime session semantics | Voice transport/handoff lifecycle; a voice-side acceptance does not settle a text-thread delivery. Existing Viewer speech path is at `codexAppServerHost.ts:2000`. | Keep within existing voice ownership. No message-delivery substitution. |
| Hypothetical `message/add`, `thread/append`, `turn/append` | No matching method in either installed schema | No matching method | No evidence these names exist in this app-server. | Do not call or advertise them. |
| Responses WebSocket `response.steer` / beta `response.inject` | Separate API surface | API-owned response/lane semantics | Official steering uses accepted/pending/failed events and successor response creation. Beta injection currently describes client-owned tool outputs. These are distinct from Codex app-server RPCs. [Steering guide][steering], [beta reference][beta]. | Out of scope for subscription-hosted Viewer. No direct Responses client or API-key fallback. |

The native queue's `clientUserMessageId` is correlation data. In the probe, two identical adds and one changed-payload add with the same value returned **three distinct submission IDs**. Repeating `thread/inject_items` with one item ID likewise produced duplicate rollout records. The existing Viewer dedup envelope and payload digest must survive even when native correlation improves.

Interruption deliberately preserves queued submissions. A normal cold resume dispatched a persisted queue automatically in P; the separate interrupted-thread scenario retained its queue after resume. A generic “resume is read-only” assumption would therefore be wrong for native-queue adopters. Source explicitly skips idle dispatch on `Interrupted` and starts queued input at other idle boundaries. [Queue lifecycle][queue-service]

## Useful features and current Viewer fit

The method names alone understate the relevant change: between 0.151.0 and 0.153.4 the default request list adds only `plugin/reconcile`, while existing methods gain behavior, metadata and new model-enabled tools. Common protocol declarations add auth-recovery notifications. Injection, native queue, turn settings and goals already existed at the 0.151 baseline; they are **newly evaluated adoption opportunities**, rather than claimed new releases.

| Feature / status at installed version | User outcome and current seam | Integration decision / evidence |
|---|---|---|
| `thread/turns/list`, `thread/items/list` — default, locally working | Bounded durable evidence without reading a whole rollout. Viewer currently tries full hydration, then a disk fallback (`codexAppServerHost.ts:1512–1560`). | First implementation slice. P returned persisted `userMessage.clientId` through both methods after restart/interruption. Cover `itemsView`, cursor exhaustion and item pages. Existing canonical context: [#1332][i1332], [#1327][i1327]. |
| Nonblocking `request_user_input_async` — model-enabled; server request contract experimental | Ask the operator while continuing useful work. Same `item/tool/requestUserInput` channel carries `isBlocking`; missing field defaults to true upstream. Viewer preserves questions but drops this field (`engineHostEvents.ts:208–259`, `codex.ts:105–123`); contracts/render model expose only `autoResolutionMs`. | Second slice: preserve `isBlocking` in host pending state, scheduling, recovery, attention projection and UI. Preserve both synchronous and asynchronous questions. `autoResolutionMs` is deprecated for the blocking decision. [Question schema][items-source], [0.153 release][r153]. Production behavior not probed. |
| `turn/start.model`, `effort`, `serviceTier`, `serviceTierForTurn`; experimental thread/turn settings update | Apply the operator's next-message settings without replacing a host where supported. Viewer hardcodes `perTurnModel: false` (`contracts.ts:264–277`) and sends only effort (`codexAppServerHost.ts:1487–1504`). | Correct the capability model after isolated settings tests. Snapshot settings with the operation. Ordinary fields are sticky for subsequent turns; `serviceTierForTurn` is the one-turn tier override. Experimental active-turn settings retain already-captured steps/pending reviewers. [Turn schema][turn-schema], [#390][i390]. |
| `Thread.model`, `reasoningEffort` — new nullable metadata | Show the effective profile after resume rather than assume stored UI settings won | Consume nullable fields with provenance; retain requested/effective separation. New in 0.153.0. [Thread data][thread-data], [r153]. |
| `model/list`, provider capabilities, experimental-feature and permission-profile lists | Accurate model/effort/image support and effective constraints | Viewer already checks image input through `model/list` (`codexAppServerHost.ts:1410`). Extend this existing negotiated capability seam; avoid a second model registry. Preserve the exact explicit model. [Model schema][model-source]. |
| Astra catalog corrections in 0.153.1–0.153.4 | Correct picker availability and tool guidance | Installed version has the current stable hotfixes. No global upgrade is necessary for these fixes. `request_user_input_async` is conditional on tool availability. [Release][release] |
| `modelProvider/authRecoveryStarted/Completed` — new notifications | Explain authentication recovery without falsely showing agent progress or quota exhaustion | Map to bounded account/host status; a completed refresh alone does not establish delivery. Existing `accounts/codexAppServer.ts`, `accounts/codexRuntime.ts`, host notification handler. [Notification schema][notifications], [0.152 release][r152]. |
| Rate-limit resets, usage and workspace messages — default APIs | Show actual account capacity and refresh after a reset | Reset-credit read/consume already implemented (`codexAppServer.ts:342`, `codexRuntime.ts:356–378`). Reuse [#1373][i1373]; stale quota reconciliation remains tracked by [#1404][i1404]. Do not add automatic spending, email or new MCP spend tools. |
| Structured approvals, Guardian reviewer, permission profiles | Keep approval authority and pending answers consistent after reload/compaction | Keep pending request ID, thread/turn and original approval context. Preserve unknown requests fail-closed. 0.153 improves retained Guardian history and account-scoped MCP approvals; those fixes are upstream behavior, not evidence of Viewer acceptance. [Permissions][permissions], [r153]. |
| `thread/goal/get/set/clear`, goal and usage events — default | Show existing engine objective/budget without a second task controller | Viewer already calls goal/set in managed runtime. Read-only projection is useful if requested; do not use engine goals to start hidden orchestration or overwrite board tasks. [Goal schema][thread-schema] |
| Context management experimental mode, history notes, `new_context`, token budgets | Longer supported work sessions and explicit context status | Leave off until history/delivery tests cover history replacement, compaction and recovery. Release describes eligible ChatGPT Plus/Pro/Pro Lite Codex-backend sessions; custom-provider and temporary structured threads are excluded. No eligibility claim for operator accounts. [r153] |
| Rollout/shared-history compression; structured token-usage records | Keep old conversations readable and prevent telemetry becoming chat text | Schema-aware pagination reduces dependence on disk encoding. Existing scanner/session parsers remain required for cross-engine history. Test compressed/shared histories before changing defaults. [r153], [#1523][i1523] |
| `additionalContext`, retention of client developer messages | Send trustworthy application context and separately marked untrusted context | Preserve author and role; do not promote user content into developer instructions. `retain_client_developer_messages` is under development/off in the isolated defaults. Compaction retention needs its own probe. [Turn schema][turn-schema], [Core injection][inject-source] |
| Input text/image/localImage/localAudio/skill/mention families; richer tool output media | Preserve attachments and links with delivery | Existing Viewer normalized content handles text and stored image refs. Native queue snapshots local images/audio before persistence; injection expects raw response items and validates image URLs. Any new type needs immutable blob/content digest, retention through unknown outcome, MIME/size admission and negotiated model support. [Queue preparation][queue-service], [selected schemas](evidence/selected-schemas.json) |
| `plugin/reconcile`, MCP cache refresh, app-account approval scope, tool output limits | Explain stale/unavailable tools and preserve account-specific consent | Add diagnostics to existing plugin/account paths only when a supported response is available. Reconcile is a mutation requiring its own uncertain-outcome handling. Per-tool `output_token_limit` and refresh fixes are upstream configuration/behavior. [r152], [r153] |
| MCP event streams — experimental; `tools_error` on future main | Surface background tool events or an explicit discovery failure | Defer subscription/event-source wiring until there is a concrete tool requiring it. Future `tools_error` should be presented as unavailable tools, never empty healthy inventory. [MCP schema][mcp-main] |
| `thread/shellCommand.timeoutMs` — new default field | Long-running shell control can name a deadline | Viewer already has owned tool processes; no separate shell-command surface is justified. Verify units/range if adopted. [r152], [thread-schema] |
| Daemon/proxy, stdio, unix and websocket transports; websocket auth flags | Persistent or remote clients can connect to app-server | Current Viewer stdio owner remains sufficient. Adopting a daemon would change exclusivity, lifecycle and replay authority; defer. `--ws-auth`, token-file/hash and JWT issuer/audience options exist in installed help; no listener or authentication probe was run. |
| Skills/hooks, plugin marketplaces, apps, fs/watch, command/exec, process/PTY, project/section/search, background terminals, remote control, environments and external import | Additional UI and management functions | Full method catalog records each family. Viewer already owns project grouping, process ownership and orchestration. No blanket RPC proxy, remote-control migration or filesystem API expansion. |
| TUI Vim draft undo/redo/search, paste setting, recap, reconnect | Preserve CLI user's drafts/history | Release-relevant, CLI-specific. Viewer can retain its existing draft/outbox model; no terminal editor changes in this task. [r152], [r153] |

### Unreleased main, separately labeled

Pinned main adds four experimental `userVerification/*` methods absent from installed 0.153.4. Their contract is local readiness/enrollment/deletion and signing a supplied challenge; status does not query server registration. The types allow unavailable/cancelled/failed outcomes. They do not establish browser member identity or solve [#1497][i1497]. No native implementation, Linux support, enrollment or credential use was probed. **Unavailable to this installed integration.** [Future verification contract][verification]

Other source deltas: optional Daybreak thread metadata (no access grant), hosted-only `thread/list.originators` (local nonempty values rejected), environment metadata/path compatibility types, app/WebMCP requirements, optional MCP tools errors, and richer account fields (`excludeResetCreditDetails`, `ordinaryUsageAllowed`, `normalModelSlug`, `supportsLunaReserve`). Preserve tolerant parsing and unknown states; do not expose unsupported controls based on source presence. [Future thread metadata][future-thread], [future account contract][future-account], [MCP][mcp-main]

## Integration slices and acceptance gates

Each slice is independently reviewable. [The actionable handoff](INTEGRATION.md) gives exact file manifests, dependency ordering, canonical issue discovery and tests. Integration is authorized after the release gate and file release; this lane changes only docs and probes. The orchestrator assigns review and implementation without overlap.

### 1. Use native pagination for authoritative delivery evidence

**Behavior:** new app-server versions supply bounded first/latest user-item evidence through pagination. Older versions keep the proven disk fallback. Preserve exact thread and operation identity throughout.

**Files:** `src/lib/runtime/codexAppServerHost.ts`, its focused host/materialization tests, existing account protocol decoder only if needed. One reader seam, shared by resume materialization and delivery confirmation. Metadata-only read obtains identity; turns/items pages obtain evidence. `itemsView: summary` cannot be treated as exhaustive. Stop on a matching immutable client ID plus canonical content/digest; bound bytes and pages. Exhausted bounded search yields unknown unless a stronger lifecycle fact proves terminal absence. A pagination transport error is not permission to resend.

**Tests:** real isolated 0.153.4 stdio thread with persisted user item, second page and items page; legacy not-supported response; wrong thread/client ID; duplicate text with distinct operation IDs; missing later page; delayed item after timeout; oversized tool history; compressed/shared-history fixture. Force the negative path by removing the required user record. Cover original-key recovery after host replacement. Existing main incident context: [#1332][i1332]; terminal receipt context [#1131][i1131].

**Rollback:** stop preferring native pages for new reads; retain the old reader. No schema migration or queue ownership change. Never redispatch an unresolved send during rollback.

### 2. Preserve nonblocking questions end to end

**Behavior:** a question with `isBlocking: false` stays answerable while the conversation can continue working. A missing field follows the older blocking contract. An elapsed UI timer never invents an answer or approval.

**Files:** `codexAppServerHost.ts` (`PendingAttention`, `acceptParsedMessage`, `currentState`, ledger restore and buffered replay), `engineHost.ts`, `engineHostEvents.ts`, `codex.ts`, `contracts.ts`, runtime journal attention projection, `components/runtime/runtimeModel.ts`, `AttentionCard.tsx`, and `ConversationAttention.tsx`. The exact manifests and test paths are in [the integration handoff](INTEGRATION.md#2-nonblocking-questions-across-host-scheduling-and-recovery). Host and queue files require release by the deployment owner.

**Scheduling and recovery:** current host source gives every pending request `attention` status (`codexAppServerHost.ts:2330`), which blocks queue dispatch and explicit steering (`structuredDeliveryQueue.ts:801–809`). Preserve validated `isBlocking` in current and restored pending records. Only a recognized question with literal false is nonblocking; true/missing/null/malformed flags, approvals and unknown methods block. Keep all outstanding IDs in `pendingAttention` for answering and retirement protection. Nonblocking requests permit active status during generation and idle status only after authoritative idle evidence. Restore the flag through event-ledger and buffered replay while preserving request/generation identity. A restored RPC request must not be answered under a new generation's ID.

**Tests:** paired otherwise-identical events with true/false/missing/malformed `isBlocking`; multiple question IDs; options absent; reply arriving after turn completion; duplicate answer operation key; cancellation and stale host request; reload/replay. Confirm both ongoing activity and answer affordance. With an unanswered false request, a real host fixture accepts matching-turn explicit steer and dispatches exactly one ordinary message after true idle; mixed requests keep blocking until their own resolution. Replay and host retirement retain unresolved IDs without fabricating answers. Use server-request fixture frames first; model-enabled real questioning remains an explicit later eligibility test. A canned fake question alone cannot prove the model exposes the tool.

**Rollback:** retain the optional field in durable records; hide new presentation if necessary. Keep original pending request IDs, resolutions and any operator answers. No new generic timeout-answer subsystem.

### 3. Apply the exact next-message profile using supported fields

**Behavior:** capture selected model/effort/tier with the admitted operation. On an idle new turn, send supported `turn/start` fields. On active steer, defer next-turn settings; do not silently mutate the running turn's profile.

**Files:** runtime capability contract, `codexAppServerHost.send`, current reconfiguration queue/profile code, composer capability consumer. The public requirement already exists in [#390][i390]. Full model/effort validation must use the selected model's supported values. Preserve permission profiles, cwd, ownership and account selection.

**Tests:** two queued messages carrying different snapshots; restart between them; active steer leaves active settings unchanged; unknown model/tier refused before actuation; null/omitted service tier; one-turn tier versus sticky tier; server accepted request with lost reply does not cause a second start. Use local backend requests to inspect actual profile forwarding. Before enabling it for ChatGPT, independently verify model/plan support without changing the user's chosen model.

**Rollback:** disable new per-turn model/tier capability for new admissions and use the existing reconfiguration path. Preserve the settings already frozen on unresolved operations; do not reinterpret them through current UI state.

### 4. Add a narrow idle history-context operation

**Behavior:** a caller explicitly adds context for future model requests without asking for a new answer. The receipt may say “stored in conversation context” after canonical persistence. It cannot say “agent read it.” Active injection is excluded from the initial supported behavior because its acknowledgment can precede persistence.

**Files:** existing runtime command admission/journal, `EngineHost` optional capability, `codexAppServerHost`, canonical evidence reader and receipt projection. Reuse one immutable operation record; add an operation kind rather than invent a second outbox service. Keep ordinary message content in user role. Context supplied by an agent retains that authorship. Only a trusted application-owned entry point may supply developer-role content.

**Identity:** freeze `(conversationId, operationId, contentDigest, input kind, role/origin, target generation, idle fence)` at admission. Derive a stable item ID once. Serialize under the same writer/operation boundary as ordinary sends. Scan canonical history before first mutation and after unknown outcomes. A repeated item ID is not server-side deduplication. A lost response fences the writer; preserve payload, image blobs and original key until authoritative settlement. Require a dead/retired original writer and complete canonical evidence before any permitted replay; a single negative scan while its writer lives proves nothing.

**Tests:** idle injection starts zero turns and reaches the next model request; user item with the right role/origin survives restart; same operation/different payload rejected; lost ack after persistence reconciles without mutation; late persistence after timeout; failure before persistence; canonical path unavailable; corrupted/unreadable history; active/idle transition at actuation; concurrent ordinary send; compaction between acknowledgment and recovery; attachments stay retained while unresolved. Reproduce the probe's duplicate-on-repeat result as the red control. Test terminal response wording in both HTTP and MCP receipt projections.

**Authorized initial scope:** integrate a narrow existing application-context use after evidence review and file release. A new composer button needs a separate UI requirement. Existing persona injection already has its own recovery path; coordinate any hardening with the current incident owner instead of editing that lane here.

**Rollback:** disable new admissions of this operation. Continue reconciling admitted operations by original key. Do not remove history, reinterpret it as a send, discard blobs, or switch unresolved operations to native queue.

### 5. Add bounded compatibility and authentication diagnostics

**Behavior:** record the selected executable version and observed capabilities once per host generation; display auth recovery and unavailable features truthfully. Existing account reset UI and native goal configuration remain the owning surfaces.

**Files:** account app-server client, host initialization/notification decoder, existing capability and status projection. Use a small static schema contract plus observed version and read-only discovery. Avoid generating 155 UI controls or shipping the full generated schema graph as a new runtime dependency.

**Tests:** unknown future notification; malformed auth completion; account remains unauthenticated; feature advertised but unavailable; permission-profile parse failure; reconnect retains pending receipt identities. Existing quota correction belongs to [#1404][i1404], not a new duplicate issue.

**Rollback:** hide added status details. Authentication failures continue to block unavailable operations; never fall back to an API key or different account/model implicitly.

## Delivery and compaction invariants shared by every slice

1. Separate client RPC request ID, Viewer operation ID, engine client-message ID, history item ID, native queue ID and turn ID. Store the relationships; none can substitute for another's contract.
2. Admission freezes payload, attachments, settings, role/authorship and the explicit null/string turn fence. Retrying transport retains these values and the original operation key.
3. Acknowledgment, queue persistence, canonical message persistence, model consumption and terminal turn completion are separate facts. Expose only the strongest verified fact. Terminal recovery `deliveredAt` must come from authoritative delivery evidence; do not assign reconciliation time as the delivery time.
4. Timeout, disconnect, incomplete pagination and “not found yet” preserve unknown outcome. Keep unresolved outbox entries, operation identity and blobs. Existing source owners are `structuredDeliveryQueue.ts`, `structuredRecovery.ts`, `runtime-host/journal.ts` and `components/conversation/outbox.ts`.
5. Compaction starts asynchronously (`thread/compact/start` returns `{}`). Existing host code correlates lifecycle completion at `codexAppServerHost.ts:1642–1776`; keep that control separate from user input. Unknown compaction outcome cannot justify a second compact. A compacted-away marker cannot prove an earlier injection never happened.
6. Approval or question responses preserve server request and generation identity. Account refresh, native queue restart, background tool output and voice handoff must never resolve an unrelated pending request.

The earlier terminalization design in [#1225][i1225] explicitly rejects new-key retry after possible handover. That is the canonical dependency for any future cancellation/edit/retry control. [#561][i561] remains the queue-first composer requirement. This investigation creates no replacement issue.

## Deferred — not currently justified

- **Native queue as Viewer's transport queue:** automatic dispatch adds a second scheduler and bypasses migration/ownership admission unless redesigned. Same-key adds duplicate; queue entries disappear before a terminal delivery proof. Existing Viewer queue is the simpler mechanism. A later adoption requires a single scheduler, crash windows on both sides of dispatch/deletion, cancellation serialization, attachment snapshot identity and terminal receipt recovery. No dual-write transition.
- **Active raw injection:** it can affect active work and remain non-durable after ack. Shipping it as “non-steering message addition” would promise more than the observed contract. Preserve an explicit unknown state if future callers require it.
- **Direct Responses API transport, beta injection, app-server daemon takeover, remote-control and native project migration:** none is needed to use the installed app-server improvements; each expands auth/lifecycle ownership.
- **Automatic context-management enablement, new-context tooling, active-turn model/reviewer mutation:** require dedicated compaction, permissions and profile tests. Avoid bundle-wide feature toggles.
- **User verification as Viewer sign-in:** experimental future challenge-signing does not establish the browser-session/member contract of [#1497][i1497]. Keep its canonical design separate.
- **Standalone tool-output entry UI, audio attachments, extra plugin/marketplace controls, account spending, external emails, native goals as board automation:** retain in inventory; implement only from an explicit user outcome and appropriate authority.
- **TUI editor parity:** editor shortcuts and terminal recap need no Viewer integration for this requirement.

No ADR is created: the recommended changes reuse existing reversible adapters and preserve the current ownership model. Adopting a second queue or daemon would be the point requiring a separate architectural decision.

## Verification, limitations and handoff

The corrected run records **46 cases and 15 passing assertions**, plus **11 focused evidence tests**. `record_snapshot` deep-copies nested responses. Event snapshots capture an explicit interval and target thread; canonical rows retain thread and transcript aliases derived from each rollout's session metadata. Original-thread repeated injection has exactly two rows, and the second thread has one. Dispatch requires a matching turn-start, completed user item/client ID/content and persisted input in the same thread and turn. Wrong thread, wrong turn, missing persistence, missing dispatch, wrong client/payload and mismatched transcript aliases fail the corresponding checks. Later scenarios cannot alter earlier snapshots.

```sh
rtk proxy python3 docs/design/codex-api-update/probe.py
rtk proxy python3 -m unittest discover -s docs/design/codex-api-update -p 'test_*.py' -v
```

The probe creates credential-free homes outside the checkout with short `/tmp` paths, runs only its owned fixture processes, and writes sanitized [results](evidence/probe-results.json). Three requests reached the local SSE fixture. Consistent `thread-a`/`thread-b`/`thread-c` and `fixture-id-*` aliases preserve equality, including identifiers embedded in message IDs. Full instructions and operator credentials are excluded.

For inventory reproduction, choose a private directory outside the checkout, then run:

```sh
rtk proxy python3 docs/design/codex-api-update/prepare_inventory.py --state "$PRIVATE_EVIDENCE_DIR"
rtk proxy python3 docs/design/codex-api-update/inventory.py --state "$PRIVATE_EVIDENCE_DIR"
```

`prepare_inventory.py` checks installed version, regenerates default/experimental schemas in isolated homes and downloads only official pinned source paths. Every input must match [source digests](evidence/source-sha256.json). Raw source and schemas stay private. The refreshed main pin is `54e04f25dbfe342bf84809d1880dbca32cb43cf6`; all 119 inputs match the reviewed source bytes. Latest stable remains 0.153.4; prerelease remains unexecuted. The prose guide was fetched again; installed schemas control enum/field spelling where they differ.

The September 8 00:38:54 UTC review rejected the original artifact for 852 tracked scratch files, omitted host scheduling and mutable/unattributed evidence. The preserved original was not edited or cherry-picked. This branch imports only compact artifacts and corrects all three findings. [Validation](evidence/validation.json) records the full candidate-diff privacy boundary, zero tracked scratch/cache files and focused checks. No selected-path exemption substitutes for the whole-diff gate.

This repair searched five phrasings through Viewer: `codex-api-update` and `isBlocking pendingRequest` with an initially invalid project key, `immutable scenario` and `message/add append` unscoped, then a corrective canonical-project `"thread/inject_items"` query. The initial empty scope results establish nothing. It read the complete review, original researcher turns and tool evidence, the original pipeline's failed publication state, and the August 2 injection repair through `conversation_messages`. The August 2 repair record at 07:43:30 UTC and tool results at 07:43:16 UTC show canonical-scan rejection before insertion and successful scoped checks; current source still preserves that mutation fence and canonical-path-before-insertion behavior. The original publication claim was only a 12-file gate; the recovered pipeline confirms its actual push was rejected.

The matrix establishes local app-server behavior. Live-model consumption, ChatGPT eligibility, true multi-page/large history, compaction, attachments and full Viewer acceptance remain unverified implementation gates in [INTEGRATION.md](INTEGRATION.md). This correction does not change runtime host/queue code or deploy. The original-key and terminal receipt contracts continue to govern every proposed slice.

[release]: https://github.com/openai/codex/releases/tag/rust-v0.153.4
[alpha]: https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.6
[main]: https://github.com/openai/codex/commit/54e04f25dbfe342bf84809d1880dbca32cb43cf6
[guide]: https://learn.chatgpt.com/docs/app-server
[r152]: https://github.com/openai/codex/releases/tag/rust-v0.152.0
[r153]: https://github.com/openai/codex/releases/tag/rust-v0.153.0
[turn-source]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L944
[inject-source]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/inject.rs#L72
[thread-core]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/codex_thread.rs#L617
[queue-processor]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_queue_processor.rs
[queue-service]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/ext/queue/src/service.rs#L265
[turn-schema]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/turn.rs
[thread-schema]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[items-source]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1733
[thread-data]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs
[model-source]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/model.rs
[notifications]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/notification.rs
[permissions]: https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs
[verification]: https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server-protocol/src/protocol/v2/user_verification.rs
[future-thread]: https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[future-account]: https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server-protocol/src/protocol/v2/account.rs
[mcp-main]: https://github.com/openai/codex/blob/54e04f25dbfe342bf84809d1880dbca32cb43cf6/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs
[steering]: https://developers.openai.com/api/docs/guides/steering
[beta]: https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses
[i1332]: https://github.com/Latand/live-log-viewer-next/issues/1332
[i1327]: https://github.com/Latand/live-log-viewer-next/issues/1327
[i1131]: https://github.com/Latand/live-log-viewer-next/issues/1131
[i561]: https://github.com/Latand/live-log-viewer-next/issues/561
[i390]: https://github.com/Latand/live-log-viewer-next/issues/390
[i1373]: https://github.com/Latand/live-log-viewer-next/issues/1373
[i1404]: https://github.com/Latand/live-log-viewer-next/issues/1404
[i1497]: https://github.com/Latand/live-log-viewer-next/issues/1497
[i1225]: https://github.com/Latand/live-log-viewer-next/issues/1225
[i1523]: https://github.com/Latand/live-log-viewer-next/issues/1523
