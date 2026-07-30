# #795 — The designated agent decides deployment

Supersedes the earlier #795 design ("direct operator deploy intent, internally
pinned exact revision") by operator decision: the designated orchestrator
decides *when* to deploy and executes the deploy itself. There is no operator
confirmation of any kind, and nothing anywhere parses prompts, utterances or
reasoning to authorize a deployment.

## What was removed

Two generations of confirmation machinery existed, and both are gone:

1. **The manager-minted round trip (#691 §4):** a `confirmation_request`
   bridge report carrying a SHA + single-use nonce + expiry, echoed back by
   the gateway as a `[bridge ref nonce sha]` trailer, verified and consumed
   atomically at runtime-host admission.
2. **The direct-intent variant (first #795 design):** `bridge_directive`
   `intent="deploy"` pinned remote main at acceptance and recorded a
   consumable authorization row (single-use, expiring, superseding), plus a
   one-time bootstrap command that converted an already-delivered directive by
   reading the root session's transcript.

Removed with them: the `confirmation_request` report class (write side), the
confirmation mint in `bridge_report`, the nonce/sha trailer extension (the
trailer keeps its bare `[bridge ref=<seq>]` correlation form for answering
`question` reports), `bridgeRef`/`bridgeNonce`/`confirm` on
`deploy_exact_sha`, the `bridgeProof` field on the deployment request contract,
the admission-time authorization gate, and the bootstrap script with its
transcript parsing.

## The contract

**Decision:** the designated orchestrator decides when a deploy happens. The
operator hears about deploys through bridge reports; nothing ever asks them to
confirm, approve, repeat, or say anything.

**Execution:** the orchestrator resolves the revision itself (e.g. remote
`main`) and calls `deploy_exact_sha` with one full 40-hex commit SHA.

**Authority** is derived from the server-attributed caller identity — process
ancestry merged with the admission-injected spawn capability, checked against
the durable per-project orchestrator designation — and from nothing else.
Prose, reasoning, prompts and arguments carry zero authority.

### Refusals (at the deploy executor, the MCP binding)

| case                                             | code                          |
| ------------------------------------------------ | ----------------------------- |
| caller not attributed as a designated seat       | `deploy_caller_not_designated`|
| caller holds no validated seat                   | `deploy_caller_not_designated`|
| seat acting from another project's context       | `deploy_cross_project`        |
| revision not a full 40-hex SHA                   | error before any call         |

### What is preserved mechanically

- **Exact-SHA execution:** the binding and the HTTP route require a full
  40-hex revision; host admission re-resolves and re-validates it.
- **Idempotency:** `clientRequestId` becomes the deployment idempotency key; a
  retry replays the original receipt, a conflicting reuse is refused.
- **Serialization:** admission is exclusive and one active deployment holds
  `busy` against the next.
- **Runtime-host/HTTP parity:** the MCP binding,
  `POST /api/runtime/deployments` and the raw runtime-host socket all present
  the same request shape (revision + idempotency key) and converge on the same
  admission.
- **After-the-fact audit:** the deployment journal/ledger records every
  deployment — id, requested and resolved revision, owner, phases, health
  evidence and timestamps — readable via `deployment_status`.

## Migration

- Durable bridge logs written under the old designs may contain
  `confirmation_request` rows (including `directIntent`-flagged authorization
  rows). They still **read** — a durable log that stops parsing loses the
  manager's history — but their authorization payloads are dropped at read,
  nothing ever writes a new one, and the drain never hands one to a
  conversation, so no legacy row can resurface as an operator prompt.
- The orchestrator mandate is version 3: the deploy section now instructs the
  seat to decide, resolve, execute and report.
