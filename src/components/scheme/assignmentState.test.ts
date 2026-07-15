import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { TaskAssignment } from "@/lib/tasks/types";

import { assignmentAgentState, assignmentOpenable } from "./assignmentState";

function assignment(over: Partial<TaskAssignment> = {}): TaskAssignment {
  return { path: "/a.jsonl", panePid: null, state: "delivered", error: null, at: "2026-07-15T00:00:00.000Z", ...over };
}

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/a.jsonl",
    root: "codex-sessions",
    name: "a.jsonl",
    project: "p",
    title: "Agent",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: 1,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  };
}

describe("assignmentAgentState — truthful per-agent states (issue #292)", () => {
  test("spawning is only a pathless in-flight spawn", () => {
    expect(assignmentAgentState(assignment({ path: null, state: "spawning" }), null)).toBe("spawning");
  });

  test("failed is an error even before a path is attributed (no spinner)", () => {
    expect(assignmentAgentState(assignment({ path: null, state: "failed", error: "no pane" }), null)).toBe("failed");
    expect(assignmentAgentState(assignment({ state: "failed", error: "x" }), file())).toBe("failed");
  });

  test("failed wins over a spawning flag when both could apply", () => {
    /* A retried spawn that failed must surface the failure with no spinner. */
    expect(assignmentAgentState(assignment({ path: null, state: "failed" }), null)).toBe("failed");
  });

  test("delivered/handoff with no resolvable current generation is gone", () => {
    expect(assignmentAgentState(assignment({ state: "delivered" }), null)).toBe("gone");
    expect(assignmentAgentState(assignment({ state: "handoff" }), null)).toBe("gone");
  });

  test("a resolvable running/active agent is live", () => {
    expect(assignmentAgentState(assignment({ state: "delivered" }), file({ proc: "running" }))).toBe("live");
    expect(assignmentAgentState(assignment({ state: "handoff" }), file({ proc: null, activity: "live" }))).toBe("live");
    expect(assignmentAgentState(assignment({ state: "delivered" }), file({ proc: null, activity: "recent" }))).toBe("live");
  });

  test("migration outranks proc/activity — the pane is moving", () => {
    const migrating = file({ proc: "running", migration: { intentId: "i", trigger: "manual", phase: "preparing", targetAccountId: "acc", failure: null } as FileEntry["migration"] });
    expect(assignmentAgentState(assignment(), migrating)).toBe("migrating");
  });

  test("a killed process is killed", () => {
    expect(assignmentAgentState(assignment(), file({ proc: "killed", activity: "idle" }))).toBe("killed");
  });

  test("a resolvable but idle/stalled agent with no live process is unhosted", () => {
    expect(assignmentAgentState(assignment(), file({ proc: null, activity: "idle" }))).toBe("unhosted");
    expect(assignmentAgentState(assignment(), file({ proc: "done", activity: "stalled" }))).toBe("unhosted");
  });

  test("open is enabled only for a live current agent", () => {
    for (const s of ["spawning", "failed", "gone", "migrating", "killed", "unhosted"] as const) {
      expect(assignmentOpenable(s)).toBe(false);
    }
    expect(assignmentOpenable("live")).toBe(true);
  });
});
