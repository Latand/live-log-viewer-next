import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { overlayLineageProjectAffinity } from "./projectAffinity";

const HOME = "/home/latand";
const LLV_ROOT = `${HOME}/.agents/tools/live-log-viewer-next`;
const LLV_PROJECT = "-agents-tools-live-log-viewer-next";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.path.split("/").pop()!,
    project: "latand",
    title: "session",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

/** Production shape of the split lineage: an orchestrator opened from the LLV
    board whose transcript records cwd=$HOME, with Viewer-spawned workers in
    LLV worktrees carrying durable lineage back to it. */
function splitFamily(): FileEntry[] {
  const root = entry({
    path: "/sessions/root.jsonl",
    title: "🔥 308 · LLV rescue · Orchestrator",
    project: "latand",
    cwd: HOME,
    projectRoot: HOME,
    conversationId: "conversation_root",
  });
  const worker = (n: number) => entry({
    path: `/sessions/worker-${n}.jsonl`,
    project: LLV_PROJECT,
    cwd: `${LLV_ROOT}/.worktrees/issue-${n}`,
    projectRoot: LLV_ROOT,
    worktree: `issue-${n}`,
    conversationId: `conversation_worker_${n}`,
    parent: "/sessions/root.jsonl",
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: "conversation_root", reviewsConversationId: null, memberships: [] },
  });
  return [root, worker(1), worker(2)];
}

test("a home-cwd root adopts its lineage's project and repository root", () => {
  const files = splitFamily();
  overlayLineageProjectAffinity(files);
  expect(files[0]!.project).toBe(LLV_PROJECT);
  expect(files[0]!.projectRoot).toBe(LLV_ROOT);
  expect(files[1]!.project).toBe(LLV_PROJECT);
});

test("the affinity projection is deterministic across refreshes", () => {
  const first = splitFamily();
  overlayLineageProjectAffinity(first);
  /* A refresh recomputes from the same durable data: same input, same result —
     and re-running over already-adopted entries changes nothing further. */
  const second = splitFamily();
  overlayLineageProjectAffinity(second);
  overlayLineageProjectAffinity(second);
  expect(second.map((file) => file.project)).toEqual(first.map((file) => file.project));
  expect(second[0]!.project).toBe(LLV_PROJECT);
});

test("an unrelated home-directory session is never pulled into the repo project", () => {
  const files = [
    ...splitFamily(),
    entry({
      path: "/sessions/solo.jsonl",
      title: "dotfiles cleanup",
      cwd: HOME,
      projectRoot: HOME,
      conversationId: "conversation_solo",
    }),
  ];
  overlayLineageProjectAffinity(files);
  expect(files.at(-1)!.project).toBe("latand");
});

test("a family spanning two repositories keeps its attribution", () => {
  const files = splitFamily();
  files.push(entry({
    path: "/sessions/worker-other.jsonl",
    project: "other-repo",
    cwd: `${HOME}/Projects/other-repo/.worktrees/x`,
    projectRoot: `${HOME}/Projects/other-repo`,
    worktree: "x",
    conversationId: "conversation_worker_other",
    parent: "/sessions/root.jsonl",
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: "conversation_root", reviewsConversationId: null, memberships: [] },
  }));
  overlayLineageProjectAffinity(files);
  expect(files[0]!.project).toBe("latand");
});

test("a root already inside a repository never adopts a sibling repo's project", () => {
  const files = splitFamily();
  /* The root works in repo A (its cwd IS the checkout); a child in repo B is
     not below the root's cwd, so nothing adopts. */
  files[0]!.cwd = `${HOME}/Projects/repo-a`;
  files[0]!.projectRoot = `${HOME}/Projects/repo-a`;
  files[0]!.project = "repo-a";
  files[1]!.cwd = `${HOME}/Projects/repo-b/.worktrees/x`;
  files[1]!.projectRoot = `${HOME}/Projects/repo-b`;
  files[2]!.cwd = `${HOME}/Projects/repo-b/.worktrees/y`;
  files[2]!.projectRoot = `${HOME}/Projects/repo-b`;
  overlayLineageProjectAffinity(files);
  expect(files[0]!.project).toBe("repo-a");
});

test("a weak sibling member above the repository adopts with the root", () => {
  const files = splitFamily();
  files.push(entry({
    path: "/sessions/helper.jsonl",
    project: "latand",
    cwd: HOME,
    projectRoot: HOME,
    conversationId: "conversation_helper",
    parent: "/sessions/root.jsonl",
    durableLineage: { kind: "spawn", role: null, parentConversationId: "conversation_root", reviewsConversationId: null, memberships: [] },
  }));
  overlayLineageProjectAffinity(files);
  expect(files.at(-1)!.project).toBe(LLV_PROJECT);
});

test("a parent cycle cannot hang the projection", () => {
  const a = entry({
    path: "/sessions/a.jsonl",
    cwd: HOME,
    projectRoot: HOME,
    conversationId: "conversation_a",
    durableLineage: { kind: "spawn", role: null, parentConversationId: "conversation_b", reviewsConversationId: null, memberships: [] },
  });
  const b = entry({
    path: "/sessions/b.jsonl",
    cwd: HOME,
    projectRoot: HOME,
    conversationId: "conversation_b",
    durableLineage: { kind: "spawn", role: null, parentConversationId: "conversation_a", reviewsConversationId: null, memberships: [] },
  });
  overlayLineageProjectAffinity([a, b]);
  expect(a.project).toBe("latand");
  expect(b.project).toBe("latand");
});
