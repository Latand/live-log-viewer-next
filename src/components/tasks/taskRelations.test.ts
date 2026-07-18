import { describe, expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { taskRelationsByPath } from "./taskRelations";

function file(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "project",
    title: path,
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

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    project: "project",
    status: "assigned",
    text: `${overrides.id} title\nbody`,
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  } as BoardTask;
}

const assignment = (overrides: Partial<BoardTask["assignments"][number]>) => ({
  path: null,
  conversationId: null,
  panePid: null,
  state: "delivered" as const,
  error: null,
  at: "2026-07-18T00:00:00.000Z",
  ...overrides,
});

describe("taskRelationsByPath", () => {
  test("an assignment resolves through the durable conversation id to the current generation", () => {
    const current = file("/current.jsonl", { conversationId: "conversation-1" });
    const relations = taskRelationsByPath(
      [current],
      [task({ id: "t1", assignments: [assignment({ path: "/archived.jsonl", conversationId: "conversation-1" })] })],
    );
    expect(relations.get("/current.jsonl")?.map((entry) => [entry.task.id, entry.relation])).toEqual([["t1", "assignment"]]);
    expect(relations.has("/archived.jsonl")).toBe(false);
  });

  test("a path-only assignment and a source relation land on their panes", () => {
    const agent = file("/agent.jsonl");
    const origin = file("/origin.jsonl");
    const relations = taskRelationsByPath(
      [agent, origin],
      [
        task({ id: "t1", assignments: [assignment({ path: "/agent.jsonl" })] }),
        task({ id: "t2", source: { path: "/origin.jsonl", ts: null, text: "captured", fingerprint: "f1", engine: "codex" } }),
      ],
    );
    expect(relations.get("/agent.jsonl")?.map((entry) => entry.task.id)).toEqual(["t1"]);
    expect(relations.get("/origin.jsonl")?.map((entry) => [entry.task.id, entry.relation])).toEqual([["t2", "source"]]);
  });

  test("assignment outranks source on the same pane and each task appears once", () => {
    const agent = file("/agent.jsonl");
    const relations = taskRelationsByPath(
      [agent],
      [task({
        id: "t1",
        assignments: [assignment({ path: "/agent.jsonl" })],
        source: { path: "/agent.jsonl", ts: null, text: "captured", fingerprint: "f2", engine: "codex" },
      })],
    );
    expect(relations.get("/agent.jsonl")?.map((entry) => [entry.task.id, entry.relation])).toEqual([["t1", "assignment"]]);
  });

  test("assignments order before sources; done tasks and unknown targets stay absent", () => {
    const agent = file("/agent.jsonl");
    const relations = taskRelationsByPath(
      [agent],
      [
        task({ id: "captured", source: { path: "/agent.jsonl", ts: null, text: "captured", fingerprint: "f2", engine: "codex" } }),
        task({ id: "assigned", assignments: [assignment({ path: "/agent.jsonl" })] }),
        task({ id: "finished", status: "done", assignments: [assignment({ path: "/agent.jsonl" })] }),
        task({ id: "elsewhere", assignments: [assignment({ path: "/missing.jsonl" })] }),
      ],
    );
    expect(relations.get("/agent.jsonl")?.map((entry) => entry.task.id)).toEqual(["assigned", "captured"]);
    expect(relations.has("/missing.jsonl")).toBe(false);
  });
});
