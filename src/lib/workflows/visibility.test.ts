import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Workflow } from "./types";

import { filterWorkflowsForFileScan, workflowHasScannedTranscript, workflowWorkspaceExists } from "./visibility";

function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf1",
    name: "demo",
    task: "t",
    project: "repo",
    repoDir: "/repos/repo",
    worktreeDir: "/repos/repo-wf-wf1",
    branch: "wf/t-wf1",
    baseBranch: "",
    baseRef: "",
    template: { name: "demo", stages: [], finish: "pr" },
    stageRuns: [],
    stageIndex: 0,
    flowId: null,
    fixerPath: null,
    state: "needs_decision",
    pausedState: null,
    stateDetail: null,
    mode: "auto",
    setupPid: null,
    srcPath: null,
    prUrl: null,
    createdAt: "1970-01-01T00:16:41.000Z",
    closedAt: null,
    ...overrides,
  };
}

function file(pathname: string): FileEntry {
  return {
    root: "codex-sessions",
    name: pathname,
    project: "repo",
    title: pathname,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    path: pathname,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("workflow workspace visibility follows repo and worktree paths", () => {
  const workflow = wf();
  expect(workflowWorkspaceExists(workflow, (pathname) => pathname === "/repos/repo")).toBe(true);
  expect(workflowWorkspaceExists(workflow, (pathname) => pathname === "/repos/repo-wf-wf1")).toBe(true);
  expect(workflowWorkspaceExists(workflow, () => false)).toBe(false);
});

test("workflow transcript visibility follows scanned file paths", () => {
  const workflow = wf({
    srcPath: "/codex/source.jsonl",
    fixerPath: "/codex/fixer.jsonl",
    stageRuns: [{ index: 0, agentPath: "/codex/agent.jsonl", paneId: null, startedAt: null, doneAt: null, doneNote: null }],
  });

  expect(workflowHasScannedTranscript(workflow, [file("/codex/agent.jsonl")])).toBe(true);
  expect(workflowHasScannedTranscript(workflow, [file("/codex/other.jsonl")])).toBe(false);
});

test("file scan filters orphaned workflow records", () => {
  const stale = wf({ id: "stale", fixerPath: "/codex/missing.jsonl" });
  const withWorkspace = wf({ id: "workspace", repoDir: "/repos/live-repo", worktreeDir: "/repos/live-repo-wf-workspace" });
  const withTranscript = wf({
    id: "transcript",
    stageRuns: [{ index: 0, agentPath: "/codex/agent.jsonl", paneId: null, startedAt: null, doneAt: null, doneNote: null }],
  });

  const visible = filterWorkflowsForFileScan([stale, withWorkspace, withTranscript], [file("/codex/agent.jsonl")], (pathname) =>
    pathname === withWorkspace.repoDir,
  );

  expect(visible.map((workflow) => workflow.id)).toEqual(["workspace", "transcript"]);
});
