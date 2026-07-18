import { describe, expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { currentWorkRect } from "./currentWork";
import type { SchemeLayout, SchemeNode } from "./layout";

const file = (over: Partial<FileEntry> = {}): FileEntry => ({
  path: "/quiet",
  root: "claude-projects",
  name: "quiet.jsonl",
  project: "demo",
  title: "Quiet",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  ...over,
});

const node = (entry: FileEntry, x: number): SchemeNode => ({
  file: entry,
  tasks: [],
  under: [],
  isRoot: true,
  x,
  y: 100,
  w: 600,
  h: 780,
});

const layout = (over: Partial<SchemeLayout> = {}): SchemeLayout => ({
  nodes: [],
  edges: [],
  stacks: [],
  decks: [],
  loops: [],
  groups: [],
  links: [],
  drafts: [],
  slots: [],
  byPath: new Map(),
  width: 6_000,
  height: 4_000,
  ...over,
});

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1",
  project: "demo",
  status: "assigned",
  text: "Ship current work framing",
  placement: "pinned",
  pos: { x: 2_000, y: 1_200 },
  assignments: [],
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

describe("currentWorkRect", () => {
  test("unions active nodes, favorite roots, open groups, drafts, and full open task cards", () => {
    const quiet = node(file(), 100);
    const active = node(file({ path: "/live", title: "Live", activity: "live" }), 900);
    const favorite = node(file({ path: "/favorite", title: "Favorite", conversationId: "fav-id" }), 3_000);
    const board = layout({
      nodes: [quiet, active, favorite],
      drafts: [{ key: "draft::d1", id: "d1", x: 4_200, y: 200, w: 600, h: 780 }],
      groups: [{
        key: "group::pipeline::p1",
        kind: "pipeline",
        id: "p1",
        hue: 20,
        members: [],
        label: "Current pipeline",
        pipeline: { state: "running", restored: false } as never,
        x: 1_700,
        y: 80,
        w: 700,
        h: 900,
      }],
    });

    expect(currentWorkRect(board, [task()], new Set(["fav-id"]))).toEqual({
      x: 900,
      y: 80,
      w: 3_900,
      h: 1_184,
    });
  });

  test("ignores quiet unpinned nodes, closed groups, and done tasks", () => {
    const board = layout({
      nodes: [node(file(), 100)],
      groups: [{
        key: "group::pipeline::closed",
        kind: "pipeline",
        id: "closed",
        hue: 0,
        members: [],
        label: "Closed",
        pipeline: { state: "closed", restored: false } as never,
        x: 50,
        y: 50,
        w: 1_000,
        h: 1_000,
      }],
    });
    expect(currentWorkRect(board, [task({ status: "done" })], new Set())).toBeNull();
  });

  test("is deterministic for identical inputs", () => {
    const active = node(file({ activity: "stalled" }), 500);
    const board = layout({ nodes: [active] });
    expect(currentWorkRect(board, [], new Set())).toEqual(currentWorkRect(board, [], new Set()));
  });
});
