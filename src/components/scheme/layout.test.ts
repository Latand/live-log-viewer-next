import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { type BranchGroup, buildBranchGroups } from "@/components/projectModel";

import { deckKey, flowLinkKey } from "./agentLinks";
import { buildSchemeLayout } from "./layout";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
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
    const quiet = entry({ path: "/root/quiet", parent: "/root", kind: "subagent" });
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

  test("derives a flow link whose endpoints resolve to placed board rects", () => {
    const root = entry({ path: "/root", activity: "live" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root], [flow({ id: "f1", implementerPath: "/root" })], []);

    expect(layout.links).toHaveLength(1);
    const link = layout.links[0]!;
    expect(link).toMatchObject({ key: flowLinkKey("f1"), kind: "flow", from: "/root", to: deckKey("f1") });
    /* Both endpoints must be drawable rects, or the link layer has nothing to anchor to. */
    expect(layout.byPath.has(link.from)).toBe(true);
    expect(layout.byPath.has(link.to)).toBe(true);
    expect(link.flow).toMatchObject({ round: 1, phase: "awaiting_verdict" });
  });

  test("a flow whose implementer is off the board derives no link", () => {
    const root = entry({ path: "/root", activity: "live" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root], [flow({ id: "f1", implementerPath: "/elsewhere" })], []);
    expect(layout.links).toHaveLength(0);
  });

  test("expanded reviewer children render as connected nodes below the implementer", () => {
    const root = entry({ path: "/implementer", activity: "live" });
    const reviewSubtask = entry({
      path: "/review-subtask",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/implementer",
      activity: "idle",
    });
    const group: BranchGroup = {
      key: "/implementer",
      columns: [
        { file: root, tasks: [] },
        { file: reviewSubtask, tasks: [] },
      ],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };

    const layout = buildSchemeLayout(
      [group],
      [],
      [root, reviewSubtask],
      [flow({ id: "f1", implementerPath: "/implementer" })],
      [],
    );
    const implementerNode = layout.nodes.find((node) => node.file.path === "/implementer")!;
    const subtaskNode = layout.nodes.find((node) => node.file.path === "/review-subtask")!;

    expect(subtaskNode.y).toBeGreaterThan(implementerNode.y + implementerNode.h);
    expect(subtaskNode.x).toBeGreaterThan(implementerNode.x);
    expect(layout.edges.some((edge) => edge.to === "/review-subtask" && !edge.dashed)).toBe(true);
    expect(layout.stacks).toHaveLength(0);
    expect(implementerNode.under.map((file) => file.path)).toEqual([]);
  });

  test("a plain subagent of a live session renders as a connected node below it, not a mini-stack", () => {
    /* End-to-end for the "Verify MVP" case: a live claude session with an idle
       Task-tool subagent and no flow. buildBranchGroups must promote the
       subagent to a column and buildSchemeLayout must place it below the parent
       wired by a solid edge — never a detached right-side mini-stack. */
    const session = entry({ path: "/session", activity: "live" });
    const subagent = entry({ path: "/session/verify-mvp", parent: "/session", kind: "subagent", activity: "idle" });
    const files = [session, subagent];

    const groups = buildBranchGroups(files, "demo");
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/session", "/session/verify-mvp"]);

    const layout = buildSchemeLayout(groups, [], files, [], []);
    const parentNode = layout.nodes.find((node) => node.file.path === "/session")!;
    const childNode = layout.nodes.find((node) => node.file.path === "/session/verify-mvp")!;
    expect(childNode.y).toBeGreaterThan(parentNode.y + parentNode.h);
    expect(layout.edges.some((edge) => edge.to === "/session/verify-mvp" && !edge.dashed)).toBe(true);
    expect(layout.stacks).toHaveLength(0);
  });
});
