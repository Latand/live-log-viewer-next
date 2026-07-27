import { afterEach, expect, test } from "bun:test";

import {
  composerStore,
  resetComposerStoresForTest,
  type SharedAttachment,
} from "./composerStore";

afterEach(() => {
  resetComposerStoresForTest();
});

function attachment(id: string): SharedAttachment {
  return { id, status: "ready", name: `${id}.png`, mime: "image/png", preview: `blob:${id}` };
}

test("one conversation has one store, however many renderings ask for it", () => {
  /* The card and the floater resolve the store the same way the realtime client is
     resolved — by conversation id — so "one composer state" is a property of the
     module, not of whoever mounted first. */
  expect(composerStore("conversation_a")).toBe(composerStore("conversation_a"));
  expect(composerStore("conversation_b")).not.toBe(composerStore("conversation_a"));
});

test("two subscribers see one draft, whichever one edits it (U2, AC4)", () => {
  const store = composerStore("conversation_a");
  const seenByCard: string[] = [];
  const seenByFloater: string[] = [];
  store.subscribe(() => seenByCard.push(store.getSnapshot().draft));
  store.subscribe(() => seenByFloater.push(store.getSnapshot().draft));

  store.setDraft("start a rev");
  store.setDraft("start a reviewer");

  expect(store.getSnapshot().draft).toBe("start a reviewer");
  expect(seenByCard).toEqual(["start a rev", "start a reviewer"]);
  expect(seenByFloater).toEqual(seenByCard);
});

test("the snapshot identity is stable between changes, so subscribers do not spin", () => {
  const store = composerStore("conversation_a");
  const first = store.getSnapshot();
  expect(store.getSnapshot()).toBe(first);

  store.setDraft("x");
  expect(store.getSnapshot()).not.toBe(first);
  expect(store.getSnapshot()).toBe(store.getSnapshot());
});

test("writing the same draft again notifies nobody", () => {
  const store = composerStore("conversation_a");
  store.setDraft("same");
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  store.setDraft("same");
  expect(notifications).toBe(0);
});

test("attachments are shared and staged once, whichever rendering attached them (AC5)", () => {
  const store = composerStore("conversation_a");
  const seen: number[] = [];
  store.subscribe(() => seen.push(store.getSnapshot().attachments.length));

  store.setAttachments([attachment("one")]);
  store.setAttachments([attachment("one"), attachment("two")]);
  expect(store.getSnapshot().attachments.map((entry) => entry.id)).toEqual(["one", "two"]);

  store.setAttachments([attachment("two")]);
  expect(store.getSnapshot().attachments.map((entry) => entry.id)).toEqual(["two"]);
  expect(seen).toEqual([1, 2, 1]);
});

test("one draft carries one idempotency key, so two Send buttons cannot become two sends (AC4)", () => {
  const store = composerStore("conversation_a");
  store.setDraft("deploy it");
  const key = store.sendKey();

  /* The floater's Send and the card's Send race. Both read the key for the draft
     they can see, and the draft has not changed, so both name one delivery. */
  expect(store.sendKey()).toBe(key);
  expect(key).toMatch(/^composer_/);
});

test("the key survives a rendering swap — closing the floater is not a new message (AC6)", () => {
  const store = composerStore("conversation_a");
  store.setDraft("deploy it");
  const key = store.sendKey();

  /* The floater unmounts, the card re-mounts, both resolve the store again. */
  const afterSwap = composerStore("conversation_a");
  expect(afterSwap.sendKey()).toBe(key);
});

test("a new draft after a send gets a new key", () => {
  const store = composerStore("conversation_a");
  store.setDraft("first");
  const first = store.sendKey();
  store.commitSend(first!);

  expect(store.getSnapshot().draft).toBe("");
  store.setDraft("second");
  expect(store.sendKey()).not.toBe(first);
});

test("committing a send clears the draft and its attachments together", () => {
  const store = composerStore("conversation_a");
  store.setDraft("look at this");
  store.setAttachments([attachment("one")]);
  const key = store.sendKey()!;

  store.commitSend(key);
  expect(store.getSnapshot()).toMatchObject({ draft: "", attachments: [] });
});

test("committing a stale key changes nothing, so a late second Send is a no-op", () => {
  const store = composerStore("conversation_a");
  store.setDraft("first");
  const first = store.sendKey();
  store.commitSend(first!);

  store.setDraft("second");
  const second = store.sendKey();
  store.commitSend(first!);

  expect(store.getSnapshot().draft).toBe("second");
  expect(store.sendKey()).toBe(second);
});

test("editing the draft after reading a key re-keys it, so the key always names what is sent", () => {
  const store = composerStore("conversation_a");
  store.setDraft("deploy");
  const before = store.sendKey();
  store.setDraft("deploy now");
  expect(store.sendKey()).not.toBe(before);
});

test("an empty draft with no attachments has no key to send under", () => {
  const store = composerStore("conversation_a");
  expect(store.sendKey()).toBeNull();
  store.setAttachments([attachment("one")]);
  expect(store.sendKey()).not.toBeNull();
});

test("hydrating from the card's existing draft does not clobber a newer shared edit", () => {
  const store = composerStore("conversation_a");
  store.setDraft("typed in the floater");
  /* The card remounts and offers its persisted sessionStorage draft. The shared
     store is already ahead, and adopting the older text would silently discard
     what the operator just typed in the other window. */
  store.hydrate("older persisted draft");
  expect(store.getSnapshot().draft).toBe("typed in the floater");
});

test("hydrating an untouched store adopts the persisted draft", () => {
  const store = composerStore("conversation_a");
  store.hydrate("older persisted draft");
  expect(store.getSnapshot().draft).toBe("older persisted draft");
});

/* Round 2: the floater must not be silently disarmed by an ordinary card remount,
   and both renderings must own one attachment tray. */

test("a card remount never leaves the floater without a sender", () => {
  const store = composerStore("conversation_a");
  const sends: string[] = [];

  /* React mounts the replacement before it unmounts the outgoing one, so the
     release from the OLD registration arrives last. A naive "clear on release"
     disarms the Send button the operator is about to press. */
  const releaseFirst = store.registerSender(() => sends.push("first"));
  const releaseSecond = store.registerSender(() => sends.push("second"));
  releaseFirst();

  store.setDraft("still sendable");
  store.send();
  expect(sends).toEqual(["second"]);

  releaseSecond();
  store.send();
  expect(sends).toEqual(["second"]);
});

test("attachments staged in the card appear in the floater and are removed once", () => {
  const store = composerStore("conversation_a");
  const removed: string[] = [];
  const release = store.registerAttachmentOwner({
    remove: (id) => { removed.push(id); },
    clearAll: () => { removed.push("*"); },
  });

  store.setAttachments([attachment("one"), attachment("two")]);
  /* Removing from the floater must reach the card's real tray — the tray owns the
     File objects and the object-URL lifetimes, which cannot live in two places. */
  store.removeAttachment("one");
  expect(removed).toEqual(["one"]);

  release();
  /* With no card mounted there is nothing to remove from, and inventing a second
     tray would be how one attachment becomes two. */
  store.removeAttachment("two");
  expect(removed).toEqual(["one"]);
});

test("the attachment owner survives a card remount the same way the sender does", () => {
  const store = composerStore("conversation_a");
  const removed: string[] = [];
  const releaseFirst = store.registerAttachmentOwner({
    remove: () => { removed.push("first"); },
    clearAll: () => undefined,
  });
  const releaseSecond = store.registerAttachmentOwner({
    remove: () => { removed.push("second"); },
    clearAll: () => undefined,
  });
  releaseFirst();

  store.removeAttachment("x");
  expect(removed).toEqual(["second"]);
  releaseSecond();
});

test("the store says whether a delivery path exists, so the floater can be honest", () => {
  /* The card can unmount while the floater stays on screen — different windows,
     different lifetimes. A Send button that silently does nothing is worse than a
     disabled one: the operator believes the message went. */
  const store = composerStore("conversation_a");
  expect(store.getSnapshot().canSend).toBe(false);

  const release = store.registerSender(() => undefined);
  expect(store.getSnapshot().canSend).toBe(true);

  release();
  expect(store.getSnapshot().canSend).toBe(false);
});

test("gaining and losing a delivery path notifies subscribers", () => {
  const store = composerStore("conversation_a");
  const seen: boolean[] = [];
  store.subscribe(() => seen.push(store.getSnapshot().canSend));

  const release = store.registerSender(() => undefined);
  release();
  expect(seen).toEqual([true, false]);
});

test("a replacement sender keeps the path open across a card remount", () => {
  const store = composerStore("conversation_a");
  const releaseFirst = store.registerSender(() => undefined);
  const seen: boolean[] = [];
  store.subscribe(() => seen.push(store.getSnapshot().canSend));

  const releaseSecond = store.registerSender(() => undefined);
  releaseFirst();
  /* Never flickered closed: the operator's Send stayed live through the remount. */
  expect(seen).toEqual([]);
  expect(store.getSnapshot().canSend).toBe(true);
  releaseSecond();
});
