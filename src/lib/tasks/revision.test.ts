import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-revision-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
const { loadTasks, saveTasks, saveTasksFile, mutateTasks, mutateTasksFile, TASKS_FILE } = await import("./store");
const { patchTask, applyAssignmentPatches, removeAssignment } = await import("./commands");
const { taskRevision } = await import("./revision");
const { createServerRuntimeConsumers } = await import("@/lib/runtime/serverConsumers");
import type { BoardTask } from "./types";
const now = "2026-09-01T00:00:00.000Z";
function row(id = "task-a"): BoardTask {
  return { id, project: "fixture-project", text: "A", placement: "pinned", pos: { x: 0, y: -1.5 },
    status: "inbox", assignments: [], createdAt: now, updatedAt: now };
}
function file() { return path.join(sandbox, `${crypto.randomUUID()}.json`); }
function patch(filePath: string, input: Parameters<typeof patchTask>[2]) {
  return mutateTasks(tasks => {
    const result = patchTask(tasks, "task-a", input, now);
    return { tasks: result.ok ? result.tasks : undefined, result };
  }, filePath);
}

test("all four writers advance generations; ABA, identical writes and recreation cannot reuse tokens", () => {
  const f = file();
  saveTasks([row(), row("untouched")], f);
  const other = loadTasks(f)[1];
  const seen = new Set<string>();
  const remember = () => { const token = taskRevision(loadTasks(f)[0]!); expect(seen.has(token)).toBe(false); seen.add(token); };
  remember();
  for (const text of ["B", "A", "A"]) { expect(patch(f, { text }).ok).toBe(true); remember(); }
  for (const pos of [{ x: 5, y: 8 }, { x: 0, y: -1.5 }]) { patch(f, { pos }); remember(); }
  mutateTasks(tasks => {
    const r = applyAssignmentPatches(tasks, "task-a", [{ path: "fixture.jsonl", panePid: null, state: "spawning", error: null, at: now }], now);
    if (!r.ok) throw new Error(r.error);
    return { tasks: r.tasks, result: r.task };
  }, f); remember();
  mutateTasks(tasks => { const r = removeAssignment(tasks, "task-a", "fixture.jsonl", now); if (!r.ok) throw new Error(r.error); return { tasks: r.tasks, result: r.task }; }, f); remember();
  mutateTasksFile(state => { state.tasks[0]!.text = "in-place"; return { state, result: undefined }; }, f); remember();
  const saved = loadTasks(f); saved[0]!.text = "whole-list"; saveTasks(saved, f); remember();
  const savedFile = { tasks: loadTasks(f), recentCreates: [] }; savedFile.tasks[0]!.text = "whole-file"; saveTasksFile(savedFile, f); remember();
  expect(loadTasks(f)[1]).toEqual(other);
  for (const token of seen) {
    const before = fs.readFileSync(f, "utf8");
    if (token === taskRevision(loadTasks(f)[0]!)) continue;
    expect(patch(f, { pos: { x: 1, y: 1 }, expectedProject: "fixture-project", expectedRevision: token }).ok).toBe(false);
    expect(fs.readFileSync(f, "utf8")).toBe(before);
  }
  mutateTasks(tasks => ({ tasks: tasks.filter(t => t.id !== "task-a"), result: undefined }), f);
  mutateTasks(tasks => ({ tasks: [row(), ...tasks], result: undefined }), f); remember();
});

test("legacy reads are stable and read-only; first update persists a generation and retains extension fields", () => {
  const f = file();
  const legacy = { ...row(), extension: { retained: [1, 2] } };
  const untouched = { ...row("untouched"), extension: "keep" };
  const raw = { tasks: [legacy, untouched], recentCreates: [{ clientRequestId: "old", taskId: "task-a" }] };
  fs.writeFileSync(f, JSON.stringify(raw));
  const bytes = fs.readFileSync(f, "utf8");
  const token = taskRevision(loadTasks(f)[0]!);
  expect(token.startsWith("task-legacy:")).toBe(true);
  expect(taskRevision(loadTasks(f)[0]!)).toBe(token);
  expect(fs.readFileSync(f, "utf8")).toBe(bytes);
  expect(patch(f, { text: "B", expectedProject: "fixture-project", expectedRevision: token }).ok).toBe(true);
  patch(f, { text: "A" });
  expect(taskRevision(loadTasks(f)[0]!)).not.toBe(token);
  const persisted = JSON.parse(fs.readFileSync(f, "utf8"));
  expect(persisted.tasks[0].extension).toEqual(legacy.extension);
  expect(persisted.tasks[1]).toEqual(untouched);
  expect(persisted.recentCreates).toEqual(raw.recentCreates);
});

test("corrupt, null, malformed revisions, duplicate ids and unreadable state never authorize a write", () => {
  for (const raw of ["{", "null", JSON.stringify({ tasks: [{ ...row(), revision: "bad" }] }), JSON.stringify({ tasks: [row(), row()] }), JSON.stringify({ tasks: [{ id: "invalid" }] })]) {
    const f = file(); fs.writeFileSync(f, raw);
    let called = false;
    expect(() => mutateTasks(tasks => { called = true; return { tasks, result: null }; }, f)).toThrow();
    expect(called).toBe(false);
    expect(() => saveTasks([row()], f)).toThrow();
    expect(() => saveTasksFile({ tasks: [row()], recentCreates: [] }, f)).toThrow();
    expect(fs.readFileSync(f, "utf8")).toBe(raw);
  }
  const directory = file(); fs.mkdirSync(directory);
  expect(() => saveTasks([row()], directory)).toThrow();
});

test("actual runtime acknowledgment invalidates the token after nested in-place assignment mutation", () => {
  expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);
  const task = row(); task.assignments = [{ path: "fixture.jsonl", panePid: null, state: "spawning", error: null, at: now }];
  saveTasks([task]);
  const token = taskRevision(loadTasks()[0]!);
  const result = createServerRuntimeConsumers().taskDeliveryAcknowledged("task-a", "fixture.jsonl");
  expect(result).toBeDefined();
  expect(loadTasks()[0]!.assignments[0]!.state).toBe("delivered");
  expect(taskRevision(loadTasks()[0]!)).not.toBe(token);
  expect(patch(TASKS_FILE, { pos: { x: 1, y: 1 }, expectedProject: "fixture-project", expectedRevision: token }).ok).toBe(false);
});


test("actual reconciliation invalidates a previous placement token", async () => {
  const { reconcileTasks } = await import("./reconcile");
  const f = file(); const initial = row();
  initial.assignments = [{ path: null, panePid: 123, state: "spawning", error: null, at: now }];
  saveTasks([initial], f); const token = taskRevision(loadTasks(f)[0]!);
  mutateTasks(tasks => {
    const outcome = reconcileTasks([], tasks, { panePidAlive: () => false, now: () => now });
    return { tasks: outcome.dirty ? outcome.tasks : undefined, result: outcome };
  }, f);
  expect(loadTasks(f)[0]!.assignments[0]!.state).toBe("failed");
  expect(patch(f, { pos: { x: 2, y: 3 }, expectedProject: "fixture-project", expectedRevision: token }).ok).toBe(false);
});
