import { expect, test } from "bun:test";

import {
  appendRuntimeLiveTurnDelta,
  completeRuntimeLiveTurnItem,
  normalizeRuntimeLiveTurn,
  runtimeLiveTurnItems,
} from "./liveTurn";

test("issue 626: bounded overflow preserves every unclaimed response identity across item and text limits", () => {
  let live = null;
  for (let index = 0; index < 40; index += 1) {
    const text = `${String(index).padStart(2, "0")}:${"x".repeat(2_045)}`;
    live = appendRuntimeLiveTurnDelta(live, `turn-${index}`, text, `2026-07-23T09:00:${String(index).padStart(2, "0")}.000Z`);
    live = completeRuntimeLiveTurnItem(live, `turn-${index}`, {
      type: "agentMessage",
      id: `response-${index}`,
      text,
    }, `2026-07-23T09:01:${String(index).padStart(2, "0")}.000Z`);
  }

  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => item.itemId)).toEqual(
    Array.from({ length: 40 }, (_, index) => `response-${index}`),
  );
  expect(live?.items).toHaveLength(32);
  expect(live?.overflow).toHaveLength(8);
  expect(items.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0))
    .toBeLessThanOrEqual(64 * 1024);
  expect(items.reduce((total, item) => total + (item.omittedChars ?? 0), 0)).toBeGreaterThan(0);

  /* Runtime journal snapshots serialize this shape. Re-normalization after a
     refresh retains every response once, in original order. */
  const refreshed = normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)));
  expect(runtimeLiveTurnItems(refreshed).map((item) => item.itemId))
    .toEqual(items.map((item) => item.itemId));
  expect(runtimeLiveTurnItems(refreshed).reduce(
    (total, item) => total + new TextEncoder().encode(item.text).length,
    0,
  ))
    .toBeLessThanOrEqual(64 * 1024);
});

test("issue 626: the text limit counts UTF-8 bytes", () => {
  const text = "ж".repeat(40_000);
  let live = appendRuntimeLiveTurnDelta(null, "turn-unicode", text);
  live = completeRuntimeLiveTurnItem(live, "turn-unicode", {
    type: "agentMessage",
    id: "response-unicode",
    text,
  });

  const [item] = runtimeLiveTurnItems(live);
  expect(new TextEncoder().encode(item?.text ?? "").length).toBeLessThanOrEqual(64 * 1024);
  expect(item?.omittedChars).toBeGreaterThan(0);
});

test("issue 626: completed text remains authoritative and exactly once after refresh replay", () => {
  const completed = (streamed: string, finalText: string, id: string) => {
    let live = appendRuntimeLiveTurnDelta(null, "turn-completion", streamed);
    live = completeRuntimeLiveTurnItem(live, "turn-completion", {
      type: "agentMessage",
      id,
      text: finalText,
    });
    live = completeRuntimeLiveTurnItem(live, "turn-completion", {
      type: "agentMessage",
      id,
      text: finalText,
    });
    return normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)));
  };

  expect(runtimeLiveTurnItems(completed("Hel", "Hello", "prefix"))).toEqual([
    expect.objectContaining({ itemId: "prefix", text: "Hello", phase: "awaiting-echo" }),
  ]);
  expect(runtimeLiveTurnItems(completed("Draft", "Rewritten final", "divergent"))).toEqual([
    expect.objectContaining({ itemId: "divergent", text: "Rewritten final", phase: "awaiting-echo" }),
  ]);
  expect(runtimeLiveTurnItems(completed("Keep streamed", "", "empty"))).toEqual([
    expect.objectContaining({ itemId: "empty", text: "Keep streamed", phase: "awaiting-echo" }),
  ]);
});

test("issue 626: the ultimate descriptor bound keeps a separate unclaimed summary", () => {
  let live = null;
  for (let index = 0; index < 550; index += 1) {
    const text = `response ${index}`;
    live = appendRuntimeLiveTurnDelta(live, `turn-${index}`, text);
    live = completeRuntimeLiveTurnItem(live, `turn-${index}`, {
      type: "agentMessage",
      id: `response-${index}`,
      text,
    });
  }

  const items = runtimeLiveTurnItems(live);
  expect(items).toHaveLength(544);
  expect(items[0]).toMatchObject({
    itemId: null,
    text: "",
    phase: "awaiting-echo",
    omittedItems: 7,
  });
  expect(items.slice(1).map((item) => item.itemId)).toEqual(
    Array.from({ length: 543 }, (_, index) => `response-${index + 7}`),
  );
});

test("issue 626: the ultimate summary counts fully text-trimmed unidentified commentary", () => {
  let live = null;
  for (let index = 0; index < 550; index += 1) {
    live = appendRuntimeLiveTurnDelta(
      live,
      `turn-unidentified-${index}`,
      `${index}:${"x".repeat(2_000)}`,
    );
  }

  const items = runtimeLiveTurnItems(live);
  expect(items).toHaveLength(544);
  expect(items[0]).toMatchObject({
    itemId: null,
    text: "",
    omittedItems: 7,
  });
  expect(items[0]?.omittedChars).toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ *
 * Issue #1100: tool activity projected from the structured host stream *
 * ------------------------------------------------------------------ */

import {
  LIVE_TURN_TOOL_ARGS_LIMIT,
  boundedToolArgs,
  projectRuntimeLiveTurnItem,
} from "./liveTurn";

const at = (second: number) => `2026-08-23T08:30:${String(second).padStart(2, "0")}.000Z`;

function claudeAssistant(uuid: string, content: unknown[]) {
  return { type: "assistant", uuid, session_id: "session-1100", message: { id: "msg_1100", role: "assistant", content } };
}

function claudeUser(uuid: string, content: unknown[]) {
  return { type: "user", uuid, session_id: "session-1100", message: { role: "user", content } };
}

test("issue 1100: a Claude first turn projects prose and tool calls in response order", () => {
  let live = appendRuntimeLiveTurnDelta(null, "turn-1100", "Reading the issue", at(0));
  live = projectRuntimeLiveTurnItem(live, "turn-1100", claudeAssistant("uuid-text-1", [
    { type: "text", text: "Reading the issue first." },
  ]), "completed", at(1));
  live = projectRuntimeLiveTurnItem(live, "turn-1100", claudeAssistant("uuid-tool-1", [
    { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/src/lib/runtime/liveTurn.ts" } },
  ]), "completed", at(2));
  live = projectRuntimeLiveTurnItem(live, "turn-1100", claudeAssistant("uuid-tool-2", [
    { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "bun test src/lib/runtime/liveTurn.test.ts", description: "run focused test" } },
  ]), "completed", at(3));
  /* Both tool_results arrive in one user message; the Read succeeded, Bash failed. */
  live = projectRuntimeLiveTurnItem(live, "turn-1100", claudeUser("uuid-results", [
    { type: "tool_result", tool_use_id: "toolu_read" },
    { type: "tool_result", tool_use_id: "toolu_bash", is_error: true },
  ]), "completed", at(4));
  live = appendRuntimeLiveTurnDelta(live, "turn-1100", "The test fails because", at(5));

  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => item.tool ? `tool:${item.itemId}:${item.tool.status}` : `text:${item.itemId ?? "streaming"}`)).toEqual([
    "text:uuid-text-1",
    "tool:toolu_read:ok",
    "tool:toolu_bash:err",
    "text:streaming",
  ]);
  expect(items[1]).toMatchObject({
    itemId: "toolu_read",
    text: "",
    phase: "awaiting-echo",
    startedAt: at(2),
    completedAt: at(4),
    tool: { name: "Read", engine: "claude", status: "ok", args: { file_path: "/repo/src/lib/runtime/liveTurn.ts" } },
  });
  expect(items[2]?.tool).toMatchObject({ name: "Bash", status: "err", args: { command: "bun test src/lib/runtime/liveTurn.test.ts" } });
  /* Compatibility text stays the latest prose, never a tool row. */
  expect(live?.text).toBe("The test fails because");
  /* The hot window carries the tool rows alongside prose. */
  expect(live?.items).toHaveLength(4);
});

test("issue 1100: a tool call record never demotes a finished row, and a result for an unseen call still shows", () => {
  let live = projectRuntimeLiveTurnItem(null, "turn-replay", claudeAssistant("u1", [
    { type: "tool_use", id: "toolu_a", name: "Grep", input: { pattern: "liveTurn", path: "src" } },
  ]), "completed", at(1));
  live = projectRuntimeLiveTurnItem(live, "turn-replay", claudeUser("u2", [{ type: "tool_result", tool_use_id: "toolu_a" }]), "completed", at(2));
  /* A replayed call record (journal replay after restart) repeats the tool_use. */
  live = projectRuntimeLiveTurnItem(live, "turn-replay", claudeAssistant("u1", [
    { type: "tool_use", id: "toolu_a", name: "Grep", input: { pattern: "liveTurn", path: "src" } },
  ]), "completed", at(1));
  /* A result whose call was bounded away upstream still tells the operator a tool ran. */
  live = projectRuntimeLiveTurnItem(live, "turn-replay", claudeUser("u3", [{ type: "tool_result", tool_use_id: "toolu_unseen", is_error: true }]), "completed", at(3));
  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => [item.itemId, item.tool?.status, item.tool?.name])).toEqual([
    ["toolu_a", "ok", "Grep"],
    ["toolu_unseen", "err", "tool"],
  ]);
  expect(items).toHaveLength(2);
});

test("issue 1100: Codex app-server tool items run on `started` and settle on `completed`", () => {
  let live = projectRuntimeLiveTurnItem(null, "turn-codex", {
    type: "commandExecution", id: "call_ls", command: "ls -la", cwd: "/repo", status: "inProgress",
  }, "started", at(1));
  live = projectRuntimeLiveTurnItem(live, "turn-codex", {
    type: "mcpToolCall", id: "call_mcp", server: "viewer", tool: "list_tasks", arguments: { project: "demo" }, status: "inProgress",
  }, "started", at(2));
  expect(runtimeLiveTurnItems(live).map((item) => [item.itemId, item.tool?.name, item.tool?.status])).toEqual([
    ["call_ls", "shell", "run"],
    ["call_mcp", "mcp__viewer__list_tasks", "run"],
  ]);
  live = projectRuntimeLiveTurnItem(live, "turn-codex", {
    type: "commandExecution", id: "call_ls", command: "ls -la", cwd: "/repo", status: "completed", exitCode: 2, aggregatedOutput: "ls: cannot access",
  }, "completed", at(3));
  live = projectRuntimeLiveTurnItem(live, "turn-codex", {
    type: "mcpToolCall", id: "call_mcp", server: "viewer", tool: "list_tasks", arguments: { project: "demo" }, status: "completed", result: { ok: true },
  }, "completed", at(4));
  /* A completed tool the projection never saw start (snapshot resync) lands as a finished row. */
  live = projectRuntimeLiveTurnItem(live, "turn-codex", {
    type: "fileChange", id: "call_patch", status: "completed", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }],
  }, "completed", at(5));
  /* Non-tool items never become tool rows. */
  live = projectRuntimeLiveTurnItem(live, "turn-codex", { type: "reasoning", id: "item_r", summary: ["thinking"] }, "completed", at(6));
  live = projectRuntimeLiveTurnItem(live, "turn-codex", { type: "agentMessage", id: "item_msg", text: "done" }, "completed", at(7));
  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => item.tool ? [item.itemId, item.tool.status, item.tool.engine] : ["text", item.itemId])).toEqual([
    ["call_ls", "err", "codex"],
    ["call_mcp", "ok", "codex"],
    ["call_patch", "ok", "codex"],
    ["text", "item_msg"],
  ]);
  expect(items[0]).toMatchObject({ completedAt: at(3), tool: { args: { cmd: "ls -la", workdir: "/repo" } } });
  expect(items[2]?.tool?.args).toEqual({ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" });
  /* A `started` assistant message carries no prose yet and projects nothing. */
  expect(projectRuntimeLiveTurnItem(null, "turn-codex", { type: "agentMessage", id: "item_msg", text: "" }, "started", at(8))).toBeNull();
});

test("issue 1100: snapshots round-trip tool rows, legacy snapshots still read as prose", () => {
  const live = projectRuntimeLiveTurnItem(null, "turn-rt", claudeAssistant("u", [
    { type: "text", text: "Running it now." },
    { type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "bun run build" } },
  ]), "completed", at(1));
  const refreshed = normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)));
  expect(runtimeLiveTurnItems(refreshed)).toEqual(runtimeLiveTurnItems(live));
  expect(runtimeLiveTurnItems(refreshed)[1]?.tool).toMatchObject({ name: "Bash", status: "run", args: { command: "bun run build" } });
  /* A pre-#1100 snapshot has no tool field: prose only, unchanged. */
  const legacy = normalizeRuntimeLiveTurn({ turnId: "turn-old", text: "old text", items: [{ itemId: "r1", text: "old text", phase: "awaiting-echo", startedAt: null, completedAt: null }] });
  expect(runtimeLiveTurnItems(legacy)).toEqual([
    { itemId: "r1", text: "old text", phase: "awaiting-echo", startedAt: null, completedAt: null },
  ]);
  /* A tool row without a tool name or status still normalizes to a valid row. */
  const sparse = normalizeRuntimeLiveTurn({ turnId: "turn-sparse", text: "", items: [{ itemId: "call_1", text: "", phase: "awaiting-echo", startedAt: null, completedAt: null, tool: { args: "not-a-record" } }] });
  expect(runtimeLiveTurnItems(sparse)[0]?.tool).toEqual({ name: "tool", engine: "claude", status: "run", args: { input: "not-a-record" } });
});

test("issue 1100: tool rows share the bounded window and its omission accounting", () => {
  let live = null;
  for (let index = 0; index < 600; index += 1) {
    live = projectRuntimeLiveTurnItem(live, "turn-many", claudeAssistant(`u-${index}`, [
      { type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `/repo/${"deep/".repeat(30)}file-${index}.ts` } },
    ]), "completed", at(index % 60));
  }
  const items = runtimeLiveTurnItems(live);
  expect(items).toHaveLength(544);
  expect(items[0]).toMatchObject({ itemId: null, text: "", omittedItems: 57 });
  expect(items[0]?.omittedChars ?? 0).toBe(0);
  expect(items.slice(1).map((item) => item.itemId)).toEqual(
    Array.from({ length: 543 }, (_, index) => `toolu_${index + 57}`),
  );
  expect(live?.items).toHaveLength(32);
  expect(live?.overflow).toHaveLength(512);
  /* Arguments are bounded across the window newest-first: the rows the operator
     is watching keep their detail, older rows keep name and status only. */
  const withArgs = items.filter((item) => item.tool && !item.tool.argsOmitted);
  const stripped = items.filter((item) => item.tool?.argsOmitted);
  expect(stripped.length).toBeGreaterThan(0);
  expect(withArgs.at(-1)?.itemId).toBe("toolu_599");
  expect(items.findIndex((item) => item.tool && !item.tool.argsOmitted)).toBeGreaterThan(items.findLastIndex((item) => item.tool?.argsOmitted));
  const bytes = withArgs.reduce((total, item) => total + new TextEncoder().encode(JSON.stringify(item.tool!.args)).length, 0);
  expect(bytes).toBeLessThanOrEqual(LIVE_TURN_TOOL_ARGS_LIMIT);
  for (const item of stripped) expect(item.tool).toMatchObject({ name: "Read", status: "run", args: {} });
});

test("issue 1100: bounded tool arguments clip strings, fold nested values and cap the projection", () => {
  const args = boundedToolArgs({
    command: "x".repeat(5_000),
    description: "short",
    count: 3,
    flag: true,
    nothing: null,
    nested: { deep: { deeper: "y".repeat(1_000) } },
    list: ["a", "b"],
    skipped: undefined,
  });
  expect(Object.keys(args)).toEqual(["command", "description", "count", "flag", "nothing", "nested", "list"]);
  expect([...(args.command as string)].length).toBe(256);
  expect(args.description).toBe("short");
  expect(typeof args.nested).toBe("string");
  expect([...(args.nested as string)].length).toBeLessThanOrEqual(256);
  expect(args.list).toBe("[\"a\",\"b\"]");
  expect(new TextEncoder().encode(JSON.stringify(args)).length).toBeLessThanOrEqual(2 * 1024);
  /* Non-record input becomes a single bounded `input` key; empty is empty. */
  expect(boundedToolArgs("raw")).toEqual({ input: "raw" });
  expect(boundedToolArgs(undefined)).toEqual({});
  /* Many large keys: trailing keys drop until the per-row cap holds. */
  const wide = boundedToolArgs(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, "z".repeat(256)])));
  expect(Object.keys(wide).length).toBeLessThan(12);
  expect(new TextEncoder().encode(JSON.stringify(wide)).length).toBeLessThanOrEqual(2 * 1024);
});

test("issue 1100: a tool row never absorbs streamed prose, and a later delta starts a new prose row after it", () => {
  let live = appendRuntimeLiveTurnDelta(null, "turn-order", "First ", at(0));
  live = projectRuntimeLiveTurnItem(live, "turn-order", claudeAssistant("u-text", [{ type: "text", text: "First thought." }]), "completed", at(1));
  live = projectRuntimeLiveTurnItem(live, "turn-order", claudeAssistant("u-tool", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }]), "completed", at(2));
  live = appendRuntimeLiveTurnDelta(live, "turn-order", "Second", at(3));
  live = appendRuntimeLiveTurnDelta(live, "turn-order", " thought.", at(4));
  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => item.tool ? "tool" : `${item.phase}:${item.text}`)).toEqual([
    "awaiting-echo:First thought.",
    "tool",
    "streaming:Second thought.",
  ]);
  /* A new turn flips streaming prose to awaiting-echo and leaves tool rows alone. */
  live = appendRuntimeLiveTurnDelta(live, "turn-next", "Next turn", at(5));
  expect(runtimeLiveTurnItems(live).map((item) => item.tool ? item.tool.status : item.phase)).toEqual([
    "awaiting-echo", "run", "awaiting-echo", "streaming",
  ]);
});
