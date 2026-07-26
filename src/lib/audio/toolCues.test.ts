import { describe, expect, test } from "bun:test";

import type { FeedEntry, ToolEvent } from "@/components/feed/parse";

import { createToolCueScanner, toolActivityCues } from "./toolCues";

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

describe("a newly appended call ticks even when it arrives already settled", () => {
  test("call and output landing in one update still produce exactly one tick", () => {
    const scanner = createToolCueScanner("conv-1");
    /* Baseline: the conversation is open, ten lines of non-tool content, no
       tool has run yet. */
    expect(scanner.scan([], 10)).toEqual([]);
    /* One tail tick delivers the call AND its output — the parse only ever
       sees the settled event. It must still tick, once. */
    const appended = [row(tool({ id: "fast-1", status: "ok", srcCall: 10 }))];
    expect(scanner.scan(appended, 12)).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:fast-1", pan: 0 },
    ]);
    /* The same window re-parsed is a duplicate observation, not a new call. */
    expect(scanner.scan(appended, 12)).toEqual([]);
  });

  test("a fast call that failed ticks the same generic cue — status does not gate newness", () => {
    const scanner = createToolCueScanner("conv-1");
    expect(scanner.scan([], 10)).toEqual([]);
    const appended = [row(tool({ id: "boom", status: "err", srcCall: 10 }))];
    expect(scanner.scan(appended, 12)).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:boom", pan: 0 },
    ]);
  });

  test("a fast Viewer MCP call keeps its distinct cue", () => {
    const scanner = createToolCueScanner("conv-1");
    expect(scanner.scan([], 10)).toEqual([]);
    const mcp = tool({
      id: "call-mcp",
      status: "ok",
      srcCall: 10,
      tool: "mcp__viewer__send_message",
      mcp: { serverName: "viewer", toolName: "send_message", args: {}, result: null },
    });
    expect(scanner.scan([row(mcp)], 12)).toEqual([
      { cue: "viewer-mcp", eventId: "tool:conv-1:call-mcp", pan: 0 },
    ]);
  });

  test("a fast call folded into a command group still ticks", () => {
    const scanner = createToolCueScanner("conv-1");
    expect(scanner.scan([], 10)).toEqual([]);
    const group = {
      kind: "cmd-group" as const,
      ids: ["fast-a"],
      calls: [tool({ id: "fast-a", status: "ok", srcCall: 11 })],
      t0: null,
    } as FeedEntry["item"];
    expect(scanner.scan([row(group)], 13)).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:fast-a", pan: 0 },
    ]);
  });
});

describe("history is silent, wherever it comes from", () => {
  test("the baseline scan of a long settled transcript makes no sound at all", () => {
    const scanner = createToolCueScanner("conv-1");
    const history = Array.from({ length: 200 }, (_, index) =>
      row(tool({ id: `old-${index}`, status: "ok", srcCall: index })),
    );
    expect(scanner.scan(history, 200)).toEqual([]);
  });

  test("paging older settled history in (prepend) stays silent", () => {
    const scanner = createToolCueScanner("conv-1");
    /* Window starts at absolute line 100. */
    const current = [row(tool({ id: "seen", status: "ok", srcCall: 120 }))];
    expect(scanner.scan(current, 150)).toEqual([]);
    /* «Show earlier» reveals lines 0…99: old calls below the heard window. */
    const paged = [
      row(tool({ id: "ancient-1", status: "ok", srcCall: 5 })),
      row(tool({ id: "ancient-2", status: "err", srcCall: 40 })),
      ...current,
    ];
    expect(scanner.scan(paged, 150)).toEqual([]);
  });

  test("after a truncation restart the floor follows the window back down", () => {
    const scanner = createToolCueScanner("conv-1");
    expect(scanner.scan([row(tool({ id: "before", status: "ok", srcCall: 400 }))], 500)).toEqual([]);
    /* The transcript was truncated: absolute indices restart at zero. The
       re-fed window is history and stays silent… */
    expect(scanner.scan([row(tool({ id: "before", status: "ok", srcCall: 4 }))], 10)).toEqual([]);
    /* …but the pane is not deaf afterwards: the next appended call ticks. */
    expect(scanner.scan([
      row(tool({ id: "before", status: "ok", srcCall: 4 })),
      row(tool({ id: "after", status: "ok", srcCall: 10 })),
    ], 12)).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:after", pan: 0 },
    ]);
  });

  test("a call still running at baseline is happening now and ticks", () => {
    const scanner = createToolCueScanner("conv-1");
    const opened = [
      row(tool({ id: "done", status: "ok", srcCall: 10 })),
      row(tool({ id: "live", status: "run", srcCall: 90 })),
    ];
    expect(scanner.scan(opened, 100)).toEqual([
      { cue: "tool-tick", eventId: "tool:conv-1:live", pan: 0 },
    ]);
  });
});

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
