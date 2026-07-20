import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { lastTurnFromRecords, recentTurnWindowsFor, recentTurnWindowsFromRecords } from "./turnDuration";

const ms = (iso: string) => Date.parse(iso);

// ── Claude jsonl record builders ────────────────────────────────────────────
const claudeUser = (timestamp: string, content: string) => ({
  type: "user",
  timestamp,
  message: { role: "user", content },
});
const claudeToolResult = (timestamp: string, id: string) => ({
  type: "user",
  timestamp,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const claudeAssistantOpen = (timestamp: string) => ({
  type: "assistant",
  timestamp,
  message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "…" }] },
});
const claudeAssistantEnd = (timestamp: string) => ({
  type: "assistant",
  timestamp,
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
});
const claudeAssistantTool = (timestamp: string) => ({
  type: "assistant",
  timestamp,
  message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
});
const claudeInterrupt = (timestamp: string, extra: Record<string, unknown> = { interruptedMessageId: "msg-1" }) => ({
  type: "user",
  timestamp,
  ...extra,
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
});
const claudeApiError = (timestamp: string) => ({
  type: "assistant",
  timestamp,
  isApiErrorMessage: true,
  message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "API Error: 500" }] },
});

// ── Codex rollout record builders ───────────────────────────────────────────
const codexUser = (timestamp: string, message: string) => ({
  timestamp,
  payload: { type: "user_message", message },
});
const codexTaskStarted = (timestamp: string) => ({ timestamp, payload: { type: "task_started" } });
const codexAgentMessage = (timestamp: string) => ({ timestamp, payload: { type: "agent_message", message: "…" } });
const codexToolCall = (timestamp: string, id: string) => ({
  timestamp,
  payload: { type: "function_call", call_id: id, name: "shell" },
});
const codexToolOutput = (timestamp: string, id: string) => ({
  timestamp,
  payload: { type: "function_call_output", call_id: id, output: "ok" },
});
const codexTaskComplete = (timestamp: string) => ({ timestamp, payload: { type: "task_complete" } });

describe("lastTurnFromRecords — Claude", () => {
  test("enumerates every completed turn in chronological order", () => {
    const result = recentTurnWindowsFromRecords(
      [
        claudeUser("2026-07-14T09:00:00.000Z", "first"),
        claudeAssistantEnd("2026-07-14T09:01:00.000Z"),
        claudeUser("2026-07-14T10:00:00.000Z", "second"),
        claudeAssistantEnd("2026-07-14T10:00:45.000Z"),
      ],
      false,
    );
    expect(result).toEqual([
      {
        startedAt: ms("2026-07-14T09:00:00.000Z"),
        endedAt: ms("2026-07-14T09:01:00.000Z"),
      },
      {
        startedAt: ms("2026-07-14T10:00:00.000Z"),
        endedAt: ms("2026-07-14T10:00:45.000Z"),
      },
    ]);
  });

  test("completed turn: prompt start to end_turn end", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "hi"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeToolResult("2026-07-14T10:00:20.000Z", "t1"),
        claudeAssistantEnd("2026-07-14T10:02:30.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:02:30.000Z"),
    });
  });

  test("running turn: no end_turn yet → endedAt null", () => {
    const boundary = lastTurnFromRecords(
      [claudeUser("2026-07-14T10:00:00.000Z", "hi"), claudeAssistantOpen("2026-07-14T10:00:05.000Z")],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("multi-turn: boundaries reflect only the most-recent turn", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T09:00:00.000Z", "first"),
        claudeAssistantEnd("2026-07-14T09:01:00.000Z"),
        claudeUser("2026-07-14T10:00:00.000Z", "second"),
        claudeAssistantEnd("2026-07-14T10:00:45.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:00:45.000Z"),
    });
  });

  test("new prompt after a finished turn with no reply is running", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T09:00:00.000Z", "first"),
        claudeAssistantEnd("2026-07-14T09:01:00.000Z"),
        claudeUser("2026-07-14T10:00:00.000Z", "second"),
      ],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("tool-result user records do not count as turn starts", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "hi"),
        claudeToolResult("2026-07-14T10:00:20.000Z", "t1"),
        claudeAssistantEnd("2026-07-14T10:00:40.000Z"),
      ],
      false,
    );
    expect(boundary?.startedAt).toBe(ms("2026-07-14T10:00:00.000Z"));
  });

  test("no prompt in the window → null", () => {
    expect(lastTurnFromRecords([claudeAssistantEnd("2026-07-14T10:00:40.000Z")], false)).toBeNull();
  });

  test("steering prompt mid-run keeps the initiating prompt as the start", () => {
    // Operator (or a relaying agent) drops a follow-up while the agent is
    // still working: the total must span initiating prompt → last activity,
    // never just the last message's own slice (issue #268 operator comment).
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start the work"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeUser("2026-07-14T10:29:41.000Z", "also check the tests"),
        claudeAssistantEnd("2026-07-14T10:30:00.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:30:00.000Z"),
    });
  });

  test("steering prompt on a still-running turn keeps the start and stays open", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeUser("2026-07-14T10:20:00.000Z", "steer"),
      ],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("interrupt sentinel closes the window without a terminal record", () => {
    // Ctrl-C leaves no `result` / `end_turn` record — only the protocol user
    // record. The window must still end there instead of ticking forever
    // (issue #268 review finding).
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeInterrupt("2026-07-14T10:04:00.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:04:00.000Z"),
    });
  });

  test("bare interrupt sentinel text (no id field) also closes the window", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeInterrupt("2026-07-14T10:01:30.000Z", {}),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:01:30.000Z"),
    });
  });

  test("the prompt after an interrupt initiates a new window", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeInterrupt("2026-07-14T10:04:00.000Z"),
        claudeUser("2026-07-14T10:05:00.000Z", "try a different approach"),
      ],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:05:00.000Z"), endedAt: null });
  });

  test("API-error crash closes the window at the error record", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
        claudeApiError("2026-07-14T10:02:00.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:02:00.000Z"),
    });
  });

  test("slash-command meta records never open a window (feed metadata contract)", () => {
    // A command invocation is journaled as meta user records that carry real
    // text: the caveat wrapper and the command echo. The feed classifies both
    // as metadata; the timer must not start before the actual prompt lands
    // (issue #406).
    const records = [
      {
        type: "user",
        timestamp: "2026-07-14T09:59:57.000Z",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>Caveat: the command output follows</local-command-caveat>" },
      },
      {
        type: "user",
        timestamp: "2026-07-14T09:59:58.000Z",
        promptSource: "command",
        message: { role: "user", content: "<command-name>/review</command-name>" },
      },
    ];
    expect(lastTurnFromRecords(records, false)).toBeNull();

    const boundary = lastTurnFromRecords(
      [...records, claudeUser("2026-07-14T10:00:00.000Z", "review the diff"), claudeAssistantEnd("2026-07-14T10:05:00.000Z")],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:05:00.000Z"),
    });
  });

  test("promptSource records stay metadata unless typed", () => {
    const notification = {
      type: "user",
      timestamp: "2026-07-14T10:10:00.000Z",
      promptSource: "system",
      origin: { kind: "task-notification" },
      message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" },
    };
    // After a finished turn, a system notification must not open a new window…
    const boundary = lastTurnFromRecords(
      [claudeUser("2026-07-14T10:00:00.000Z", "hi"), claudeAssistantEnd("2026-07-14T10:01:00.000Z"), notification],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:01:00.000Z"),
    });
    // …while an explicitly typed prompt keeps its role through envelope fields.
    const typed = lastTurnFromRecords(
      [
        {
          type: "user",
          timestamp: "2026-07-14T10:20:00.000Z",
          promptSource: "typed",
          origin: { kind: "human" },
          message: { role: "user", content: "queued while you worked" },
        },
      ],
      false,
    );
    expect(typed).toEqual({ startedAt: ms("2026-07-14T10:20:00.000Z"), endedAt: null });
  });

  test("an image-bearing prompt opens a window without any text part", () => {
    const boundary = lastTurnFromRecords(
      [
        {
          type: "user",
          timestamp: "2026-07-14T10:00:00.000Z",
          message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
        },
        claudeAssistantOpen("2026-07-14T10:00:05.000Z"),
      ],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("an ordinary prompt still opens a window under the shared contract", () => {
    const boundary = lastTurnFromRecords([claudeUser("2026-07-14T10:00:00.000Z", "plain prompt")], false);
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("an sdk prompt after a finished turn starts a fresh window over new tool work", () => {
    // Headless/conveyor lanes prompt through the SDK (`promptSource:"sdk"`,
    // no origin). The feed renders the envelope as a system row, but it is a
    // genuine initiator: the window must open at the sdk prompt, not tick
    // from the previous human turn's start (issue #406 review).
    const sdkPrompt = {
      type: "user",
      timestamp: "2026-07-14T12:00:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: "You are a Verifier. Confirm the checkout is clean." },
    };
    const running = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "earlier human turn"),
        claudeAssistantEnd("2026-07-14T10:01:00.000Z"),
        sdkPrompt,
        claudeAssistantTool("2026-07-14T12:00:05.000Z"),
      ],
      false,
    );
    expect(running).toEqual({ startedAt: ms("2026-07-14T12:00:00.000Z"), endedAt: null });

    // A session whose prompts are ALL sdk-sourced still carries a boundary.
    const headless = lastTurnFromRecords([sdkPrompt, claudeAssistantEnd("2026-07-14T12:10:00.000Z")], false);
    expect(headless).toEqual({
      startedAt: ms("2026-07-14T12:00:00.000Z"),
      endedAt: ms("2026-07-14T12:10:00.000Z"),
    });
  });

  test("idle-delivered peer and coordinator messages start fresh windows", () => {
    // Peer/coordinator deliveries are journaled with isMeta:true, yet they
    // initiate the turn that follows — provenance outranks the meta flag.
    for (const kind of ["peer", "coordinator"] as const) {
      const boundary = lastTurnFromRecords(
        [
          claudeUser("2026-07-14T10:00:00.000Z", "earlier human turn"),
          claudeAssistantEnd("2026-07-14T10:01:00.000Z"),
          {
            type: "user",
            timestamp: "2026-07-14T12:00:00.000Z",
            isMeta: true,
            origin: { kind },
            message: { role: "user", content: [{ type: "text", text: "please pick up the review" }] },
          },
          claudeAssistantTool("2026-07-14T12:00:05.000Z"),
        ],
        false,
      );
      expect(boundary).toEqual({ startedAt: ms("2026-07-14T12:00:00.000Z"), endedAt: null });
    }
  });

  test("a compaction summary never opens a window", () => {
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "hi"),
        claudeAssistantEnd("2026-07-14T10:01:00.000Z"),
        {
          type: "user",
          timestamp: "2026-07-14T10:02:00.000Z",
          isCompactSummary: true,
          message: { role: "user", content: "This session is being continued from a previous conversation…" },
        },
      ],
      false,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:01:00.000Z"),
    });
  });

  test("a survived API error keeps the run open and steering continuous", () => {
    // The error was transient: the model kept working after it, so a later
    // prompt steers the same window instead of resetting the start.
    const boundary = lastTurnFromRecords(
      [
        claudeUser("2026-07-14T10:00:00.000Z", "start"),
        claudeApiError("2026-07-14T10:00:30.000Z"),
        claudeAssistantOpen("2026-07-14T10:00:40.000Z"),
        claudeUser("2026-07-14T10:10:00.000Z", "steer"),
      ],
      false,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });
});

describe("lastTurnFromRecords — Codex", () => {
  test("enumerates completed turns followed by the final open turn", () => {
    expect(recentTurnWindowsFromRecords(
      [
        codexUser("2026-07-14T08:00:00.000Z", "first"),
        codexTaskComplete("2026-07-14T08:01:00.000Z"),
        codexUser("2026-07-14T10:00:00.000Z", "second"),
        codexTaskStarted("2026-07-14T10:00:01.000Z"),
      ],
      true,
    )).toEqual([
      { startedAt: ms("2026-07-14T08:00:00.000Z"), endedAt: ms("2026-07-14T08:01:00.000Z") },
      { startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null },
    ]);
  });

  test("completed turn: user_message start to task_complete end", () => {
    const boundary = lastTurnFromRecords(
      [
        codexUser("2026-07-14T10:00:00.000Z", "hi"),
        codexTaskStarted("2026-07-14T10:00:01.000Z"),
        codexToolCall("2026-07-14T10:00:05.000Z", "c1"),
        codexToolOutput("2026-07-14T10:00:12.000Z", "c1"),
        codexAgentMessage("2026-07-14T10:03:00.000Z"),
        codexTaskComplete("2026-07-14T10:03:10.000Z"),
      ],
      true,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:03:10.000Z"),
    });
  });

  test("running turn: open tool call → endedAt null", () => {
    const boundary = lastTurnFromRecords(
      [
        codexUser("2026-07-14T10:00:00.000Z", "hi"),
        codexTaskStarted("2026-07-14T10:00:01.000Z"),
        codexToolCall("2026-07-14T10:00:05.000Z", "c1"),
      ],
      true,
    );
    expect(boundary).toEqual({ startedAt: ms("2026-07-14T10:00:00.000Z"), endedAt: null });
  });

  test("multi-turn: only the most-recent turn's boundaries", () => {
    const boundary = lastTurnFromRecords(
      [
        codexUser("2026-07-14T08:00:00.000Z", "first"),
        codexTaskComplete("2026-07-14T08:01:00.000Z"),
        codexUser("2026-07-14T10:00:00.000Z", "second"),
        codexTaskComplete("2026-07-14T10:00:30.000Z"),
      ],
      true,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:00:30.000Z"),
    });
  });

  test("no user message in the window → null", () => {
    expect(lastTurnFromRecords([codexTaskComplete("2026-07-14T10:00:00.000Z")], true)).toBeNull();
  });

  test("relayed user_message mid-run keeps the initiating prompt as the start", () => {
    const boundary = lastTurnFromRecords(
      [
        codexUser("2026-07-14T10:00:00.000Z", "start the work"),
        codexTaskStarted("2026-07-14T10:00:01.000Z"),
        codexToolCall("2026-07-14T10:00:05.000Z", "c1"),
        codexUser("2026-07-14T10:44:00.000Z", "relayed follow-up"),
        codexToolOutput("2026-07-14T10:44:30.000Z", "c1"),
        codexTaskComplete("2026-07-14T10:45:00.000Z"),
      ],
      true,
    );
    expect(boundary).toEqual({
      startedAt: ms("2026-07-14T10:00:00.000Z"),
      endedAt: ms("2026-07-14T10:45:00.000Z"),
    });
  });
});

test("a truncated transcript prefix reports the gap and never fabricates a turn start", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-turn-windows-"));
  const pathname = path.join(directory, "session.jsonl");
  try {
    const records = [
      claudeUser("2026-07-14T08:00:00.000Z", "old prompt outside the retained tail"),
      { type: "assistant", timestamp: "2026-07-14T08:00:01.000Z", message: { role: "assistant", stop_reason: null, content: "x".repeat(140_000) } },
      claudeAssistantEnd("2026-07-14T08:01:00.000Z"),
      claudeUser("2026-07-14T10:00:00.000Z", "visible prompt"),
      claudeAssistantEnd("2026-07-14T10:01:00.000Z"),
    ];
    fs.writeFileSync(pathname, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const stat = fs.statSync(pathname);
    const entry = {
      path: pathname,
      root: "claude-projects",
      name: "session.jsonl",
      project: "fixture",
      title: "fixture",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      parent: null,
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
      activity: "recent",
      derivationComplete: true,
      proc: "done",
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    } satisfies FileEntry;

    expect(recentTurnWindowsFor(entry)).toEqual({
      prefixTruncated: true,
      complete: true,
      windows: [{
        startedAt: ms("2026-07-14T10:00:00.000Z"),
        endedAt: ms("2026-07-14T10:01:00.000Z"),
      }],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
