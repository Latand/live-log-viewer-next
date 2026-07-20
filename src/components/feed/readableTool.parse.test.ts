import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { codexExecStderrLines, claudeExecFailLines } from "./__fixtures__/readableTools";
import { buildFeed, type CmdGroupItem, type ToolEvent } from "./parse";
import { coalesceFollowUps, groupNestedCalls } from "./toolBlocks";

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

test("redacted session-label collisions retain separate ownership and poll runs", () => {
  const line = (payload: Record<string, unknown>, ts: string) => JSON.stringify({ type: "response_item", timestamp: ts, payload });
  const sensitiveKey = String.fromCharCode(116, 111, 107, 101, 110);
  const firstSession = `${sensitiveKey}=opaque-first-session`;
  const secondSession = `${sensitiveKey}=opaque-second-session`;
  const lines = [
    line({ type: "function_call", call_id: "eA", name: "exec_command", arguments: JSON.stringify({ cmd: "serve A" }) }, "2026-07-10T10:00:00Z"),
    line({ type: "function_call_output", call_id: "eA", output: `Script running with session ID ${firstSession}\nWall time 1.0 seconds\nOutput:\nA` }, "2026-07-10T10:00:01Z"),
    line({ type: "function_call", call_id: "eB", name: "exec_command", arguments: JSON.stringify({ cmd: "serve B" }) }, "2026-07-10T10:00:02Z"),
    line({ type: "function_call_output", call_id: "eB", output: `Script running with session ID ${secondSession}\nWall time 1.0 seconds\nOutput:\nB` }, "2026-07-10T10:00:03Z"),
    line({ type: "function_call", call_id: "pA1", name: "write_stdin", arguments: JSON.stringify({ session_id: firstSession, chars: "" }) }, "2026-07-10T10:00:04Z"),
    line({ type: "function_call_output", call_id: "pA1", output: `Script running with cell ID ${firstSession}\nWall time 5.0 seconds\nOutput:\n` }, "2026-07-10T10:00:09Z"),
    line({ type: "function_call", call_id: "pA2", name: "write_stdin", arguments: JSON.stringify({ session_id: firstSession, chars: "" }) }, "2026-07-10T10:00:10Z"),
    line({ type: "function_call_output", call_id: "pA2", output: `Script running with cell ID ${firstSession}\nWall time 5.0 seconds\nOutput:\n` }, "2026-07-10T10:00:15Z"),
    line({ type: "function_call", call_id: "pB1", name: "write_stdin", arguments: JSON.stringify({ session_id: secondSession, chars: "" }) }, "2026-07-10T10:00:16Z"),
    line({ type: "function_call_output", call_id: "pB1", output: `Script running with cell ID ${secondSession}\nWall time 5.0 seconds\nOutput:\n` }, "2026-07-10T10:00:21Z"),
    line({ type: "function_call", call_id: "pB2", name: "write_stdin", arguments: JSON.stringify({ session_id: secondSession, chars: "" }) }, "2026-07-10T10:00:22Z"),
    line({ type: "function_call_output", call_id: "pB2", output: `Script running with cell ID ${secondSession}\nWall time 5.0 seconds\nOutput:\n` }, "2026-07-10T10:00:27Z"),
  ];
  const group = buildFeed(codexFile, lines, false, "").items.find((item): item is CmdGroupItem => item.kind === "cmd-group");
  if (!group) throw new Error("expected a cmd-group");

  const blocks = groupNestedCalls(group.calls);
  expect(blocks.map((block) => block.parent.id)).toEqual(["eA", "eB"]);
  expect(blocks[0].children.map((child) => child.id)).toEqual(["pA1", "pA2"]);
  expect(blocks[1].children.map((child) => child.id)).toEqual(["pB1", "pB2"]);
  expect(coalesceFollowUps(blocks[0].children)).toHaveLength(1);
  expect(coalesceFollowUps(blocks[1].children)).toHaveLength(1);

  const serialized = JSON.stringify(group);
  expect(serialized).not.toContain(firstSession);
  expect(serialized).not.toContain(secondSession);
  expect(group.calls.every((call) => call.session === `${sensitiveKey}=[redacted]`)).toBe(true);
});

test("metadata-wrapped in-flight stdin retains private session ownership", () => {
  const line = (payload: Record<string, unknown>, ts: string) => JSON.stringify({ type: "response_item", timestamp: ts, payload });
  const sensitiveKey = String.fromCharCode(116, 111, 107, 101, 110);
  const firstSession = `${sensitiveKey}=metadata-first-session`;
  const secondSession = `${sensitiveKey}=metadata-second-session`;
  const exec = (id: string, ts: string) => line({ type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `serve ${id}` }) }, ts);
  const output = (id: string, session: string, ts: string) => line({ type: "function_call_output", call_id: id, output: `Script running with session ID ${session}\nOutput:\nready` }, ts);
  const stdin = (id: string, session: string, ts: string) =>
    line({ type: "custom_tool_call", call_id: id, name: "exec", input: `await tools.write_stdin({ session_id: "${session}", chars: "" });` }, ts);
  const lines = [
    exec("eA", "2026-07-10T10:00:00Z"),
    output("eA", firstSession, "2026-07-10T10:00:01Z"),
    exec("eB", "2026-07-10T10:00:02Z"),
    output("eB", secondSession, "2026-07-10T10:00:03Z"),
    stdin("pA", firstSession, "2026-07-10T10:00:04Z"),
    stdin("pB", secondSession, "2026-07-10T10:00:05Z"),
  ];
  const group = buildFeed(codexFile, lines, false, "").items.find((item): item is CmdGroupItem => item.kind === "cmd-group");
  if (!group) throw new Error("expected a cmd-group");

  const blocks = groupNestedCalls(group.calls);
  expect(blocks.map((block) => block.parent.id)).toEqual(["eA", "eB"]);
  expect(blocks[0].children.map((child) => child.id)).toEqual(["pA"]);
  expect(blocks[1].children.map((child) => child.id)).toEqual(["pB"]);
  expect(JSON.stringify(group)).not.toContain(firstSession);
  expect(JSON.stringify(group)).not.toContain(secondSession);
});

test("the parser distinguishes bare polls from keystroke write_stdin", () => {
  const line = (payload: Record<string, unknown>, ts: string) => JSON.stringify({ type: "response_item", timestamp: ts, payload });
  const lines = [
    line({ type: "function_call", call_id: "e1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run dev", workdir: "/w" }) }, "2026-07-10T10:00:00Z"),
    line({ type: "function_call_output", call_id: "e1", output: "Script running with session ID 8479\nWall time 1.0 seconds\nOutput:\nbooting" }, "2026-07-10T10:00:01Z"),
    // A wait is always a bare poll.
    line({ type: "function_call", call_id: "w1", name: "wait", arguments: JSON.stringify({ cell_id: "8479", yield_time_ms: 10000 }) }, "2026-07-10T10:00:02Z"),
    line({ type: "function_call_output", call_id: "w1", output: "Script running with cell ID 8479\nWall time 10.0 seconds\nOutput:\n" }, "2026-07-10T10:00:12Z"),
    // An empty write_stdin is a poll; a keystroke keeps its input semantics.
    line({ type: "function_call", call_id: "s1", name: "write_stdin", arguments: JSON.stringify({ session_id: 8479, chars: "" }) }, "2026-07-10T10:00:13Z"),
    line({ type: "function_call_output", call_id: "s1", output: "Script running with cell ID 8479\nWall time 5.0 seconds\nOutput:\n" }, "2026-07-10T10:00:18Z"),
    line({ type: "function_call", call_id: "k1", name: "write_stdin", arguments: JSON.stringify({ session_id: 8479, chars: "y\n" }) }, "2026-07-10T10:00:19Z"),
    line({ type: "function_call_output", call_id: "k1", output: "Script running with cell ID 8479\nWall time 0.2 seconds\nOutput:\naccepted" }, "2026-07-10T10:00:20Z"),
  ];
  const group = buildFeed(codexFile, lines, false, "").items.find((item): item is CmdGroupItem => item.kind === "cmd-group");
  if (!group) throw new Error("expected a cmd-group");
  const byId = new Map(group.calls.map((c) => [c.id, c]));
  expect(byId.get("e1")?.poll).toBeUndefined(); // the exec parent owns the session
  expect(byId.get("w1")?.poll).toBe(true);
  expect(byId.get("s1")?.poll).toBe(true);
  // Keystrokes are retained as a readable, non-poll write; the session survives.
  expect(byId.get("k1")?.poll).not.toBe(true);
  expect(byId.get("k1")?.session).toBe("8479");
});
