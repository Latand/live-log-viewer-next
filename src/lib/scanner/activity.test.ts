import { describe, expect, test } from "bun:test";

import { turnStateFromRecords } from "./activity";

const assistant = (stop: string | null, ...kinds: string[]) => ({
  type: "assistant",
  message: {
    stop_reason: stop,
    content: kinds.map((kind) => (kind === "text" ? { type: "text", text: "Now let me rewrite the file." } : { type: kind })),
  },
});

describe("turnStateFromRecords (claude)", () => {
  test("mid-turn narration — text record before its tool_use lands — keeps the turn open", () => {
    /* The exact window that mislabeled working subagents as «returned with
       result»: Claude appends the narration record first, then the tool_use. */
    const records = [{ type: "user" }, assistant(null, "thinking"), assistant(null, "text")];
    expect(turnStateFromRecords(records, false)).toBe("busy");
  });

  test("end_turn closes the turn", () => {
    const records = [{ type: "user" }, assistant("end_turn", "text")];
    expect(turnStateFromRecords(records, false)).toBe("done");
  });

  test("stop_sequence closes the turn", () => {
    expect(turnStateFromRecords([assistant("stop_sequence", "text")], false)).toBe("done");
  });

  test("tool_use stop_reason keeps the turn open", () => {
    expect(turnStateFromRecords([assistant("tool_use", "tool_use")], false)).toBe("busy");
  });

  test("trailing user record (tool result pending) keeps the turn open", () => {
    const records = [assistant("tool_use", "tool_use"), { type: "user" }];
    expect(turnStateFromRecords(records, false)).toBe("busy");
  });

  test("no assistant/user records yields no verdict", () => {
    expect(turnStateFromRecords([{ type: "summary" }], false)).toBeNull();
  });
});

describe("turnStateFromRecords (codex)", () => {
  const payload = (type: string, extra: Record<string, unknown> = {}) => ({ type: "event_msg", payload: { type, ...extra } });

  test("lifecycle events are authoritative", () => {
    expect(turnStateFromRecords([payload("task_started")], true)).toBe("busy");
    expect(turnStateFromRecords([payload("task_started"), payload("task_complete")], true)).toBe("done");
  });

  test("interim agent_message after tool activity falls back to done only without newer lifecycle", () => {
    const records = [payload("task_started"), payload("function_call"), payload("agent_message")];
    expect(turnStateFromRecords(records, true)).toBe("busy");
  });

  test("token_count and reasoning records are ignored", () => {
    const records = [payload("task_complete"), payload("token_count"), payload("reasoning")];
    expect(turnStateFromRecords(records, true)).toBe("done");
  });
});
