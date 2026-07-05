import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import type { BranchGroup } from "@/components/projectModel";

import { buildSchemeLayout } from "./layout";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "сесія",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function flow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: "/reviewer",
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt: "2026-07-05T00:00:00Z",
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

describe("buildSchemeLayout byPath", () => {
  test("carries stacks and decks as glide/edge targets alongside nodes", () => {
    const root = entry({ path: "/root", activity: "live" });
    const quiet = entry({ path: "/root/quiet", parent: "/root", kind: "субагент" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [quiet],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root, quiet], [flow({ id: "f1", implementerPath: "/root" })], []);

    expect(layout.byPath.has("/root")).toBe(true);
    expect(layout.stacks).toHaveLength(1);
    expect(layout.byPath.get(layout.stacks[0]!.key)).toBe(layout.stacks[0]!);
    expect(layout.decks).toHaveLength(1);
    expect(layout.byPath.get(layout.decks[0]!.key)).toBe(layout.decks[0]!);
  });
});
