import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { overlayResourceSessionTitles, overlaySessionTitles } from "./titleProjection";
import { writeSessionTitle } from "./titleStore";

const UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_PATH = `/home/u/.claude/projects/proj/${UUID}.jsonl`;

let stateDir = "";
let registryRoot = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-title-proj-"));
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-title-proj-reg-"));
  process.env.LLV_STATE_DIR = stateDir;
  setAgentRegistryForTests(new AgentRegistry(path.join(registryRoot, "registry.json")));
});

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  setAgentRegistryForTests(null);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(registryRoot, { recursive: true, force: true });
});

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: SESSION_PATH,
    root: "claude-projects",
    name: "x",
    project: "proj",
    title: "Auto derived",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 0,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

test("stamps conversationId, applies the override, and flags renamable for a main session", () => {
  const conversation = setRegistryConversation();
  writeSessionTitle([`conversation:${conversation.id}`], `conversation:${conversation.id}`, "Human name", undefined, "t1");

  const file = entry();
  overlaySessionTitles([file]);
  expect(file.conversationId).toBe(conversation.id);
  expect(file.title).toBe("Human name");
  expect(file.autoTitle).toBe("Auto derived");
  expect(file.renamable).toBe(true);
});

test("applies a UUID-keyed override when the registry does not own the path", () => {
  writeSessionTitle([`uuid:claude:${UUID}`], `uuid:claude:${UUID}`, "By uuid", undefined, "t1");
  const file = entry();
  overlaySessionTitles([file]);
  expect(file.conversationId).toBeUndefined();
  expect(file.title).toBe("By uuid");
  expect(file.renamable).toBe(true);
});

test("a title filed under a predecessor/continuity path survives onto the successor", () => {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const conversation = registry.ensureConversation("claude", SESSION_PATH, null);
  // A prior transcript the conversation still owns (e.g. an account-migration
  // predecessor), with its own UUID/path.
  const predUuid = "22222222-2222-4333-8444-555555555555";
  const predPath = `/home/u/.claude/projects/proj/${predUuid}.jsonl`;
  registry.recordConversationContinuityPath(conversation.id, predPath);
  setAgentRegistryForTests(registry);
  // The title was filed under the predecessor's UUID key.
  writeSessionTitle([`uuid:claude:${predUuid}`], `uuid:claude:${predUuid}`, "Kept name", undefined, "t1");

  // Overlaying the current (successor) transcript still finds the title.
  const successor = entry();
  overlaySessionTitles([successor]);
  expect(successor.conversationId).toBe(conversation.id);
  expect(successor.title).toBe("Kept name");
  expect(successor.autoTitle).toBe("Auto derived");
});

test("a subagent is not renamable and receives no override affordance", () => {
  const subPath = "/home/u/.claude/projects/proj/abc/subagents/agent-9.jsonl";
  const file = entry({ path: subPath, kind: "subagent" });
  overlaySessionTitles([file]);
  expect(file.renamable).toBe(false);
});

test("the resource projection applies identity and titles without transcript-head eligibility reads", () => {
  const pathname = `/home/u/.codex/sessions/2026/07/16/rollout-${UUID}.jsonl`;
  const registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"));
  const resourceConversation = registry.ensureConversation("codex", pathname, null);
  setAgentRegistryForTests(registry);
  writeSessionTitle(
    [`conversation:${resourceConversation.id}`],
    `conversation:${resourceConversation.id}`,
    "Resource name",
    undefined,
    "t1",
  );
  const originalOpen = fs.openSync;
  let transcriptReads = 0;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === pathname) transcriptReads += 1;
    return originalOpen(...args);
  }) as typeof fs.openSync;
  try {
    const file = entry({ path: pathname, root: "codex-sessions", engine: "codex", fmt: "codex", size: 1024 });
    overlayResourceSessionTitles([file]);
    expect(file.conversationId).toBe(resourceConversation.id);
    expect(file.title).toBe("Resource name");
    expect(file.renamable).toBeUndefined();
    expect(transcriptReads).toBe(0);
  } finally {
    fs.openSync = originalOpen;
  }
});

function setRegistryConversation() {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const conversation = registry.ensureConversation("claude", SESSION_PATH, null);
  setAgentRegistryForTests(registry);
  return conversation;
}
