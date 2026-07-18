import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { durableStageTurnEvidence } from "./durableEvidence";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durable-evidence-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeTranscript(name: string, records: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

const PASS_TEXT = "done\n\n```json\n{\"status\":\"pass\"}\n```";

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
