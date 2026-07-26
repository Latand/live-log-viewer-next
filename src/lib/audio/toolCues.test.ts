import { describe, expect, test } from "bun:test";

import type { FeedEntry, ToolEvent } from "@/components/feed/parse";

import { toolActivityCues } from "./toolCues";

function tool(over: Partial<ToolEvent> & { id: string }): ToolEvent {
  return {
    kind: "tool",
    ts: null,
    srcCall: 0,
    family: "other",
    icon: "note",
    tool: "Bash",
    summary: "ls",
    chips: [],
    status: "run",
    statusLabel: "running",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  } as ToolEvent;
}

const row = (item: FeedEntry["item"]): FeedEntry => ({ anchorKey: null, key: "k", item });

describe("only work that is happening now ticks", () => {
  test("an in-flight call ticks; a finished one is history and stays silent", () => {
    const items = [
      row(tool({ id: "call-done", status: "ok" })),
      row(tool({ id: "call-failed", status: "err" })),
      row(tool({ id: "call-live", status: "run" })),
    ];

    expect(toolActivityCues(items, "conv-1")).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:call-live", pan: 0 },
    ]);
  });

  test("opening a long transcript of settled calls makes no sound at all", () => {
    const history = Array.from({ length: 200 }, (_, index) => row(tool({ id: `old-${index}`, status: "ok" })));
    expect(toolActivityCues(history, "conv-1")).toEqual([]);
  });
});

describe("Viewer MCP calls get their own cue", () => {
  test("an in-flight Viewer MCP call is not ordinary tool texture", () => {
    const mcp = tool({
      id: "call-mcp",
      tool: "mcp__viewer__send_message",
      mcp: { serverName: "viewer", toolName: "send_message", args: {}, result: null },
    });

    expect(toolActivityCues([row(mcp)], "conv-1")).toEqual([
      { cue: "viewer-mcp", eventId: "tool:conv-1:call-mcp", pan: 0 },
    ]);
  });
});

describe("identities", () => {
  test("the same call in a re-parsed feed keeps its identity", () => {
    const first = toolActivityCues([row(tool({ id: "call-7" }))], "conv-1");
    const reparsed = toolActivityCues([row(tool({ id: "call-7" })), row(tool({ id: "call-8" }))], "conv-1");

    expect(reparsed[0].eventId).toBe(first[0].eventId);
    expect(reparsed[1].eventId).not.toBe(first[0].eventId);
  });

  test("two conversations never share an identity, however the engine numbers them", () => {
    /* Codex synthesizes ids for records that carry none, and those repeat across
       conversations — without the namespace one pane would silence another. */
    const left = toolActivityCues([row(tool({ id: "plain-3-1700" }))], "conv-a");
    const right = toolActivityCues([row(tool({ id: "plain-3-1700" }))], "conv-b");

    expect(left[0].eventId).not.toBe(right[0].eventId);
  });

  test("the pan follows the pane the call belongs to", () => {
    expect(toolActivityCues([row(tool({ id: "c" }))], "conv-1", -0.8)[0].pan).toBe(-0.8);
  });
});

describe("folded command groups", () => {
  test("a live call inside a collapsed run still ticks", () => {
    const group = {
      kind: "cmd-group" as const,
      ids: ["a", "b"],
      calls: [tool({ id: "a", status: "ok" }), tool({ id: "b", status: "run" })],
      t0: null,
    } as FeedEntry["item"];

    expect(toolActivityCues([row(group)], "conv-1")).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:b", pan: 0 },
    ]);
  });

  test("rows that are not tool activity are ignored", () => {
    const items = [
      row({ kind: "user", ts: null, text: "hello" }),
      row({ kind: "think", text: "…" }),
      row({ kind: "note", text: "note" }),
    ];
    expect(toolActivityCues(items, "conv-1")).toEqual([]);
  });
});
