import { expect, test } from "bun:test";

import { turnStateFromRecords } from "./turnState";

test("issue 51 keeps a Codex turn busy through interim assistant text and tool work", () => {
  const records = [
    { payload: { type: "turn_started" } },
    { payload: { type: "agent_message" } },
    { payload: { type: "custom_tool_call", id: "tool-1" } },
    { payload: { type: "agent_message" } },
  ];
  expect(turnStateFromRecords(records, true)).toMatchObject({ state: "busy", source: "tool" });
  expect(turnStateFromRecords([
    ...records,
    { payload: { type: "custom_tool_call_output", call_id: "tool-1" } },
    { timestamp: "2026-07-10T12:00:00.000Z", payload: { type: "turn_complete" } },
  ], true)).toEqual({ state: "terminal", source: "lifecycle", terminalAt: "2026-07-10T12:00:00.000Z" });
});

test("issue 51 requires the matching terminal event after every open tool closes", () => {
  const open = [
    { type: "event_msg", timestamp: "2026-07-10T00:00:00Z", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "event_msg", timestamp: "2026-07-10T00:00:01Z", payload: { type: "agent_message", message: "I am checking" } },
    { type: "response_item", timestamp: "2026-07-10T00:00:02Z", payload: { type: "custom_tool_call", id: "tool-1" } },
  ];
  expect(turnStateFromRecords(open, true).state).toBe("busy");

  const closedTool = [...open, {
    type: "response_item",
    timestamp: "2026-07-10T00:00:03Z",
    payload: { type: "custom_tool_call_output", call_id: "tool-1", output: "ok" },
  }];
  expect(turnStateFromRecords(closedTool, true).state).toBe("busy");

  const prematureTerminal = [...open, {
    type: "event_msg",
    timestamp: "2026-07-10T00:00:02.500Z",
    payload: { type: "task_complete", turn_id: "turn-1" },
  }];
  expect(turnStateFromRecords(prematureTerminal, true).state).toBe("busy");

  const terminal = [...closedTool, {
    type: "event_msg",
    timestamp: "2026-07-10T00:00:04Z",
    payload: { type: "task_complete", turn_id: "turn-1" },
  }];
  expect(turnStateFromRecords(terminal, true)).toMatchObject({
    state: "terminal",
    source: "lifecycle",
    terminalAt: "2026-07-10T00:00:04Z",
  });
});

test("later work after a terminal event reopens the Codex turn", () => {
  const records = [
    { type: "event_msg", timestamp: "2026-07-10T00:00:00Z", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "event_msg", timestamp: "2026-07-10T00:00:01Z", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "response_item", timestamp: "2026-07-10T00:00:02Z", payload: { type: "function_call", call_id: "late-tool" } },
  ];
  expect(turnStateFromRecords(records, true).state).toBe("busy");
});

test("Claude migration waits for a top-level result event", () => {
  const assistant = {
    type: "assistant",
    timestamp: "2026-07-10T00:00:01Z",
    message: { stop_reason: "end_turn" },
  };
  expect(turnStateFromRecords([assistant], false, true)).toEqual({
    state: "busy",
    source: "assistant",
    terminalAt: null,
  });
  expect(turnStateFromRecords([
    assistant,
    { type: "result", timestamp: "2026-07-10T00:00:02Z", subtype: "success" },
  ], false, true)).toEqual({
    state: "terminal",
    source: "lifecycle",
    terminalAt: "2026-07-10T00:00:02Z",
  });
});
