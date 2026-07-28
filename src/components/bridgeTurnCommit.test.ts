import { expect, test } from "bun:test";

import { receiptIsAdmitted } from "./runtime/runtimeModel";
import type { RuntimeReceiptStatus } from "@/lib/runtime/contracts";

/**
 * When the bridge's turn-start cursor may move (#691 §4).
 *
 * Third site of the same class: a cursor advanced on something weaker than durable
 * admission loses reports. The relay's live path waits for the host's confirmation;
 * the turn-start path waits for the send to be admitted — and `ok: true` is not that.
 * A structured send answers ok with a receipt that may still be `pending`, which is a
 * message the server has not committed to holding.
 *
 * The predicate is exercised here directly, over the receipt statuses the runtime
 * actually produces, because the composer's own suite cannot reach this branch
 * without standing up the whole queue-first outbox.
 */

/** Mirrors the condition in `TmuxComposer`'s send path, verbatim in shape. */
function bridgeCursorMayCommit(json: {
  ok: boolean;
  structured?: boolean;
  receipt?: { status: RuntimeReceiptStatus } | null;
}): boolean {
  return json.ok
    && (json.structured
      ? Boolean(json.receipt && receiptIsAdmitted(json.receipt.status))
      : true);
}

test("a failed send never moves the cursor", () => {
  expect(bridgeCursorMayCommit({ ok: false })).toBe(false);
  expect(bridgeCursorMayCommit({ ok: false, structured: true, receipt: { status: "delivered" } })).toBe(false);
});

test("a structured ok WITHOUT a durable receipt does not move the cursor", () => {
  /* The reported defect: generic HTTP success while the receipt has not been
     committed to. The reports must stay pending for the next turn. */
  expect(bridgeCursorMayCommit({ ok: true, structured: true, receipt: null })).toBe(false);
  expect(bridgeCursorMayCommit({ ok: true, structured: true })).toBe(false);
  expect(bridgeCursorMayCommit({ ok: true, structured: true, receipt: { status: "pending" } })).toBe(false);
});

test("a structured ok WITH an admitted receipt moves the cursor", () => {
  for (const status of ["queued", "delivering", "delivered"] as RuntimeReceiptStatus[]) {
    expect(bridgeCursorMayCommit({ ok: true, structured: true, receipt: { status } })).toBe(true);
  }
});

test("a receipt that failed outright does not move the cursor", () => {
  for (const status of ["failed", "interrupted"] as RuntimeReceiptStatus[]) {
    expect(bridgeCursorMayCommit({ ok: true, structured: true, receipt: { status } }))
      .toBe(receiptIsAdmitted(status));
    expect(receiptIsAdmitted(status)).toBe(false);
  }
});

test("the legacy path has no receipt, so an ok response is its admission", () => {
  /* `/api/tmux` answers ok only after the write; there is no queue behind it to be
     pending in, so demanding a receipt there would stall the cursor forever. */
  expect(bridgeCursorMayCommit({ ok: true })).toBe(true);
  expect(bridgeCursorMayCommit({ ok: true, structured: false })).toBe(true);
});
