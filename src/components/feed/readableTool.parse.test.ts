import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { codexExecStderrLines, claudeExecFailLines } from "./__fixtures__/readableTools";
import { buildFeed, type CmdGroupItem, type ToolEvent } from "./parse";
import { groupNestedCalls } from "./toolBlocks";

const codexFile = { path: "/tmp/x.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;

function onlyTool(file: FileEntry, lines: string[]): ToolEvent {
  const tool = buildFeed(file, lines, false, "").items.find((item) => item.kind === "tool");
  if (!tool || tool.kind !== "tool") throw new Error("expected a tool event");
  return tool;
}

test("codex exec_command captures cwd, exit code, duration, and end time", () => {
  const event = onlyTool(codexFile, codexExecStderrLines());
  expect(event.command).toBe("make");
  expect(event.cwd).toBe("/workspace/build");
  expect(event.exitCode).toBe(0);
  expect(event.durationMs).toBe(2500);
  // endTs is the call start + duration, so it renders a real wall-clock span.
  expect(event.endTs).toBe(new Date(Date.parse("2026-07-10T10:00:00Z") + 2500).toISOString());
});

test("an explicit stderr delimiter splits the stream out of stdout", () => {
  const event = onlyTool(codexFile, codexExecStderrLines());
  expect(event.outputPreview).toContain("built target app");
  expect(event.outputPreview).not.toContain("warning: deprecated flag");
  expect(event.stderr).toBe("warning: deprecated flag");
  expect(event.stderrTruncated).toBe(false);
});

test("a Claude cd-prefixed Bash failure recovers cwd and a non-zero exit", () => {
  const event = onlyTool(claudeFile, claudeExecFailLines());
  expect(event.cwd).toBe("/workspace/app");
  expect(event.status).toBe("err");
  expect(event.exitCode).toBe(2);
  expect(event.stderr).toBeUndefined();
});

test("an undelimited body stays entirely on stdout — the parser never guesses stderr", () => {
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo hi" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: "hi\nerror: not a real stderr section" }] }] } }),
  ];
  const event = onlyTool(claudeFile, lines);
  expect(event.stderr).toBeUndefined();
  expect(event.outputPreview).toContain("error: not a real stderr section");
});

test("a large stdout result marks itself truncated past the cap", () => {
  const big = Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join("\n");
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat big.log" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: big }] }] } }),
  ];
  const event = onlyTool(claudeFile, lines);
  expect(event.outputTruncated).toBe(true);
});

test("an unknown tool keeps its generic typed fallback and never a command block", () => {
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "u1", name: "SomeFutureTool", input: { payload: "opaque" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "ok" }] }] } }),
  ];
  const event = onlyTool(claudeFile, lines);
  expect(event.family).toBe("other");
  expect(event.command).toBeUndefined();
  expect(event.summary).toContain("SomeFutureTool");
});

test("a wait/write_stdin run nests as follow-ups of the exec that owns them", () => {
  const line = (payload: Record<string, unknown>, ts: string) => JSON.stringify({ type: "response_item", timestamp: ts, payload });
  const lines = [
    line({ type: "function_call", call_id: "e1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run dev", workdir: "/w" }) }, "2026-07-10T10:00:00Z"),
    line({ type: "function_call_output", call_id: "e1", output: "Script running with session ID 8479\nWall time 1.0 seconds\nOutput:\nbooting" }, "2026-07-10T10:00:01Z"),
    line({ type: "function_call", call_id: "w1", name: "wait", arguments: JSON.stringify({ cell_id: "8479", yield_time_ms: 10000 }) }, "2026-07-10T10:00:02Z"),
    line({ type: "function_call_output", call_id: "w1", output: "Script running with cell ID 8479\nWall time 10.0 seconds\nOutput:\nready" }, "2026-07-10T10:00:12Z"),
    line({ type: "function_call", call_id: "s1", name: "write_stdin", arguments: JSON.stringify({ session_id: 8479, chars: "" }) }, "2026-07-10T10:00:13Z"),
    line({ type: "function_call_output", call_id: "s1", output: "Script running with cell ID 8479\nWall time 5.0 seconds\nOutput:\n" }, "2026-07-10T10:00:18Z"),
  ];
  const group = buildFeed(codexFile, lines, false, "").items.find((item): item is CmdGroupItem => item.kind === "cmd-group");
  if (!group) throw new Error("expected a cmd-group");
  const blocks = groupNestedCalls(group.calls);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].parent.tool).toBe("exec_command");
  expect(blocks[0].children.map((c) => c.tool)).toEqual(["wait", "write_stdin"]);
  // Each nested call preserves its own individual state.
  expect(blocks[0].children.every((c) => c.status === "ok")).toBe(true);
});
