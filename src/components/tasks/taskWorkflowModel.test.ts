import { expect, test } from "bun:test";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { projectTaskWorkflows } from "./taskWorkflowModel";

const task = (id = "task-a", overrides: Partial<BoardTask> = {}): BoardTask => ({ id, project: "project", text: "Restore delivery",
  status: "assigned", placement: "unplaced", assignments: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides });
const file = (id: string, path = `fixtures/${id}.jsonl`, overrides: Partial<FileEntry> = {}): FileEntry => ({ path, conversationId: id,
  title: `Worker ${id}`, root: "codex-sessions", name: id, project: "project", engine: "codex", kind: "session", fmt: "codex",
  parent: null, mtime: 1, size: 1, activity: "recent", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...overrides });
const role = { roleId: "builder" as const, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
const attempt = (n: number, overrides: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt => ({ n, state: "failed", effectiveRole: role,
  launchId: `launch-${n}`, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
  startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: "launch failed", ...overrides });
const pipeline = (id: string, attempts: PipelineStageAttempt[] = [], overrides: Partial<Pipeline> = {}): Pipeline => ({
  id, task: "Restore delivery", taskIds: ["task-a"], project: "project", repoDir: "fixture-repo", worktreeDir: "fixture-worktree",
  branch: "fixture-branch", baseBranch: "main", baseRef: "a".repeat(40), lastPassedCommit: "b".repeat(40),
  stages: [{ id: "build", kind: "run", effectiveRole: role, prompt: "Build", next: null }], runs: [{ stageId: "build", attempts }],
  cursor: null, state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2026-01-01", closedAt: null, ...overrides });

test("a done task retains two executions, pathless failure, review findings and a planned stage", () => {
  const a = pipeline("initial", [attempt(1), attempt(2, { conversationId: "worker", agentPath: "fixtures/worker.jsonl", state: "passed", verdict: { status: "pass" }, error: null })]);
  const b = pipeline("successor", [attempt(1, { effectiveRole: { ...role, roleId: "reviewer" }, verdict: { status: "fail", findings: ["Late response clears a newer draft"] }, reviewHeadSha: "c".repeat(40) })]);
  b.stages.push({ id: "verify", kind: "run", effectiveRole: role, prompt: "Verify", next: null });
  const result = projectTaskWorkflows([task("task-a", { status: "done" })], [a, b], [], [file("worker")]).tasks[0];
  expect(result.executions).toHaveLength(2);
  expect(result.references.map(r => r.kind)).toEqual(["attempt", "attempt", "attempt", "planned"]);
  expect(result.workers).toHaveLength(1);
  expect(result.unresolved).toBe(2);
  expect(result.reviews).toBe(1);
  expect(result.references[2].findings).toEqual(["Late response clears a newer draft"]);
  expect(result.references[2].reviewedSha).toBe("c".repeat(40));
  expect(result.executions[0].pipeline.publishedCommit).toBeUndefined();
});

test("manager source overlap and matching titles never manufacture membership", () => {
  const t = task("task-a", { source: { path: "fixtures/manager.jsonl", ts: null, text: "Restore delivery", fingerprint: "fixture", engine: "codex" },
    assignments: [{ path: "fixtures/manager.jsonl", conversationId: "manager", panePid: null, state: "handoff", error: null, at: "2026-01-01" }] });
  const p = pipeline("other", [], { taskIds: [], srcPath: "fixtures/manager.jsonl", srcConversationId: "manager" });
  const result = projectTaskWorkflows([t], [p], [], [file("manager")]);
  expect(result.tasks[0].executions).toHaveLength(0);
  expect(result.unlinkedPipelines).toEqual([p]);
});

test("direct launch assignment links an unresolved attempt without a transcript", () => {
  const t = task("task-a", { assignments: [{ path: null, launchId: "launch-1", panePid: null, state: "spawning", error: null, at: "2026-01-01" }] });
  const result = projectTaskWorkflows([t], [pipeline("p", [attempt(1)], { taskIds: [] })], [], []);
  expect(result.tasks[0].executions[0].basis).toBe("assignment");
  expect(result.tasks[0].references.every(r => r.file === null)).toBe(true);
});

test("current generation wins over placeholders and archived paths; contradictory identity stays unresolved", () => {
  const old = file("worker", "fixtures/old.jsonl", { migratedTo: "fixtures/new.jsonl" });
  const current = file("worker", "fixtures/new.jsonl");
  const p = pipeline("p", [attempt(1, { conversationId: "worker", agentPath: old.path }), attempt(2, { conversationId: "missing", agentPath: current.path })]);
  const result = projectTaskWorkflows([task()], [p], [], [file("worker", "spawn:launch-1"), old, current]).tasks[0];
  expect(result.references[0].file).toBe(current);
  expect(result.references[1].file).toBeNull();
  expect(result.workers).toEqual([current]);
});

test("shared worker has one canonical target in each task and remains reachable at scale", () => {
  for (const count of [24, 100, 1000]) {
    const files = Array.from({ length: count }, (_, i) => file(`worker-${i}`));
    const tasks = Array.from({ length: Math.ceil(count / 4) }, (_, i) => task(`task-${i}`));
    const pipelines = tasks.map((t, i) => pipeline(`p-${i}`, files.slice(i * 4, i * 4 + 4).map((f, n) => attempt(n + 1, { conversationId: f.conversationId!, agentPath: f.path })), { taskIds: [t.id] }));
    pipelines[0].taskIds.push(tasks.at(-1)!.id);
    const result = projectTaskWorkflows(tasks, pipelines, [], files);
    expect(new Set(result.tasks.flatMap(t => t.workers.map(f => f.path))).size).toBe(count);
    expect(result.unlinkedWorkers).toHaveLength(0);
    expect(result.tasks.at(-1)!.workers).toContain(files.at(-1)!);
  }
});

test("embedded review rounds preserve their own SHA, verdict and binding", () => {
  const p = pipeline("p", [attempt(1, { flowId: "flow-a" })]);
  const flow = { id: "flow-a", implementerPath: "fixtures/builder.jsonl", rounds: [
    { n: 1, reviewerBindingId: "binding-a", reviewerPath: "fixtures/reviewer.jsonl", reviewerConversationId: "reviewer", verdict: "REQUEST_CHANGES", findingsCount: 2, reviewHeadSha: "d".repeat(40) },
    { n: 2, reviewerBindingId: "binding-b", reviewerPath: null, reviewerConversationId: null, verdict: null, findingsCount: null, terminalAt: "2026-01-02" },
  ] } as Flow;
  const result = projectTaskWorkflows([task()], [p], [flow], [file("reviewer")]);
  expect(result.tasks[0].reviews).toBe(2);
  expect(result.tasks[0].references.at(-2)?.reviewedSha).toBe("d".repeat(40));
  expect(result.tasks[0].references.at(-1)?.state).toBe("unresolved");
  expect(result.unlinkedFlows).toHaveLength(0);
});

test("unlinked history is project-scoped while explicit cross-project workers remain reachable", () => {
  const local = file("local"), other = file("other", "fixtures/other.jsonl", { project: "other-project" });
  const foreignPipeline = pipeline("foreign", [attempt(1, { conversationId: "other", agentPath: other.path })], { project: "other-project", taskIds: [] });
  const result = projectTaskWorkflows([task()], [foreignPipeline], [], [local, other], "project");
  expect(result.unlinkedWorkers).toEqual([local]);
  expect(result.unlinkedPipelines).toHaveLength(0);
  expect(result.unlinkedReferences.map(r => r.file)).toEqual([local]);
  foreignPipeline.taskIds = ["task-a"];
  const linked = projectTaskWorkflows([task()], [foreignPipeline], [], [local, other], "project");
  expect(linked.tasks[0].workers).toEqual([other]);
  expect(linked.unlinkedWorkers).toEqual([local]);
});
