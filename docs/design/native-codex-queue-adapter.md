# Native Codex queue adapter

Issue #1632 supplies the transport slice for #1629. Ordinary sends retain their
default interrupt behavior when the parent integrates this adapter. This slice
changes no running host, HTTP route, journal, composer, or voice code.

`NativeCodexQueue` binds one native thread to one injected, already initialized
RPC connection with experimental API negotiation enabled. Its handwritten boundary schemas follow Codex CLI 0.154.0's
generated v2 queue and input schemas. The native desktop queue implementation
bundled with app-server 0.153.4 informed coalesced refresh and separate server /
client identity handling. No bundled implementation is copied here.

The port implements `rpc(method, params, timeoutMs)`, matching the existing host
call shape. It must correlate request IDs on that connection, unwrap `result`,
honor the deadline, reject errors, and never retry mutations. Only a correlated
JSON-RPC error envelope may become `NativeQueueProtocolRefusal`. The current
host collapses errors to generic exceptions; the integrating stage must preserve
that distinction at the envelope boundary. Generic errors remain uncertain.

The adapter exposes `add`, `update`, `delete`, `reorder`, and `start` with native
parameters. `update` takes the prior submission's server ID and client message
ID plus replacement native input. It verifies both echoed identities. Input
variants, text spans, media details, paths, URLs, and extra fields are retained.
The integrating caller owns durable operation identity and prior payload
snapshots, including attachment retention across editing and recovery.

Every successful mutation returns `{ outcome: "acknowledged", result }`.
Neither this acknowledgement nor an empty queue establishes delivery. Idle add
and start can dispatch immediately; repeated `clientUserMessageId` values can
create separate submissions. A delete result describes native queue removal
only. A start result validates the turn envelope's ID, status, and items array;
nested turn items are opaque and provide no canonical delivery proof here.
Malformed replies, lost acknowledgements, and unclassified RPC failures throw
`NativeQueueUncertainError`. The caller must retain its original durable
operation and payload without automatically repeating the mutation. Error
causes can contain protocol data and must not be serialized to public surfaces.
Disposal before transport invocation throws `NativeQueueNotSubmittedError` with
`outcome: "not-submitted"`: the caller can safely reconsider submission through
its existing durable workflow and a current adapter. This local outcome is
distinct from protocol refusal. After transport invocation, disposal and lost
acknowledgements preserve uncertainty. The adapter never retries either path.

`read()` returns a copy of the last complete observation and its `stale` flag.
`items: null` means there has been no complete observation. `items: []` means a
complete list was observed empty. `refresh()` coalesces concurrent readers and
walks all pages in order. Defaults are 100 items requested per page, 20 pages,
2,000 retained submissions, two refresh passes, and a ten-second total read
deadline. Bounds are configurable. A still-unresolved wire read prevents a new
read from accumulating behind its expired deadline.

The host forwards notifications to `handleNotification(method, params)`.
Matching `thread/queue/changed` notifications invalidate the snapshot and return
`true`, allowing the caller to request a refresh when needed. Idle invalidation
does no I/O. Notifications during a refresh trigger another bounded pass.
Errors, missing completion cursors, repeated cursors or submission IDs,
contradictory identities, pending mutations, and exhausted bounds retain the
previous snapshot as stale and reject the refresh. Native lists have no thread
ID or snapshot revision: request correlation and notification forwarding remain
port responsibilities. The result records observed pages; native pagination
offers no atomic snapshot guarantee.

Use one adapter for a thread on its current connection. Dispose it on host or
account replacement and forward no events from the old connection to the new
adapter. Disposal fences late list results and unsent RPC work. Mutation
acknowledgements already in flight retain their original thread identity.
The integrating caller owns subscriptions, capability checks, recovery, and
canonical settlement. No scheduler or parallel persistence system is added.

Focused verification uses `src/lib/runtime/nativeCodexQueue.test.ts` under the
Dockerfile's Bun 1.4.0 with lockfile dependencies. Isolate HOME, all three XDG
roots, CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME, LLV_STATE_DIR, and a short
TMPDIR; use an allowlisted environment. Set `NATIVE_CODEX_QUEUE_TEST_BINARY` to
an explicitly selected absolute Codex 0.154.0 executable to enable the optional
installed-binary fixture. It creates its own credential-free homes and loopback
synthetic SSE backend, verifies real paginated reads and all mutation responses,
and drops a successful add acknowledgement as a negative control. It retains
scratch evidence outside the checkout and stops only its own fixture process.
Without that variable the binary fixture is explicitly skipped. Hosted checks
run their existing named suites; they do not automatically include this new
test file. Parent integration must add its required ongoing CI coverage.
