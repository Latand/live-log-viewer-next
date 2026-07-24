import { describe, expect, test } from "bun:test";

import {
  OAUTH_FAILURE_AT,
  SHUTDOWN_INTERRUPT_UUID,
  continuationPromptRecord,
  inheritedPromptRecord,
  oauthFailureRecord,
  oauthFailureWithRecoveryTail,
  shutdownInterruptRecord,
  syntheticNoOpRecord,
  workingAssistantRecord,
} from "./fixtures/claudeRecoveryTail";
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

describe("issue 516 — structured Claude API-error records project the terminal turn", () => {
  const user = (timestamp: string) => ({
    type: "user",
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "continue" }] },
  });
  const workingAssistant = (timestamp: string) => ({
    type: "assistant",
    timestamp,
    message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "working" }] },
  });
  const apiError = (timestamp: string, error: string | null, flagged = true, stop: string | null = "stop_sequence") => ({
    type: "assistant",
    timestamp,
    isApiErrorMessage: flagged,
    ...(error === null ? {} : { error }),
    message: { role: "assistant", model: "<synthetic>", stop_reason: stop, content: [{ type: "text", text: "API Error" }] },
  });
  const result = (timestamp: string) => ({ type: "result", timestamp, subtype: "success" });

  const authoritativeCases: {
    name: string;
    records: Record<string, unknown>[];
    expected: { state: string; source: string; terminalAt: string | null };
  }[] = [
    {
      name: "an authentication_failed API error closes the turn as lifecycle-terminal",
      records: [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "authentication_failed")],
      expected: { state: "terminal", source: "lifecycle", terminalAt: "2026-07-17T15:00:01Z" },
    },
    {
      name: "a rate_limit API error closes the turn as lifecycle-terminal",
      records: [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "rate_limit")],
      expected: { state: "terminal", source: "lifecycle", terminalAt: "2026-07-17T15:00:01Z" },
    },
    {
      name: "an unknown API error code keeps the busy-assistant projection",
      records: [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "model_not_found")],
      expected: { state: "busy", source: "assistant", terminalAt: null },
    },
    {
      name: "a flagged API error without a structured code keeps the busy-assistant projection",
      records: [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", null)],
      expected: { state: "busy", source: "assistant", terminalAt: null },
    },
    {
      name: "a terminal error code on an unflagged assistant record keeps the busy-assistant projection",
      records: [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "authentication_failed", false)],
      expected: { state: "busy", source: "assistant", terminalAt: null },
    },
    {
      name: "a newer user record reopens the turn after a terminal API error",
      records: [
        user("2026-07-17T15:00:00Z"),
        apiError("2026-07-17T15:00:01Z", "authentication_failed"),
        user("2026-07-17T15:00:02Z"),
      ],
      expected: { state: "busy", source: "lifecycle", terminalAt: null },
    },
    {
      name: "a newer ordinary assistant record reopens the turn after a terminal API error",
      records: [
        user("2026-07-17T15:00:00Z"),
        apiError("2026-07-17T15:00:01Z", "rate_limit"),
        workingAssistant("2026-07-17T15:00:02Z"),
      ],
      expected: { state: "busy", source: "assistant", terminalAt: null },
    },
    {
      name: "a later result record stays terminal at its own timestamp",
      records: [
        user("2026-07-17T15:00:00Z"),
        apiError("2026-07-17T15:00:01Z", "authentication_failed"),
        result("2026-07-17T15:00:02Z"),
      ],
      expected: { state: "terminal", source: "lifecycle", terminalAt: "2026-07-17T15:00:02Z" },
    },
  ];

  for (const { name, records, expected } of authoritativeCases) {
    test(`authoritative: ${name}`, () => {
      expect(turnStateFromRecords(records, false, true)).toEqual(expected as ReturnType<typeof turnStateFromRecords>);
    });
  }

  test("activity: a terminal API error without a stop reason closes the turn", () => {
    const records = [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "authentication_failed", true, null)];
    expect(turnStateFromRecords(records, false)).toEqual({
      state: "terminal",
      source: "lifecycle",
      terminalAt: "2026-07-17T15:00:01Z",
    });
  });

  test("activity: an unknown API error without a stop reason keeps the busy-assistant projection", () => {
    const records = [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", "model_not_found", true, null)];
    expect(turnStateFromRecords(records, false)).toEqual({ state: "busy", source: "assistant", terminalAt: null });
  });

  test("activity: an ordinary stop_sequence assistant record keeps its terminal projection", () => {
    const records = [user("2026-07-17T15:00:00Z"), apiError("2026-07-17T15:00:01Z", null, false)];
    expect(turnStateFromRecords(records, false)).toEqual({
      state: "terminal",
      source: "lifecycle",
      terminalAt: "2026-07-17T15:00:01Z",
    });
  });
});

describe("issue 516 — recovery records must not reopen a released turn", () => {
  const authoritative = (records: Record<string, unknown>[]) => turnStateFromRecords(records, false, true);
  const released = { state: "terminal", source: "lifecycle", terminalAt: OAUTH_FAILURE_AT } as const;

  test("the production recovery tail after a terminal OAuth failure projects a released turn", () => {
    expect(authoritative(oauthFailureWithRecoveryTail())).toEqual(released);
  });

  test("a repeated recovery attempt stays released", () => {
    expect(authoritative(oauthFailureWithRecoveryTail(3))).toEqual(released);
  });

  test("a tail ending on the synthetic no-op right after the OAuth boundary is released", () => {
    const records = [
      { type: "user", timestamp: "2026-07-24T06:36:44.000Z", message: { role: "user", content: [{ type: "text", text: "Continue the reseat probe." }] } },
      oauthFailureRecord(OAUTH_FAILURE_AT),
      continuationPromptRecord("2026-07-24T07:04:23.736Z"),
      syntheticNoOpRecord("2026-07-24T07:04:23.736Z"),
    ];
    expect(authoritative(records)).toEqual(released);
  });

  test("a recovery run that ends on a live prompt keeps the turn busy", () => {
    const records = oauthFailureWithRecoveryTail();
    const upToPrompt = records.slice(0, records.findIndex((record) => record.uuid === SHUTDOWN_INTERRUPT_UUID));
    expect(authoritative(upToPrompt)).toEqual({ state: "busy", source: "lifecycle", terminalAt: null });
  });

  test("a real in-flight assistant record inside the run keeps the turn busy", () => {
    const records = [
      ...oauthFailureWithRecoveryTail(),
      workingAssistantRecord("2026-07-24T07:05:00.000Z"),
    ];
    expect(authoritative(records)).toEqual({ state: "busy", source: "assistant", terminalAt: null });
  });

  test("a synthetic-model record carrying real prose is not a no-op", () => {
    const prose = syntheticNoOpRecord("2026-07-24T07:04:23.736Z");
    (prose.message as Record<string, unknown>).content = [{ type: "text", text: "Правда — я запустив його" }];
    const records = [...oauthFailureWithRecoveryTail(), prose];
    expect(authoritative(records)).toEqual({ state: "busy", source: "assistant", terminalAt: null });
  });

  test("a recovery run without a terminal boundary keeps the turn busy", () => {
    const records = [
      { type: "user", timestamp: "2026-07-24T07:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "start" }] } },
      continuationPromptRecord("2026-07-24T07:04:23.736Z"),
      syntheticNoOpRecord("2026-07-24T07:04:23.736Z"),
      inheritedPromptRecord("2026-07-24T07:04:23.804Z"),
      shutdownInterruptRecord("2026-07-24T07:04:25.176Z"),
    ];
    expect(authoritative(records)).toEqual({ state: "busy", source: "lifecycle", terminalAt: null });
  });

  test("an ordinary result boundary also releases its recovery tail", () => {
    const records = [
      { type: "user", timestamp: "2026-07-24T06:36:44.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "result", timestamp: "2026-07-24T06:36:50.000Z", subtype: "success" },
      continuationPromptRecord("2026-07-24T07:04:23.736Z"),
      syntheticNoOpRecord("2026-07-24T07:04:23.736Z"),
    ];
    expect(authoritative(records)).toEqual({
      state: "terminal",
      source: "lifecycle",
      terminalAt: "2026-07-24T06:36:50.000Z",
    });
  });

  test("the activity projection keeps its own live semantics for the same tail", () => {
    expect(turnStateFromRecords(oauthFailureWithRecoveryTail(), false)).toEqual({
      state: "busy",
      source: "lifecycle",
      terminalAt: null,
    });
  });
});
