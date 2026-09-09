# Codex API implementation handoff

The operator authorized integration. This PR repairs research and probes; product integration remains outstanding. Begin after the deployment release gate and explicit release of the shared host/queue files. The deployment owner retains startup, succession, registry and release behavior. Each slice below needs a separate implementation PR and fresh review at its exact HEAD.

Source baseline: Viewer `88e5a9508be2802266734056d6436f3168201cad`; installed Codex `0.153.4`. Recheck the target base and these file manifests before implementation. Serialize shared-file ownership in the order **pagination → questions → profiles → idle context → diagnostics**. Diagnostics has no semantic dependency on idle context, but shares the host file. Idle context depends on the pagination evidence reader. No runtime file changes belong to the research PR.

Every slice preserves the original operation key, immutable content/attachment/profile snapshot, explicit null/string turn fence, account authority, writer generation and terminal delivery evidence. Timeout or partial history leaves the outcome unknown. Retain unresolved records and blobs; never use a replacement key, queue disappearance, auth refresh or elapsed time as proof of delivery. Native queue dispatch stays disabled in Viewer. No API-key, account or model fallback.

Run only named tests, with private HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME and a short TMPDIR. Allowlist environment variables; do not copy operator credentials. Use the repository's Bun version and dependency lockfile. Read the installed Next guide before editing a route or component. Add TypeScript checking for each product PR and rendered/browser verification for changed affordances. Product tests listed below are future acceptance work; this research PR has exercised the separate Python probe matrix only.

Canonical discovery on 2026-09-08 read issue bodies and searched all states for Codex pagination, nonblocking, isBlocking, history injection and Codex API. Closed [#301](https://github.com/Latand/live-log-viewer-next/issues/301) and [#1332](https://github.com/Latand/live-log-viewer-next/issues/1332) cover earlier pagination work; current host source still uses hydration plus disk fallback. Closed [#390](https://github.com/Latand/live-log-viewer-next/issues/390) supplies the next-message profile requirement. Closed [#1131](https://github.com/Latand/live-log-viewer-next/issues/1131) and [#561](https://github.com/Latand/live-log-viewer-next/issues/561) supply receipt and queue-first contracts. Open [#1225](https://github.com/Latand/live-log-viewer-next/issues/1225) owns parked-operation terminalization, and open [#1404](https://github.com/Latand/live-log-viewer-next/issues/1404) owns stale quota recovery. The slices below cover remaining adoption work without reopening those shipped fixes or duplicating the open work.

| Order | Integration issue | Prerequisite |
|---|---|---|
| 1 | [Native pagination for canonical delivery evidence #1557](https://github.com/Latand/live-log-viewer-next/issues/1557) | Deployment release gate and host-file release |
| 2 | [Nonblocking questions across host scheduling and recovery #1558](https://github.com/Latand/live-log-viewer-next/issues/1558) | Serialize after #1557; shared-file release |
| 3 | [Apply the frozen next-message profile #1559](https://github.com/Latand/live-log-viewer-next/issues/1559) | Serialize after #1558; shared-file release |
| 4 | [Fenced idle history context without a new response #1560](https://github.com/Latand/live-log-viewer-next/issues/1560) | Serialize after #1559; shared-file release |
| 5 | [Bounded capability and authentication recovery status #1561](https://github.com/Latand/live-log-viewer-next/issues/1561) | Serialize after #1560; shared-file release |

## 1. Native pagination for canonical delivery evidence

Current `sessionMaterializationEvidence` and delivery lookup in `codexAppServerHost.ts` use full hydration and disk fallback. Add bounded `thread/turns/list` and `thread/items/list` traversal shared by those readers. Metadata establishes the target thread and canonical path. Page records establish client ID, canonical content/digest and turn identity. A summary page is incomplete until required item pages are read. Unsupported native APIs keep the established disk fallback; transport errors and exhausted search bounds remain unknown.

Owned product files:

- `src/lib/runtime/codexAppServerHost.ts` — history-reading/materialization methods only.
- `src/lib/runtime/codexHistoryReader.ts` — optional new private helper if needed to keep the existing host readable.

Focused tests:

- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/codexAppServerHost.integration.test.ts`
- `src/lib/runtime/codexHistoryReader.test.ts` — only if the helper is added.

Acceptance: exercise a real isolated stdio thread and a second turns page plus items page; wrong thread/client ID/content, duplicate text under distinct keys, missing/error pages, delayed persistence, oversized tool output and compressed/shared history. Removing the required canonical record must turn the positive case red. Host replacement reconciles the original operation without another send. Bound bytes/pages at the reader seam and retain current deadlines. Exclude host startup/succession changes and native queue enablement.

Dependencies: deployment owner releases the host file; context is closed #301/#1332. Rollback disables preference for native pages while retaining the legacy reader and every unresolved operation.

## 2. Nonblocking questions across host scheduling and recovery

An unanswered `item/tool/requestUserInput` with validated `isBlocking: false` stays answerable while generation and explicitly fenced steering continue. After an authoritative idle transition, one queued ordinary send can dispatch. True, missing, null, malformed flags and approval/unknown request methods remain blocking. `autoResolutionMs` never decides blocking and never fabricates an answer.

Owned product files:

- `src/lib/runtime/codexAppServerHost.ts` — `PendingAttention`, request admission, `currentState`, ledger restore, buffered replay/reconciliation and pending-request retirement guards.
- `src/lib/runtime/engineHost.ts` — document `HostState.pendingAttention` retaining all answerable IDs while status reflects validated blocking requests.
- `src/lib/runtime/engineHostEvents.ts`
- `src/lib/runtime/codex.ts`
- `src/lib/runtime/contracts.ts`
- `src/runtime-host/journal.ts` — attention persistence/projection only, after its owner releases the file.
- `src/components/runtime/runtimeModel.ts`
- `src/components/runtime/AttentionCard.tsx`
- `src/components/runtime/ConversationAttention.tsx`

The queue's existing idle/active fences should suffice once host status is correct. `src/lib/runtime/structuredDeliveryQueue.ts` is an inspection dependency; change it only if the integrated fixture proves a remaining scheduling gap and ownership is released. Preserve all pending IDs, including nonblocking ones, in host snapshots and retirement checks. Replayed requests retain their original generation and current/restored origin; do not send an answer to a newly assigned RPC ID after restart. Never let resolving one question clear a mixed blocking request.

Focused tests:

- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/engineHostEvents.test.ts`
- `src/lib/runtime/codex.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/runtime-host/journal.test.ts`
- `src/components/runtime/runtimeModel.test.ts`
- `src/components/runtime/ConversationAttention.test.ts`
- `src/components/runtime/AttentionCard.nonblocking.dom.test.tsx` — new focused rendered test.

Acceptance: paired real host fixture frames for false/true/missing/null/string flags; unanswered false stays active, accepts an explicit matching-turn steer and permits idle dispatch exactly once. Mixed requests still block. Late answers, duplicate answer keys, options absent, cancellation, reload, buffered replay and host retirement preserve identity and answer affordance. A stale/unowned restored request remains visible with truthful recovery status. Model tool availability requires a later authorized live-model check; fixture frames prove the adapter contract only. Board layout stays with its existing owner.

Dependencies: serialize after slice 1; obtain host/journal ownership. Rollback retains durable flags/IDs and answers while disabling the new affordance; never resolve or discard pending questions implicitly.

## 3. Apply the frozen next-message profile

Follow up closed #390 using installed `turn/start.model`, `effort`, `serviceTier` and `serviceTierForTurn`. Freeze selected settings when admitting each operation. Forward supported fields on an idle new turn; explicit active steer keeps the active profile and defers next-turn changes. Advertise per-turn capabilities only after schema, model and account support are established.

Owned product files:

- `src/lib/runtime/contracts.ts`
- `src/lib/runtime/commands.ts`
- `src/lib/runtime/codexAppServerHost.ts` — capability discovery and `send` only.
- `src/lib/runtime/structuredDeliveryQueue.ts` — existing profile/reconfiguration boundary.
- `src/components/runtimeProfile.ts`
- `src/components/tmuxComposerRuntime.ts`
- `src/components/RuntimePill.tsx`

Focused tests:

- `src/lib/runtime/commands.test.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/components/runtimeProfile.test.ts`
- `src/components/RuntimePill.dom.test.tsx`
- `src/components/TmuxComposer.staleKey.dom.test.tsx`

Acceptance: two queued operations with distinct profile snapshots survive restart; fixture backend sees the intended fields; sticky and one-turn service tier stay distinct; omitted/null tier preserves the schema contract. Invalid model/effort/tier fails before actuation. Active steer and lost replies never trigger a second start or alter the admitted settings. Verify selected ChatGPT model/plan eligibility before enabling a production capability; retain the exact selected model.

Dependencies: slices 1–2 and release of queue ownership. Rollback disables new capabilities for new admissions while preserving settings already frozen on unresolved operations.

## 4. Fenced idle history context without a new response

Provide a narrow application-context operation using `thread/inject_items` under proven idle ownership. The authorized integration starts from existing trusted application use; a new composer button requires a separate UI requirement. A receipt may report stored context only after canonical persistence. Model consumption remains a separate fact. Active injection stays unsupported initially: the local probe acknowledged it before interruption and did not find it persisted afterward.

Owned product files:

- `src/lib/runtime/commands.ts`
- `src/lib/runtime/contracts.ts`
- `src/lib/runtime/engineHost.ts`
- `src/lib/runtime/codexAppServerHost.ts`
- `src/lib/runtime/structuredDeliveryQueue.ts`
- `src/lib/runtime/structuredRecovery.ts`
- `src/lib/runtime/http.ts`
- `src/runtime-host/journal.ts`

Reuse the current operation and receipt surfaces, with an explicit context kind and role/origin. Freeze conversation, operation key, payload digest, item ID, attachments, generation and idle fence at admission. User content retains user role; trusted application context alone may use developer role. Canonical lookup precedes insertion and follows unknown outcomes. A repeated item ID is not server deduplication. Keep the original writer fenced after a lost acknowledgment; possible replay requires authoritative retirement and complete evidence. Never reinterpret this operation as an ordinary send.

Focused tests:

- `src/lib/runtime/commands.test.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/codexAppServerHost.integration.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/lib/runtime/structuredRecovery.test.ts`
- `src/lib/runtime/http.test.ts`
- `src/runtime-host/journal.test.ts`

Acceptance: idle context persists through restart and reaches the next request with zero new turns at insertion. Same key/changed payload refuses; lost acknowledgment and delayed persistence reconcile without another insertion. Cover missing/corrupt history, concurrent ordinary send, active/idle race, compaction, attachments retained while unknown and terminal HTTP/MCP receipt wording. Preserve the existing persona recovery fence from closed #857/#858. No cancellation/replacement control ships through this slice; #1225 retains that work.

Dependencies: slice 1 evidence reader, serialized after slice 3 and shared-file release. Rollback closes new context admissions and continues original-key reconciliation without deleting history or blobs.

## 5. Bounded capability and authentication recovery status

Expose selected executable/version and observed capability/auth-recovery status through existing account/host projections. Decode `modelProvider/authRecoveryStarted` and `modelProvider/authRecoveryCompleted` conservatively. A refresh completion alone establishes neither authenticated usability nor message delivery. Preserve unavailable and unknown states.

Owned product files:

- `src/lib/accounts/codexAppServer.ts`
- `src/lib/accounts/codexRuntime.ts`
- `src/lib/runtime/codexAppServerHost.ts` — initialization and notification handling only.
- `src/lib/runtime/engineHostEvents.ts`
- `src/lib/runtime/contracts.ts`
- `src/components/runtime/runtimeModel.ts`

Focused tests:

- `src/lib/accounts/codexAppServer.test.ts`
- `src/lib/accounts/codexRuntime.test.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/engineHostEvents.test.ts`
- `src/components/runtime/runtimeModel.test.ts`

Acceptance: malformed completion, still-unauthenticated account, advertised-but-unavailable feature, unknown notification, permission-profile parse failure and reconnect preserve pending operation identity. No schema graph is shipped as a runtime dependency. Existing #1404 owns quota/reset freshness; this slice adds no reset consumption or fallback credentials.

Dependencies: serialized host ownership; no semantic dependency on slice 4. Rollback hides status detail while retaining conservative operation admission.
