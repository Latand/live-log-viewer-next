import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";

import { GET } from "./route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-conversations-route-"));

afterEach(() => replaceConversationCatalog([]));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("search lazily covers the first prompt of a cataloged Claude subagent", async () => {
  const transcript = path.join(sandbox, "agent-child.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Investigate cobalt orchard" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "agent-child.jsonl",
    project: "quiet-project",
    title: "Child agent",
    firstPrompt: "",
    engine: "claude",
    kind: "subagent",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=cobalt%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([transcript]);
});

test("search lazily covers a Codex prompt behind an early generated title", async () => {
  const transcript = path.join(sandbox, "codex-titled.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "ai-title", aiTitle: "Readable catalog title" }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Investigate amber orchard" } }),
  ].join("\n") + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "codex-sessions",
    name: "codex-titled.jsonl",
    project: "quiet-project",
    title: "Readable catalog title",
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=amber%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([transcript]);
});
