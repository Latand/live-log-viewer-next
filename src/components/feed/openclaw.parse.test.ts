import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed, createFeedSession, type Item } from "./parse";

/*
 * The OpenClaw feed renderer (#1207). OpenClaw needs a third renderer rather
 * than a translation into Claude's shape: it stores a tool result as a
 * top-level record carrying its own `toolResult` role, where Claude nests one
 * as a `tool_result` block inside a "user" record. Translating would synthesize
 * user records the operator never sent.
 *
 * Every id, model, provider, tool name and message body below is invented. No
 * OpenClaw record was copied.
 */

const openclawFile = {
  path: "/openclaw/agents/primary/sessions/oc-session-alpha.jsonl",
  engine: "openclaw",
  fmt: "openclaw",
  activity: "recent",
} as FileEntry;

const AT = "2026-08-27T09:00:00.000Z";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function message(id: string, message: Record<string, unknown>): string {
  return line({ type: "message", id, parentId: "oc-parent", timestamp: AT, message });
}

function assistant(id: string, content: unknown[], overrides: Record<string, unknown> = {}): string {
  return message(id, {
    role: "assistant",
    provider: "demo-provider",
    model: "demo-model",
    api: "demo-api",
    stopReason: "stop",
    content,
    ...overrides,
  });
}

/* `srcCall`/`srcResult` are absolute stream indices, so a windowed parse and a
   start-0 one-shot number them differently for the same logical line. Both are
   opaque provenance tokens; normalize them out before structural comparison. */
function normalize(items: Item[]): unknown {
  return JSON.parse(JSON.stringify(items, (key, value) => (key === "srcCall" || key === "srcResult" ? 0 : value)));
}

function render(lines: string[], showSvc = false): Item[] {
  return buildFeed(openclawFile, lines, showSvc, "").items;
}

test("every OpenClaw record shape maps onto its feed primitive", () => {
  const items = render([
    line({ type: "session", version: 3, id: "oc-header", timestamp: AT, cwd: "/openclaw/workspace" }),
    message("oc-user-1", { role: "user", content: "Plant the cobalt orchard", timestamp: AT }),
    message("oc-user-2", { role: "user", content: [{ type: "text", text: "and water it" }], timestamp: AT }),
    assistant("oc-assistant-1", [
      { type: "thinking", thinking: "weighing   the   options", thinkingSignature: "invented-signature" },
      { type: "text", text: "Planting now.", textSignature: "invented-signature" },
      { type: "toolCall", id: "oc-call-1", name: "Bash", arguments: { command: "plant --orchard cobalt" } },
    ], { stopReason: "toolUse" }),
    message("oc-result-1", {
      role: "toolResult",
      toolCallId: "oc-call-1",
      toolName: "Bash",
      isError: false,
      content: [{ type: "toolResult", toolCallId: "oc-call-1", tool_use_id: "oc-call-1", content: "planted 3 rows" }],
    }),
  ]);

  expect(items.map((item) => item.kind)).toEqual(["user", "user", "think", "prose", "tool"]);
  expect(items[0]).toMatchObject({ kind: "user", text: "Plant the cobalt orchard" });
  expect(items[1]).toMatchObject({ kind: "user", text: "and water it" });
  expect(items[2]).toMatchObject({ kind: "think", text: "weighing the options" });
  /* Prose carries the OpenClaw identity, which is what picks the feed avatar. */
  expect(items[3]).toMatchObject({ kind: "prose", text: "Planting now.", engine: "openclaw", sourceId: "oc-assistant-1" });
  expect(items[4]).toMatchObject({
    kind: "tool",
    id: "oc-call-1",
    tool: "Bash",
    family: "shell",
    command: "plant --orchard cobalt",
    status: "ok",
    outputPreview: expect.stringContaining("planted 3 rows"),
  });
});

test("a tool result attaches by the call id the record itself carries", () => {
  const items = render([
    assistant("oc-assistant-1", [
      { type: "toolCall", id: "oc-call-1", name: "Read", arguments: { file_path: "/invented/notes.md" } },
    ], { stopReason: "toolUse" }),
    message("oc-result-1", {
      role: "toolResult",
      toolCallId: "oc-call-1",
      toolName: "Read",
      isError: true,
      content: [{ type: "text", text: "no such file" }],
    }),
  ]);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool", id: "oc-call-1", tool: "Read", status: "err" });
});

test("a tool result whose call is absent does not invent a user bubble", () => {
  const items = render([
    message("oc-result-orphan", {
      role: "toolResult",
      toolCallId: "oc-call-missing",
      toolName: "Read",
      isError: false,
      content: [{ type: "text", text: "orphaned output" }],
    }),
  ]);

  expect(items.some((item) => item.kind === "user")).toBe(false);
});

test("a provider or model switch emits exactly one service row", () => {
  const items = render([
    assistant("oc-assistant-1", [{ type: "text", text: "first" }]),
    assistant("oc-assistant-2", [{ type: "text", text: "second" }]),
    assistant("oc-assistant-3", [{ type: "text", text: "third" }], { model: "demo-model-2" }),
  ], true);

  const svc = items.filter((item) => item.kind === "svc");
  expect(svc).toEqual([{ kind: "svc", text: "demo-provider · demo-model-2" }]);
});

/* The synthetic records OpenClaw writes for itself carry model labels no
   provider ever ran; they must not announce a model switch. */
test("a synthetic-provider record never announces a model switch", () => {
  const items = render([
    assistant("oc-assistant-1", [{ type: "text", text: "first" }]),
    assistant("oc-assistant-2", [{ type: "text", text: "mirrored" }], { provider: "openclaw", model: "delivery-mirror" }),
    assistant("oc-assistant-3", [{ type: "text", text: "third" }]),
  ], true);

  expect(items.filter((item) => item.kind === "svc")).toEqual([]);
  /* The mirrored record still renders — it is real content OpenClaw injected. */
  expect(items.filter((item) => item.kind === "prose").map((item) => (item as { text: string }).text))
    .toEqual(["first", "mirrored", "third"]);
});

test("model and thinking level changes render as service rows", () => {
  const items = render([
    line({ type: "model_change", id: "oc-change-1", parentId: "oc-parent", timestamp: AT, provider: "demo-provider", modelId: "demo-model-2" }),
    line({ type: "thinking_level_change", id: "oc-change-2", parentId: "oc-parent", timestamp: AT, thinkingLevel: "high" }),
    line({ type: "custom", id: "oc-change-3", parentId: "oc-parent", timestamp: AT, customType: "demo:snapshot", data: {} }),
  ], true);

  expect(items).toEqual([
    { kind: "svc", text: "demo-provider · demo-model-2" },
    { kind: "svc", text: "thinking · high" },
    { kind: "svc", text: "demo:snapshot" },
  ]);
});

test("an OpenClaw transcript never falls back to raw plain-text rows", () => {
  const items = render([
    line({ type: "session", version: 3, id: "oc-header", timestamp: AT, cwd: "/openclaw/workspace" }),
    message("oc-user-1", { role: "user", content: "Plant the cobalt orchard", timestamp: AT }),
  ], true);

  expect(items.some((item) => item.kind === "raw")).toBe(false);
});

/* The feed is an incremental window parser: a sliding window must render the
   same rows a fresh parse of that window would. The model-switch service row is
   the only cross-record state the OpenClaw arm holds, so its baseline has to
   clear when the line that set it slides out. */
test("a sliding window renders the same rows as a fresh parse of that window", () => {
  const lines = [
    line({ type: "session", version: 3, id: "oc-header", timestamp: AT, cwd: "/openclaw/workspace" }),
    message("oc-user-1", { role: "user", content: "Plant the cobalt orchard", timestamp: AT }),
    assistant("oc-assistant-1", [{ type: "text", text: "first" }]),
    assistant("oc-assistant-2", [{ type: "text", text: "second" }], { model: "demo-model-2" }),
    assistant("oc-assistant-3", [
      { type: "toolCall", id: "oc-call-1", name: "Bash", arguments: { command: "plant --orchard cobalt" } },
    ], { stopReason: "toolUse", model: "demo-model-2" }),
    message("oc-result-1", {
      role: "toolResult",
      toolCallId: "oc-call-1",
      toolName: "Bash",
      isError: false,
      content: [{ type: "text", text: "planted 3 rows" }],
    }),
    assistant("oc-assistant-4", [{ type: "text", text: "done" }], { model: "demo-model-3" }),
  ];

  const session = createFeedSession({ engine: "openclaw", fmt: "openclaw", showSvc: true, lineFilter: "" });
  const cap = 4;
  let window: string[] = [];
  let start = 0;
  for (const next of lines) {
    window = window.concat(next);
    if (window.length > cap) {
      start += window.length - cap;
      window = window.slice(-cap);
    }
    const incremental = session.feed(window, start, false);
    const oneShot = buildFeed(openclawFile, window, true, "");
    expect(normalize(incremental.items.map((row) => row.item))).toEqual(normalize(oneShot.items));
    expect(incremental.hiddenServiceCount).toBe(oneShot.hiddenServiceCount);
  }
});
