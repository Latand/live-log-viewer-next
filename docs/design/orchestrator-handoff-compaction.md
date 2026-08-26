# Orchestrator rotation handoff compaction — issue #1067

Why a manager seat could rotate itself to death, and the invariant that stops
it. Implementation detail lives in the code and its tests; this records the
decisions a reader cannot recover from either.

## The incident

Rotation defaulted the successor mandate to the incumbent's *current* mandate
and appended a fresh `## Handoff from your predecessor (rotation)` section.
Handoffs therefore stacked verbatim and the mandate grew monotonically — live
seats carried 3, 9 and 11 stacked sections, and one reached 31.4 KB. Past
`MAX_STRUCTURED_TEXT_BYTES` (32 000) the designation message failed with
"structured message text exceeds the 32000-byte envelope bound", while the seat
command's own `MANDATE_MAX_BYTES` (64 000) had waved the mandate through. The
intent then sat pending forever behind a dead "last designation failed" banner:
every retry recomposed the same undeliverable text, and rotation is
operator-only, so no agent could repair it.

## The invariant

> A successor mandate is **core + at most one `## Rotation history` section +
> exactly one fresh handoff**, and it is measured as delivered before any
> durable intent exists.

Its size is a function of the core and the caps — never of how many rotations
came before. Three things have to hold for that to be true:

**Splitting is total.** A boundary is a whole line equal to a reserved heading,
so `### ` sub-headings inside a body never split. Line endings are normalized
first: a mandate that made a CRLF round trip would otherwise split into
`"## Rotation history\r"` lines that match nothing, and every stacked handoff
would survive as "core". The split runs on whichever base the rotation uses —
the request's mandate or the incumbent's stored one — because the desktop
rotate draft prefills its textarea from the stored mandate and posts the
stacked text back explicitly. A malformed mandate carrying several history
sections collapses into one.

**Nothing below the core may write a boundary.** The history body, the caller's
handoff notes and the board task text are model-, caller- and board-controlled,
and one line reading `## Rotation history` inside any of them becomes a
boundary for the *next* split — which is the stacking, back again. Every one of
them has its Markdown headings turned into list items before it is rendered.
The core is exempt on purpose: it is the operator's own prose, its real
headings must survive, and the split has already proved it holds neither
reserved heading.

**One bound decides, and it is the delivery bound.** `MANDATE_MAX_BYTES` is
gone. The preflight measures exactly the text delivery ships — the mandate
after `orchestratorMandateForDelivery`, plus the role scaffold spawn mode
prepends — against `MAX_STRUCTURED_TEXT_BYTES`, so a mandate that passes cannot
fail the envelope assertion afterwards, and no safety margin is needed.

## Budgets

| Constant | Value | Why |
|---|---|---|
| `HISTORY_BUDGET_BYTES` | 4 096 | The history section costs the same whether a model or the fallback wrote it. |
| `FALLBACK_HANDOFF_COUNT` | 2 | AC 3's N. |
| `PREDECESSOR_REPORT_CAP_BYTES` | 6 000 | Bounded tail of the predecessor's last assistant report. |
| `SUMMARY_INPUT_CAP_BYTES` | 48 000 | Oldest handoffs drop out first; the previous digest already covers them. |
| `HANDOFF_DIGEST_TIMEOUT_MS` | 75 000 | One bounded try — the longest rotation will wait for a nicer history. |

When the composed mandate still does not fit, it is trimmed in a fixed order:
**history first** (the successor can still read the predecessor's transcript),
then the caller's notes. The task list keeps its existing caps and the
predecessor pointer is never dropped — it is the successor's only route back to
the full record. If even core + fresh handoff cannot be delivered, rotation
refuses with 413 `mandate_too_large`, naming the bytes, the overhead, the bound
and the excess, before any intent exists.

## Decisions

**The summarizer may never block rotation.** One bounded headless Codex turn on
`CODEX_LUNA_MODEL`, through the flows runner's own account, process-group and
artifact discipline (`--ignore-user-config` so the MCP server table is empty,
single agent, read-only sandbox, killed as a group when the timer fires). Every
unhappy answer — no capacity, timeout, non-zero exit, empty or over-budget
output, or a thrown error — resolves to a *fallback reason*, never an error the
caller has to interpret. The fallback is a pure function of the incumbent's
mandate and the reason: the newest two handoffs verbatim, then the previous
digest if room remains, inside the same budget. A rotation that falls back is
fully reproducible.

**A timed-out run is not a finished one.** The one-shot runner reports
`timeout` even when the child had already written `last-message.md`: an
artifact flushed before the group was killed is a fragment, and reading it as
`done` silently denies rotation the deterministic fallback it is entitled to.

**"Identity-free" cannot be delegated to the model.** The prompt asks for a
digest without names, handles, addresses or paths, but the material is
transcript-derived, the model may quote it back, and whatever it writes is
pasted into the successor's mandate and re-summarized at every later rotation —
one leak becomes permanent. `hardenedRedact` covers credentials only, so
`identityRedact` removes four classes deterministically (email addresses,
account handles including the owner segment of a code-hosting URL, filesystem
paths, opaque record ids) on the way into the prompt and again on the model's
output, before the budget check. Over-redaction is the intended failure mode: a
digest of decisions, blockers and in-flight work needs none of them, and the
fresh handoff — which is not summarized — still carries the predecessor's real
transcript path. The deterministic fallback is deliberately untouched: AC 3
specifies the prior handoffs verbatim, and they are the seat's own text.

**The summarizer is an await point across a durable transition.** Rotation
reads the incumbent, waits up to 75 s, then designates with
`replaceIncumbent: true`. A designation that settles inside that window owns the
seat by the time rotation resumes, and replacing it would revoke a newer
orchestrator on the strength of a stale read. Rotation re-reads the seat after
composing and proceeds only when `conversationId` and `seatEpoch` still match;
otherwise 409 `incumbent_changed`, naming both epochs. Nothing is spawned and no
intent is created, so rotating again simply recomposes from the seated
orchestrator. The synchronous path — a first rotation, or a replay of a live
pending intent — has no await point and passes trivially, so the serialization
the store already provides is unchanged.

**A failed intent is terminal, and terminal outranks the idempotency key.** No
schema change: the terminal state is the existing pending row whose
`intent.error` is non-null, which the store already terminalizes into `history`
as `reason: "terminal_error"` on the next `begin`. What changed in `seats.ts` is
that the error is now checked *before* the same-key replay. Replaying an errored
row re-delivered the stored mandate — precisely the text that had just failed —
and left the failed row in the blocking pending position, which is the dead
banner in the incident. Since ambiguous failures (5xx, lost response) make the
draft keep its key and retry with it, that was the common path, not the rare
one. The next `begin` now clears the row whichever key sends it, and the
recomposed mandate is the one that ships. Exactly-once survives where it
matters: delivery is deduplicated by the clientRequestId-derived
`clientMessageId`, a spawn by its `clientAttemptId` receipt. A still-live
pending intent (no recorded error) still replays with its original text.

## Verification

Tests are isolated by construction: every one runs under a fresh
`LLV_STATE_DIR` from `mkdtemp`, restored and removed in `afterEach`, and all
side effects go through injected dependencies — no test spawns a real agent,
opens a socket or reads an account, and the operator's live state under
`$XDG_CONFIG_HOME/agent-log-viewer` is never touched. Fixture conversation ids
are assembled from parts so no id-shaped literal reaches a public artifact.

```
bun test src/lib/orchestrator/seatCommand.test.ts \
         src/lib/orchestrator/handoffDigest.test.ts \
         src/lib/orchestrator/seats.test.ts \
         src/lib/flows/exec.test.ts
bunx tsc --noEmit
bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD main)
```

## Cut on purpose

- **No new seat schema or `state: "failed"` value** — the store's abandoned-row
  rule already exists and the UI already renders `intent.error`.
- **No retry across accounts, no queue, no persistent digest cache** — one
  bounded attempt, then a pure fallback; the digest is recomputed from the
  stored mandate at the next rotation anyway.
- **No configuration knobs for the budgets** — constants next to the code.
- **No summarizer on the first rotation** — nothing to compact.
- **No task-list trimming beyond the existing caps** — the two named trims
  already guarantee a fit for any realistic core.
- **No ADR** — every choice is a local constant or a pure function, reversible
  in one PR.

## Deferred

- **An operator surface to cancel a pending intent.** Once a pending row can
  only hold a deliverable mandate, the remaining pending states are genuinely
  in flight or already terminal.
- **Summarizing on the first rotation.** The transcript path in the handoff
  covers it; add only if successors demonstrably skip reading it.
- **A Claude-engine summarizer when every Codex account is exhausted.** The
  deterministic fallback already meets the criteria; a second engine doubles
  the surface for a rare window.
- **Truncating an over-budget digest instead of falling back.** Measure how
  often it happens before softening it.
