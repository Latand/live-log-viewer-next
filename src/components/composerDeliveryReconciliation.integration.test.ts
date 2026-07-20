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

test("an expired window with no receipt resolves to null so the caller can recover", async () => {
  const actuations = 0;
  let refreshes = 0;

  const reconciled = await reconcileComposerReceipt<{ idempotencyKey: string }>({
    read: () => {
      /* Reading the authoritative snapshot never issues a send. */
      return null;
    },
    refresh: async () => {
      refreshes += 1;
      return false;
    },
    timeoutMs: 30,
    pollIntervalMs: 4,
  });

  /* A null resolution is the recoverable signal: the window closed without a
     receipt, and reconciliation issued zero sends. */
  expect(reconciled).toBeNull();
  expect(actuations).toBe(0);
  expect(refreshes).toBeGreaterThan(0);
});

test("an aborted window resolves to null without waiting out the deadline", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = reconcileComposerReceipt({
    read: () => null,
    refresh: () => new Promise<boolean>(() => {}),
    timeoutMs: 10_000,
    pollIntervalMs: 1_000,
    signal: controller.signal,
  });
  controller.abort();

  expect(await pending).toBeNull();
  expect(Date.now() - started).toBeLessThan(1_000);
});
