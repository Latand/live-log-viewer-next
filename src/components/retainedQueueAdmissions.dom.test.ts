import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

import type { NativeQueueMutation } from "@/hooks/useNativeQueue";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";

import {
  findRetainedQueueAdmission,
  queueAdmissionKey,
  queueEnvelopeNeedsDurableBytes,
  readRetainedQueueAdmissions,
  refuseQueueAdmission,
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

test("a document rides the durable envelope, and its bytes are part of what names the operation", async () => {
  const document = { name: "trace.bin", base64: "AP8QgH8ADQo=".repeat(40_000) };
  const envelope: RetainedQueueAdmission = { key: "key-document", binding,
    mutation: { action: "add", text: "trace attached", files: [document] } };
  /* Files alone take a hand-off past the slot, exactly as images do. */
  expect(queueEnvelopeNeedsDurableBytes(envelope)).toBe(true);
  expect(await retainDurableQueueAdmission(CARD, envelope)).toBe("retained");
  expect(slot()!).not.toContain(document.base64.slice(0, 64));
  const [record] = readRetainedQueueAdmissions(CARD);
  expect(record!.payload).toMatchObject({ images: 0, files: 1 });
  expect(record!.mutation.files).toBeUndefined();
  expect(await restoreQueueAdmission(CARD, record!)).toEqual(envelope);
  expect((await findRetainedQueueAdmission(CARD, envelope.mutation))?.key).toBe("key-document");
  const other = { ...envelope.mutation, files: [{ ...document, base64: "AAAA".repeat(40_000) }] };
  expect(await findRetainedQueueAdmission(CARD, other)).toBeUndefined();
});

test("a hand-off retained before files could ride keeps the identity it was stored under", async () => {
  /* The authored digest of a message with no files is unchanged, so a record a
     previous build wrote is still found by pressing the same message again. */
  const envelope = handOff("four screenshots");
  expect(await retainDurableQueueAdmission(CARD, envelope)).toBe("retained");
  const stored = JSON.parse(slot()!) as Array<{ payload: { authored: string } }>;
  const legacy = JSON.stringify({ action: "add", text: "four screenshots", images: envelope.mutation.images,
    runtime: null, entryId: null, expectedRevision: null, queuedSubmissionIds: null, turnId: null });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacy))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  expect(stored[0]!.payload.authored).toBe(digest);
});

test("a refused hand-off keeps its identity and its bytes, across a reload, until it is discarded", async () => {
  /* #1652: a refusal admitted nothing, but the record is still the only whole
     copy of the message once the composer holds newer words. */
  const envelope = handOff("refused later");
  await retainDurableQueueAdmission(CARD, envelope);
  refuseQueueAdmission(CARD, envelope.key, "native queue host or account ownership changed");
  resetRetainedQueueAdmissionsForTests();
  const [record] = readRetainedQueueAdmissions(CARD);
  expect(record).toMatchObject({ key: envelope.key, refused: { reason: "native queue host or account ownership changed" }, payload: { images: 4 } });
  expect((await restoreQueueAdmission(CARD, record!)).mutation).toEqual(envelope.mutation);
  /* The same message pressed again is a new operation. */
  expect(await findRetainedQueueAdmission(CARD, envelope.mutation)).toBeUndefined();

  releaseQueueAdmission(CARD, envelope.key);
  expect(slot()).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(restoreQueueAdmission(CARD, record!)).rejects.toThrow("could not be verified");
});

test("the same message retained again as a new operation takes over the refused copy", async () => {
  const refused = handOff("queued again", "key-refused");
  await retainDurableQueueAdmission(CARD, refused);
  refuseQueueAdmission(CARD, refused.key, "stale binding");
  const [old] = readRetainedQueueAdmissions(CARD);
  /* A different message leaves the refused copy where it is. */
  expect(await retainDurableQueueAdmission(CARD, handOff("something else", "key-other"))).toBe("retained");
  expect(readRetainedQueueAdmissions(CARD).map((entry) => entry.key)).toEqual(["key-refused", "key-other"]);

  expect(await retainDurableQueueAdmission(CARD, { ...refused, key: "key-again" })).toBe("retained");
  expect(readRetainedQueueAdmissions(CARD).map((entry) => entry.key)).toEqual(["key-other", "key-again"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(restoreQueueAdmission(CARD, old!)).rejects.toThrow("could not be verified");
  const [, again] = readRetainedQueueAdmissions(CARD);
  expect((await restoreQueueAdmission(CARD, again!)).mutation).toEqual(refused.mutation);
});

test("a small refused hand-off stays inline, and is taken over by the same words pressed again", () => {
  const small: RetainedQueueAdmission = { key: "small-refused", binding, mutation: { action: "add", text: "short" } };
  retainQueueAdmission(CARD, small);
  refuseQueueAdmission(CARD, small.key, "stale binding");
  expect(JSON.parse(slot()!)).toEqual([{ ...small, refused: { reason: "stale binding" } }]);
  expect(retainQueueAdmission(CARD, { ...small, key: "small-again" })).toBe("retained");
  expect(readRetainedQueueAdmissions(CARD).map((entry) => entry.key)).toEqual(["small-again"]);
});

test("a refused copy the new operation takes over does not count against the bound", () => {
  for (let index = 0; index < 7; index++) retainQueueAdmission(CARD, { key: `other-${index}`, binding, mutation: { action: "add", text: `other ${index}` } });
  const small: RetainedQueueAdmission = { key: "bounded-refused", binding, mutation: { action: "add", text: "bounded" } };
  expect(retainQueueAdmission(CARD, small)).toBe("retained");
  refuseQueueAdmission(CARD, small.key, "stale binding");
  expect(retainQueueAdmission(CARD, { key: "new-message", binding, mutation: { action: "add", text: "new" } })).toBe("refused");
  expect(retainQueueAdmission(CARD, { ...small, key: "bounded-again" })).toBe("retained");
  expect(readRetainedQueueAdmissions(CARD)).toHaveLength(8);
});
