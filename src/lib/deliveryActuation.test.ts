import { expect, test } from "bun:test";

import { withConversationActuation } from "./deliveryActuation";

/* The per-conversation actuation section (#1709): serial per conversation, independent across
   conversations, re-entrant, and released by work that throws. */

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

test("another conversation's work does not wait, and a section entered again from inside itself runs at once", async () => {
  const events: string[] = [];
  const held = gate();
  const inside = gate();
  const blocking = withConversationActuation("conversation_a", async () => {
    events.push(await withConversationActuation("conversation_a", async () => "nested runs"));
    inside.open();
    await held.opened;
  });
  await inside.opened;
  /* conversation_a's section is still held here. */
  await withConversationActuation("conversation_b", async () => { events.push("other conversation runs"); });
  expect(events).toEqual(["nested runs", "other conversation runs"]);
  held.open();
  await blocking;
});

test("work that throws releases the section and its error reaches the caller", async () => {
  await expect(withConversationActuation("conversation_c", async () => { throw new Error("command refused"); })).rejects.toThrow("command refused");
  expect(await withConversationActuation("conversation_c", async () => "next runs")).toBe("next runs");
});
