import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

import type { NativeQueueMutation } from "@/hooks/useNativeQueue";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";

import {
  findRetainedQueueAdmission,
  queueAdmissionKey,
  queueEnvelopeNeedsDurableBytes,
  readRetainedQueueAdmissions,
  releaseQueueAdmission,
  resetRetainedQueueAdmissionsForTests,
  restoreQueueAdmission,
  retainDurableQueueAdmission,
  retainQueueAdmission,
  type RetainedQueueAdmission,
} from "./retainedQueueAdmissions";

const dom = new Window();
Object.assign(globalThis, { window: dom, navigator: dom.navigator, sessionStorage: dom.sessionStorage });
const storage = installComposerStorageForTests();
afterAll(() => storage.uninstall());
afterEach(() => {
  storage.reset();
  sessionStorage.clear();
  resetRetainedQueueAdmissionsForTests();
});

const CARD = "conversation_queue_payload";
const binding = { threadId: "thread-one", accountId: "account-one" };
/* Four screenshots: far past what sessionStorage takes as one slot. */
const image = (fill: string) => ({ mime: "image/png", base64: fill.repeat(1024 * 1024) });
const handOff = (text: string, key = `key-${text}`): RetainedQueueAdmission => ({
  key,
  binding,
  mutation: { action: "add", text, images: ["A", "B", "C", "D"].map(image) as never, selectedContext: { version: 1, state: "none" } as never },
});
const slot = () => sessionStorage.getItem(queueAdmissionKey(CARD));

test("a large hand-off keeps its identity in the slot and its bytes in IndexedDB", async () => {
  const envelope = handOff("four screenshots");
  expect(queueEnvelopeNeedsDurableBytes(envelope)).toBe(true);
  expect(await retainDurableQueueAdmission(CARD, envelope)).toBe("retained");

  const stored = JSON.parse(slot()!) as Record<string, unknown>[];
  expect(slot()!.length).toBeLessThan(2048);
  /* A build that predates this reads the entry as one it cannot name. */
  expect(stored[0]).not.toHaveProperty("mutation");
  expect(stored[0]).toMatchObject({ key: envelope.key, binding, command: { action: "add", text: "four screenshots" } });

  const [record] = readRetainedQueueAdmissions(CARD);
  expect(record!.payload).toMatchObject({ images: 4 });
  expect(record!.mutation.images).toBeUndefined();
  const restored = await restoreQueueAdmission(CARD, record!);
  expect(restored).toEqual({ key: envelope.key, binding, mutation: envelope.mutation });
  /* A reload loses the in-process mirror; the slot alone still names it. */
  resetRetainedQueueAdmissionsForTests();
  expect(readRetainedQueueAdmissions(CARD).map((entry) => entry.key)).toEqual([envelope.key]);
});

test("pressing the same large message again finds its operation; a different one does not", async () => {
  const envelope = handOff("same message");
  await retainDurableQueueAdmission(CARD, envelope);
  /* A later press captures a later selection; the admitted one rides the replay. */
  const again = { ...envelope.mutation, selectedContext: { version: 1, state: "later" } } as unknown as NativeQueueMutation;
  expect((await findRetainedQueueAdmission(CARD, again))?.key).toBe(envelope.key);
  expect(await findRetainedQueueAdmission(CARD, { ...envelope.mutation, text: "different words" })).toBeUndefined();
  expect(await retainDurableQueueAdmission(CARD, envelope)).toBe("retained");
  expect(readRetainedQueueAdmissions(CARD)).toHaveLength(1);
});

test("storage that will not take the bytes refuses before anything is recorded", async () => {
  const digest = spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("storage refused"));
  try {
    expect(await retainDurableQueueAdmission(CARD, handOff("refused"))).toBe("refused");
  } finally {
    digest.mockRestore();
  }
  expect(slot()).toBeNull();
  expect(readRetainedQueueAdmissions(CARD)).toEqual([]);
});

test("an unreadable slot refuses, and entries this build cannot name survive every write", async () => {
  sessionStorage.setItem(queueAdmissionKey(CARD), "{not json");
  expect(await retainDurableQueueAdmission(CARD, handOff("beside garbage"))).toBe("refused");
  expect(slot()).toBe("{not json");

  resetRetainedQueueAdmissionsForTests();
  const future = { key: "future-operation", mutation: { action: "future-action" }, binding };
  sessionStorage.setItem(queueAdmissionKey(CARD), JSON.stringify([future]));
  const envelope = handOff("beside a future record");
  expect(await retainDurableQueueAdmission(CARD, envelope)).toBe("retained");
  releaseQueueAdmission(CARD, envelope.key);
  expect(JSON.parse(slot()!)).toEqual([future]);
});

test("a copy that does not verify is not replayed and its identity stays", async () => {
  const envelope = handOff("tampered");
  await retainDurableQueueAdmission(CARD, envelope);
  const [record] = readRetainedQueueAdmissions(CARD);
  await expect(restoreQueueAdmission(CARD, { ...record!, payload: { ...record!.payload!, fingerprint: "0".repeat(64) } }))
    .rejects.toThrow("could not be verified");
  expect(readRetainedQueueAdmissions(CARD).map((entry) => entry.key)).toEqual([envelope.key]);
});

test("terminal evidence releases the identity and then its bytes", async () => {
  const envelope = handOff("settled");
  await retainDurableQueueAdmission(CARD, envelope);
  const [record] = readRetainedQueueAdmissions(CARD);
  releaseQueueAdmission(CARD, envelope.key);
  expect(slot()).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(restoreQueueAdmission(CARD, record!)).rejects.toThrow("could not be verified");
});

test("a small command stays inline and synchronous", () => {
  const small: RetainedQueueAdmission = { key: "small", binding, mutation: { action: "add", text: "short" } };
  expect(queueEnvelopeNeedsDurableBytes(small)).toBe(false);
  expect(retainQueueAdmission(CARD, small)).toBe("retained");
  expect(JSON.parse(slot()!)).toEqual([small]);
});
