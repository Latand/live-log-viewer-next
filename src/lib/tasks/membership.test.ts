import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import {
  ADMISSION_BATCH,
  admitConversations,
  admitScannedConversations,
  commitTaskMembership,
  ensureTaskMembership,
  planAdmissions,
  recordLaunchIdentity,
  refineTask,
  UNTITLED_TASK_TEXT,
} from "./membership";
import { patchTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

const now = "2026-09-09T10:00:00.000Z";
let serial = 0;
const deps = { now: () => now, id: () => `task-${String((serial += 1)).padStart(3, "0")}` };

function task(id: string, project: string, extra: Partial<BoardTask> = {}): BoardTask {
  return { id, project, status: "inbox", text: `Task ${id}`, placement: "unplaced", assignments: [], createdAt: now, updatedAt: now, ...extra } as BoardTask;
}

function entry(index: number, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/projects/root/session-${index}.jsonl`,
    conversationId: `conversation_fixture_${index}`,
    title: `Fixture conversation ${index} about area ${index}`,
    project: "fixture",
    root: "claude-projects",
    kind: "session",
    fmt: "claude",
    engine: "claude",
    name: `session-${index}.jsonl`,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...extra,
  } as FileEntry;
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-membership-")), "tasks.json");

test("a global launch mints one placeholder keyed by its attempt; the replay converges on it and the identity fill is idempotent", () => {
  const first = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-1" }, title: "Restore search results\nmore prompt", identity: { clientAttemptId: "attempt-1", engine: "claude" } }, deps);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.created.length).toBe(1);
  const created = first.tasks.find((candidate) => candidate.id === first.taskIds[0])!;
  expect(created.text).toBe("Restore search results");
  expect(created.origin).toEqual({ kind: "launch", key: "attempt-1", refinement: "pending" });
  expect(created.assignments).toEqual([{ clientAttemptId: "attempt-1", path: null, panePid: null, state: "linked", error: null, at: now, engine: "claude" }]);
  expect(created.status).toBe("assigned");
  /* Crash after commit, before the receipt: the same attempt key replays. */
  const replay = ensureTaskMembership(first.tasks, { project: "fixture", origin: { kind: "launch", key: "attempt-1" }, identity: { clientAttemptId: "attempt-1" } }, deps);
  expect(replay.ok && replay.taskIds).toEqual(first.taskIds);
  expect(replay.ok && replay.created).toEqual([]);
  expect(replay.ok && replay.changed).toBe(false);
  /* The receipt names launch and conversation ids: filled onto the same assignment, twice without change. */
  const filled = recordLaunchIdentity(first.tasks, first.taskIds, { clientAttemptId: "attempt-1", launchId: "launch-1", conversationId: "conversation_new" }, now);
  expect(filled.changed).toBe(true);
  expect(filled.tasks[0]!.assignments.length).toBe(1);
  expect(filled.tasks[0]!.assignments[0]).toMatchObject({ clientAttemptId: "attempt-1", launchId: "launch-1", conversationId: "conversation_new", state: "linked" });
  const again = recordLaunchIdentity(filled.tasks, first.taskIds, { clientAttemptId: "attempt-1", launchId: "launch-1", conversationId: "conversation_new" }, now);
  expect(again.changed).toBe(false);
  /* A later admission by conversation id finds the held membership, minting nothing. */
  const byConversation = ensureTaskMembership(filled.tasks, { project: "fixture", origin: { kind: "conversation", key: "conversation_new" }, identity: { conversationId: "conversation_new", path: "/fixture/new.jsonl" } }, deps);
  expect(byConversation.ok && byConversation.created).toEqual([]);
  expect(byConversation.ok && byConversation.taskIds).toEqual(first.taskIds);
  expect(byConversation.ok && byConversation.tasks[0]!.assignments[0]!.path).toBe("/fixture/new.jsonl");
});

test("explicit targets are validated together: a missing or foreign task refuses the whole request and writes nothing", () => {
  const tasks = [task("a", "fixture"), task("b", "fixture"), task("c", "elsewhere")];
  const missing = ensureTaskMembership(tasks, { project: "fixture", origin: { kind: "launch", key: "k" }, identity: { clientAttemptId: "k" }, explicitTaskIds: ["a", "gone"] }, deps);
  expect(missing.ok).toBe(false);
  expect(!missing.ok && missing.status).toBe(404);
  const foreign = ensureTaskMembership(tasks, { project: "fixture", origin: { kind: "launch", key: "k" }, identity: { clientAttemptId: "k" }, explicitTaskIds: ["a", "c"] }, deps);
  expect(foreign.ok).toBe(false);
  expect(!foreign.ok && foreign.status).toBe(409);
  const both = ensureTaskMembership(tasks, { project: "", origin: { kind: "launch", key: "k" }, identity: { clientAttemptId: "k" }, explicitTaskIds: ["a", "b", "a"] }, deps);
  expect(both.ok && both.taskIds).toEqual(["a", "b"]);
  expect(both.ok && both.tasks.filter((candidate) => candidate.assignments.some((assignment) => assignment.clientAttemptId === "k")).length).toBe(2);
  expect(both.ok && both.created).toEqual([]);
});

test("a task that already holds a delivered assignment keeps that state; membership never downgrades it to linked", () => {
  const held = task("held", "fixture", { assignments: [{ path: "/fixture/p.jsonl", conversationId: "conversation_p", panePid: null, state: "delivered", error: null, at: now }] });
  const result = ensureTaskMembership([held], { project: "fixture", origin: { kind: "conversation", key: "conversation_p" }, identity: { conversationId: "conversation_p", path: "/fixture/p.jsonl", launchId: "launch-p" } }, deps);
  expect(result.ok && result.created).toEqual([]);
  expect(result.ok && result.tasks[0]!.assignments[0]).toMatchObject({ state: "delivered", launchId: "launch-p" });
});

test("mandatory membership is exempt from the per-project task limit", () => {
  const tasks = Array.from({ length: 300 }, (_, index) => task(`t${index}`, "fixture"));
  const result = ensureTaskMembership(tasks, { project: "fixture", origin: { kind: "conversation", key: "conversation_301" }, identity: { conversationId: "conversation_301", path: "/fixture/301.jsonl" } }, deps);
  expect(result.ok && result.created.length).toBe(1);
  expect(result.ok && result.tasks.length).toBe(301);
});

test("an untitled admission reads «Untitled task» with refinement pending; an identity-less one refuses", () => {
  const result = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "k2" }, title: "   ", identity: { clientAttemptId: "k2" } }, deps);
  expect(result.ok && result.tasks[0]!.text).toBe(UNTITLED_TASK_TEXT);
  expect(result.ok && result.tasks[0]!.origin?.refinement).toBe("pending");
  const empty = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "k3" }, identity: {} }, deps);
  expect(empty.ok).toBe(false);
});

function pipeline(id: string, attempts: { agentPath: string | null; conversationId: string | null }[], taskIds: string[] = []): Pipeline {
  return {
    id, task: `Pipeline ${id} goal`, taskIds, project: "fixture", repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `pipeline/${id}`, baseBranch: "main", baseRef: "abc", lastPassedCommit: "abc",
    stages: [{ id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    runs: [{ stageId: "build", attempts: attempts.map((attempt, index) => ({ n: index + 1, state: "running", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null }, launchId: `launch-${id}-${index}`, conversationId: attempt.conversationId, sessionId: null, agentPath: attempt.agentPath, paneId: null, accountId: null, usageLimitedAccounts: [], flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null, startedAt: now, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null })) }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: now, closedAt: null,
  } as unknown as Pipeline;
}

test("admission planning covers roots and their children, skips held ones, gives a task-less pipeline one fallback task, and is bounded", () => {
  const entries = [
    entry(1),
    entry(2, { parent: "/fixture/projects/root/session-1.jsonl" }),
    entry(3, { path: "spawn:launch-3" }),
    entry(4, { root: "claude-tasks" }),
    entry(5),
    entry(6),
    entry(7),
  ];
  const held = task("held", "fixture", { assignments: [{ path: entries[4]!.path, conversationId: entries[4]!.conversationId!, panePid: null, state: "delivered", error: null, at: now }] });
  const p = pipeline("p1", [{ agentPath: entries[5]!.path, conversationId: entries[5]!.conversationId! }, { agentPath: entries[6]!.path, conversationId: entries[6]!.conversationId! }]);
  const plans = planAdmissions(entries, [held], [p]);
  expect(plans.map((plan) => [plan.origin.kind, plan.origin.key])).toEqual([["pipeline", "p1"], ["pipeline", "p1"], ["conversation", "conversation_fixture_1"], ["conversation", "conversation_fixture_2"]]);
  expect(plans[3]!.inherit).toEqual([{ conversationId: "conversation_fixture_1", path: entries[0]!.path }]);
  const admitted = admitConversations([held], plans, deps);
  expect(admitted.admitted).toBe(4);
  /* One fallback task for the pipeline with both stage conversations, one
     placeholder for the root conversation titled from its first prompt, and
     the child inside that same placeholder: its membership is canonical. */
  const fallback = admitted.tasks.find((candidate) => candidate.origin?.kind === "pipeline")!;
  expect(fallback.text).toBe("Pipeline p1 goal");
  expect(fallback.assignments.map((assignment) => assignment.path).sort()).toEqual([entries[5]!.path, entries[6]!.path].sort());
  const placeholder = admitted.tasks.find((candidate) => candidate.origin?.kind === "conversation")!;
  expect(placeholder.text).toBe(entries[0]!.title);
  expect(placeholder.assignments.map((assignment) => [assignment.conversationId, assignment.state])).toEqual([["conversation_fixture_1", "linked"], ["conversation_fixture_2", "linked"]]);
  expect(admitted.tasks.filter((candidate) => candidate.origin?.kind === "conversation").length).toBe(1);
  /* The child can now name the task it belongs to. */
  const refined = refineTask(admitted.tasks, { callerConversationId: "conversation_fixture_2", text: "Child names the task" });
  expect(refined.ok && refined.refined).toEqual([{ taskId: placeholder.id, result: "applied" }]);
  /* A second pass finds nothing left to admit; a pipeline that carries task ids covers its stages. */
  expect(planAdmissions(entries, admitted.tasks, [p])).toEqual([]);
  expect(planAdmissions([entry(8)], [], [pipeline("p2", [{ agentPath: entry(8).path, conversationId: entry(8).conversationId! }], ["some-task"])])).toEqual([]);
  /* Bounded: 1,000 imports arrive in batches and converge without duplicates. */
  const many = Array.from({ length: 1000 }, (_, index) => entry(100 + index));
  let tasks: BoardTask[] = [];
  let passes = 0;
  for (;;) {
    const batch = planAdmissions(many, tasks, []);
    if (!batch.length) break;
    expect(batch.length).toBeLessThanOrEqual(ADMISSION_BATCH);
    tasks = admitConversations(tasks, batch, deps).tasks;
    passes += 1;
  }
  expect(passes).toBe(Math.ceil(1000 / ADMISSION_BATCH));
  expect(tasks.length).toBe(1000);
  expect(new Set(tasks.map((candidate) => candidate.origin!.key)).size).toBe(1000);
});

test("the durable commit is serialized through the task file, replays safely and survives an interrupted pass", () => {
  const filePath = tmpFile();
  saveTasks([task("existing", "fixture")], filePath);
  const first = commitTaskMembership({ project: "fixture", origin: { kind: "launch", key: "attempt-9" }, title: "Trim the launch copy", identity: { clientAttemptId: "attempt-9", engine: "codex" } }, filePath);
  expect(first.ok && first.created.length).toBe(1);
  const second = commitTaskMembership({ project: "fixture", origin: { kind: "launch", key: "attempt-9" }, identity: { clientAttemptId: "attempt-9" } }, filePath);
  expect(second.ok && second.taskIds).toEqual(first.ok ? first.taskIds : []);
  expect(loadTasks(filePath).length).toBe(2);
  /* Scanned admission: an interrupted pass (only the first batch written) resumes from the file. */
  const entries = Array.from({ length: 120 }, (_, index) => entry(index));
  expect(admitScannedConversations(entries, [], filePath)).toBe(ADMISSION_BATCH);
  expect(admitScannedConversations(entries, [], filePath)).toBe(ADMISSION_BATCH);
  expect(admitScannedConversations(entries, [], filePath)).toBe(20);
  expect(admitScannedConversations(entries, [], filePath)).toBe(0);
  const stored = loadTasks(filePath);
  expect(stored.filter((candidate) => candidate.origin?.kind === "conversation").length).toBe(120);
  expect(stored.every((candidate) => candidate.assignments.every((assignment) => assignment.state !== "delivered" || candidate.id === "existing"))).toBe(true);
});

test("a retry keeps its original target set: the same attempt cannot be re-admitted against another task or gain a target", () => {
  const tasks = [task("a", "fixture"), task("b", "fixture")];
  const first = ensureTaskMembership(tasks, { project: "", origin: { kind: "launch", key: "attempt-t" }, identity: { clientAttemptId: "attempt-t" }, explicitTaskIds: ["a"] }, deps);
  expect(first.ok && first.taskIds).toEqual(["a"]);
  const moved = ensureTaskMembership(first.ok ? first.tasks : tasks, { project: "", origin: { kind: "launch", key: "attempt-t" }, identity: { clientAttemptId: "attempt-t" }, explicitTaskIds: ["b"] }, deps);
  expect(moved.ok).toBe(false);
  expect(!moved.ok && moved.status).toBe(409);
  const widened = ensureTaskMembership(first.ok ? first.tasks : tasks, { project: "", origin: { kind: "launch", key: "attempt-t" }, identity: { clientAttemptId: "attempt-t" }, explicitTaskIds: ["a", "b"] }, deps);
  expect(widened.ok).toBe(false);
  const same = ensureTaskMembership(first.ok ? first.tasks : tasks, { project: "", origin: { kind: "launch", key: "attempt-t" }, identity: { clientAttemptId: "attempt-t", launchId: "launch-t" }, explicitTaskIds: ["a"] }, deps);
  expect(same.ok && same.taskIds).toEqual(["a"]);
  expect(same.ok && same.tasks.find((candidate) => candidate.id === "b")!.assignments).toEqual([]);
  /* A launch admitted without a target (placeholder) cannot acquire one on retry. */
  const placeholder = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-p" }, identity: { clientAttemptId: "attempt-p" } }, deps);
  const retargeted = ensureTaskMembership(placeholder.ok ? placeholder.tasks : [], { project: "", origin: { kind: "launch", key: "attempt-p" }, identity: { clientAttemptId: "attempt-p" }, explicitTaskIds: ["a"] }, deps);
  expect(retargeted.ok).toBe(false);
});

test("a launch whose identity write was lost is repaired from the transcript's receipt keys instead of minting a second task", () => {
  const committed = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-lost" }, title: "Seat the successor", identity: { clientAttemptId: "attempt-lost", engine: "claude" } }, deps);
  const tasks = committed.ok ? committed.tasks : [];
  const arrived = entry(500, { spawn: { launchId: "launch-lost", clientAttemptId: "attempt-lost", accountId: null, state: "recovered" } } as Partial<FileEntry>);
  const plans = planAdmissions([arrived], tasks, []);
  expect(plans.length).toBe(1);
  expect(plans[0]!.explicitTaskIds).toEqual(committed.ok ? committed.taskIds : []);
  expect(plans[0]!.identity).toMatchObject({ launchId: "launch-lost", clientAttemptId: "attempt-lost", conversationId: "conversation_fixture_500", path: arrived.path });
  const repaired = admitConversations(tasks, plans, deps);
  expect(repaired.tasks.length).toBe(1);
  expect(repaired.tasks[0]!.assignments).toEqual([expect.objectContaining({ clientAttemptId: "attempt-lost", launchId: "launch-lost", conversationId: "conversation_fixture_500", path: arrived.path, state: "linked" })]);
  expect(planAdmissions([arrived], repaired.tasks, [])).toEqual([]);
});

test("the first-action refinement names a pending placeholder once: replay returns the prior result, a second text is already-named, a stranger is refused, an operator edit wins", () => {
  const admitted = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-r" }, title: "raw prompt line that is long", identity: { clientAttemptId: "attempt-r", launchId: "launch-r", conversationId: "conversation_agent" } }, deps);
  const tasks = admitted.ok ? admitted.tasks : [];
  const taskId = admitted.ok ? admitted.taskIds[0]! : "";
  expect(tasks[0]!.origin?.refinement).toBe("pending");
  const stranger = refineTask(tasks, { callerConversationId: "conversation_other", text: "Hijack" });
  expect(stranger.ok).toBe(false);
  expect(!stranger.ok && stranger.status).toBe(404);
  const strangerExplicit = refineTask(tasks, { callerConversationId: "conversation_other", taskId, text: "Hijack" });
  expect(!strangerExplicit.ok && strangerExplicit.status).toBe(403);
  const first = refineTask(tasks, { callerConversationId: "conversation_agent", text: "Restore search results\nRe-index the catalog and verify the results page.\nA third line is dropped." }, now);
  expect(first.ok && first.refined).toEqual([{ taskId, result: "applied" }]);
  const named = first.ok ? first.tasks : tasks;
  expect(named[0]!.text).toBe("Restore search results\nRe-index the catalog and verify the results page.\nA third line is dropped.");
  const four = refineTask(tasks, { callerConversationId: "conversation_agent", text: "Title\none\ntwo\nthree" }, now);
  expect(four.ok && four.tasks[0]!.text).toBe("Title\none\ntwo");
  expect(named[0]!.origin).toMatchObject({ refinement: "titled", refinedBy: "conversation_agent" });
  const replay = refineTask(named, { callerConversationId: "conversation_agent", text: "Restore search results\nRe-index the catalog and verify the results page.\nA third line is dropped." });
  expect(replay.ok && replay.refined).toEqual([{ taskId, result: "replayed" }]);
  const second = refineTask(named, { callerConversationId: "conversation_agent", text: "Something else" });
  expect(second.ok && second.refined).toEqual([{ taskId, result: "already-named" }]);
  expect((second.ok ? second.tasks : named)[0]!.text).toBe(named[0]!.text);
  /* An operator edit on a pending placeholder names it; the agent then gets already-named. */
  const fresh = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-o" }, identity: { clientAttemptId: "attempt-o", conversationId: "conversation_agent_2" } }, deps);
  const edited = patchTask(fresh.ok ? fresh.tasks : [], fresh.ok ? fresh.taskIds[0]! : "", { text: "Operator's own title" }, now);
  expect(edited.ok && edited.task.origin?.refinement).toBe("titled");
  const late = refineTask(edited.ok ? edited.tasks : [], { callerConversationId: "conversation_agent_2", text: "Agent title" });
  expect(late.ok && late.refined[0]!.result).toBe("already-named");
  expect(late.ok && late.tasks[0]!.text).toBe("Operator's own title");
  /* A long first line is shortened; empty text refuses. */
  const long = refineTask(tasks, { callerConversationId: "conversation_agent", text: "x".repeat(120) });
  expect(long.ok && long.tasks[0]!.text.length).toBe(80);
  expect(refineTask(tasks, { callerConversationId: "conversation_agent", text: "   " }).ok).toBe(false);
});

test("a resume successor keeps its conversation's task: the new launch id resolves by the canonical conversation id, and the original launch record stays", () => {
  const first = ensureTaskMembership([], { project: "fixture", origin: { kind: "launch", key: "attempt-r" }, title: "Resume me", identity: { clientAttemptId: "attempt-r", launchId: "launch-r1", conversationId: "conversation_r", engine: "codex" } }, deps);
  if (!first.ok) throw new Error(first.error);
  /* The successor reserves a fresh launch id (no client attempt) for the same
     conversation, from a checkout the scanner files under another project. */
  const resumed = ensureTaskMembership(first.tasks, { project: "other-checkout", origin: { kind: "launch", key: "launch-r2" }, identity: { launchId: "launch-r2", conversationId: "conversation_r", engine: "codex" } }, deps);
  if (!resumed.ok) throw new Error(resumed.error);
  expect(resumed.created).toEqual([]);
  expect(resumed.taskIds).toEqual(first.taskIds);
  expect(resumed.tasks.length).toBe(1);
  expect(resumed.tasks[0]!.assignments).toEqual([expect.objectContaining({ launchId: "launch-r1", clientAttemptId: "attempt-r", conversationId: "conversation_r", state: "linked" })]);
  /* Replaying the successor's own reservation converges the same way. */
  const replay = ensureTaskMembership(resumed.tasks, { project: "fixture", origin: { kind: "launch", key: "launch-r2" }, identity: { launchId: "launch-r2", conversationId: "conversation_r" } }, deps);
  expect(replay.ok && replay.changed).toBe(false);
  expect(replay.ok && replay.taskIds).toEqual(first.taskIds);
});

test("a reviewer joins the task the reviewed implementer holds; without one, the flow fallback binds implementer and reviewer together", () => {
  const implementer = { conversationId: "conversation_impl", path: "/fixture/impl.jsonl" };
  const held = ensureTaskMembership([], { project: "fixture", origin: { kind: "conversation", key: implementer.conversationId }, title: "Ship the thing", identity: implementer }, deps);
  if (!held.ok) throw new Error(held.error);
  const reviewer = ensureTaskMembership(held.tasks, { project: "fixture", origin: { kind: "flow", key: "flow-1" }, identity: { launchId: "launch-rev-1", conversationId: "conversation_rev1", clientAttemptId: "flow_flow-1_a" }, inherit: [implementer] }, deps);
  if (!reviewer.ok) throw new Error(reviewer.error);
  expect(reviewer.created).toEqual([]);
  expect(reviewer.taskIds).toEqual(held.taskIds);
  expect(reviewer.tasks[0]!.assignments.map((assignment) => assignment.conversationId)).toEqual(["conversation_impl", "conversation_rev1"]);
  /* Round two of the same flow lands in the same task. */
  const second = ensureTaskMembership(reviewer.tasks, { project: "fixture", origin: { kind: "flow", key: "flow-1" }, identity: { launchId: "launch-rev-2", conversationId: "conversation_rev2", clientAttemptId: "flow_flow-1_b" }, inherit: [implementer] }, deps);
  expect(second.ok && second.taskIds).toEqual(held.taskIds);
  expect(second.ok && second.tasks.length).toBe(1);

  /* An implementer nobody admitted yet: the fallback names the whole exchange. */
  const orphan = { conversationId: "conversation_legacy", path: "/fixture/legacy.jsonl" };
  const fallback = ensureTaskMembership([], { project: "fixture", origin: { kind: "flow", key: "flow-2" }, title: "Review flow", identity: { launchId: "launch-rev-3", conversationId: "conversation_rev3" }, inherit: [orphan] }, deps);
  if (!fallback.ok) throw new Error(fallback.error);
  expect(fallback.created.length).toBe(1);
  expect(fallback.tasks[0]!.origin).toEqual({ kind: "flow", key: "flow-2", refinement: "pending" });
  expect(fallback.tasks[0]!.assignments.map((assignment) => [assignment.conversationId, assignment.state])).toEqual([["conversation_rev3", "linked"], ["conversation_legacy", "linked"]]);
  const later = ensureTaskMembership(fallback.tasks, { project: "fixture", origin: { kind: "flow", key: "flow-2" }, identity: { launchId: "launch-rev-4", conversationId: "conversation_rev4" }, inherit: [orphan] }, deps);
  expect(later.ok && later.created).toEqual([]);
  expect(later.ok && later.tasks.length).toBe(1);
});

test("a child is planned only once its parent is covered, follows a parent planned earlier in the pass, and a child of a removed parent gets its own placeholder", () => {
  const root = entry(20);
  const child = entry(21, { parent: root.path });
  const grandchild = entry(22, { parent: child.path });
  const orphan = entry(23, { parent: "/fixture/projects/root/gone.jsonl" });
  /* Children listed before their parent wait for the pass that covers it;
     the orphan's parent is gone, so it stands on its own. */
  const first = planAdmissions([grandchild, child, orphan, root], [], [], 3);
  expect(first.map((plan) => plan.identity.conversationId)).toEqual(["conversation_fixture_20", "conversation_fixture_21", "conversation_fixture_23"]);
  expect(first[1]!.inherit).toEqual([{ conversationId: "conversation_fixture_20", path: root.path }]);
  expect(first[2]!.inherit).toBeUndefined();
  let tasks = admitConversations([], first, deps).tasks;
  expect(tasks.map((task) => task.assignments.map((assignment) => assignment.conversationId))).toEqual([["conversation_fixture_20", "conversation_fixture_21"], ["conversation_fixture_23"]]);
  const second = planAdmissions([grandchild, child, orphan, root], tasks, []);
  expect(second.map((plan) => plan.identity.conversationId)).toEqual(["conversation_fixture_22"]);
  expect(second[0]!.inherit).toEqual([{ conversationId: "conversation_fixture_21", path: child.path }]);
  tasks = admitConversations(tasks, second, deps).tasks;
  expect(tasks.length).toBe(2);
  expect(tasks[0]!.assignments.map((assignment) => assignment.conversationId)).toEqual(["conversation_fixture_20", "conversation_fixture_21", "conversation_fixture_22"]);
  expect(planAdmissions([grandchild, child, orphan, root], tasks, [])).toEqual([]);
});
