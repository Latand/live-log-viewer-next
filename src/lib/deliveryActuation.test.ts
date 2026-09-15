import { expect, test } from "bun:test";

import { tryConversationActuation, withConversationActuation } from "./deliveryActuation";

/* The per-conversation actuation section (#1709): serial per conversation, independent across conversations,
   released by work that throws, continued only by the lease handed to its work, and never entered by
   anything that merely runs from inside it. */

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("work for one conversation runs in the order it entered, each after the previous one ends", async () => {
  const events: string[] = [];
  const first = gate();
  const one = withConversationActuation("conversation_a", async () => { events.push("first starts"); await first.opened; events.push("first ends"); });
  const two = withConversationActuation("conversation_a", async () => { events.push("second runs"); });
  await settle();
  expect(events).toEqual(["first starts"]);
  first.open();
  await Promise.all([one, two]);
  expect(events).toEqual(["first starts", "first ends", "second runs"]);
});

test("another conversation's work does not wait for a held section", async () => {
  const held = gate();
  const blocking = withConversationActuation("conversation_b", () => held.opened);
  await settle();
  expect(await withConversationActuation("conversation_other", async () => "other conversation runs")).toBe("other conversation runs");
  held.open();
  await blocking;
});

test("work that throws releases the section and its error reaches the caller", async () => {
  await expect(withConversationActuation("conversation_c", async () => { throw new Error("command refused"); })).rejects.toThrow("command refused");
  expect(await withConversationActuation("conversation_c", async () => "next runs")).toBe("next runs");
});

test("work queued from inside a section, a microtask or a timer, waits for the section to end: ownership is not inherited", async () => {
  const events: string[] = [];
  let queued!: Promise<void>;
  await withConversationActuation("conversation_d", async () => {
    events.push("holder starts");
    queueMicrotask(() => {
      queued = withConversationActuation("conversation_d", async () => { events.push("queued runs"); });
    });
    await settle();
    events.push("holder ends");
  });
  await queued;
  expect(events).toEqual(["holder starts", "holder ends", "queued runs"]);
});

test("the lease handed to a section's work continues that section at once, and stops working when the section ends", async () => {
  const events: string[] = [];
  let kept!: Parameters<Parameters<typeof withConversationActuation>[1]>[0];
  await withConversationActuation("conversation_e", async (lease) => {
    kept = lease;
    events.push(await withConversationActuation("conversation_e", async () => "continued with the lease", lease));
  });
  /* A lease for another conversation, or one whose section has ended, waits like anyone else. */
  const other = gate();
  const holder = withConversationActuation("conversation_e", () => other.opened);
  let staleRan = false;
  const stale = withConversationActuation("conversation_e", async () => { staleRan = true; }, kept);
  await settle();
  expect(staleRan).toBe(false);
  other.open();
  await Promise.all([holder, stale]);
  expect(staleRan).toBe(true);
  expect(events).toEqual(["continued with the lease"]);
});

test("a try on a busy section does not wait: it answers when the section frees, and a free section runs at once", async () => {
  const held = gate();
  const holder = withConversationActuation("conversation_f", () => held.opened);
  const busy = await tryConversationActuation("conversation_f", async () => "must not run");
  expect(busy.acquired).toBe(false);
  let freed = false;
  if (!busy.acquired) void busy.released.then(() => { freed = true; });
  await settle();
  expect(freed).toBe(false);
  held.open();
  await holder;
  await settle();
  expect(freed).toBe(true);
  expect(await tryConversationActuation("conversation_f", async () => "runs")).toEqual({ acquired: true, value: "runs" });
});
