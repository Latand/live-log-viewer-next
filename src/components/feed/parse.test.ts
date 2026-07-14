import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path, { join } from "node:path";

import type { FileEntry } from "@/lib/types";

import { buildFeed, createFeedSession, type Item } from "./parse";

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;
const codexFile = { path: "/tmp/x.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const plainFile = { path: "/tmp/x.output", engine: "codex", fmt: "plain", activity: "recent" } as FileEntry;

/* Auto-incrementing ids inside plain tool items depend on how many pushes the
   session has ever seen, so a slid window numbers them differently than a
   fresh one-shot parse. Likewise srcCall/srcResult are absolute stream indices,
   which differ between a windowed parse and a start-0 one-shot for the same
   logical line. Both are opaque provenance tokens; normalize them out before
   structural comparison. */
function normalize(items: Item[]): unknown {
  return JSON.parse(
    JSON.stringify(items, (key, value) => {
      if (key === "srcCall" || key === "srcResult") return 0;
      return typeof value === "string" && (key === "id" || key === "ids") ? value.replace(/^plain-\d+-/, "plain-N-") : value;
    }),
  );
}

/**
 * Feed `lines` into one session chunk-by-chunk with useLogTail's cap-trim
 * semantics, and after every chunk compare the incremental snapshot against a
 * fresh one-shot parse of the same window.
 */
function assertParity(file: FileEntry, lines: string[], opts: { cap?: number; chunks?: number[]; showSvc?: boolean; live?: boolean } = {}) {
  const { cap = 0, chunks = [1, 3, 2, 5, 1, 4], showSvc = false, live = false } = opts;
  const session = createFeedSession({ engine: file.engine, fmt: file.fmt, showSvc, lineFilter: "" });
  const liveFile = { ...file, activity: live ? "live" : file.activity } as FileEntry;
  let window: string[] = [];
  let start = 0;
  let fed = 0;
  let step = 0;
  while (fed < lines.length) {
    const take = Math.min(chunks[step % chunks.length], lines.length - fed);
    window = window.concat(lines.slice(fed, fed + take));
    fed += take;
    step += 1;
    if (cap > 0 && window.length > cap) {
      start += window.length - cap;
      window = window.slice(-cap);
    }
    const incremental = session.feed(window, start, live);
    const oneShot = buildFeed(liveFile, window, showSvc, "");
    expect(normalize(incremental.items.map((entry) => entry.item))).toEqual(normalize(oneShot.items));
    expect(incremental.hiddenServiceCount).toBe(oneShot.hiddenServiceCount);
  }
  return session;
}

const claudeUser = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-06T10:00:00Z", message: { content: text } });
const claudeProse = (text: string, stop: string | null = "end_turn") =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:01Z",
    message: { stop_reason: stop, content: [{ type: "text", text }] },
  });
const claudeThink = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
const claudeTool = (id: string, name: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:02Z",
    message: { content: [{ type: "tool_use", id, name, input: { command } }] },
  });
const claudeResult = (id: string, text: string, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-07-06T10:00:03Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
  });
const claudeSend = (id: string, to: string, message: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T10:00:04Z",
    message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to, summary: "s", message } }] },
  });
const codexUserResponse = (timestamp: string, content: Record<string, unknown>[]) =>
  JSON.stringify({ type: "response_item", timestamp, payload: { type: "message", role: "user", content } });
const codexUserEvent = (timestamp: string, message: string) => JSON.stringify({ type: "event_msg", timestamp, payload: { type: "user_message", message } });
const codexAssistantResponse = (timestamp: string, text: string) =>
  JSON.stringify({ type: "response_item", timestamp, payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] } });
const codexAssistantEvent = (timestamp: string, message: string) =>
  JSON.stringify({ type: "event_msg", timestamp, payload: { type: "agent_message", phase: "commentary", message } });
const codexUserPair = (timestamp: string, text: string) => [codexUserResponse(timestamp, [{ type: "input_text", text }]), codexUserEvent(timestamp, text)];
const codexReasoning = (timestamp: string) => JSON.stringify({ type: "response_item", timestamp, payload: { type: "reasoning" } });

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8").trim().split("\n");
}

function itemsOfKind(feed: ReturnType<typeof buildFeed>, kind: Item["kind"]) {
  return feed.items.filter((item) => item.kind === kind);
}

describe("feed session parity with one-shot parse", () => {
  test("claude transcript: tools, results, grouping, tmsg delivery, compaction", () => {
    const lines = [
      claudeUser("take the first step"),
      claudeThink("thinking through the first step and action plan"),
      claudeTool("c1", "Bash", "ls -la"),
      claudeResult("c1", "total 8"),
      claudeProse("Done, here is the result."),
      // A run of five commands: folds into one cmd-group once a prose lands after.
      claudeTool("g1", "Bash", "echo 1"),
      claudeResult("g1", "1"),
      claudeTool("g2", "Bash", "echo 2"),
      claudeResult("g2", "exited with code 3"),
      claudeTool("g3", "Read", "cat a.txt"),
      claudeResult("g3", "aaa"),
      claudeTool("g4", "Bash", "echo 4"),
      claudeResult("g4", "4"),
      claudeTool("g5", "Bash", "echo 5"),
      claudeResult("g5", "5"),
      claudeProse("Series complete."),
      claudeSend("m1", "worker-1", "check the branch"),
      claudeResult("m1", '{"success": true, "msg_id": "abc123"}'),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "t", compactMetadata: { trigger: "auto", preTokens: 9000 } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "Conversation summary." } }),
      claudeUser("continue"),
      claudeProse("Continuing."),
    ];
    assertParity(claudeFile, lines);
    assertParity(claudeFile, lines, { cap: 7, chunks: [2, 1, 3] });
    assertParity(claudeFile, lines, { showSvc: true });
    assertParity(claudeFile, lines, { live: true, chunks: [1] });
  });

  test("codex interactive shell: wait/write_stdin decode, keys, and empty-wait collapse (#141)", () => {
    const ESC = "\x1b";
    const lines = [
      /* The REAL current wait wrapper: `Script running with cell ID N` (issue
         #141 / finding 3), not the older `Process running with session ID`. */
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "function_call", name: "wait", call_id: "w1", arguments: JSON.stringify({ cell_id: "46", yield_time_ms: 30000 }) } }),
      JSON.stringify({ type: "response_item", timestamp: "t2", payload: { type: "function_call_output", call_id: "w1", output: `Script running with cell ID 46\nWall time 10.0 seconds\nOutput:\n${ESC}[32m#16 building${ESC}[0m\r\n#16 done\r\n` } }),
      JSON.stringify({ type: "response_item", timestamp: "t3", payload: { type: "function_call", name: "write_stdin", call_id: "s1", arguments: JSON.stringify({ session_id: 8479, chars: "" }) } }),
      /* An empty wait/poll wrapped in the same `Script running with cell ID` form. */
      JSON.stringify({ type: "response_item", timestamp: "t4", payload: { type: "function_call_output", call_id: "s1", output: "Script running with cell ID 8479\nWall time 5.0 seconds\nOutput:\n" } }),
    ];
    const feed = buildFeed(codexFile, lines, false, "");
    /* Two consecutive tool events now fold into a cmd-group (§3.4), so read the
       decoded calls from both top-level tool rows and any group. */
    const tools = feed.items.flatMap((item): Extract<Item, { kind: "tool" }>[] =>
      item.kind === "tool" ? [item] : item.kind === "cmd-group" ? item.calls : [],
    );
    const wait = tools.find((tool) => tool.tool === "wait")!;
    expect(wait.family).toBe("shell");
    /* Decoded: real newlines, ANSI removed, preamble (incl. the real wrapper) not leaked. */
    expect(wait.outputPreview).toContain("#16 building");
    expect(wait.outputPreview).toContain("#16 done");
    expect(wait.outputPreview).not.toContain(ESC);
    expect(wait.outputPreview).not.toContain("Script running with cell ID");
    expect(wait.outputPreview).not.toContain("Wall time");
    expect(wait.outputPreview).not.toContain("Output:");
    /* write_stdin names its session; its empty chunk collapses to "waiting Ns"
       with the captured wall time, not an "ok" with leaked runtime metadata. */
    const stdin = tools.find((tool) => tool.tool === "write_stdin")!;
    expect(stdin.summary).toContain("8479");
    expect(stdin.outputPreview).toBe("");
    expect(stdin.statusLabel.toLowerCase()).toContain("wait");
    expect(stdin.statusLabel).toContain("5");
  });

  test("codex rollout: echo dedup, shell calls, compaction pair, service rows", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "t0", payload: { model: "gpt-5.2", cwd: "/tmp" } }),
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run tests" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t1", payload: { type: "user_message", message: "run tests" } }),
      JSON.stringify({ type: "event_msg", timestamp: "t2", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "t3", payload: { type: "function_call", name: "shell", call_id: "s1", arguments: JSON.stringify({ command: "bun test" }) } }),
      JSON.stringify({ type: "response_item", timestamp: "t4", payload: { type: "function_call_output", call_id: "s1", output: "42 pass" } }),
      JSON.stringify({ type: "response_item", timestamp: "t5", payload: { type: "reasoning" } }),
      JSON.stringify({ type: "response_item", timestamp: "t6", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Tests are green." }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t6", payload: { type: "agent_message", message: "Tests are green." } }),
      JSON.stringify({ type: "compacted", timestamp: "t7" }),
      JSON.stringify({ type: "event_msg", timestamp: "t7", payload: { type: "context_compacted" } }),
      JSON.stringify({ type: "event_msg", timestamp: "t8", payload: { type: "task_complete" } }),
    ];
    assertParity(codexFile, lines);
    assertParity(codexFile, lines, { showSvc: true });
    assertParity(codexFile, lines, { cap: 4, chunks: [1, 2] });
    assertParity(codexFile, lines, { cap: 3, chunks: [1] });
  });

  test("codex custom tools render their call and structured output", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "t0", payload: { model: "gpt-5.6-sol", cwd: "/tmp" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t1",
        payload: {
          type: "custom_tool_call",
          id: "ctc-1",
          call_id: "call-1",
          name: "exec",
          status: "completed",
          input: "const r = await tools.exec_command({ cmd: \"rtk git status\" }); text(r.output);",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [{ type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n## main" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2.1",
        payload: { type: "custom_tool_call", id: "ctc-2", call_id: "call-2", name: "exec", status: "completed", input: "throw new Error();" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2.2",
        payload: { type: "custom_tool_call_output", call_id: "call-2", output: [{ type: "input_text", text: "Script failed\nError: boom" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t3",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Status checked." }] },
      }),
    ];
    const feed = buildFeed(codexFile, lines, false, "");
    /* The orchestration record and the plain exec are two consecutive tool
       events, so they now fold into one cmd-group (§3.4); read the calls back
       from the group. */
    const commands = feed.items.flatMap((item): Extract<Item, { kind: "tool" }>[] =>
      item.kind === "tool" ? [item] : item.kind === "cmd-group" ? item.calls : [],
    );
    expect(commands).toHaveLength(2);
    const command = commands[0];
    if (command?.kind !== "tool") throw new Error("expected tool item");
    // A tools.exec_command orchestration: the outer summary names the nested
    // operation, the combined output attaches to the outer event.
    expect(command.orchestration?.calls.length).toBeGreaterThanOrEqual(1);
    expect(command.summary).toContain("rtk git status");
    expect(command.outputPreview).toContain("## main");
    expect(command.status).toBe("ok");
    const failed = commands[1];
    if (failed?.kind !== "tool") throw new Error("expected failed tool item");
    expect(failed.orchestration).toBeUndefined();
    expect(failed.summary).toContain("exec");
    expect(failed.status).toBe("err");
    expect(failed.outputPreview).toContain("Error: boom");
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("plain job log: command lifecycle and a pending structured block", () => {
    const lines = [
      "[10:00] Running command: /usr/bin/zsh -lc bun run build",
      "[10:01] Command completed",
      "[10:01] Intermediate agent response",
      "[10:02] Running command: bun test",
      "[10:03] Command failed: exited with code 1",
      "plain raw line without brackets",
    ];
    assertParity(plainFile, lines, { chunks: [1] });
    assertParity(plainFile, lines, { cap: 3, chunks: [2, 1] });
  });

  test("a job-log 'Applying N files' line renders complete with no perpetual spinner", () => {
    const lines = ["[10:00] Applying 3 files to the working tree"];
    const feed = buildFeed(plainFile, lines, false, "");
    const tool = feed.items.find((item) => item.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("expected tool item");
    expect(tool.status).toBe("ok");
    expect(tool.summary).toContain("3 files");
    assertParity(plainFile, lines, { chunks: [1] });
  });

  test("window slide past a tool_use: its result degrades to the svc fallback", () => {
    const lines = [
      claudeTool("c1", "Bash", "sleep 100"),
      claudeUser("a"),
      claudeUser("b"),
      claudeUser("c"),
      claudeResult("c1", "done late"),
    ];
    // cap 3 evicts the tool_use before its result arrives on both sides.
    assertParity(claudeFile, lines, { cap: 3, chunks: [1], showSvc: true });
  });
});

describe("feed session identity stability", () => {
  test("appending prose keeps every existing item identity", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("one"), claudeProse("first"), claudeUser("two")];
    const before = session.feed(lines, 0, true);
    const after = session.feed([...lines, claudeProse("second")], 0, true);
    expect(after.items.length).toBe(before.items.length + 1);
    for (let i = 0; i < before.items.length; i += 1) {
      expect(after.items[i].item).toBe(before.items[i].item);
      expect(after.items[i].key).toBe(before.items[i].key);
    }
  });

  test("a tool_result changes only its own cmd item", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("go"), claudeTool("c1", "Bash", "ls"), claudeTool("c2", "Bash", "pwd")];
    const before = session.feed(lines, 0, true);
    const after = session.feed([...lines, claudeResult("c1", "ok done")], 0, true);
    // user bubble and the untouched second call keep their identity
    expect(after.items[0].item).toBe(before.items[0].item);
    expect(after.items[2].item).toBe(before.items[2].item);
    // the resolved call is a fresh object with the result attached
    expect(after.items[1].item).not.toBe(before.items[1].item);
    const resolved = after.items[1].item;
    if (resolved.kind !== "tool") throw new Error("expected tool item");
    expect(resolved.status).toBe("ok");
    expect(after.items[1].key).toBe(before.items[1].key);
  });

  test("idempotent re-feed of an unchanged window returns the cached snapshot", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines = [claudeUser("one"), claudeProse("first")];
    const first = session.feed(lines, 0, false);
    const second = session.feed(lines, 0, false);
    expect(second).toBe(first);
  });

  test("a folded cmd-group keeps its identity across unrelated appends", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const lines: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      lines.push(claudeTool("g" + i, "Bash", "echo " + i), claudeResult("g" + i, String(i)));
    }
    lines.push(claudeProse("after the series"));
    const before = session.feed(lines, 0, false);
    const group = before.items[0].item;
    expect(group.kind).toBe("cmd-group");
    const after = session.feed([...lines, claudeProse("one more response")], 0, false);
    expect(after.items[0].item).toBe(group);
  });

  test("a live trailing tool run folds its completed prefix but keeps the current call visible (§3.4)", () => {
    const lines = [
      claudeTool("a1", "Bash", "echo 1"),
      claudeResult("a1", "1"),
      claudeTool("a2", "Bash", "echo 2"),
      claudeResult("a2", "2"),
      claudeTool("a3", "Read", "cat x.txt"), // in-flight: no result yet
    ];
    // Live: the completed a1/a2 fold; the current a3 stays its own visible line —
    // a live 40-call run must not read as 40 individual ToolLines.
    const live = buildFeed({ ...claudeFile, activity: "live" } as FileEntry, lines, false, "");
    expect(live.items).toHaveLength(2);
    const group = live.items[0];
    if (group.kind !== "cmd-group") throw new Error("expected a cmd-group");
    expect(group.calls.map((call) => call.id)).toEqual(["a1", "a2"]);
    const current = live.items[1];
    if (current.kind !== "tool") throw new Error("expected the current call as a visible tool line");
    expect(current.id).toBe("a3");
    // Settled (not live): the whole run folds into one group.
    const settled = buildFeed(claudeFile, lines, false, "");
    expect(settled.items).toHaveLength(1);
    expect(settled.items[0].kind).toBe("cmd-group");
  });

  test("a live tail keeps every concurrent in-flight call visible, folding only the completed prefix (§3.4)", () => {
    const lines = [
      claudeTool("c1", "Bash", "echo 1"),
      claudeResult("c1", "1"),
      claudeTool("c2", "Bash", "echo 2"),
      claudeResult("c2", "2"),
      claudeTool("c3", "Read", "cat a.txt"),
      claudeResult("c3", "a"),
      claudeTool("r1", "Bash", "sleep 1"), // in-flight
      claudeTool("r2", "Bash", "sleep 2"), // in-flight, concurrent
    ];
    const live = buildFeed({ ...claudeFile, activity: "live" } as FileEntry, lines, false, "");
    // The completed c1/c2/c3 fold; both running calls stay their own visible lines.
    expect(live.items).toHaveLength(3);
    const group = live.items[0];
    if (group.kind !== "cmd-group") throw new Error("expected the completed prefix folded");
    expect(group.calls.map((call) => call.id)).toEqual(["c1", "c2", "c3"]);
    const running = live.items.slice(1);
    expect(running.map((item) => (item.kind === "tool" ? item.id : item.kind))).toEqual(["r1", "r2"]);
    expect(running.every((item) => item.kind === "tool" && item.status === "run")).toBe(true);
  });

  test("a live tail of only concurrent run calls stays fully visible with no group", () => {
    const lines = [claudeTool("r1", "Bash", "a"), claudeTool("r2", "Bash", "b"), claudeTool("r3", "Bash", "c")];
    const live = buildFeed({ ...claudeFile, activity: "live" } as FileEntry, lines, false, "");
    expect(live.items.map((item) => (item.kind === "tool" ? item.id : item.kind))).toEqual(["r1", "r2", "r3"]);
  });

  test("prepended history resets the session and reparses the wider window", () => {
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const older = [claudeUser("old message")];
    const recent = [claudeUser("new"), claudeProse("answer")];
    session.feed(recent, 0, false);
    const widened = session.feed(older.concat(recent), -1, false);
    expect(normalize(widened.items.map((entry) => entry.item))).toEqual(
      normalize(buildFeed(claudeFile, older.concat(recent), false, "").items),
    );
  });
});

describe("Codex user-turn coalescing", () => {
  test("folds only an adjacent response/event echo and preserves two identical sends", () => {
    const lines = [...codexUserPair("t1", "same"), ...codexUserPair("t2", "same")];
    expect(itemsOfKind(buildFeed(codexFile, lines.slice(0, 2), false, ""), "user")).toEqual([{ kind: "user", ts: "t1", text: "same" }]);
    const feed = buildFeed(codexFile, lines, false, "");
    expect(itemsOfKind(feed, "user")).toEqual([
      { kind: "user", ts: "t1", text: "same" },
      { kind: "user", ts: "t2", text: "same" },
    ]);
    assertParity(codexFile, lines, { chunks: [1, 1, 2], cap: 3 });
  });

  test("keeps genuine identical sends when hidden service rows occur between turns", () => {
    const lines = [...codexUserPair("t1", "same"), codexReasoning("t1.5"), ...codexUserPair("t2", "same")];
    for (const showSvc of [false, true]) {
      const feed = buildFeed(codexFile, lines, showSvc, "");
      expect(itemsOfKind(feed, "user")).toHaveLength(2);
      assertParity(codexFile, lines, { chunks: [2, 1], cap: 4, showSvc });
    }
  });

  test("keeps unrelated and reordered response/event records as separate turns", () => {
    const mismatch = [
      codexUserResponse("t1", [{ type: "input_text", text: "first" }]),
      codexUserEvent("t2", "second"),
    ];
    const reordered = [
      codexUserEvent("t2", "second"),
      codexUserResponse("t1", [{ type: "input_text", text: "first" }]),
    ];
    const queued = [
      codexUserResponse("t1", [{ type: "input_text", text: "first" }]),
      codexUserResponse("t2", [{ type: "input_text", text: "second" }]),
      codexUserEvent("t1", "first"),
      codexUserEvent("t2", "second"),
    ];
    for (const lines of [mismatch, reordered, queued]) {
      expect(itemsOfKind(buildFeed(codexFile, lines, false, ""), "user").map((item) => item.kind === "user" ? item.text : "").sort()).toEqual(["first", "second"]);
      assertParity(codexFile, lines, { chunks: [1], cap: 3 });
    }
  });

  test("requires matching text inside the ISO timestamp correlation window", () => {
    const responseTs = "2026-07-10T10:00:00.000Z";
    const echoTs = "2026-07-10T10:00:00.500Z";
    const differentTexts = [
      codexUserResponse(responseTs, [{ type: "input_text", text: "first message" }]),
      codexUserEvent(echoTs, "second message"),
    ];
    const identicalEcho = [
      codexUserResponse(responseTs, [{ type: "input_text", text: "same message" }]),
      codexUserEvent(echoTs, "same message"),
    ];

    expect(itemsOfKind(buildFeed(codexFile, differentTexts, false, ""), "user")).toEqual([
      { kind: "user", ts: responseTs, text: "first message" },
      { kind: "user", ts: echoTs, text: "second message" },
    ]);
    expect(itemsOfKind(buildFeed(codexFile, identicalEcho, false, ""), "user")).toEqual([
      { kind: "user", ts: echoTs, text: "same message" },
    ]);
    assertParity(codexFile, differentTexts, { chunks: [1] });
    assertParity(codexFile, identicalEcho, { chunks: [1] });
  });

  test("keeps every reserved-looking composer prefix in a user bubble", () => {
    const prefixes = ["<task>", "Caveat: The messages below", "[Request interrupted", "This came from another Claude session", "# AGENTS.md instructions"];
    const lines = prefixes.flatMap((prefix, index) => codexUserPair(`t${index}`, `${prefix} human input`));
    const feed = buildFeed(codexFile, lines, false, "");
    expect(itemsOfKind(feed, "user")).toHaveLength(prefixes.length);
    expect(itemsOfKind(feed, "sysmsg")).toHaveLength(0);
    assertParity(codexFile, lines, { chunks: [1, 2, 1], cap: 5 });
  });

  test("uses record shape to collapse actual harness rows", () => {
    const lines = [
      codexUserResponse("t1", [{ type: "input_text", text: "<permissions instructions> injected" }]),
      JSON.stringify({ type: "event_msg", timestamp: "t2", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "t3", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "developer context" }] } }),
    ];
    const feed = buildFeed(codexFile, lines, false, "");
    expect(itemsOfKind(feed, "user")).toHaveLength(0);
    expect(itemsOfKind(feed, "sysmsg")).toHaveLength(2);
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("normalizes image, local-image, skill, mention, and unknown user parts without payload leaks", () => {
    const secret = "do-not-render-this-token";
    const lines = [
      codexUserResponse("t1", [
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "local-image", path: "/home/user/.claude/viewer-inbox/photo.png" },
        { type: "skill", name: "feed-parser" },
        { type: "mention", target: "@reviewer" },
        { type: "opaque_payload", credential: secret },
      ]),
    ];
    const feed = buildFeed(codexFile, lines, false, "");
    expect(itemsOfKind(feed, "image")).toHaveLength(1);
    expect(itemsOfKind(feed, "inbox-image")).toEqual([{ kind: "inbox-image", name: "photo.png", path: "/home/user/.claude/viewer-inbox/photo.png" }]);
    expect(itemsOfKind(feed, "note")).toEqual([
      { kind: "note", text: "Attachment: skill" },
      { kind: "note", text: "Attachment: mention" },
      { kind: "note", text: "Attachment: opaque payload" },
    ]);
    expect(JSON.stringify(feed.items)).not.toContain(secret);
    expect(feed.hiddenServiceCount).toBe(0);
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("keeps changed and typeless non-empty parts visible through safe notes", () => {
    const secret = "must-not-leak";
    const lines = [codexUserResponse("t1", [{ type: "input_text", value: "changed field" }, { credential: secret }])];
    const feed = buildFeed(codexFile, lines, false, "");
    expect(itemsOfKind(feed, "note")).toEqual([
      { kind: "note", text: "Attachment: input text" },
      { kind: "note", text: "Attachment" },
    ]);
    expect(JSON.stringify(feed.items)).not.toContain(secret);
    expect(feed.hiddenServiceCount).toBe(0);
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("bounds attachment labels and rejects oversized inline image payloads", () => {
    const longType = "x".repeat(100_000);
    const oversizedData = "A".repeat(Math.ceil((12 * 1024 * 1024 * 4) / 3));
    const lines = [codexUserResponse("t1", [
      { type: longType, value: "present" },
      { type: "input_image", image_url: `data:image/png;base64,${oversizedData}` },
    ])];
    const feed = buildFeed(codexFile, lines, false, "");
    const notes = itemsOfKind(feed, "note");
    expect(notes).toHaveLength(2);
    expect(notes.every((item) => item.kind === "note" && item.text.length <= 100)).toBe(true);
    expect(itemsOfKind(feed, "image")).toHaveLength(0);
    expect(JSON.stringify(feed.items)).not.toContain(oversizedData.slice(0, 128));
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("uses event text with response attachments and keeps the original feed key", () => {
    const response = codexUserResponse("t1", [
      { type: "input_text", text: "canonical composer text" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
    ]);
    const echo = codexUserEvent("t1.001", "canonical composer text");
    const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    const preview = session.feed([response], 0, true);
    const complete = session.feed([response, echo], 0, true);
    expect(complete.items).toHaveLength(2);
    expect(complete.items[0]?.key).toBe(preview.items[0]?.key);
    expect(complete.items[0]?.item).toEqual({ kind: "user", ts: "t1.001", text: "canonical composer text" });
    expect(complete.items[1]?.item.kind).toBe("image");
    assertParity(codexFile, [response, echo], { chunks: [1] });
  });

  test("has incremental and one-shot parity when a retained window starts on either pair half", () => {
    const response = codexUserResponse("t1", [{ type: "input_text", text: "slide me" }]);
    const echo = codexUserEvent("t1", "slide me");
    const next = JSON.stringify({ type: "event_msg", timestamp: "t2", payload: { type: "task_started" } });
    const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    session.feed([response, echo], 0, false);
    const echoOnly = session.feed([echo], 1, false);
    expect(echoOnly.items.map((entry) => entry.item)).toEqual(buildFeed(codexFile, [echo], false, "").items);
    expect(itemsOfKind(buildFeed(codexFile, [response], false, ""), "user")).toHaveLength(1);
    expect(itemsOfKind({ items: echoOnly.items.map((entry) => entry.item), hiddenServiceCount: echoOnly.hiddenServiceCount }, "user")).toHaveLength(1);
    assertParity(codexFile, [response, echo, next], { chunks: [2, 1], cap: 2 });
    assertParity(codexFile, [response, echo, next], { chunks: [1], cap: 1 });
  });
});

describe("Codex assistant prose coalescing", () => {
  test("coalesces production-shaped echoes in either record order and gives the event timestamp ownership", () => {
    const sevenMsText = "Причина `sudo` тоже найдена точно: сокет Docker имеет права `root:docker`, пользователь `latand` уже записан в группу `docker`, однако текущая login-сессия запущена без этой дополнительной группы. Host network, PID namespace и маунты к этому отношения не имеют. После нового входа в сессию группа подхватится; для текущей оболочки можно запускать через `sg docker -c ...`. Проверяю доступ этим способом без изменения системы.";
    const zeroMsText = "Account-switch UI готов и закоммичен: bare `select()` удалён, обе поверхности используют preview → confirm/migrate, активный аккаунт можно нажать для ремонта застрявших поколений, retry получает свежую revision. Переношу UI-коммит в общую ветку и запускаю интеграционную проверку backend+frontend. После неё будет один свежий независимый review-round.";
    const productionOrder = [
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-10T07:05:12.128Z", payload: { type: "agent_message", message: sevenMsText, phase: "commentary", memory_citation: null } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-10T07:05:12.135Z", payload: { type: "message", id: "msg_0393b5967eeb6b3d016a5099a6c6f881918750dcfe9b95b684", role: "assistant", content: [{ type: "output_text", text: sevenMsText }], phase: "commentary" } }),
    ];
    const reversedOrder = [
      JSON.stringify({ type: "response_item", timestamp: "2026-07-10T07:05:24.424Z", payload: { type: "message", id: "msg_0393b5967eeb6b3d016a5099b33df88191bfb8b5a7b245ebb7", role: "assistant", content: [{ type: "output_text", text: zeroMsText }], phase: "commentary" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-10T07:05:24.424Z", payload: { type: "agent_message", message: zeroMsText, phase: "commentary", memory_citation: null } }),
    ];

    expect(itemsOfKind(buildFeed(codexFile, productionOrder, false, ""), "prose")).toEqual([
      { kind: "prose", ts: "2026-07-10T07:05:12.128Z", text: sevenMsText, engine: "codex" },
    ]);
    expect(itemsOfKind(buildFeed(codexFile, reversedOrder, false, ""), "prose")).toEqual([
      { kind: "prose", ts: "2026-07-10T07:05:24.424Z", text: zeroMsText, engine: "codex" },
    ]);
  });

  test("requires opposite shapes, adjacent source records, matching normalized text, and the correlation boundary", () => {
    const text = "same assistant message";
    const at = "2026-07-10T07:06:16.000Z";
    const cases: { lines: string[]; count: number; label: string }[] = [
      { label: "two events", lines: [codexAssistantEvent(at, text), codexAssistantEvent(at, text)], count: 2 },
      { label: "two responses", lines: [codexAssistantResponse(at, text), codexAssistantResponse(at, text)], count: 2 },
      { label: "different text", lines: [codexAssistantEvent(at, text), codexAssistantResponse(at, "different")], count: 2 },
      { label: "normalized whitespace", lines: [codexAssistantEvent(at, `  ${text}  `), codexAssistantResponse("2026-07-10T07:06:16.500Z", `\n${text}\n`)], count: 1 },
      { label: "one second", lines: [codexAssistantEvent(at, text), codexAssistantResponse("2026-07-10T07:06:17.000Z", text)], count: 1 },
      { label: "one second plus one millisecond", lines: [codexAssistantEvent(at, text), codexAssistantResponse("2026-07-10T07:06:17.001Z", text)], count: 2 },
    ];
    for (const { lines, count, label } of cases) {
      expect(itemsOfKind(buildFeed(codexFile, lines, false, ""), "prose"), label).toHaveLength(count);
    }

    const separated = [codexAssistantEvent(at, text), codexReasoning("2026-07-10T07:06:16.100Z"), codexAssistantResponse("2026-07-10T07:06:16.200Z", text)];
    for (const showSvc of [false, true]) {
      expect(itemsOfKind(buildFeed(codexFile, separated, showSvc, ""), "prose")).toHaveLength(2);
    }
  });

  test("consumes echo eligibility one pair at a time", () => {
    const text = "alternate";
    const event = codexAssistantEvent("2026-07-10T07:06:16.000Z", text);
    const response = codexAssistantResponse("2026-07-10T07:06:16.001Z", text);
    expect(itemsOfKind(buildFeed(codexFile, [event, response, event, response], false, ""), "prose")).toHaveLength(2);
    expect(itemsOfKind(buildFeed(codexFile, [event, response, event], false, ""), "prose")).toHaveLength(2);
  });

  test("preserves the first live-tail key in both orders", () => {
    const text = "live tail";
    const orders = [
      { lines: [codexAssistantEvent("2026-07-10T07:06:16.000Z", text), codexAssistantResponse("2026-07-10T07:06:16.007Z", text)], eventTs: "2026-07-10T07:06:16.000Z" },
      { lines: [codexAssistantResponse("2026-07-10T07:06:17.000Z", text), codexAssistantEvent("2026-07-10T07:06:17.007Z", text)], eventTs: "2026-07-10T07:06:17.007Z" },
    ];
    for (const { lines: [first, second], eventTs } of orders) {
      const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
      const preview = session.feed([first], 0, true);
      const complete = session.feed([first, second], 0, true);
      expect(complete.items).toHaveLength(1);
      expect(complete.items[0]?.key).toBe(preview.items[0]?.key);
      expect(complete.items[0]?.item).toMatchObject({ kind: "prose", ts: eventTs });
    }
  });

  test("keeps review, citation, and blob payloads intact while coalescing their sources", () => {
    const review = "VERDICT: APPROVE\n\nSummary: parser contract holds.";
    const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[contract]\n</citation_entries>\n<rollout_ids>\n019f4944-97f1-7f20-bd8b-7c3c23085bb0\n</rollout_ids>\n</oai-mem-citation>";
    const variants = [review, `${review}\n\n${citation}`, "x".repeat(20_001)];
    for (const text of variants) {
      for (const [first, second] of [
        [codexAssistantEvent("2026-07-10T07:06:16.000Z", text), codexAssistantResponse("2026-07-10T07:06:16.007Z", text)],
        [codexAssistantResponse("2026-07-10T07:06:17.000Z", text), codexAssistantEvent("2026-07-10T07:06:17.007Z", text)],
      ]) {
        const paired = buildFeed(codexFile, [first, second], false, "").items;
        const eventRecord = first.includes("event_msg") ? first : second;
        const standalone = buildFeed(codexFile, [eventRecord], false, "").items;
        expect(paired.map((item) => ({ ...item, ts: undefined }))).toEqual(standalone.map((item) => ({ ...item, ts: undefined })));
        expect(paired.filter((item) => item.kind === "review")).toHaveLength(text.startsWith("VERDICT") ? 1 : 0);
        expect(paired.filter((item) => item.kind === "mem-citation")).toHaveLength(text.includes("<oai-mem-citation>") ? 1 : 0);
        expect(paired.filter((item) => item.kind === "blob")).toHaveLength(text.length === 20_001 ? 1 : 0);
        const reviewItem = paired.find((item) => item.kind === "review");
        if (reviewItem?.kind === "review") expect(reviewItem.ts).toBe(second.includes("event_msg") ? JSON.parse(second).timestamp : JSON.parse(first).timestamp);
      }
    }
  }, 15_000);

  test("keeps incremental, prepend, and sliding-window parsing equivalent to a fresh parse", () => {
    const event = codexAssistantEvent("2026-07-10T07:06:16.000Z", "seam");
    const response = codexAssistantResponse("2026-07-10T07:06:16.007Z", "seam");
    for (const lines of [[event, response], [response, event]]) {
      assertParity(codexFile, lines, { chunks: [1], cap: 1, live: true });
      assertParity(codexFile, lines, { chunks: [2, 1], cap: 2 });
      const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
      const prepend = session.feed([lines[1]], 1, false);
      const widened = session.feed(lines, 0, false);
      expect(widened.items.map((entry) => entry.item)).toEqual(buildFeed(codexFile, lines, false, "").items);
      expect(prepend.items).toHaveLength(1);

      const sliding = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
      sliding.feed(lines, 0, false);
      const secondOnly = sliding.feed([lines[1]], 1, false);
      expect(secondOnly.items.map((entry) => entry.item)).toEqual(buildFeed(codexFile, [lines[1]], false, "").items);
    }
  });
});

describe("Codex functions.exec orchestration", () => {
  const orch = (input: string, callId: string, ts = "t") =>
    JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "custom_tool_call", id: "ctc-" + callId, call_id: callId, name: "exec", status: "completed", input } });
  const orchOutput = (callId: string, text: string) =>
    JSON.stringify({ type: "response_item", timestamp: "t", payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text }] } });

  test("four concurrent tools read as one record with structured, distinct children", () => {
    const src =
      'const r = await Promise.all([tools.exec_command({cmd:"git status"}), tools.exec_command({cmd:"git diff"}), tools.read_file({path:"src/a.ts"}), tools.exec_command({cmd:"ls -la"})]); text(r);';
    const feed = buildFeed(codexFile, [orch(src, "c1"), orchOutput("c1", "## main")], false, "");
    const tools = feed.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    const event = tools[0];
    if (event.kind !== "tool") throw new Error("expected tool");
    const nested = event.orchestration?.calls.filter((call) => call.icon !== "note") ?? [];
    expect(nested).toHaveLength(4);
    expect(event.summary).toContain("4");
    expect(new Set(nested.map((call) => call.summary)).size).toBeGreaterThan(1);
    // outer + nested ids are available for diagnosis
    expect(event.id).toBe("c1");
    expect(nested.every((call) => call.id.length > 0)).toBe(true);
    // combined output attaches to the outer event
    expect(event.outputPreview).toContain("## main");
    // compose helper text() becomes a quiet label outside the tool rows
    expect(event.orchestration?.calls.some((call) => call.tool === "text" && call.icon === "note")).toBe(true);
  });

  test("consecutive exec records fold into a cmd-group while staying distinguishable (§3.4)", () => {
    const lines = [orch('await tools.exec_command({cmd:"aaa"})', "a"), orch('await tools.exec_command({cmd:"bbb"})', "b"), orch('await tools.exec_command({cmd:"ccc"})', "c"), orch('await tools.exec_command({cmd:"ddd"})', "d")];
    const items = buildFeed(codexFile, lines, false, "").items;
    // Four consecutive orchestration records fold into one quiet group; expanding
    // it lists each call with its own distinct summary and its nested body intact.
    expect(items).toHaveLength(1);
    const group = items[0];
    if (group.kind !== "cmd-group") throw new Error("expected a cmd-group");
    expect(group.calls).toHaveLength(4);
    expect(new Set(group.calls.map((call) => call.summary)).size).toBe(4);
    expect(group.calls.every((call) => call.orchestration !== undefined)).toBe(true);
    assertParity(codexFile, lines, { chunks: [1] });
  });

  test("supports the function_call exec shape and redacts source", () => {
    const fc = JSON.stringify({
      type: "response_item",
      timestamp: "t",
      payload: { type: "function_call", name: "exec", call_id: "f1", arguments: JSON.stringify({ input: 'await tools.exec_command({cmd:"echo token=SECRETLEAK99"})' }) },
    });
    const feed = buildFeed(codexFile, [fc], false, "");
    const event = feed.items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected tool");
    expect(event.orchestration).toBeDefined();
    expect(JSON.stringify(event)).not.toContain("SECRETLEAK99");
  });

  test("unwraps metadata-passthrough exec calls and preserves nested stdin poll details", () => {
    const lines = [
      JSON.stringify({
        type: "response_item",
        timestamp: "t1",
        payload: {
          type: "custom_tool_call",
          id: "ctc-poll",
          call_id: "poll-call",
          name: "exec",
          status: "completed",
          input: 'const result = await tools.write_stdin({ session_id: 73, chars: "" }); text(result.output);',
          internal_chat_message_metadata_passthrough: { turn_id: "turn-synthetic" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2",
        payload: {
          type: "custom_tool_call_output",
          call_id: "poll-call",
          output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nprocess is still running" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-synthetic" },
        },
      }),
    ];

    const event = buildFeed(codexFile, lines, false, "").items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected metadata-wrapped exec tool");
    expect(event.orchestration?.calls).toHaveLength(2);
    expect(event.orchestration?.calls[0]?.tool).toBe("write_stdin");
    expect(event.orchestration?.calls[0]?.summary).toContain("73");
    expect(event.orchestration?.calls[0]?.summary.toLowerCase()).toContain("poll");
    expect(event.outputPreview).toContain("process is still running");
    expect(event.outputPreview).not.toContain("Script completed");
  });

  test("keeps runtime stdin argument expressions visible in nested summaries", () => {
    const event = buildFeed(
      codexFile,
      [orch("await tools.write_stdin({ session_id: process.session_id, chars });", "runtime-poll")],
      false,
      "",
    ).items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected nested stdin tool");
    expect(event.orchestration?.calls[0]?.summary).toContain("process.session_id");
    expect(event.orchestration?.calls[0]?.summary).toContain("chars");
  });

  test("a plain custom tool without tools.* stays a single generic row", () => {
    const feed = buildFeed(codexFile, [orch("return 2 + 2;", "p1")], false, "");
    const event = feed.items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected tool");
    expect(event.orchestration).toBeUndefined();
  });

  /* Issue #83: the collapsed row must carry the actual command/target, whatever
     shape the `tools.exec_command` argument takes in the generated JS. */
  const single = (input: string) => {
    const feed = buildFeed(codexFile, [orch(input, "s")], false, "");
    const event = feed.items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected tool");
    return event;
  };

  test("inline template-literal command keeps its full head, not an inner fragment", () => {
    // The old first-quote heuristic grabbed the `'1,240p'` inside the template.
    const event = single("const r = await tools.exec_command({cmd: `sed -n '1,240p' '${f}'`, workdir: \"/repo\"}); text(r.output);");
    expect(event.family).toBe("shell");
    expect(event.icon).toBe("shell");
    expect(event.summary).toBe("sed -n '1,240p' '${f}'");
  });

  test("a workdir path never masquerades as the command", () => {
    const event = single("await tools.exec_command({cmd: `git status --short`, workdir: \"/home/user/repo\"});");
    expect(event.summary).toContain("git status");
    expect(event.summary).not.toContain("/home/user/repo");
  });

  test("shorthand {cmd} resolves the command from its const definition", () => {
    const event = single("const cmd = `rtk gh issue create --title x`;\nconst r = await tools.exec_command({cmd, workdir: \"/repo\"});\ntext(r.output);");
    expect(event.family).toBe("shell");
    expect(event.summary).toContain("rtk gh issue create");
  });

  test("an identifier value (cmd: c) resolves through its const", () => {
    const event = single("const c = 'bun test src';\nconst r = await tools.exec_command({cmd:c, workdir:\"/repo\"});");
    expect(event.summary).toContain("bun test src");
  });

  test("a const cmds=[[label, command]] batch expands to one row per command", () => {
    const input =
      'const cmds = [["A", "git fetch origin", "/repo"], ["B", "git status --short", "/repo"], ["C", "git log -1", "/repo"]];\n' +
      "const rs = await Promise.all(cmds.map(([name, cmd, wd]) => tools.exec_command({cmd, workdir: wd})));\n" +
      "rs.forEach((r, i) => text(`${cmds[i][0]}: ${r.output}`));";
    const event = single(input);
    expect(event.icon).toBe("cmd-group");
    const nested = event.orchestration?.calls ?? [];
    expect(nested.map((call) => call.summary)).toEqual(["git fetch origin", "git status --short", "git log -1"]);
    // the collapsed row leads with the first command and tags the batch size
    expect(event.summary).toContain("git fetch origin");
    expect(event.summary).toContain("3");
  });

  test("a truly runtime-computed command degrades to a clean shell label, not a stray path", () => {
    // cmd is destructured in the map with no static tuple array to recover from.
    const event = single("const rs = await Promise.all(items.map(c => tools.exec_command({cmd:c, workdir:\"/home/user/repo\"})));");
    expect(event.family).toBe("shell");
    expect(event.summary).not.toContain("/home/user/repo");
  });

  /* Issue #90: a `const patch = "*** Begin Patch\n…"` assignment driving
     tools.apply_patch is the common Codex edit shape. Its escaped JS string must
     parse into the structured diff model — never a raw source dump. */
  test("a buried apply_patch payload parses into a structured diff, not a raw source dump", () => {
    const src =
      'const patch = "*** Begin Patch\\n*** Update File: src/limit.ts\\n@@\\n-const limit = 10;\\n+const limit = 20;\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    const event = single(src);
    expect(event.family).toBe("edit");
    expect(event.summary).toContain("limit.ts");
    expect(event.body?.type).toBe("diff");
    if (event.body?.type !== "diff") throw new Error("expected a diff body");
    expect(event.body.files).toHaveLength(1);
    const lines = event.body.files[0].hunks.flatMap((hunk) => hunk.lines.map((line) => line.t + line.text));
    expect(lines).toContain("-const limit = 10;");
    expect(lines).toContain("+const limit = 20;");
    // The escaped JS source is never dumped as an orchestration body, and the
    // edit row is represented by the diff (not duplicated as a nested call).
    expect(event.orchestration).toBeUndefined();
    // The diff is expanded inline by default.
    expect(event.open).toBe(true);
  });

  test("apply_patch string escapes (\\n, \\\") decode into real diff lines", () => {
    const src =
      'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-const s = \\"old\\";\\n+const s = \\"new\\";\\n*** End Patch";\nawait tools.apply_patch(patch);';
    const event = single(src);
    if (event.body?.type !== "diff") throw new Error("expected a diff body");
    const texts = event.body.files[0].hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    // The `\"` decoded to a real quote and each `\n` became a line boundary.
    expect(texts).toContain('const s = "old";');
    expect(texts).toContain('const s = "new";');
    // No raw escape residue (a literal backslash-n) survives inside any line.
    expect(texts.every((line) => !line.includes("\\n"))).toBe(true);
  });

  test("a record mixing apply_patch with another op keeps the diff and the non-edit nested row", () => {
    const src =
      'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch";\nawait tools.exec_command({cmd:"bun test src/a.test.ts"});\nawait tools.apply_patch(patch);';
    const event = single(src);
    expect(event.body?.type).toBe("diff");
    const nested = event.orchestration?.calls ?? [];
    // The edit op is carried by the diff, so it is not duplicated as a row.
    expect(nested.every((call) => call.family !== "edit")).toBe(true);
    expect(nested.some((call) => call.summary.includes("bun test"))).toBe(true);
  });

  test("the Script completed / Wall time / Output {} preamble is suppressed as no-signal output", () => {
    const src = 'const patch = "*** Begin Patch\\n*** Add File: src/new.ts\\n+export const x = 1;\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    const feed = buildFeed(codexFile, [orch(src, "p"), orchOutput("p", "Script completed\nWall time 0.1 seconds\nOutput:\n\n{}")], false, "");
    const event = feed.items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected a tool item");
    expect(event.status).toBe("ok");
    expect(event.outputPreview).toBe("");
    expect(event.body?.type).toBe("diff");
  });
});

describe("Codex payload audit fixture", () => {
  const lines = fixtureLines("codex-payload-audit.jsonl");

  test("pins the read-only audit provenance, counts, and parser dispositions", () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "codex-payload-audit-manifest.json"), "utf8")) as {
      roots: string[];
      windowDays: number;
      files: number;
      rows: number;
      malformedRows: number;
      payloads: { record: string; type: string; count: number; disposition: string }[];
      nested: { path: string; type: string; count: number; disposition: string }[];
    };
    expect(manifest.roots).toEqual(["~/.codex/sessions", "~/.config/agent-log-viewer/accounts/codex/*/sessions"]);
    expect(manifest.windowDays).toBe(3);
    expect(manifest.files).toBeGreaterThan(0);
    expect(manifest.rows).toBeGreaterThan(0);
    expect(manifest.malformedRows).toBe(3);
    expect(manifest.payloads.every((entry) => entry.count > 0 && ["structured", "service", "typed-fallback"].includes(entry.disposition))).toBe(true);
    expect(manifest.nested.every((entry) => entry.count > 0 && ["structured", "service", "typed-detail"].includes(entry.disposition))).toBe(true);
    const fixturePayloads = new Set(
      lines
        .map((line) => JSON.parse(line) as { type?: string; payload?: { type?: string } })
        .filter((record) => record.type && record.payload?.type)
        .map((record) => `${record.type}/${record.payload!.type}`),
    );
    expect([...fixturePayloads].sort()).toEqual(manifest.payloads.map((entry) => `${entry.record}/${entry.type}`).sort());
    expect(nestedTypes()).toEqual(manifest.nested.map((entry) => `${entry.path}:${entry.type}`).sort());
  });

  function nestedTypes(): string[] {
    const found = new Set<string>();
    for (const line of lines) {
      const payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload;
      if (!payload) continue;
      const typed = (value: unknown): string | null => value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
        ? String((value as { type: string }).type)
        : null;
      const collect = (prefix: string, values: unknown) => {
        if (!Array.isArray(values)) return;
        for (const value of values) {
          const type = typed(value);
          if (type) found.add(`${prefix}:${type}`);
        }
      };
      collect("content", payload.content);
      collect("output", payload.output);
      collect("replacement", payload.replacement_history);
      for (const replacement of Array.isArray(payload.replacement_history) ? payload.replacement_history : []) {
        collect("replacement.content", replacement && typeof replacement === "object" ? (replacement as { content?: unknown }).content : undefined);
      }
      const action = typed(payload.action);
      if (action) found.add(`action:${action}`);
      if (payload.changes && typeof payload.changes === "object") {
        for (const change of Object.values(payload.changes)) {
          const type = typed(change);
          if (type) found.add(`change:${type}`);
        }
      }
      collect("tools", payload.tools);
      for (const namespace of Array.isArray(payload.tools) ? payload.tools : []) {
        collect("tools.tool", namespace && typeof namespace === "object" ? (namespace as { tools?: unknown }).tools : undefined);
      }
      const result = payload.result && typeof payload.result === "object" ? payload.result as { Ok?: { content?: unknown } } : undefined;
      collect("result.Ok.content", result?.Ok?.content);
    }
    return [...found].sort();
  }

  test("covers every top-level and payload type observed in the three-day audit", () => {
    const records = lines.map((line) => JSON.parse(line) as { type?: string; payload?: { type?: string } });
    expect([...new Set(records.map((record) => record.type ?? "<missing>"))].sort()).toEqual([
      "<missing>",
      "compacted",
      "event_msg",
      "inter_agent_communication_metadata",
      "response_item",
      "session_meta",
      "turn_context",
      "world_state",
    ]);
    expect([...new Set(records.map((record) => record.payload?.type).filter((type): type is string => Boolean(type)))].sort()).toEqual([
      "agent_message",
      "context_compacted",
      "custom_tool_call",
      "custom_tool_call_output",
      "function_call",
      "function_call_output",
      "mcp_tool_call_end",
      "message",
      "patch_apply_end",
      "reasoning",
      "sub_agent_activity",
      "task_complete",
      "task_started",
      "thread_settings_applied",
      "token_count",
      "tool_search_call",
      "tool_search_output",
      "turn_aborted",
      "user_message",
      "web_search_end",
    ]);
  });

  test("covers every nested item type observed in the three-day audit", () => {
    expect(nestedTypes()).toEqual([
      "action:find_in_page",
      "action:open_page",
      "action:other",
      "action:search",
      "change:add",
      "change:delete",
      "change:update",
      "content:encrypted_content",
      "content:input_image",
      "content:input_text",
      "content:output_text",
      "output:input_image",
      "output:input_text",
      "replacement.content:input_text",
      "replacement:compaction",
      "replacement:message",
      "result.Ok.content:image",
      "result.Ok.content:text",
      "tools.tool:function",
      "tools:namespace",
    ]);
  });

  test("every audited shape reaches a structured, service, or typed fallback item", () => {
    const feed = buildFeed(codexFile, lines, true, "");
    expect(feed.items.some((item) => item.kind === "raw")).toBe(false);
    const fallbacks = feed.items.filter((item) => (item as { kind: string }).kind === "record") as unknown as { recordType: string }[];
    expect(fallbacks.map((item) => item.recordType).sort()).toEqual(["record", "record", "tool_search_call", "tool_search_output"]);
  });

  test("typed fallback bounds, redacts, and contains a future payload", () => {
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "t",
      payload: { type: "future_payload", api_key: "LEAKME12345", detail: "x".repeat(40_000) },
    });
    const feed = buildFeed(codexFile, [line], false, "");
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0] as unknown as { kind: string; recordType: string; body: string; truncated: boolean };
    expect(item.kind).toBe("record");
    expect(item.recordType).toBe("future_payload");
    expect(item.body).not.toContain("LEAKME12345");
    expect(item.body.length).toBeLessThanOrEqual(24_000);
    expect(item.truncated).toBe(true);
  });

  test("typed fallback redacts bearer credentials from detail and its type chip", () => {
    const credential = "synthetic-sensitive-credential";
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "t",
      payload: {
        type: `authorization: Bearer ${credential}`,
        detail: `Authorization: Bearer ${credential}`,
      },
    });
    const item = buildFeed(codexFile, [line], false, "").items[0] as unknown as { kind: string; recordType: string; body: string };
    expect(item.kind).toBe("record");
    expect(item.recordType).not.toContain(credential);
    expect(item.recordType).toContain("[redacted]");
    expect(item.body).not.toContain(credential);
    expect(item.body).toContain("[redacted]");
  });

  test("a malformed JSONL row stays inside the typed record renderer", () => {
    const feed = buildFeed(codexFile, ['{"type":"response_item","payload":{"api_key":"LEAKME12345"'], false, "");
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0] as unknown as { kind: string; recordType: string; body: string };
    expect(item.kind).toBe("record");
    expect(item.recordType).toBe("malformed_record");
    expect(item.body).toContain("response_item");
    expect(item.body).not.toContain("LEAKME12345");
  });

  test("a malformed JSONL row redacts a bearer credential", () => {
    const credential = "synthetic-malformed-credential";
    const feed = buildFeed(codexFile, [`{"type":"response_item","Authorization":"Bearer ${credential}`], false, "");
    const item = feed.items[0] as unknown as { kind: string; body: string };
    expect(item.kind).toBe("record");
    expect(item.body).not.toContain(credential);
    expect(item.body).toContain("[redacted]");
  });

  test("valid non-record JSON values stay inside the typed record renderer", () => {
    for (const line of ["[]", '"synthetic"', "42", "true", "null"]) {
      const feed = buildFeed(codexFile, [line], false, "");
      expect(feed.items).toHaveLength(1);
      const item = feed.items[0] as unknown as { kind: string; recordType: string };
      expect(item.kind).toBe("record");
      expect(item.recordType).toBe("malformed_record");
    }
  });

  test("typed tool output keeps an image placeholder beside captured text", () => {
    const feed = buildFeed(codexFile, lines, false, "");
    const tools = feed.items.flatMap((item): Extract<Item, { kind: "tool" }>[] =>
      item.kind === "tool" ? [item] : item.kind === "cmd-group" ? item.calls : [],
    );
    const custom = tools.find((item) => item.id === "custom-call");
    expect(custom?.outputPreview).toContain("Synthetic poll output");
    expect(custom?.outputPreview.toLowerCase()).toContain("image");
    expect(custom?.outputPreview).not.toContain("c3ludGhldGlj");
  });

  test("typed tool output keeps primitive values and unknown block labels", () => {
    const lines = [
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "custom_tool_call", call_id: "mixed-call", name: "exec", input: "return 1;" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2",
        payload: { type: "custom_tool_call_output", call_id: "mixed-call", output: [{ type: "future_block", detail: "opaque-value" }, 7, true] },
      }),
    ];
    const event = buildFeed(codexFile, lines, false, "").items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected mixed-output tool");
    expect(event.outputPreview).toContain("future_block");
    expect(event.outputPreview).toContain("7");
    expect(event.outputPreview).toContain("true");
    expect(event.outputPreview).not.toContain("opaque-value");
  });

  test("typed tool output redacts bearer credentials in text and block labels", () => {
    const credential = "synthetic-tool-output-credential";
    const lines = [
      JSON.stringify({ type: "response_item", timestamp: "t1", payload: { type: "custom_tool_call", call_id: "secret-call", name: "exec", input: "return 1;" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "t2",
        payload: {
          type: "custom_tool_call_output",
          call_id: "secret-call",
          output: [
            { type: "input_text", text: `Authorization: Bearer ${credential}` },
            { type: `Bearer ${credential}`, detail: "opaque" },
          ],
        },
      }),
    ];
    const event = buildFeed(codexFile, lines, false, "").items.find((item) => item.kind === "tool");
    if (event?.kind !== "tool") throw new Error("expected secret-output tool");
    expect(event.outputPreview).not.toContain(credential);
    expect(event.outputPreview).toContain("[redacted]");
  });
});

describe("Codex orchestration over a real rollout fixture (issue #83)", () => {
  const fixture = readFileSync(join(import.meta.dir, "__fixtures__", "codex-orchestration.jsonl"), "utf8").split("\n").filter(Boolean);
  /* Consecutive tool events fold into cmd-groups (§3.4), so read every native
     tool event back from both top-level rows and any group. */
  const events = buildFeed(codexFile, fixture, false, "").items.flatMap((item): Extract<Item, { kind: "tool" }>[] =>
    item.kind === "tool" ? [item] : item.kind === "cmd-group" ? item.calls : [],
  );

  test("every native tool card carries a meaningful, non-empty summary", () => {
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const event of events) {
      expect(event.summary.trim().length).toBeGreaterThan(0);
      // no card is a bare method placeholder like "cmd"/"exec"/"tool"
      expect(["cmd", "exec", "tool", "text"]).not.toContain(event.summary.trim());
      // the orchestration source chip is populated for the expanded view
      if (event.orchestration) expect(event.orchestration.source.length).toBeGreaterThan(0);
    }
  });

  test("real exec_command shapes summarize to their command/target head", () => {
    const summaries = events.map((event) => event.summary);
    // inline template read
    expect(summaries.some((s) => s.startsWith("sed -n '1,240p'"))).toBe(true);
    // shorthand-const command
    expect(summaries.some((s) => s.includes("rtk gh issue create"))).toBe(true);
    // const cmds=[[…]] batch → cmd-group leading with the first command
    const batch = events.find((event) => event.icon === "cmd-group");
    expect(batch?.orchestration?.calls.length).toBeGreaterThanOrEqual(3);
    expect(batch?.summary).toContain("rtk proxy curl");
    // view_image → a read card naming the file
    expect(events.some((event) => event.family === "read" && /\.png$/.test(event.summary))).toBe(true);
    // apply_patch → an edit card naming the file count
    expect(events.some((event) => event.family === "edit" && event.summary.includes("file"))).toBe(true);
  });
});

describe("Claude protocol and repeated prose", () => {
  test("keeps a queued human message in the user role beside harness records", () => {
    const lines = fixtureLines("claude-queued-mid-turn.jsonl");
    const feed = buildFeed(claudeFile, lines, false, "");

    expect(itemsOfKind(feed, "user")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Keep this request styled as a user message.") }),
    ]);
    expect(itemsOfKind(feed, "sysmsg")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("<task-notification>") }),
    ]);
    assertParity(claudeFile, lines, { chunks: [1] });
  });

  test("classifies structural and complete-wrapper protocol rows as system messages", () => {
    const lines = [
      JSON.stringify({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat: command</local-command-caveat>" } }),
      JSON.stringify({ type: "user", interruptedMessageId: "msg-1", message: { content: "[Request interrupted by user]" } }),
      JSON.stringify({ type: "user", promptSource: "command", message: { content: "command output" } }),
      JSON.stringify({ type: "user", origin: "task", message: { content: "task notification" } }),
      JSON.stringify({ type: "user", message: { content: "<task-notification type=\"idle\">done</task-notification>" } }),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    expect(itemsOfKind(feed, "user")).toHaveLength(0);
    expect(itemsOfKind(feed, "sysmsg")).toHaveLength(lines.length);
    assertParity(claudeFile, lines, { chunks: [1], cap: 3 });
  });

  test("retains repeated assistant prose with stable entries across a sliding window", () => {
    const lines = [claudeProse("repeat"), claudeUser("between"), claudeProse("repeat")];
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const before = session.feed(lines.slice(0, 2), 0, false);
    const after = session.feed(lines, 0, false);
    expect(itemsOfKind(buildFeed(claudeFile, lines, false, ""), "prose")).toHaveLength(2);
    expect(after.items[0]?.item).toBe(before.items[0]?.item);
    expect(after.items[0]?.key).toBe(before.items[0]?.key);
    assertParity(claudeFile, lines, { chunks: [1], cap: 2 });
  });
});

const claudeWakeup = (id: string, input: Record<string, unknown>, timestamp = "2026-07-06T10:00:02Z") =>
  JSON.stringify({ type: "assistant", timestamp, message: { content: [{ type: "tool_use", id, name: "ScheduleWakeup", input }] } });


describe("ScheduleWakeup card", () => {
  test("emits a standalone wakeup tool event with a derived fire time", () => {
    const ts = "2026-07-06T10:00:02Z";
    const lines = [claudeWakeup("w1", { delaySeconds: 1200, reason: "Fallback poll", prompt: "Continue the issue" }, ts)];
    const feed = buildFeed(claudeFile, lines, false, "");
    const tools = feed.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    const wakeup = tools[0].kind === "tool" ? tools[0].wakeup : undefined;
    expect(wakeup).toBeDefined();
    expect(wakeup?.reason).toBe("Fallback poll");
    expect(wakeup?.prompt).toBe("Continue the issue");
    expect(wakeup?.superseded).toBe(false);
    expect(wakeup?.fireAt).toBe(Date.parse(ts) + 1200 * 1000);
  });

  test("a wakeup never folds into a cmd-group even amid a command run", () => {
    const lines = [
      claudeTool("g1", "Bash", "echo 1"),
      claudeResult("g1", "1"),
      claudeTool("g2", "Bash", "echo 2"),
      claudeResult("g2", "2"),
      claudeWakeup("w1", { delaySeconds: 60, reason: "r", prompt: "p" }),
      claudeTool("g3", "Bash", "echo 3"),
      claudeResult("g3", "3"),
      claudeTool("g4", "Bash", "echo 4"),
      claudeResult("g4", "4"),
      claudeProse("done"),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    const wakeups = feed.items.filter((item) => item.kind === "tool" && item.wakeup);
    expect(wakeups).toHaveLength(1);
    assertParity(claudeFile, lines);
  });

  test("only the newest wakeup stays active; earlier ones are superseded", () => {
    const lines = [
      claudeWakeup("w1", { delaySeconds: 600, reason: "first", prompt: "p1" }),
      claudeProse("waited a bit"),
      claudeWakeup("w2", { delaySeconds: 900, reason: "second", prompt: "p2" }),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    const wakeups = feed.items.filter((item) => item.kind === "tool" && item.wakeup);
    expect(wakeups).toHaveLength(2);
    const byReason = new Map(wakeups.map((w) => [w.kind === "tool" ? w.wakeup?.reason : "", w.kind === "tool" ? w.wakeup?.superseded : undefined]));
    expect(byReason.get("first")).toBe(true);
    expect(byReason.get("second")).toBe(false);
    assertParity(claudeFile, lines);
  });

  test("recovers the fire time from the result when the input carried no delay", () => {
    const ts = "2026-07-06T10:00:02Z";
    const lines = [
      claudeWakeup("w1", { reason: "r", prompt: "p" }, ts),
      claudeResult("w1", "Next wakeup scheduled for 13:30:00 (in 1215s). Nothing more to do this turn."),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    const tool = feed.items.find((item) => item.kind === "tool");
    const wakeup = tool && tool.kind === "tool" ? tool.wakeup : undefined;
    expect(wakeup?.fireAt).toBe(Date.parse(ts) + 1215 * 1000);
  });

  test("the resolved delay overrides the requested delay on attach", () => {
    const ts = "2026-07-06T10:00:02Z";
    const lines = [
      claudeWakeup("w1", { delaySeconds: 120, reason: "r", prompt: "p" }, ts),
      claudeResult("w1", "Next wakeup scheduled for 10:02:15 (in 135s)."),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    const tool = feed.items.find((item) => item.kind === "tool");
    const wakeup = tool && tool.kind === "tool" ? tool.wakeup : undefined;
    // ts + the resolved 135s wins over the requested 120s (timezone-independent).
    expect(wakeup?.fireAt).toBe(Date.parse(ts) + 135 * 1000);
  });

  test("a rejected wakeup is marked failed and does not supersede the prior valid one", () => {
    const lines = [
      claudeWakeup("w1", { delaySeconds: 600, reason: "first", prompt: "p1" }),
      claudeResult("w1", "Next wakeup scheduled for 10:10:00 (in 600s)."),
      claudeProse("waited a bit"),
      claudeWakeup("w2", { delaySeconds: 900, reason: "second", prompt: "p2" }),
      claudeResult("w2", "delaySeconds must be between 60 and 3600", true),
    ];
    const feed = buildFeed(claudeFile, lines, false, "");
    const wakeups = feed.items.filter((item) => item.kind === "tool" && item.wakeup);
    expect(wakeups).toHaveLength(2);
    const by = new Map(wakeups.map((w) => [w.kind === "tool" ? w.wakeup?.reason : "", w.kind === "tool" ? w.wakeup : undefined]));
    // The rejected newer call is failed and not superseding; the first stays active.
    expect(by.get("second")?.failed).toBe(true);
    expect(by.get("second")?.superseded).toBe(false);
    expect(by.get("first")?.failed).toBe(false);
    expect(by.get("first")?.superseded).toBe(false);
    assertParity(claudeFile, lines);
  });
});
