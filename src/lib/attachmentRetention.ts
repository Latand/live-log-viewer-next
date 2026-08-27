/**
 * When a send's inbox attachments may be deleted (issue #1224).
 *
 * The rule is keyed on the delivery having TERMINATED, never on the response
 * not being ok. Those are different facts. A structured send can come back
 * `ok: false` while the message is on its way — the host connection dropped
 * mid-command, or the host answered with an `uncertain` receipt — and the same
 * bytes the agent is about to be told to open are still the only copy that
 * exists: the browser uploaded them and let them go. Deleting on "not ok"
 * therefore hands the agent a path to a file the Viewer just removed, which is
 * the silent data loss this issue exists to remove, one layer down from the
 * composer. #1213 already refuses to claim delivery for an uncertain send; the
 * inbox refuses to un-deliver one.
 *
 * The trade is deliberate and one-directional: an uncertain delivery that in
 * fact never landed leaves at most one message's attachments behind (5 files,
 * 40 MB, by `filePolicy`), while the opposite mistake destroys the operator's
 * only copy. Bytes are recoverable; a deleted attachment is not.
 */

/**
 * What the Viewer can honestly say about a send once its route is finished:
 *
 * - `accepted`  — admitted, queued, held or delivered. The agent has, or will
 *                 be given, the path, so the bytes stay.
 * - `refused`   — terminally refused. Nothing was handed over and nothing ever
 *                 will be, so the bytes are orphans and go.
 * - `uncertain` — the attempt may have landed and the Viewer cannot tell. The
 *                 bytes stay until something settles it.
 */
export type AttachmentDeliveryOutcome = "accepted" | "refused" | "uncertain";

/** Inbox bytes are released on a TERMINAL refusal, and on nothing else. */
export function attachmentsAreOrphaned(outcome: AttachmentDeliveryOutcome): boolean {
  return outcome === "refused";
}

/**
 * The delivery fate of a structured send, as its own result reports it. The
 * uncertainty test is the one `flows/engine.ts` applies before it dares call a
 * relayed send failed: a transport failure proves nothing about what the host
 * did with the command, and an `uncertain` receipt is the host saying so
 * itself.
 */
export function structuredAttachmentOutcome(result: {
  ok: boolean;
  transportUncertain?: boolean;
  receipt?: { status?: string } | null;
}): AttachmentDeliveryOutcome {
  if (result.ok) return "accepted";
  if (result.transportUncertain === true) return "uncertain";
  return result.receipt?.status === "uncertain" ? "uncertain" : "refused";
}
