# Native Codex runtime integration

This backend stage of #1629 preserves the Voice implementation from #1634 at
`016271376270bb306839ed2ea6b38199ea2de61c` and incorporates the reviewed queue
adapter from #1633 and history reader from #1635. The queue controls, the
composer's second submission, the MCP work-identity wiring and the Voice repairs
are the experience stage, in `native-codex-experience.md`.

The reference is Codex CLI 0.154.0 and the native app's 0.153.4 protocol.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
provides the protocol overview. Installed schemas and credential-free native
fixtures establish the behavior exercised here.

## Runtime boundary

`GET /api/runtime/queue?conversationId=…` returns the native snapshot alongside
Viewer entries, payload versions and canonical proof. A failed native read
retains its stale snapshot. Unavailable journal data returns an error.

`POST /api/runtime/queue` admits `add`, `update`, `delete`, `reorder`, `start`, or
`send-now`. Each mutation needs its own immutable `idempotencyKey` and a
`binding` containing the native `threadId` and selected `accountId`. Entry
controls also require the Viewer `entryId` and `expectedRevision`. Reorder uses
native submission IDs. Start requires `turnId: null`; Send now requires an
explicit null or matching active turn ID. Replaying a Viewer admission returns
the same operation. Native mutations are never retried automatically.

The existing structured delivery controller executes these mutations. An
ordinary Codex send with explicit queue policy uses the same native path once
the host has negotiated support. Its journal effect leaves the Viewer dispatch
queue after native acknowledgement. Codex owns subsequent dispatch, including
idle add and cold-resume dispatch. Unknown native capability refuses new queued
sends before dispatch. Default interrupt remains unchanged.
Canonical reconciliation runs as coalesced reads outside the dispatch loop, so
history reads cannot hold interrupt or answer controls.

A mutation receipt records acknowledgement independently from delivery. A
unique queue observation can recover a lost add or update acknowledgement.
Canonical history must establish the original client ID, exact prepared input,
payload version, item and turn before delivery is reported. Native local-image
serialization is matched back to frozen refs by MIME, byte count and SHA-256;
a changed image remains a conflict. Queue disappearance,
provider recovery, and process liveness establish no delivery verdict.

Edits retain every admitted payload version, image reference and requested
profile. The dispatched version and its turn become immutable. Entry reads
retain every unresolved row within the 2,000-entry admission bound and include
the latest 128 terminal entries. Older terminal rows remain in SQLite. Each
entry permits 128 retained versions. Admission refuses a bound before dropping
any existing content.

Send now withdraws an active native queue entry before steering. Only
`deleted: true` permits the steer, which still carries the original active turn
fence. If the turn changes after withdrawal, the payload remains `withdrawn`
and an explicit idle start can send it. A missing or uncertain deletion never
starts another instruction. Positive deletion settles the original entry as
discarded while retaining its payload history.

## Profiles and attention

Normal `turn/start` forwards validated model, effort, sticky `serviceTier`, and
one-turn `serviceTierForTurn`. Omitted and null fields remain distinct. Explicit
model selections must occur in the observed catalog. Invalid selections fail
before a mutating call. Active steering inherits the active turn's profile.
Native queue params have no per-entry profile fields: versions retain requested
settings for audit and report `profilePolicy: thread-at-dispatch`. Provider
eligibility still determines whether a submitted profile can execute.

Only a well-formed `item/tool/requestUserInput` with `isBlocking: false` permits
active work and steering to continue. Every answerable ID remains in the host
snapshot. Missing or malformed flags, malformed questions, approvals, and
unknown request methods remain blocking. Restored requests retain their original
identity and become unowned. A new process reusing an RPC ID gets a separate
Viewer attention ID; answering the restored ID cannot target the new request.

Host diagnostics expose the executable basename, reported version, observed
queue capability, and authentication recovery state. Completion of provider
auth recovery remains unverified for usability and delivery. UTF-8 decoding
retains split characters across stdout frames.

Claude explicitly refuses unsupported steering before broker actuation. A
missing replay echo rejects the original delivery promise while retaining that
promise, the ledger and the incumbent process. Repeating the same host request
cannot write again while its echo is unresolved. A late exact echo can still
confirm the original payload.

## Verification and handoff

`bun scripts/verify-native-codex-runtime.ts <absolute-codex-binary>` runs the
named queue, history, host, status and inherited Voice tests under private
HOME/XDG/provider/state roots and a short TMPDIR. CI installs Codex 0.154.0 and
runs this same check with the Dockerfile's Bun version. Dependencies come from
the repository lockfile.

The runtime integration fixture uses the real CLI and native persistence against
a loopback Responses server. Only its authentication/catalog projection is
synthetic. It exercises idle auto-dispatch, edits, native start, lost replies,
canonical-record removal, cold host replacement and profile fields. Separate
regressions cover Send now's turn boundary, concurrent executor admission,
account changes, delayed Claude echoes, UTF-8 boundaries and nonblocking flags.
The HTTP test admits against a populated 128-session fixture within 250 ms and
asserts that admission waits for zero native RPCs. This measures server feedback;
rendered queue responsiveness belongs to the next stage.

Three regressions fail against the preserved Voice baseline and pass on the
candidate: a false question flag blocking work, a split Unicode delivery echo,
and a delayed Claude echo killing its incumbent. ESLint remains unavailable
because of the baseline React plugin crash.

#1560 remains a separate explicit history-only operation. Its insertion,
canonical persistence receipt and role boundary differ from send/queue. This
stage provides no context-injection action and never routes a send into one.

The experience stage carries the inherited Voice handoff forward: ambiguous
utterance-to-handoff correlations are published as ambiguity and stay refused,
retained context is bound to the backing turn that owns it rather than to a
clock, and the canonical transcript now reaches the browser. Real-provider audio
and spoken model quality over a live call remain unverified.
