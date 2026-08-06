import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { admitTranscriptConversation } from "./transcriptAdmission";
import { resumeConversation } from "@/lib/delivery";
import type { FileEntry } from "@/lib/types";

/*
 * Issue #935: continuing a conversation must not depend on how its first host
 * was born. A session started by typing `claude` in a plain terminal holds no
 * registry identity, so the transcript-host bridge declined it and the viewer
 * fell through to a legacy tmux launch that structured transport prohibits for
 * Claude — the operator's only recovery was a fresh session reading the old
 * JSONL. These cases pin the bridge route and each specific refusal.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminal-born-resume-test-"));
const SESSION_ID = "12345678-1234-1234-1234-123456789abc";

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});
afterEach(() => setAgentRegistryForTests(null));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function registryFor(name: string): AgentRegistry {
  return new AgentRegistry(path.join(SANDBOX, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
}

function terminalBornEntry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "repo",
    cwd: path.join(SANDBOX, "repo"),
    title: "a terminal-born conversation",
    engine: "claude",
    kind: "session",
    parent: null,
    activity: "idle",
    mtime: 0,
    size: 1,
    proc: "done",
    pid: null,
    model: "opus",
    ...overrides,
  } as unknown as FileEntry;
}

test("a terminal-born transcript is admitted and resumes through the transcript-host bridge", async () => {
  const pathname = path.join(SANDBOX, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(pathname, "{}\n");
  const registry = registryFor("terminal-born");
  setAgentRegistryForTests(registry);
  const entry = terminalBornEntry(pathname);
  // The registry has never seen this conversation: nothing spawned it.
  expect(registry.conversationForPath(pathname)).toBeNull();
  const bridgeRequests: { path: string; conversationId?: string | null }[] = [];
  let legacyLaunches = 0;

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry,
    listFiles: async () => [entry],
    recover: async (request: { path: string; conversationId?: string | null }) => {
      bridgeRequests.push({ path: request.path, conversationId: request.conversationId });
      /* The deployed bridge only owns a conversation the registry holds an
         identity for — the gate this lane had to open. */
      const conversation = registry.conversationForPath(request.path);
      if (!conversation) return null;
      return { target: null, path: request.path, conversationId: conversation.id, spawned: true };
    },
    deliver: async () => {
      legacyLaunches += 1;
      return { ok: true, outcome: "resumed", target: "%9" };
    },
  } as never);

  expect(outcome).toMatchObject({ ok: true, target: null, outcome: "resumed", spawned: true, structured: true });
  expect(legacyLaunches).toBe(0);
  // First attempt without an identity, second one carrying the admitted id.
  expect(bridgeRequests).toHaveLength(2);
  expect(bridgeRequests[0]!.conversationId).toBeUndefined();
  const admitted = registry.conversationForPath(pathname)!;
  expect(bridgeRequests[1]!.conversationId).toBe(admitted.id);
});

test("admission records the transcript's own provenance, not a default", () => {
  const pathname = path.join(SANDBOX, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(pathname, "{}\n");
  const registry = registryFor("provenance");
  const cwd = path.join(SANDBOX, "repo");

  const admission = admitTranscriptConversation(registry, terminalBornEntry(pathname, {
    cwd,
    model: "sonnet",
    launchModel: "opus",
    effort: "high",
  } as Partial<FileEntry>), {
    resolveAccount: () => ({
      engine: "claude",
      accountId: "account-b",
      kind: "managed",
      home: path.join(SANDBOX, "account-b"),
      transcriptRoot: SANDBOX,
      env: { NODE_ENV: "test" },
    }),
  });

  expect(admission).toMatchObject({ ok: true });
  const conversation = registry.conversationForPath(pathname)!;
  const generation = conversation.generations.at(-1)!;
  expect(conversation.engine).toBe("claude");
  expect(generation.id).toBe(SESSION_ID);
  expect(generation.accountId).toBe("account-b");
  expect(generation.launchProfile.cwd).toBe(cwd);
  expect(generation.launchProfile.model).toBe("opus");
  expect(generation.launchProfile.effort).toBe("high");
});

test("a session still running in a foreign terminal is refused by name, and nothing is launched", async () => {
  const pathname = path.join(SANDBOX, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(pathname, "{}\n");
  const registry = registryFor("foreign-live");
  setAgentRegistryForTests(registry);
  let legacyLaunches = 0;

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry,
    listFiles: async () => [terminalBornEntry(pathname, { proc: "running", pid: 4242 })],
    recover: async () => null,
    livePaneHost: async () => null,
    deliver: async () => {
      legacyLaunches += 1;
      return { ok: true, outcome: "resumed", target: "%9" };
    },
  } as never);

  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    error: "the session is still running in a terminal the viewer does not own; close it there, then continue from here",
  });
  expect(legacyLaunches).toBe(0);
  expect(registry.conversationForPath(pathname)).toBeNull();
});

test("a live tmux pane keeps its own delivery: the foreign-terminal refusal is only for a pane-less owner", async () => {
  const pathname = path.join(SANDBOX, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(pathname, "{}\n");
  const registry = registryFor("live-pane");
  setAgentRegistryForTests(registry);
  let legacyDeliveries = 0;

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry,
    listFiles: async () => [terminalBornEntry(pathname, { proc: "running", pid: 4242 })],
    recover: async () => null,
    livePaneHost: async () => ({ paneId: "%3", display: "0:0.0" }),
    resumeSpecFor: () => ({ command: "resume", launchProfile: null }),
    deliver: async () => {
      legacyDeliveries += 1;
      return { ok: true, outcome: "delivered-to-live", target: "%3" };
    },
  } as never);

  expect(outcome).toMatchObject({ ok: true, target: "%3" });
  expect(legacyDeliveries).toBe(1);
});

test("an unreadable transcript and a transcript with no session id each name their own refusal", () => {
  const registry = registryFor("named-refusals");

  expect(admitTranscriptConversation(registry, terminalBornEntry(path.join(SANDBOX, `${SESSION_ID}.jsonl`)))).toEqual({
    ok: false,
    reason: "the conversation transcript cannot be read from disk",
  });
  const unnamed = path.join(SANDBOX, "notes.jsonl");
  fs.writeFileSync(unnamed, "{}\n");
  expect(admitTranscriptConversation(registry, terminalBornEntry(unnamed))).toEqual({
    ok: false,
    reason: "the transcript filename carries no Claude session id",
  });
  const shell = path.join(SANDBOX, "task.log");
  fs.writeFileSync(shell, "output\n");
  expect(admitTranscriptConversation(registry, terminalBornEntry(shell, { engine: "shell" }))).toEqual({
    ok: false,
    reason: "this entry is not an agent conversation, so it has no session to continue",
  });
});

test("a Codex transcript born in a terminal is admitted the same way", () => {
  const pathname = path.join(SANDBOX, `rollout-2026-08-07T10-00-00-${SESSION_ID}.jsonl`);
  fs.writeFileSync(pathname, "{}\n");
  const registry = registryFor("codex-terminal-born");

  const admission = admitTranscriptConversation(registry, terminalBornEntry(pathname, {
    root: "codex-sessions",
    engine: "codex",
  }), { resolveAccount: () => null });

  expect(admission).toMatchObject({ ok: true });
  const conversation = registry.conversationForPath(pathname)!;
  expect(conversation.engine).toBe("codex");
  expect(conversation.generations.at(-1)!.id).toBe(SESSION_ID);
});
