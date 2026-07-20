import type { CmdGroupItem, ToolEvent } from "../parse";

/* Synthetic fixtures behind the readable tool block (issue #475). Two flavours:
   - ToolEvent objects for DOM tests that render the cards directly.
   - Raw JSONL line builders for parser tests that feed buildFeed and assert the
     structured fields (cwd, exitCode, durationMs, endTs, split stderr).
   No fixture carries a real path, secret, or host value. */

export function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-07-10T10:00:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "ls -la",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  };
}

/** exec success: cwd, duration, exit 0, and a small stdout body. */
export const execSuccess = toolEvent({
  id: "exec-ok",
  summary: "git status",
  command: "git status --short",
  cwd: "/workspace/app",
  durationMs: 240,
  endTs: "2026-07-10T10:00:00.240Z",
  exitCode: 0,
  outputPreview: " M src/index.ts\n M README.md",
});

/** exec failure: non-zero exit, danger tone, error text on the output stream. */
export const execFailure = toolEvent({
  id: "exec-err",
  summary: "bun test",
  command: "bun test",
  cwd: "/workspace/app",
  durationMs: 1830,
  endTs: "2026-07-10T10:00:01.830Z",
  status: "err",
  statusLabel: "exit 3",
  exitCode: 3,
  outputPreview: "1 fail\nexpected true to be false",
  open: true,
});

/** A long multiline command that must wrap instead of scrolling the document. */
export const longCommand = toolEvent({
  id: "exec-long",
  summary: "for f in *.ts; do …",
  command:
    "for f in $(git ls-files '*.ts'); do echo \"formatting ${f} with a rather long pipeline of tools\"; prettier --write \"$f\" && eslint --fix \"$f\"; done && echo done",
  cwd: "/workspace/a/very/deeply/nested/project/that/keeps/going/and/going/src",
  durationMs: 62_000,
  endTs: "2026-07-10T10:01:02Z",
  exitCode: 0,
  outputPreview: "formatting one.ts\nformatting two.ts\ndone",
});

/** Large stdout that overflows the preview budget and offers "show all". */
export const largeStdout = toolEvent({
  id: "exec-big",
  summary: "cat build.log",
  command: "cat build.log",
  outputPreview: Array.from({ length: 80 }, (_, i) => `line ${i + 1} of build output`).join("\n"),
  outputTruncated: false,
});

/** Split stdout + stderr streams into their own disclosures. */
export const withStderr = toolEvent({
  id: "exec-stderr",
  summary: "cargo build",
  command: "cargo build --release",
  cwd: "/workspace/rust",
  durationMs: 4200,
  endTs: "2026-07-10T10:00:04.200Z",
  exitCode: 0,
  outputPreview: "Compiling app v0.1.0\nFinished release target",
  stderr: "warning: unused variable `x`\nwarning: 1 warning emitted",
  stderrTruncated: false,
});

/** Explicitly truncated stdout: the block must say so and gate "show all". */
export const truncatedOutput = toolEvent({
  id: "exec-trunc",
  summary: "grep -r pattern",
  command: "grep -rn pattern .",
  outputPreview: Array.from({ length: 60 }, (_, i) => `match ${i + 1}`).join("\n"),
  outputTruncated: true,
});

/** Unknown typed payload: a tool the taxonomy does not recognize keeps the
    generic fallback summary and renders without a command block or a crash. */
export const unknownFallback = toolEvent({
  id: "unknown-1",
  family: "other",
  tool: "SomeFutureTool",
  icon: "tool",
  summary: "SomeFutureTool: opaque payload",
  command: undefined,
  outputPreview: "{\"result\":\"opaque\"}",
});

/** A Codex interactive-shell run: an exec parent followed by a wait tail and an
    empty stdin poll — the three the group must nest as one ordered block. */
export const nestedParent = toolEvent({
  id: "exec-session",
  tool: "exec_command",
  summary: "npm run dev",
  command: "npm run dev",
  cwd: "/workspace/app",
  session: "8479",
  outputPreview: "starting dev server",
});
/** A wait that surfaced real output keeps its captured line readable in a
    dedicated follow-up row (issue #497). */
export const nestedWait = toolEvent({
  id: "wait-1",
  tool: "wait",
  summary: "wait · 8479",
  statusLabel: "waiting 10s",
  session: "8479",
  poll: true,
  outputPreview: "compiled successfully",
});
/** A bare empty poll: no keystrokes, no output — the row that collapses. */
export const nestedPoll = toolEvent({
  id: "poll-1",
  tool: "write_stdin",
  summary: "stdin → 8479 · poll",
  statusLabel: "waiting 5s",
  session: "8479",
  poll: true,
  durationMs: 5000,
  outputPreview: "",
});
/** A write_stdin carrying real keystrokes keeps its session and readable row. */
export const nestedKeystroke = toolEvent({
  id: "keys-1",
  tool: "write_stdin",
  summary: "stdin → 8479 · y⏎",
  session: "8479",
  outputPreview: "",
});

/** An empty poll builder for a collapsing run: each carries the shared session,
    a wall-time, and an empty output captured by the coalesced row (#497). */
export function emptyPoll(id: string, over: Partial<ToolEvent> = {}): ToolEvent {
  return toolEvent({ id, tool: "wait", summary: "wait · 8479", session: "8479", poll: true, durationMs: 5000, outputPreview: "", statusLabel: "waiting 5s", ...over });
}

/** A cmd-group carrying the nested exec/wait/poll run plus a standalone read. */
export function nestedGroup(over: Partial<CmdGroupItem> = {}): CmdGroupItem {
  const calls = [nestedParent, nestedWait, nestedPoll, toolEvent({ id: "read-1", family: "read", tool: "Read", icon: "file", summary: "Read config.ts" })];
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0].ts,
    t1: "2026-07-10T10:00:20Z",
    byTool: { exec_command: 1, wait: 1, write_stdin: 1, Read: 1 },
    okCount: 4,
    errCount: 0,
    hasErr: false,
    active: false,
    ...over,
  };
}

/** A poll-dominated interactive run (issue #497 production evidence): one exec
    parent trailed by six empty polls that must coalesce into one compact counted
    row, with a keystroke write_stdin still readable at the tail. */
export function pollHeavyGroup(over: Partial<CmdGroupItem> = {}): CmdGroupItem {
  const calls = [
    nestedParent,
    emptyPoll("p1"),
    emptyPoll("p2"),
    emptyPoll("p3"),
    emptyPoll("p4"),
    emptyPoll("p5"),
    emptyPoll("p6"),
    nestedKeystroke,
  ];
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0].ts,
    t1: "2026-07-10T10:00:40Z",
    byTool: { exec_command: 1, wait: 6, write_stdin: 1 },
    okCount: 8,
    errCount: 0,
    hasErr: false,
    active: false,
    ...over,
  };
}

/** A settled aggregate group: two completed exec calls with commands + output,
    no active flag — a historical run rendered from a static transcript. */
export function settledGroup(over: Partial<CmdGroupItem> = {}): CmdGroupItem {
  const calls = [
    { ...execSuccess, id: "g-1" },
    { ...withStderr, id: "g-2" },
  ];
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0].ts,
    t1: "2026-07-10T10:00:04Z",
    byTool: { Bash: 2 },
    okCount: 2,
    errCount: 0,
    hasErr: false,
    active: false,
    ...over,
  };
}

/** The trailing live aggregate: the same run marked `active` — one expanded
    group whose commands and outputs must all show immediately (issue #475). */
export function activeGroup(over: Partial<CmdGroupItem> = {}): CmdGroupItem {
  return settledGroup({ active: true, ...over });
}

/** A trailing live aggregate that carries a failure: the compact summary must
    keep the failure status and count visible even after it auto-collapses. */
export function activeFailureGroup(over: Partial<CmdGroupItem> = {}): CmdGroupItem {
  const calls = [
    { ...execSuccess, id: "gf-1" },
    { ...execFailure, id: "gf-2" },
  ];
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0].ts,
    t1: "2026-07-10T10:00:01Z",
    byTool: { Bash: 2 },
    okCount: 1,
    errCount: 1,
    hasErr: true,
    active: true,
    ...over,
  };
}

/* --- Raw JSONL line builders for the parser fixtures --------------------- */

/** A live Claude turn whose trailing tool run is still in flight: two completed
    Bash calls followed by a third that has no result yet (status "run"). The
    whole run must fold into one active aggregate — the in-flight call included —
    not a settled group plus a loose running row (issue #475). */
export function liveTrailingRunLines(): string[] {
  const toolUse = (id: string, command: string, ts: string) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const toolResult = (id: string, text: string, ts: string) =>
    JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
  return [
    toolUse("b1", "git status --short", "2026-07-10T10:00:00Z"),
    toolResult("b1", " M src/index.ts", "2026-07-10T10:00:00Z"),
    toolUse("b2", "bun test", "2026-07-10T10:00:01Z"),
    toolResult("b2", "5 pass", "2026-07-10T10:00:01Z"),
    toolUse("b3", "bun run build", "2026-07-10T10:00:02Z"),
  ];
}

const codexLine = (payload: Record<string, unknown>, timestamp = "2026-07-10T10:00:00Z") =>
  JSON.stringify({ type: "response_item", timestamp, payload });

/** Codex exec_command (cwd via the `workdir` arg) → result with a Wall time
    preamble, an exit code, and an explicitly delimited stderr tail. */
export function codexExecStderrLines(): string[] {
  return [
    codexLine({
      type: "function_call",
      call_id: "call-x",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "make", workdir: "/workspace/build" }),
    }),
    codexLine(
      {
        type: "function_call_output",
        call_id: "call-x",
        output: "Script completed\nWall time 2.5 seconds\nProcess exited with code 0\nOutput:\nbuilt target app\n[stderr]\nwarning: deprecated flag",
      },
      "2026-07-10T10:00:03Z",
    ),
  ];
}

/** A plain Claude Bash call whose command carries a `cd … &&` cwd prefix and a
    non-zero exit result. */
export function claudeExecFailLines(): string[] {
  return [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cd /workspace/app && bun test" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: "1 fail\nexited with code 2" }], is_error: true }] } }),
  ];
}
