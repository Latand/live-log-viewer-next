import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, type NativeGeneration } from "./contracts";
import { RegisteredSuccessorProvider, type ProviderDependencies } from "./provider";
import type { CodexAppServerClient } from "@/lib/accounts/codexAppServer";

const roots: string[] = [];

function accountRoot(engine: "claude" | "codex", base: string, id: string) {
  const home = path.join(base, id);
  const transcriptRoot = path.join(home, engine === "claude" ? "projects" : "sessions");
  fs.mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.chmodSync(transcriptRoot, 0o700);
  return { engine, accountId: id, kind: "managed" as const, home, transcriptRoot, env: { ...process.env } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("Claude successor provider uses registered homes and shared model normalization", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "-repo", "019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  let command = "";
  const dependencies: ProviderDependencies = {
    accounts: {
      resolveSpawn: () => target,
      resolveTranscriptOwner: () => source,
    },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => { command = spec.command; return { paneId: "%9", panePid: 99 }; },
    now: () => "2026-07-10T12:00:00.000Z",
  };
  const provider = new RegisteredSuccessorProvider(dependencies);
  const sourceGeneration: NativeGeneration = {
    id: "019f423a-d6e9-7903-b597-3e676b6ff3d4",
    path: sourcePath,
    accountId: "source",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "claude-fable-5-20260701", effort: "high" }),
    historyHash: null,
    host: null,
    createdAt: "2026-07-10T11:00:00.000Z",
    archivedAt: null,
  };
  const receipt = await provider.create({ engine: "claude", operationId: "019f423a-d6e9-4903-8597-3e676b6ff3d4", conversationId: "conversation_test", source: sourceGeneration, targetAccountId: "target" });
  expect(command).toContain("CLAUDE_CONFIG_DIR=");
  expect(command).toContain("--model' 'fable'");
  expect(command).not.toContain("claude-fable-5");
  expect(command).toContain("--effort' 'high'");
  expect(receipt.path.startsWith(target.transcriptRoot + path.sep)).toBeTrue();
  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: sourceGeneration.launchProfile })).resolves.toBeUndefined();
});

test("unknown Claude transcript model omits the successor override", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-unknown-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  let command = "";
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => { command = spec.command; return { paneId: "%10" }; },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await provider.create({
    engine: "claude",
    operationId: "019f423a-d6e9-4903-8597-3e676b6ff3d4",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "native", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "mythos-1" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
  });
  expect(command).not.toContain("--model");
});

test("Codex successor provider forks, safely copies, resumes, and verifies through app-server ports", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "2026", "07", "10", "rollout-019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, "{\"type\":\"session_meta\"}\n", { mode: 0o600 });
  const forkId = "019f423a-d6e9-4903-8597-3e676b6ff3d4";
  const forkPath = path.join(source.transcriptRoot, "2026", "07", "10", `rollout-${forkId}.jsonl`);
  const calls: string[] = [];
  let resumeOptions: unknown = null;
  let goalOptions: unknown = null;
  const client = (home: string) => ({
    async readAccount() { calls.push(`${path.basename(home)}:account`); return { account: { type: "chatgpt" }, requiresOpenaiAuth: false }; },
    async forkThread() { calls.push("source:fork"); fs.writeFileSync(forkPath, "{\"type\":\"session_meta\"}\n", { mode: 0o600 }); return { id: forkId, path: forkPath }; },
    async resumeThread(id: string, options: unknown) { calls.push("target:resume"); resumeOptions = options; return { id, path: null }; },
    async readThread(id: string) { calls.push("target:read"); return { id, path: null }; },
    async setThreadName() { calls.push("target:name"); },
    async setThreadGoal(_id: string, objective: string, status: string) { calls.push("target:goal"); goalOptions = { objective, status }; },
    close() { calls.push(`${path.basename(home)}:close`); },
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const profile = emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, permissionMode: "never", readOnly: true, title: "Migration", goal: { objective: "Ship", status: "active", tokensUsed: null, timeUsedSeconds: null } });
  const receipt = await provider.create({
    engine: "codex",
    operationId: "operation-codex",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "019f423a-d6e9-7903-b597-3e676b6ff3d4", path: sourcePath, accountId: "source", launchProfile: profile, historyHash: null, host: null, createdAt: "now", archivedAt: null },
  });
  expect(receipt.nativeId).toBe(forkId);
  expect(receipt.path.startsWith(target.transcriptRoot + path.sep)).toBeTrue();
  expect(fs.readFileSync(receipt.path, "utf8")).toContain("session_meta");
  expect(calls).toContain("source:fork");
  expect(calls).toContain("target:resume");
  expect(calls).toContain("target:name");
  expect(calls).toContain("target:goal");
  expect(resumeOptions).toEqual({ path: receipt.path, cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, approvalPolicy: "never", sandbox: "read-only" });
  expect(goalOptions).toEqual({ objective: "Ship", status: "active" });
  await provider.verify(receipt, { engine: "codex", targetAccountId: "target", launchProfile: profile });
  expect(calls.filter((call) => call === "target:read").length).toBeGreaterThanOrEqual(2);
});
