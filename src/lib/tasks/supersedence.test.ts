import { expect, test } from "bun:test";

import type { BoardTask } from "./types";
import { projectSupersededTaskHandoffs } from "./supersedence";

function task(assignments: BoardTask["assignments"]): BoardTask {
  return {
    id: "t1",
    project: "viewer",
    status: "assigned",
    text: "Ship #383",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
  } as BoardTask;
}

const AT = "2026-07-18T13:37:51.000Z";

function conversations() {
  return {
    conversation_one: {
      id: "conversation_one" as const,
      supersededBy: { conversationId: "conversation_two" as const, at: AT, reason: "recovery-spawn" as const },
      generations: [{ path: "/one.jsonl" }] as never,
    },
    conversation_two: {
      id: "conversation_two" as const,
      supersededBy: { conversationId: "conversation_three" as const, at: AT, reason: "stage-retry" as const },
      generations: [{ path: "/two.jsonl" }] as never,
    },
    conversation_three: {
      id: "conversation_three" as const,
      supersededBy: null,
      generations: [{ path: "/three.jsonl" }] as never,
    },
  };
}

test("a task assigned to a superseded round projects one handoff for the live chain end", () => {
  const source = task([{ path: "/one.jsonl", conversationId: "conversation_one", panePid: null, state: "delivered", error: null, at: AT }]);
  const projected = projectSupersededTaskHandoffs([source], conversations(), (id) => id);

  expect(projected[0]!.assignments).toHaveLength(2);
  expect(projected[0]!.assignments.at(-1)).toMatchObject({
    conversationId: "conversation_three",
    path: "/three.jsonl",
    state: "handoff",
    panePid: null,
  });
  /* Append-only overlay: the original assignment record is untouched. */
  expect(projected[0]!.assignments[0]).toBe(source.assignments[0]);
  expect(source.assignments).toHaveLength(1);
});

test("tasks already holding the chain end, or without superseded assignments, pass through unchanged", () => {
  const settled = task([
    { path: "/one.jsonl", conversationId: "conversation_one", panePid: null, state: "delivered", error: null, at: AT },
    { path: "/three.jsonl", conversationId: "conversation_three", panePid: null, state: "delivered", error: null, at: AT },
  ]);
  const quiet = task([{ path: "/three.jsonl", conversationId: "conversation_three", panePid: null, state: "delivered", error: null, at: AT }]);

  expect(projectSupersededTaskHandoffs([settled], conversations(), (id) => id)[0]).toBe(settled);
  expect(projectSupersededTaskHandoffs([quiet], conversations(), (id) => id)[0]).toBe(quiet);
});

test("a dangling chain inherits nothing (fail open) and a cycle never hangs", () => {
  const dangling = {
    conversation_one: {
      id: "conversation_one" as const,
      supersededBy: { conversationId: "conversation_gone" as const, at: AT, reason: "recovery-spawn" as const },
      generations: [{ path: "/one.jsonl" }] as never,
    },
  };
  const cyclic = {
    conversation_a: { id: "conversation_a" as const, supersededBy: { conversationId: "conversation_b" as const, at: AT, reason: "manual" as const }, generations: [] as never },
    conversation_b: { id: "conversation_b" as const, supersededBy: { conversationId: "conversation_a" as const, at: AT, reason: "manual" as const }, generations: [] as never },
  };
  const assigned = (id: string) => task([{ path: null, conversationId: id, panePid: null, state: "delivered", error: null, at: AT }]);

  expect(projectSupersededTaskHandoffs([assigned("conversation_one")], dangling, (id) => id)[0]!.assignments).toHaveLength(1);
  expect(projectSupersededTaskHandoffs([assigned("conversation_a")], cyclic, (id) => id)[0]!.assignments).toHaveLength(1);
});
