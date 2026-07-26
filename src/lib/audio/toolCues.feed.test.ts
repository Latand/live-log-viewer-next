import { expect, test } from "bun:test";

import { createFeedSession } from "@/components/feed/parse";

import { createToolCueScanner } from "./toolCues";

/**
 * The scanner against the real parser: a short call whose call AND output land
 * in one tail tick — the parse only ever observes it settled — must still tick
 * exactly once, for every record shape an engine writes tool calls in.
 */

const userLine = JSON.stringify({
  type: "user",
  timestamp: "2026-07-10T09:59:00Z",
  message: { content: "run the checks" },
});

const claudeToolUse = (id: string, command: string) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:00Z", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const claudeToolResult = (id: string, text: string) =>
  JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

const codexLine = (payload: Record<string, unknown>) =>
  JSON.stringify({ type: "response_item", timestamp: "2026-07-10T10:00:00Z", payload });

function feedThenAppend(engine: "claude" | "codex", baseline: string[], appended: string[]) {
  const session = createFeedSession({ engine, fmt: engine, showSvc: false, lineFilter: "" });
  const scanner = createToolCueScanner("conv-1");
  const first = scanner.scan(session.feed(baseline, 0, true).items, baseline.length);
  const all = [...baseline, ...appended];
  const second = scanner.scan(session.feed(all, 0, true).items, all.length);
  return { session, scanner, all, first, second };
}

test("claude: a tool_use whose tool_result arrived in the same update ticks once", () => {
  const { session, scanner, all, first, second } = feedThenAppend(
    "claude",
    [userLine],
    [claudeToolUse("b1", "git status --short"), claudeToolResult("b1", " M src/index.ts")],
  );
  expect(first).toEqual([]);
  expect(second).toEqual([{ cue: "tool-tick", eventId: "tool:conv-1:b1", pan: 0 }]);
  /* The next tick re-parses the same window: nothing new, nothing rings. */
  expect(scanner.scan(session.feed(all, 0, true).items, all.length)).toEqual([]);
});

test("codex: a function_call settled by its function_call_output in the same update ticks once", () => {
  const { first, second } = feedThenAppend(
    "codex",
    [codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "build it" }] })],
    [
      codexLine({ type: "function_call", call_id: "call-fast", name: "exec_command", arguments: JSON.stringify({ cmd: "make", workdir: "/workspace/build" }) }),
      codexLine({ type: "function_call_output", call_id: "call-fast", output: "Process exited with code 0\nOutput:\nok" }),
    ],
  );
  expect(first).toEqual([]);
  expect(second).toEqual([{ cue: "tool-tick", eventId: "tool:conv-1:call-fast", pan: 0 }]);
});

test("codex: a custom_tool_call settled in the same update ticks once", () => {
  const { first, second } = feedThenAppend(
    "codex",
    [codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "open it" }] })],
    [
      codexLine({ type: "custom_tool_call", call_id: "call-custom", name: "browser.open", input: "https://example.invalid" }),
      codexLine({ type: "custom_tool_call_output", call_id: "call-custom", output: "opened" }),
    ],
  );
  expect(first).toEqual([]);
  expect(second).toEqual([{ cue: "tool-tick", eventId: "tool:conv-1:call-custom", pan: 0 }]);
});

test("paging older history in resets the parser but never replays a sound", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  const scanner = createToolCueScanner("conv-1");
  /* The pane opens on a window that starts at absolute line 2 — two older
     lines exist on disk but are not loaded. */
  const window = [userLine, claudeToolUse("b7", "bun test"), claudeToolResult("b7", "5 pass")];
  expect(scanner.scan(session.feed(window, 2, true).items, 5)).toEqual([]);
  /* A fast call lands (call + output in one tick) and rings. */
  const grown = [...window, claudeToolUse("b8", "bun run build"), claudeToolResult("b8", "done")];
  expect(scanner.scan(session.feed(grown, 2, true).items, 7)).toEqual([
    { cue: "tool-tick", eventId: "tool:conv-1:b8", pan: 0 },
  ]);
  /* «Show earlier»: the window now starts at 0, which resets the session and
     re-parses everything — fresh item objects, same transcript. The revealed
     old call and the already-heard calls all stay silent. */
  const paged = [claudeToolUse("b0", "ls"), claudeToolResult("b0", "README.md"), ...grown];
  expect(scanner.scan(session.feed(paged, 0, true).items, 7)).toEqual([]);
});
