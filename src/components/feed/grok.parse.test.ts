import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed } from "./parse";

const grokFile = {
  path: "/grok/sessions/project/session-alpha/chat_history.jsonl",
  engine: "grok",
  fmt: "grok",
  activity: "recent",
} as FileEntry;

const line = (record: Record<string, unknown>) => JSON.stringify(record);

test("Grok Build chat history renders messages and joins tool output", () => {
  const items = buildFeed(grokFile, [
    line({ type: "system", content: "ignored" }),
    line({ type: "user", content: "Inspect the cobalt orchard" }),
    line({ type: "reasoning", content: "checking   the   plan" }),
    line({ type: "assistant", content: "I will inspect it.", model_id: "grok-demo", tool_calls: [
      { id: "grok-call-1", name: "Bash", arguments: JSON.stringify({ command: "ls orchard" }) },
    ] }),
    line({ type: "tool_result", tool_call_id: "grok-call-1", content: "three files", is_error: false }),
  ], false, "").items;

  expect(items.map((item) => item.kind)).toEqual(["user", "think", "prose", "tool"]);
  expect(items[0]).toMatchObject({ kind: "user", text: "Inspect the cobalt orchard" });
  expect(items[1]).toMatchObject({ kind: "think", text: "checking the plan" });
  expect(items[2]).toMatchObject({ kind: "prose", text: "I will inspect it.", engine: "grok" });
  expect(items[3]).toMatchObject({ kind: "tool", id: "grok-call-1", status: "ok", outputPreview: expect.stringContaining("three files") });
});
