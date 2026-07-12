import { describe, expect, test } from "bun:test";

import { ReplayBuffer, sanitize } from "./lib";
import { codexNotificationText } from "./codex-rpc";

describe("ReplayBuffer", () => {
  test("a late viewer receives every event after its last sequence", () => {
    const replay = new ReplayBuffer<string>(4);
    replay.push("one");
    const second = replay.push("two");
    replay.push("three");

    expect(replay.after(second.seq)).toEqual([{ seq: 3, value: "three" }]);
  });

  test("retains a bounded replay window", () => {
    const replay = new ReplayBuffer<string>(2);
    replay.push("one");
    replay.push("two");
    replay.push("three");

    expect(replay.after(0)).toEqual([
      { seq: 2, value: "two" },
      { seq: 3, value: "three" },
    ]);
  });
});

describe("sanitize", () => {
  test("redacts token-shaped strings, emails, and the local home path", () => {
    expect(
      sanitize({
        token: "sk-example-secret-value",
        email: "person@example.com",
        path: "/home/latand/project",
      }),
    ).toEqual({
      token: "[REDACTED_TOKEN]",
      email: "[REDACTED_EMAIL]",
      path: "$HOME/project",
    });
  });
});

describe("codexNotificationText", () => {
  test("combines fragmented deltas and completed agent messages", () => {
    const messages = [
      { method: "item/agentMessage/delta", params: { delta: "STEERED-" } },
      { method: "item/agentMessage/delta", params: { delta: "OK" } },
      { method: "item/completed", params: { item: { type: "agentMessage", text: "STEERED-OK" } } },
    ];

    expect(codexNotificationText(messages)).toContain("STEERED-OK");
  });
});
