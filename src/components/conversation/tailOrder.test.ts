import { describe, expect, test } from "bun:test";

import { CONVERSATION_TAIL_ORDER, orderedConversationTail } from "./tailOrder";

/*
 * P1#3 (round-1 review), ordering arm — proven with a stable pure helper instead
 * of a process-global module-mocked LogFeed render. LogFeed renders its window
 * tail strictly in the order this helper returns, so asserting the order here
 * enforces prompt → reply chronology at the source.
 */

describe("orderedConversationTail", () => {
  test("the streaming assistant delta always renders AFTER the operator's pending prompt", () => {
    const order = orderedConversationTail({ launch: false, outbox: true, delta: true });
    expect(order).toEqual(["outbox", "delta"]);
    expect(order.indexOf("outbox")).toBeLessThan(order.indexOf("delta"));
  });

  test("during launch the status chips lead, then the prompt, then the reply", () => {
    expect(orderedConversationTail({ launch: true, outbox: true, delta: true }))
      .toEqual(["launch", "outbox", "delta"]);
  });

  test("only present sections render, in canonical order", () => {
    expect(orderedConversationTail({ launch: true, outbox: false, delta: false })).toEqual(["launch"]);
    expect(orderedConversationTail({ launch: false, outbox: false, delta: true })).toEqual(["delta"]);
    expect(orderedConversationTail({ launch: false, outbox: false, delta: false })).toEqual([]);
  });

  test("the canonical order is launch → outbox → delta", () => {
    expect(CONVERSATION_TAIL_ORDER).toEqual(["launch", "outbox", "delta"]);
  });
});
