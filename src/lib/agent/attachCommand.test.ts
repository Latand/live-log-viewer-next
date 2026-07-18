import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { ResumeSpec } from "./cli";
import { attachCommandFromSpec, attachTargetPath, resolveAttachCommand, type AttachResolverDeps } from "./attachCommand";

/**
 * Pure attach-command composition (design §6). No spawning, no waiting — every
 * datum is already in the registry, so the command is composed synchronously.
 */

function spec(overrides: Partial<ResumeSpec> = {}): ResumeSpec {
  return { command: "claude --resume 22222222", cwd: "/home/latand/Projects/atlas", windowName: "atlas", engine: "claude", ...overrides };
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
