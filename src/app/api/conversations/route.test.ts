import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { writeSessionTitle } from "@/lib/session/titleStore";

import { GET } from "./route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-conversations-route-"));
const previousStateDir = process.env.LLV_STATE_DIR;
let registry: AgentRegistry;

beforeEach(() => {
  process.env.LLV_STATE_DIR = sandbox;
  registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(registry);
});
afterEach(() => {
  replaceConversationCatalog([]);
  setAgentRegistryForTests(null);
  fs.rmSync(path.join(sandbox, "session-titles.json"), { force: true });
  fs.rmSync(path.join(sandbox, "registry.json"), { force: true });
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

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

test("search finds a capped-out conversation by its custom title", async () => {
  const transcript = path.join(sandbox, "custom-title.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Raw scanner title" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "custom-title.jsonl",
    project: "quiet-project",
    title: "Raw scanner title",
    firstPrompt: "Raw scanner title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  const key = `path:${transcript}`;
  writeSessionTitle([key], key, "Renamed amber orchard", undefined, "2026-07-13T00:00:00.000Z");

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=renamed%20amber"));
  const body = await response.json() as { items: Array<{ path: string; title: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({ path: transcript, title: "Renamed amber orchard" })]);
});

test("search finds a capped-out conversation by its registry launch title", async () => {
  const transcript = path.join(sandbox, "launch-title.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Raw scanner title" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "launch-title.jsonl",
    project: "quiet-project",
    title: "Raw scanner title",
    firstPrompt: "Raw scanner title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, title: "Launch amber orchard", project: "launch-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=launch%20amber"));
  const body = await response.json() as { items: Array<{ path: string; title: string; project: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({
    path: transcript,
    title: "Launch amber orchard",
    project: "launch-project",
  })]);
});

test("an empty-query project list uses the registry launch project", async () => {
  const transcript = path.join(sandbox, "launch-project.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Launch project prompt" } }) + "\n");
  const stat = fs.statSync(transcript);
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "launch-project.jsonl",
    project: "scanner-project",
    title: "Scanner title",
    firstPrompt: "",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
  }]);
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, title: "Launch title", project: "launch-project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?project=launch-project"));
  const body = await response.json() as { items: Array<{ path: string; title: string; project: string }> };

  expect(response.status).toBe(200);
  expect(body.items).toEqual([expect.objectContaining({
    path: transcript,
    title: "Launch title",
    project: "launch-project",
  })]);
});

test("a primitive JSON line in one transcript does not break global search", async () => {
  const malformed = path.join(sandbox, "primitive.jsonl");
  const target = path.join(sandbox, "search-target.jsonl");
  fs.writeFileSync(malformed, "null\n42\n");
  fs.writeFileSync(target, JSON.stringify({ type: "user", message: { content: "Find violet orchard" } }) + "\n");
  const malformedStat = fs.statSync(malformed);
  const targetStat = fs.statSync(target);
  replaceConversationCatalog([
    {
      path: malformed,
      root: "claude-projects",
      name: "primitive.jsonl",
      project: "quiet-project",
      title: "Primitive transcript",
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: malformedStat.mtimeMs / 1000,
      size: malformedStat.size,
    },
    {
      path: target,
      root: "claude-projects",
      name: "search-target.jsonl",
      project: "quiet-project",
      title: "Search target",
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: targetStat.mtimeMs / 1000,
      size: targetStat.size,
    },
  ]);

  const response = await GET(new Request("http://127.0.0.1/api/conversations?q=violet%20orchard"));
  const body = await response.json() as { items: Array<{ path: string }> };

  expect(response.status).toBe(200);
  expect(body.items.map((item) => item.path)).toEqual([target]);
});
