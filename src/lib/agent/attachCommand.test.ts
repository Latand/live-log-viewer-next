import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import type { ResumeSpec } from "./cli";
import { resumeSpecForSession } from "./cli";
import { attachCommandFromSpec, attachTargetPath, resolveAttachCommand, resolveLaunchAttachCommand, type AttachResolverDeps, type LaunchAttachDeps } from "./attachCommand";

/* The codex resume command now enumerates MCP servers via `codex mcp list --json`
   (PR #610). Stub that binary so the pure P1#6 launch-attach composition below
   stays hermetic and does not depend on a real codex install being present. */
const MCP_STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attach-mcp-"));
const MCP_STUB = path.join(MCP_STUB_DIR, "codex-mcp-stub");
fs.writeFileSync(MCP_STUB, `#!/bin/sh\nprintf '[{"name":"viewer"}]'\n`);
fs.chmodSync(MCP_STUB, 0o755);
/* spawnSync chdir's into the launch cwd to enumerate MCP servers, so it must be a
   real directory. */
const WORKTREE = path.join(MCP_STUB_DIR, "worktree");
fs.mkdirSync(WORKTREE, { recursive: true });
const OLD_CODEX_BINARY = process.env.LLV_CODEX_BINARY;
process.env.LLV_CODEX_BINARY = MCP_STUB;

afterAll(() => {
  if (OLD_CODEX_BINARY === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = OLD_CODEX_BINARY;
  fs.rmSync(MCP_STUB_DIR, { recursive: true, force: true });
});

/**
 * Pure attach-command composition (design §6). No spawning, no waiting — every
 * datum is already in the registry, so the command is composed synchronously.
 */

function spec(overrides: Partial<ResumeSpec> = {}): ResumeSpec {
  return { command: "claude --resume 22222222", cwd: "/home/user/Projects/atlas", windowName: "atlas", engine: "claude", ...overrides };
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/root.jsonl", root: "claude-projects", name: "root.jsonl", project: "viewer", title: "root",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "idle", proc: null, pid: null, model: "sonnet", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function deps(files: FileEntry[], over: Partial<AttachResolverDeps> = {}): AttachResolverDeps {
  return {
    files,
    resumeSpecFor: (_root, path) => (path === "/missing.jsonl" ? null : spec({ cwd: `/cwd${path}` })),
    accountIdForPath: () => "d",
    accountLabelFor: (engine, id) => `${id} · ${engine}-max`,
    ...over,
  };
}

test("attachCommandFromSpec composes the one-line full command with a shell-quoted cwd", () => {
  const cmd = attachCommandFromSpec(spec({ cwd: "/home/o'brien/atlas" }), { accountId: "d", accountLabel: "D · claude-max" });
  expect(cmd.command).toBe("claude --resume 22222222");
  // the apostrophe in the path is shell-escaped for the `cd '<cwd>' && …` one-liner
  expect(cmd.fullCommand).toBe("cd '/home/o'\\''brien/atlas' && claude --resume 22222222");
  // the standalone "Copy working directory" row shares the same quoting (finding 5)
  expect(cmd.cdCommand).toBe("cd '/home/o'\\''brien/atlas'");
  expect(cmd.accountLabel).toBe("D · claude-max");
  expect(cmd.note).toBeUndefined();
});

test("cdCommand shell-quotes ordinary and space-bearing paths so both paste correctly", () => {
  expect(attachCommandFromSpec(spec({ cwd: "/plain/path" }), { accountId: "d", accountLabel: "l" }).cdCommand)
    .toBe("cd '/plain/path'");
  expect(attachCommandFromSpec(spec({ cwd: "/has a space/atlas" }), { accountId: "d", accountLabel: "l" }).cdCommand)
    .toBe("cd '/has a space/atlas'");
});

test("resolveAttachCommand resolves a live/finished conversation to its own resume command", () => {
  const f = file({ path: "/root.jsonl", engine: "codex", root: "codex-sessions" });
  const res = resolveAttachCommand("/root.jsonl", deps([f]));
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.value.accountId).toBe("d");
    expect(res.value.cwd).toBe("/cwd/root.jsonl");
    expect(res.value.note).toBeUndefined();
  }
});

test("issue 561: the command uses the conversation's recorded cwd, not the spec's sniffed fallback", () => {
  /* The resume spec re-derives cwd by sniffing the transcript head and falls
     back to $HOME when that read is empty — the wrong-path symptom #561 filed.
     When the conversation's own cwd is known it must win. */
  const meta = { accountId: "d", accountLabel: "l", cwd: "/real/project/dir" };
  const cmd = attachCommandFromSpec(spec({ cwd: "/home/user" /* sniffed fallback */ }), meta);
  expect(cmd.cwd).toBe("/real/project/dir");
  expect(cmd.cdCommand).toBe("cd '/real/project/dir'");
  expect(cmd.fullCommand).toBe("cd '/real/project/dir' && claude --resume 22222222");
});

test("issue 561: resolveAttachCommand carries the entry's recorded cwd into the command", () => {
  const f = file({ path: "/root.jsonl", engine: "codex", root: "codex-sessions", cwd: "/home/user/atlas" });
  const res = resolveAttachCommand("/root.jsonl", deps([f]));
  expect(res.ok).toBe(true);
  if (res.ok) {
    /* The recorded cwd overrides the resolver's `/cwd/root.jsonl` spec fallback. */
    expect(res.value.cwd).toBe("/home/user/atlas");
    expect(res.value.fullCommand.startsWith("cd '/home/user/atlas' && ")).toBe(true);
  }
});

test("a Claude subagent resolves through its root session with a subagent-root note", () => {
  const root = file({ path: "/root.jsonl", kind: "session" });
  const sub = file({ path: "/sub.jsonl", kind: "subagent", parent: "/root.jsonl" });
  const res = resolveAttachCommand("/sub.jsonl", deps([root, sub]));
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.note).toBe("subagent-root");
});

test("an unknown path is rejected 404, a shell task 409", () => {
  const missing = resolveAttachCommand("/nope.jsonl", deps([]));
  expect(missing).toEqual({ ok: false, error: expect.any(String), status: 404 });
  const shell = resolveAttachCommand("/task.sh", deps([file({ path: "/task.sh", engine: "shell" as FileEntry["engine"] })]));
  expect(shell.ok).toBe(false);
  if (!shell.ok) expect(shell.status).toBe(409);
});

test("a non-resumable subagent with no resumable ancestor is 409, not a crash", () => {
  const orphan = file({ path: "/orphan.jsonl", kind: "subagent", parent: "/gone.jsonl" });
  const res = resolveAttachCommand("/orphan.jsonl", deps([orphan]));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

test("a cyclic parent chain terminates instead of looping forever", () => {
  const a = file({ path: "/a.jsonl", kind: "subagent", parent: "/b.jsonl" });
  const b = file({ path: "/b.jsonl", kind: "subagent", parent: "/a.jsonl" });
  const res = resolveAttachCommand("/a.jsonl", deps([a, b]));
  expect(res.ok).toBe(false);
});

test("attachTargetPath resolves the path the composed command actually resumes (subagent → root)", () => {
  const root = file({ path: "/root.jsonl", kind: "session" });
  const sub = file({ path: "/sub.jsonl", kind: "subagent", parent: "/root.jsonl" });
  // a resumable conversation is its own target; a subagent's target is its root
  expect(attachTargetPath("/root.jsonl", [root, sub])).toBe("/root.jsonl");
  expect(attachTargetPath("/sub.jsonl", [root, sub])).toBe("/root.jsonl");
  // unknown paths and orphaned subagents resolve to nothing
  expect(attachTargetPath("/nope.jsonl", [root, sub])).toBeNull();
  expect(attachTargetPath("/orphan.jsonl", [file({ path: "/orphan.jsonl", kind: "subagent", parent: "/gone.jsonl" })])).toBeNull();
});

/*
 * P1#6 (round-1 review): a queued launch window's path is the synthetic
 * `spawn:<launchId>`. Its "Open in terminal" must resolve through the durable
 * launch receipt — real account home, cwd, and session id — and compose a
 * working command, never hand the synthetic path to a filesystem endpoint (the
 * HTTP 400 the review flagged).
 */
const SESSION_ID = "00000000-0000-0000-0000-000000000001";

function launchDeps(over: Partial<LaunchAttachDeps> = {}): LaunchAttachDeps {
  return {
    receipt: {
      engine: "codex",
      cwd: WORKTREE,
      accountId: "work",
      key: { engine: "codex", sessionId: SESSION_ID },
      launchProfile: { model: "gpt-5.4", effort: "high", fast: null },
    },
    materializedPath: null,
    resolveByPath: () => ({ ok: false, error: "not scanned yet", status: 404 }),
    resumeSpecForSession,
    homeForAccount: () => "/repo/.codex-home",
    accountLabelFor: (_engine, accountId) => `${accountId} · codex`,
    ...over,
  };
}

test("P1#6: a queued launch (no transcript yet) composes a real resume command from its receipt — not a 400", () => {
  const res = resolveLaunchAttachCommand(launchDeps());
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.value.cwd).toBe(WORKTREE);
    expect(res.value.command).toContain(`resume ${SESSION_ID}`);
    expect(res.value.command).toContain("CODEX_HOME='/repo/.codex-home'");
    /* The launch's recorded MCP allowlist is re-applied on resume (PR #610). */
    expect(res.value.command).toContain("'mcp_servers.viewer.enabled=true'");
    expect(res.value.fullCommand.startsWith(`cd '${WORKTREE}' && `)).toBe(true);
    expect(res.value.accountLabel).toBe("work · codex");
  }
});

test("P1#6: a materialized transcript is preferred and resolved through the full path flow", () => {
  const byPath = { ok: true as const, value: { engine: "codex" as const, accountId: "work", accountLabel: "work · codex", cwd: "/repo/worktree", command: "codex resume from-path", cdCommand: "cd '/repo/worktree'", fullCommand: "cd '/repo/worktree' && codex resume from-path" } };
  const res = resolveLaunchAttachCommand(launchDeps({ materializedPath: "/repo/rollout.jsonl", resolveByPath: () => byPath }));
  expect(res).toEqual(byPath);
});

test("P1#6: a launch whose session has not bound yet is a clear 409, never a 400", () => {
  const res = resolveLaunchAttachCommand(launchDeps({ receipt: { engine: "codex", cwd: "/repo/worktree", accountId: "work", key: null, launchProfile: { model: null, effort: null, fast: null } } }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

test("P1#6: an unknown launch id is a 404", () => {
  const res = resolveLaunchAttachCommand(launchDeps({ receipt: null }));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(404);
});
