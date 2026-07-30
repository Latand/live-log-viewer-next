# #795 — Direct operator deploy intent, internally pinned exact revision

## The journey before this change

1. The manager prepared one exact 40-hex SHA and appended a
   `confirmation_request` bridge report carrying that SHA plus a minted
   single-use nonce and expiry (`bridge_report`, designated-seat only).
2. The gateway drained the report and was instructed to voice
   "Deploy authorization requested for commit `<40 hex>`" and, on agreement, to
   echo the exact `[bridge ref=<seq> nonce=<nonce> sha=<sha>]` trailer back as a
   directive. The operator sat inside a SHA-bound challenge: the product's copy
   made their authorization a hash phrase.
3. The manager read the trailer and called `deploy_exact_sha` with
   `bridgeRef` + `bridgeNonce`; the MCP binding forwarded to
   `POST /api/runtime/deployments`, which forwarded to runtime-host admission —
   the one gate that verifies nonce, SHA, expiry and single-use **and consumes
   atomically** (`consumeBridgeConfirmation`).

Everything in step 3 was already right. The defect was the shape of step 1–2:
the round trip put the operator in charge of relaying a revision identity that
only machines need.

## The interaction contract

**The operator says a deploy naturally. That single utterance is the whole
authorization.** No confirmation menu, no hash phrase, no repeated prompt.

1. The gateway relays the operator's words once:
   `bridge_directive { intent: "deploy", instruction: <their words> }`.
   Only the voice gateway (server-attributed origin, never caller-supplied) may
   carry a deploy intent; agents and the manager itself are refused.
2. **At intent acceptance** the product resolves current remote `main` to an
   exact 40-hex revision and records ONE consumable authorization, durably:
   - project + designated seat (routing authority),
   - origin (the gateway conversation that relayed the operator),
   - the exact pinned revision,
   - expiry (bounded lifetime, 10 minutes),
   - idempotency identity derived from the root turn — a retry after a lost
     receipt replays the SAME authorization instead of minting a second one,
   - single-use consumption + supersession fields.
   A newer accepted deploy intent for the same project supersedes any live
   unconsumed one — repinning, never stacking.
3. The manager receives the directive with the machine trailer
   `[bridge ref=<seq> nonce=<nonce> sha=<pinned>]` attached server-side. The
   revision is internal evidence; it never routes back through the operator.
4. The manager calls `deploy_exact_sha` for exactly that revision. The
   authorization is verified **and consumed atomically at runtime-host
   admission** — the same single gate as before, where the MCP binding, the
   HTTP route and a raw socket client all converge.

### Refusal matrix (a refusal never consumes)

| case                                   | reason        | where                    |
| -------------------------------------- | ------------- | ------------------------ |
| replayed authorization                 | `consumed`    | host admission (atomic)  |
| stale intent (past expiry)             | `expired`     | host admission           |
| superseded by a newer deploy intent    | `superseded`  | host admission           |
| revision drifted from the pinned one   | `sha_mismatch`| host admission           |
| unknown/never-minted reference         | `no_confirmation` | host admission       |
| agent or gateway calling the executor  | refusal at the MCP binding (attributed non-manager) |
| cross-project executor caller          | refusal at the MCP binding (row project ≠ caller project) |
| non-gateway session minting an intent  | refusal at the MCP binding (`deploy_intent_gateway_only`) |
| remote main unresolvable               | fail-closed refusal; nothing is minted |

The nonce stays a bearer secret delivered only to the designated seat, so the
binding-level identity checks are defense in depth on top of it, never instead
of it.

### Audit

The authorization row in the durable bridge log is the after-the-fact evidence:
who relayed it (server-attributed origin), when it was accepted, the exact
pinned revision, when it expired, when it was consumed or superseded. The
deployment ledger keeps the execution half, exact-SHA as before.

## Bootstrap / migration

There is a genuine chicken-and-egg here, and it has to be closed explicitly:
the acceptance path lives in `bridge_directive`, which production serves only
AFTER the new Viewer is deployed — and deploying the new Viewer is the very
thing awaiting authorization. Meanwhile the operator's deploy directive has
already been delivered and sits in the voice root's transcript, and production
admission understands exactly one thing: a `confirmation_request` row's
ref + nonce.

**The one-time migration command** (run from the merged exact-head tree while
production still serves the old Viewer):

```
bun scripts/bootstrap-direct-deploy-intent.ts <deliveryId> [--execute]
```

- It takes a directive **delivery id** (`bridge_d_<turn>_<utterance>`), never
  prose. The id must derive from a `bridge_directive` call recorded in the
  ROOT session's own transcript (resolved from the durable registry/lineage,
  not from anything typed at the command) — so the thing converted is an
  utterance the gateway actually relayed, attributed by the identity chain
  production already trusts.
- It refuses: a directive absent from the root transcript, one that does not
  read as a deploy ask (attribution proves who spoke, not that they authorized
  a deployment), one older than the 24-hour bootstrap window, and one with no
  designated seat.
- On acceptance it pins current remote main and records the existing-format
  single-use authorization via the same idempotent key the live path derives —
  a re-run replays the same authorization; a later replay of the same turn
  through the new Viewer maps to the same row. No gateway drainage, no
  operator prompt, no hash phrase.
- `--execute` invokes the ALREADY-DEPLOYED exact-SHA executor once with the
  minted ref + nonce, health-gated on the serving route answering first. The
  old admission consumes it exactly as it consumes a legacy confirmation.
- The command needs only the local state directory and the transcript on disk;
  it does not require the new Viewer to be serving anything.

**Steady state after bootstrap:**

- **No state migration.** The direct intent is recorded as a
  `confirmation_request`-class row in the existing bridge report log (flagged
  `directIntent`, never drained to the gateway), with the existing
  `sha`/`nonce`/`expiresAt`/`consumedAt` shape — which is exactly why the old
  executor can consume it.
- **Old manager, new viewer:** a legacy manager that still mints its own
  `confirmation_request` keeps verifying mechanically, but it never becomes a
  user prompt of any kind: the gateway is told NOT to ask the operator for
  confirmation or approval. If the operator already stated the deploy, the
  gateway echoes the trailer silently; otherwise it may mention in passing
  that a release is ready and move on. Deploys happen on the operator's own
  initiative only.
- New fields (`supersededAt`, `directIntent`) are optional; old rows normalize
  unchanged.
