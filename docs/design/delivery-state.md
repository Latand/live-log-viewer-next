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
