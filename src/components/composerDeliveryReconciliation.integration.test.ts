import { expect, test } from "bun:test";

import {
  ComposerAdmissionTimeoutError,
  reconcileComposerReceipt,
  withComposerAdmissionDeadline,
} from "./composerAdmissionDeadline";

test("a timed-out admission keeps one actuation while its late response yields the receipt", async () => {
  const clientMessageId = "composer-delayed-receipt";
  let actuations = 0;
  const durableDelivery = new Promise<{ idempotencyKey: string }>((resolve) => {
    actuations += 1;
    setTimeout(() => {
      resolve({ idempotencyKey: clientMessageId });
    }, 15);
  });

  await expect(withComposerAdmissionDeadline(durableDelivery, 2))
    .rejects.toBeInstanceOf(ComposerAdmissionTimeoutError);

  const reconciled = await reconcileComposerReceipt({
    read: () => null,
    refresh: async () => false,
    late: durableDelivery,
    timeoutMs: 100,
    pollIntervalMs: 1,
  });

  expect(reconciled).toEqual({ idempotencyKey: clientMessageId });
  expect(actuations).toBe(1);
});
