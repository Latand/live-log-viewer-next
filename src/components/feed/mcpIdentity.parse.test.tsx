import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { FeedItem } from "./FeedItem";
import { buildFeed, createFeedSession, type Item } from "./parse";

/* Issue #650: a Claude assistant record carries the MCP tool that produced the
   turn's context in `attributionMcpServer`/`attributionMcpTool`. That stamp
   sits on the whole record, so every sibling tool_use inherits it — a Bash
   command made after a viewer MCP call used to render as "MCP · viewer ·
   Updating pipeline". A card's identity comes from its own tool_use name, and
   from nothing else. */

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;

const attributed = (block: Record<string, unknown>, ts: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    attributionMcpServer: "viewer",
    attributionMcpTool: "pipeline_action",
    message: { content: [block] },
  });

const toolResult = (id: string, text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
  });

/* A conversation shaped like the production repro: a real viewer MCP call, then
   ordinary tool calls that follow it inside attributed records. */
const conversation = [
  JSON.stringify({ type: "user", timestamp: "2026-07-24T10:50:00Z", message: { content: "advance the pipeline" } }),
  attributed({
    type: "tool_use",
    id: "call-viewer",
    name: "mcp__viewer__pipeline_action",
    input: { pipelineId: "pipe-1", action: "update" },
  }, "2026-07-24T10:50:10Z"),
  toolResult("call-viewer", "{\"ok\":true}", "2026-07-24T10:50:11Z"),
  attributed({
    type: "tool_use",
    id: "call-bash",
    name: "Bash",
    input: { command: "bun test src/components/feed/parse.test.ts", description: "Run the feed parser tests", timeout: 600000 },
  }, "2026-07-24T10:51:44Z"),
  toolResult("call-bash", "12 pass", "2026-07-24T10:51:50Z"),
  attributed({
    type: "tool_use",
    id: "call-browse",
    name: "mcp__agent-browser__navigate",
    input: { url: "https://example.invalid/board" },
  }, "2026-07-24T10:52:20Z"),
  attributed({
    type: "tool_use",
    id: "call-read",
    name: "Read",
    input: { file_path: "src/components/feed/parse.ts" },
  }, "2026-07-24T10:52:52Z"),
];

function toolItems(items: Item[]) {
  const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const item of items) {
    if (item.kind === "tool") byId.set(item.id, item);
    if (item.kind === "cmd-group") for (const call of item.calls) byId.set(call.id, call);
  }
  return byId;
}

test("a Bash call after a viewer MCP call keeps its own shell identity", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const bash = calls.get("call-bash");
  expect(bash).toBeDefined();
  expect(bash!.tool).toBe("Bash");
  expect(bash!.family).toBe("shell");
  expect(bash!.summary).toBe("bun test src/components/feed/parse.test.ts");
  expect(bash!.mcp).toBeUndefined();

  const read = calls.get("call-read");
  expect(read!.tool).toBe("Read");
  expect(read!.mcp).toBeUndefined();

  // The genuine viewer call still gets its MCP identity, from its own name.
  const viewer = calls.get("call-viewer");
  expect(viewer!.mcp).toMatchObject({ serverName: "viewer", toolName: "pipeline_action" });
});

test("a non-viewer MCP call is never relabelled with the record's viewer attribution", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const browse = calls.get("call-browse");
  expect(browse).toBeDefined();
  expect(browse!.tool).toBe("mcp__agent-browser__navigate");
  expect(browse!.mcp).toBeUndefined();
});

test("the incremental session classifies the same way as a one-shot parse", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  let fed = 0;
  let snapshot: Item[] = [];
  while (fed < conversation.length) {
    fed += 2;
    snapshot = session.feed(conversation.slice(0, fed), 0, true).items.map((entry) => entry.item);
  }
  const calls = toolItems(snapshot);
  expect(calls.get("call-bash")!.mcp).toBeUndefined();
  expect(calls.get("call-browse")!.mcp).toBeUndefined();
  expect(calls.get("call-viewer")!.mcp).toMatchObject({ serverName: "viewer", toolName: "pipeline_action" });
});

test("the feed renders the Bash call as a shell card and the viewer call as an MCP card", () => {
  const calls = toolItems(buildFeed(claudeFile, conversation, false, "").items);

  const bashHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-bash")!} />);
  expect(bashHtml).not.toContain("mcp-call-card");
  expect(bashHtml).not.toContain("Updating pipeline");
  expect(bashHtml).toContain("bun test src/components/feed/parse.test.ts");

  const browseHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-browse")!} />);
  expect(browseHtml).not.toContain("mcp-call-card");
  expect(browseHtml).not.toContain("Updating pipeline");

  const viewerHtml = renderToStaticMarkup(<FeedItem item={calls.get("call-viewer")!} />);
  expect(viewerHtml).toContain("mcp-call-card");
  expect(viewerHtml).toContain("Updating pipeline");
});
