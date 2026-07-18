import { describe, expect, test } from "bun:test";

import type { TaskAssignment } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { assignmentAgentState, assignmentOpenable } from "./assignmentState";

function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return { path: "/agent.jsonl", panePid: null, state: "delivered", error: null, at: "2026-07-18T00:00:00.000Z", ...overrides };
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/agent.jsonl",
    root: "codex-sessions",
    name: "agent.jsonl",
    project: "project",
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
    ...overrides,
  };
}

describe("assignmentAgentState", () => {
  test("a pathless in-flight launch is spawning", () => {
    expect(assignmentAgentState(assignment({ path: null, state: "spawning" }), null)).toBe("spawning");
  });

  test("failure wins before path attribution and never becomes a spinner", () => {
    expect(assignmentAgentState(assignment({ path: null, state: "failed", error: "no pane" }), null)).toBe("failed");
    expect(assignmentAgentState(assignment({ state: "failed", error: "delivery failed" }), file())).toBe("failed");
  });

  test("an unresolved delivered assignment is gone", () => {
    expect(assignmentAgentState(assignment(), null)).toBe("gone");
  });

  test("running and recently active agents are live", () => {
    expect(assignmentAgentState(assignment(), file({ proc: "running", activity: "idle" }))).toBe("live");
    expect(assignmentAgentState(assignment(), file({ proc: null, activity: "recent" }))).toBe("live");
    expect(assignmentAgentState(assignment(), file({ proc: "running", activity: "stalled" }))).toBe("live");
  });

  test("migration, killed, and unhosted classifications stay truthful", () => {
    const migration = { intentId: "i", trigger: "manual", phase: "preparing", targetAccountId: "account", failure: null } as FileEntry["migration"];
    expect(assignmentAgentState(assignment(), file({ migration }))).toBe("migrating");
    expect(assignmentAgentState(assignment(), file({ proc: "killed", activity: "idle" }))).toBe("killed");
    expect(assignmentAgentState(assignment(), file({ proc: null, activity: "idle" }))).toBe("unhosted");
    expect(assignmentAgentState(assignment(), file({ proc: null, activity: "stalled" }))).toBe("unhosted");
    expect(assignmentAgentState(assignment(), file({ proc: "done", activity: "idle" }))).toBe("unhosted");
  });

  test("every present transcript state is openable — including stalled and idle hosts (fresh-review Finding 1)", () => {
    /* A resolved transcript is board content with a pane to center on, whatever
       its host process is doing. */
    for (const state of ["live", "killed", "unhosted"] as const) {
      expect(assignmentOpenable(state)).toBe(true);
    }
    expect(assignmentOpenable(assignmentAgentState(assignment(), file({ proc: null, activity: "stalled" })))).toBe(true);
    expect(assignmentOpenable(assignmentAgentState(assignment(), file({ proc: null, activity: "idle" })))).toBe(true);
  });

  test("open stays unavailable without a resolvable pane: spawning, failed, gone, migrating", () => {
    for (const state of ["spawning", "failed", "gone", "migrating"] as const) {
      expect(assignmentOpenable(state)).toBe(false);
    }
  });
});
