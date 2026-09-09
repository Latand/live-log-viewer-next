import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStableTailRecords } from "@/lib/scanner/activity";

import { durableStageTurnEvidence } from "./durableEvidence";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durable-evidence-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeTranscript(name: string, records: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

const PASS_TEXT = "done\n\n```json\n{\"status\":\"pass\"}\n```";

test("a one-record Codex launch transcript reports no agent progress (#1325)", async () => {
  const file = writeTranscript("codex-launch-only.jsonl", [
    { type: "session_meta", timestamp: "2026-08-31T09:00:00.000Z", payload: { originator: "synthetic" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: true,
    message: null,
  });
});

test("a one-record Codex user event reports transcript progress (#1325)", async () => {
  const file = writeTranscript("codex-user-only.jsonl", [
    { type: "event_msg", timestamp: "2026-08-31T09:00:01.000Z", payload: { type: "user_message", message: "begin" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: false,
  });
});

test("a truncated tail ending in session metadata does not grant launch-only evidence (#1325)", async () => {
  const file = path.join(dir, "codex-truncated-before-session-meta.jsonl");
  const earlierProgress = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "x".repeat(140_000) },
  });
  const replayedMetadata = JSON.stringify({ type: "session_meta", payload: { originator: "synthetic" } });
  fs.writeFileSync(file, `${earlierProgress}\n${replayedMetadata}\n`, "utf8");

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: false,
  });
});

test("a Claude end-turn transcript yields terminal evidence with its final message", async () => {
  const file = writeTranscript("claude-terminal.jsonl", [
    { type: "user", timestamp: "2026-07-18T10:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T10:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T10:05:00.000Z"));
});

test("a mid-work Claude assistant message is busy, never terminal", async () => {
  const file = writeTranscript("claude-midwork.jsonl", [
    { type: "user", timestamp: "2026-07-18T10:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T10:01:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "midway through the fix" }] },
    },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "busy", message: { text: "midway through the fix" } });
});

test("a Codex task_complete transcript yields terminal evidence with the final agent message", async () => {
  const file = writeTranscript("codex-terminal.jsonl", [
    { timestamp: "2026-07-18T11:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T11:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T11:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  const evidence = await durableStageTurnEvidence("codex", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T11:05:00.000Z"));
});

test("a re-hosted Codex continuation settles after a tool call cut off in the prior turn (#1589)", async () => {
  const file = writeTranscript("codex-rehosted-continuation.jsonl", [
    { timestamp: "2026-09-09T05:36:42.000Z", type: "response_item", payload: { type: "function_call", call_id: "old-tool" } },
    { timestamp: "2026-09-09T05:38:44.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "continued-turn" } },
    { timestamp: "2026-09-09T05:40:17.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-09-09T05:40:18.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "continued-turn", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    message: { text: PASS_TEXT },
  });
});

test("a Codex tail window truncated above its own function_call stays busy (#1589)", async () => {
  /* The real shape behind the guard: a rollout whose single tool output is
     large enough that the 128 KiB window starts inside it, so the matching
     `function_call` is above the window and no boundary is visible. The last
     agent message parses as a verdict, so `unknown` here would hand the engine
     a settlement candidate over a transcript that is still mid-turn. */
  const file = path.join(dir, "codex-truncated-tool-output.jsonl");
  const rows = [
    JSON.stringify({ timestamp: "2026-09-09T07:30:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "oversized" } }),
    /* Bulk that pushes the call out of the window; the read starts inside it. */
    JSON.stringify({ timestamp: "2026-09-09T07:30:01.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "r".repeat(200_000) } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:02.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "oversized", output: "x".repeat(40_000) } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:04.000Z", type: "event_msg", payload: { type: "token_count" } }),
  ];
  fs.writeFileSync(file, rows.join("\n") + "\n", "utf8");

  const read = await readStableTailRecords(file);
  expect(read).toMatchObject({ integrity: "complete", prefixTruncated: true });
  expect(read.records.map((record) => (record.payload as { type: string }).type))
    .toEqual(["agent_message", "custom_tool_call_output", "token_count"]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "busy",
    message: { text: PASS_TEXT },
  });
});

test("a Codex turn with an open tool call is busy", async () => {
  const file = writeTranscript("codex-busy.jsonl", [
    { timestamp: "2026-07-18T11:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T11:01:00.000Z", payload: { type: "function_call", call_id: "call-1" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a Codex terminal verdict with trailing bookkeeping records stays terminal (#337 production shape)", async () => {
  /* The exact production tail: fenced verdict, task_complete, then bookkeeping
     records append after the turn ends — the scan holds jsonl_turn_stalled at
     this final size while the turn is durably terminal. */
  const file = writeTranscript("codex-terminal-bookkeeping.jsonl", [
    { timestamp: "2026-07-18T12:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T12:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T12:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
    { timestamp: "2026-07-18T12:05:01.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 52_144, output_tokens: 3_902 } } } },
  ]);

  const evidence = await durableStageTurnEvidence("codex", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T12:05:00.000Z"));
});

test("a Claude end-turn verdict with a trailing bookkeeping record stays terminal (#337 production shape)", async () => {
  const file = writeTranscript("claude-terminal-bookkeeping.jsonl", [
    { type: "user", timestamp: "2026-07-18T12:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T12:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
    { type: "file-history-snapshot", timestamp: "2026-07-18T12:05:01.000Z", snapshot: { trackedFileBackups: {} } },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
});

test("a Codex verdict whose turn still holds an open tool call is busy, never terminal", async () => {
  const file = writeTranscript("codex-open-tool-verdict.jsonl", [
    { timestamp: "2026-07-18T13:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T13:01:00.000Z", payload: { type: "function_call", call_id: "call-9" } },
    { timestamp: "2026-07-18T13:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T13:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a user record after a terminal Codex verdict reopens the turn as busy", async () => {
  const file = writeTranscript("codex-user-followup.jsonl", [
    { timestamp: "2026-07-18T14:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T14:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T14:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
    { timestamp: "2026-07-18T14:06:00.000Z", payload: { type: "user_message", message: "one more request before you stop" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a user record after a terminal Claude verdict reopens the turn as busy", async () => {
  const file = writeTranscript("claude-user-followup.jsonl", [
    { type: "user", timestamp: "2026-07-18T14:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T14:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
    { type: "user", timestamp: "2026-07-18T14:06:00.000Z", message: { role: "user", content: "one more request" } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy" });
});

test("a missing or torn artifact yields no durable evidence", async () => {
  expect(await durableStageTurnEvidence("claude", path.join(dir, "absent.jsonl"))).toBeNull();

  const torn = path.join(dir, "torn.jsonl");
  fs.writeFileSync(torn, '{"type":"assistant","message":{"stop_reason":"end_turn"\n', "utf8");
  expect(await durableStageTurnEvidence("claude", torn)).toBeNull();
});

/* #1141 — a provider limit cuts the turn off mid-flight, so the transcript's
   last record is the CLI's own notice and there is no verdict to read. The
   invented notices below are the two shapes the CLIs write; never copy a real
   transcript into a fixture. */
const CLAUDE_SESSION_LIMIT = "You've hit your session limit. Try again once the window resets.";

function claudeLimitRecord(timestamp: string, text = CLAUDE_SESSION_LIMIT): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp,
    isApiErrorMessage: true,
    error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text }] },
  };
}

test("a Claude turn cut off by a session limit reports the provider's notice as terminal evidence (#1141)", async () => {
  const file = writeTranscript("claude-session-limit.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "halfway through the fix" }] },
    },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: CLAUDE_SESSION_LIMIT },
  });
  expect(evidence!.terminalProviderMessage!.ts).toBe(Date.parse("2026-08-27T09:41:00.000Z"));
});

test("a limit notice under trailing bookkeeping records still closes the turn (#1141)", async () => {
  const file = writeTranscript("claude-session-limit-bookkeeping.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
    { type: "file-history-snapshot", timestamp: "2026-08-27T09:41:01.000Z", snapshot: { trackedFileBackups: {} } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: CLAUDE_SESSION_LIMIT },
  });
});

test("a turn that ended on its own verdict carries no provider notice (#1141)", async () => {
  const file = writeTranscript("claude-verdict-no-notice.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal",
    message: { text: PASS_TEXT },
    terminalProviderMessage: null,
  });
});

test("a silent mid-work transcript carries no provider notice (#1141)", async () => {
  const file = writeTranscript("claude-silent-midwork.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:02:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "reading the failing test" }] },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy", terminalProviderMessage: null });
});

test("prose that merely quotes a limit notice is not one (#1141)", async () => {
  const file = writeTranscript("claude-quoted-limit.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:05:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `The stage agent stopped on "${CLAUDE_SESSION_LIMIT}" last night.` }],
      },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "terminal", terminalProviderMessage: null });
});

test("a prompt after the limit notice reopens the turn and withdraws the evidence (#1141)", async () => {
  const file = writeTranscript("claude-limit-then-prompt.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
    { type: "user", timestamp: "2026-08-27T13:00:00.000Z", message: { role: "user", content: "carry on now that the window reset" } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy", terminalProviderMessage: null });
});

test("a Codex turn refused for usage carries the provider's notice (#1141)", async () => {
  const file = writeTranscript("codex-usage-limit.jsonl", [
    { timestamp: "2026-08-27T10:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-08-27T10:04:00.000Z", payload: { type: "agent_message", message: "starting on the stage" } },
    {
      timestamp: "2026-08-27T10:05:00.000Z",
      payload: {
        type: "task_complete",
        error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" },
      },
    },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: "You've hit your usage limit. Try again after reset." },
  });
});

test("a Codex usage-limit terminal record carries its governing reset (#1371)", async () => {
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const file = writeTranscript("codex-usage-limit-reset.jsonl", [
    { timestamp: "2026-08-31T10:00:00.000Z", payload: { type: "task_started" } },
    {
      timestamp: "2026-08-31T10:04:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 27, window_minutes: 10_080, resets_at: resetsAt },
          secondary: null,
          credits: { has_credits: true, balance: "0" },
          plan_type: "pro",
        },
      },
    },
    {
      timestamp: "2026-08-31T10:05:00.000Z",
      payload: {
        type: "task_complete",
        message: "You've hit your usage limit. Try again after the weekly reset.",
        codex_error_info: "usage_limit",
      },
    },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: {
      text: "You've hit your usage limit. Try again after the weekly reset.",
      usageLimit: { resetsAt },
    },
  });
});

test("a Codex turn that completed normally carries no provider notice (#1141)", async () => {
  const file = writeTranscript("codex-clean-complete.jsonl", [
    { timestamp: "2026-08-27T10:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-08-27T10:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-08-27T10:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "terminal", terminalProviderMessage: null });
});
