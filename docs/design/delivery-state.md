# Delivery state without badge clutter (issue #264)

Owner verdict: green «доставлено» pills stacking near the pane header and
rejection pills piling above the composer are wrong in placement **and**
lifecycle. The message bubble appearing in the feed IS the success receipt;
badges may only exist for states the feed cannot show.

## State classes

Every runtime receipt status maps to exactly one surfacing class
(`src/components/runtime/deliveryState.ts` is the single authority):

| class        | statuses                                              | surface |
|--------------|-------------------------------------------------------|---------|
| **active**   | `pending` `delivering` `queued` `uncertain`           | the existing compact `<details>` disclosure attached to the composer (amber count, per-attempt rows) |
| **resolved** | `turn-started` `steered` `delivered` `answered` `interrupted` | **nothing persistent** — no chip, badge, or pill anywhere |
| **problem**  | `rejected` `failed`                                   | one inline row in the disclosure with Retry (same idempotency key), Edit & resend (new key), and Dismiss |

`turn-started`/`steered` count as resolved (not "active" as before): the
message is inside the running turn, so its bubble is in the transcript and the
turn indicator elsewhere in the UI carries the "agent is working" news.
`interrupted` is a deliberate user action's outcome — terminal, non-actionable,
quiet.

## Lifecycle rules

1. **Success never accumulates.** Resolved receipts render nothing. A group of
   attempts (same kind+text) whose *newest* attempt resolved disappears
   entirely — stale failures superseded by a successful resend of the same
   message go quiet with it.
2. **The echo line bridges feed lag.** While the transcript's mtime has not
   grown past the delivery moment, the delivered text shows as one quiet muted
   line (✓ text · time) above the composer — derived from receipts, never
   stored — and self-clears the instant the feed grows (the bubble landed), on
   dismiss, or after a 10-minute cap. This keeps delivery truth visible during
   the known feed-hydration lag (issue #264 repro of 2026-07-15) without a
   second ambiguous "delivered" layer once the bubble exists.
3. **Failures render once, attached to where the send originated.** Retry
   reuses the idempotency key; Edit mints a new one; Dismiss persists the
   operation ids in sessionStorage keyed by conversation identity and rides
   identity adoption exactly like drafts (`adoptComposerState`). A *new*
   attempt (new operation id) is never suppressed by an old dismissal.
4. **Standalone (non-message) operations** follow the same classes: active and
   problem states visible (problems dismissible), terminal success invisible.
   This removes the accumulated green pills for interrupts etc.
5. **Legacy tmux queue rows** already behave as echoes (they prune when the
   transcript grows past the send moment) and keep their quiet one-line recipe
   (design system §3.5). Migration-fence states (held/queued/recovering/failed)
   keep persisting until resolved or dismissed — they are pending/problem, not
   success.
6. Nothing delivery-related renders outside the composer block; the pane
   header/minimap stay clear.

Both locales (EN/UK), desktop and 390 px: identical anatomy; the failure row's
action chips wrap under the message text at 390 px as before.

## The failure notice (issue #1362)

The problem class no longer renders one pill per attempt. While a settled
message failure is showing, the disclosure's summary line **is** the notice:

```
▸ ⊘ not delivered — runtime host unavailable  ×3            ↻  ✕
```

- **Collapse.** Identical consecutive failures fold into one notice with an
  attempt counter: the newest visible settled failure plus every consecutive
  earlier one with the same cause (`deliveryNoticeRun`). Three retries of one
  message are one notice, ×3. A textless message failure (no echo to group by)
  joins the run and shares one history row per cause. An older failure with a
  different cause waits in the history until the run in front of it is
  dismissed, then surfaces as the next notice.
- **At rest.** Status glyph + `not delivered — <terse cause>` on one
  truncating line, the counter as plain muted text (never a badge). A known
  reason code is its human sentence; a verbatim sentence takes its terse form
  from `describeReceiptFailure` (`receipt.cause.*`), else its first clause. The
  whole sentence rides on hover.
- **Expand.** The full first sentence and the remediation after its semicolon
  render once at the top of the history, then the per-message rows as before
  (Retry / Edit & resend / Discard / Dismiss per row, ×N and superseded
  history). The notice is the accordion's disclosure, not a copy of it.
- **Subordinate but clearly an error.** A 2px danger edge, the glyph and the
  status word carry the role (design §3.7: role in the edge, never a full
  wash); fill and type are the composer's own sunken caption. Both themes read
  through the same role tokens.
- **Actions.** Quiet icon-buttons in the row: same-key Retry for a confirmed
  failure of a message (never for a rejection or a discard), and Dismiss, which
  clears the whole group — every settled attempt the counter counted.
  44px hit areas on touch, inside the same 44px line.
