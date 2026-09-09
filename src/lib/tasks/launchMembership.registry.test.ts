import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { BoardTask } from "@/lib/tasks/types";

/**
 * The launch boundary against the real registry and the real task store
 * (#1586): a dedicated task launch joins its task and nothing else, a resume
 * successor keeps its conversation's task, and a queued pinned receipt that is
 * recovered for its first execution passes the membership prerequisite before
 * anything is actuated — an unavailable store fails the launch instead.
 */

const previousStateDir = process.env.LLV_STATE_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-launch-membership-"));
process.env.LLV_STATE_DIR = stateDir;
const { AgentRegistry } = await import("@/lib/agent/registry");
const { loadTasks, saveTasks, TASKS_FILE } = await import("@/lib/tasks/store");
const { terminalizeStaleStructuredSpawns } = await import("@/lib/runtime/structuredSpawn");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const now = "2026-09-09T12:00:00.000Z";
const project = "fixture-project";
function task(id: string, text: string, assignments: BoardTask["assignments"] = []): BoardTask {
  return { id, project, status: "inbox", text, placement: "unplaced", assignments, createdAt: now, updatedAt: now };
}
function registryAt(name: string) {
  return new AgentRegistry(path.join(stateDir, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
}
const holders = (conversationId: string) => loadTasks().filter((candidate) => candidate.assignments.some((assignment) => assignment.conversationId === conversationId)).map((candidate) => candidate.id);

test("a dedicated task launch joins exactly its task at the reservation; the replay and the resume successor stay there", () => {
  saveTasks([task("dedicated", "Dedicated task")]);
  const registry = registryAt("dedicated");
  const begun = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_1", requestDigest: "a".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["dedicated"] });
  if (begun.kind !== "created") throw new Error("expected a fresh reservation");
  expect(loadTasks().length).toBe(1);
  expect(holders(begun.receipt.conversationId)).toEqual(["dedicated"]);
  expect(loadTasks()[0]!.assignments).toEqual([expect.objectContaining({ launchId: begun.receipt.launchId, clientAttemptId: "task_dedicated_attempt_1", conversationId: begun.receipt.conversationId, state: "linked" })]);

  const replay = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_1", requestDigest: "a".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["dedicated"] });
  expect(replay.kind).toBe("replay");
  expect(loadTasks().length).toBe(1);

  /* The conversation settles, then resumes with a fresh launch id. */
  const settled = registry.ensureConversation("claude", path.join(stateDir, "dedicated.jsonl"), null);
  saveTasks([task("dedicated", "Dedicated task", [{ launchId: begun.receipt.launchId, clientAttemptId: "task_dedicated_attempt_1", path: path.join(stateDir, "dedicated.jsonl"), conversationId: settled.id, panePid: null, state: "delivered", error: null, at: now }])]);
  const resumed = registry.beginSpawnRequest({ engine: "claude", cwd: path.join(stateDir, "another-checkout"), transport: "structured", conversationId: settled.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }) });
  if (resumed.kind !== "created") throw new Error("expected the resume reservation");
  expect(resumed.receipt.conversationId).toBe(settled.id);
  expect(loadTasks().length).toBe(1);
  expect(holders(settled.id)).toEqual(["dedicated"]);
  expect(loadTasks()[0]!.assignments).toEqual([expect.objectContaining({ launchId: begun.receipt.launchId, conversationId: settled.id, state: "delivered" })]);

  /* A missing target aborts the reservation: no receipt survives, no task is minted. */
  expect(() => registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_2", requestDigest: "b".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["deleted-task"] })).toThrow("task deleted-task is not available");
  expect(registry.spawnReceiptForClientAttempt("task_dedicated_attempt_2")).toMatchObject({ state: "failed" });
  expect(loadTasks().length).toBe(1);
});

function queuedTmuxReceipt(registry: InstanceType<typeof AgentRegistry>, attempt: string, retryAt: string, taskIds?: string[]) {
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd: stateDir,
    transport: "tmux",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: attempt,
    requestDigest: "c".repeat(64),
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Queued work" }),
    launchDisplay: { prompt: "Continue the queued work", images: 0, echo: "Continue the queued work" },
    ...(taskIds ? { taskIds } : {}),
  });
  if (begun.kind !== "created") throw new Error("expected queued receipt creation");
  registry.queuePinnedSpawn(begun.receipt.launchId, {
    version: 1,
    retryAt,
    accountId: "account-a",
    locale: "en",
    spec: { engine: "claude", command: "claude", cwd: stateDir, windowName: "queued-pin", launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Queued work" }) },
    ["prompt"]: "Continue the queued work",
    imageRefs: [],
    parentArtifactPath: null,
    pipelineSourceConversationId: null,
  }, `Pinned account quota is exhausted — queued until ${retryAt}`);
  return begun.receipt;
}

const account = { engine: "claude" as const, accountId: "account-a", kind: "managed" as const, home: path.join(stateDir, "account-a"), transcriptRoot: path.join(stateDir, "account-a", "projects"), env: { NODE_ENV: "test" as const } };

test("a queued pinned launch recovered for its first execution keeps the membership recorded at reservation, and a deleted target is replaced before actuation", async () => {
  saveTasks([task("queued-target", "Target of a queued launch")]);
  const registry = registryAt("queued");
  const retryAt = new Date(Date.now() - 1_000).toISOString();
  const kept = queuedTmuxReceipt(registry, "queued_kept_attempt", retryAt, ["queued-target"]);
  const orphaned = queuedTmuxReceipt(registry, "queued_orphaned_attempt", retryAt, ["queued-target"]);
  expect(holders(kept.conversationId)).toEqual(["queued-target"]);
  /* The second launch loses its membership row while it waits in the queue
     (its target deleted, or its write lost); the first keeps its row. */
  saveTasks(loadTasks().map((candidate) => ({ ...candidate, assignments: candidate.assignments.filter((assignment) => assignment.conversationId !== orphaned.conversationId) })));
  const spawned: string[] = [];
  const restarted = registryAt("queued");
  const tick = await terminalizeStaleStructuredSpawns(restarted, null, {
    now: () => Date.now(),
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    spawnTmuxAgent: async (_spec, _prompt, receipt) => {
      spawned.push(receipt?.launchId ?? "unknown");
      throw new Error("stop at the actuation seam");
    },
  });
  expect(tick.examined).toBe(2);
  expect(spawned.sort()).toEqual([kept.launchId, orphaned.launchId].sort());
  expect(loadTasks().length).toBe(2);
  expect(holders(kept.conversationId)).toEqual(["queued-target"]);
  const replacement = loadTasks().find((candidate) => candidate.id !== "queued-target")!;
  expect(replacement.origin).toEqual({ kind: "launch", key: "queued_orphaned_attempt", refinement: "pending" });
  expect(holders(orphaned.conversationId)).toEqual([replacement.id]);
});

test("an unavailable task store keeps a recovered queued launch from executing: the receipt fails and no agent is started", async () => {
  saveTasks([]);
  const registry = registryAt("queued-unavailable");
  const receipt = queuedTmuxReceipt(registry, "queued_unavailable_attempt", new Date(Date.now() - 1_000).toISOString());
  expect(loadTasks().length).toBe(1);
  /* The store becomes unreadable between reservation and recovery. */
  const backup = fs.readFileSync(TASKS_FILE);
  fs.rmSync(TASKS_FILE);
  fs.mkdirSync(TASKS_FILE);
  try {
    const spawned: string[] = [];
    const restarted = registryAt("queued-unavailable");
    const tick = await terminalizeStaleStructuredSpawns(restarted, null, {
      now: () => Date.now(),
      resolveSpawnAccount: () => account,
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async (_spec, _prompt, claimed) => {
        spawned.push(claimed?.launchId ?? "unknown");
        throw new Error("an agent must not start outside every task");
      },
    });
    expect(tick).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
    expect(spawned).toEqual([]);
    const failed = restarted.snapshot().receipts[receipt.launchId]!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("task membership could not be recorded");
  } finally {
    fs.rmSync(TASKS_FILE, { recursive: true, force: true });
    fs.writeFileSync(TASKS_FILE, backup);
  }
});
