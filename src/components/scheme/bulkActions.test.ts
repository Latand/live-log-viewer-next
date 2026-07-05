import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import type { SchemeNode } from "./layout";
import {
  canBulkFlow,
  canBulkInterrupt,
  canBulkKill,
  canBulkMessage,
  canBulkRemove,
  runBulk,
  withPresenceGuard,
  type BulkRunner,
} from "./bulkActions";

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

function schemeNode(overrides: Partial<SchemeNode> & { path: string }): SchemeNode {
  return {
    file: entry({ path: overrides.path }),
    tasks: [],
    under: [],
    isRoot: true,
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    ...overrides,
  };
}

function flow(implementerPath: string): Flow {
  return {
    id: "flow-" + implementerPath,
    template: "implement-review-loop",
    project: "demo",
    cwd: "/repo",
    implementerPath,
    roles: {
      implementer: { engine: "claude", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "HEAD",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-05T00:00:00.000Z",
    closedAt: null,
  };
}

describe("runBulk", () => {
  test("runs paths sequentially without overlapping calls", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const runner: BulkRunner = async (path) => {
      events.push("enter:" + path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      events.push("exit:" + path);
      inFlight -= 1;
      return { ok: true };
    };

    const results = await runBulk(["/a", "/b", "/c"], runner);

    expect(peak).toBe(1);
    expect(events).toEqual(["enter:/a", "exit:/a", "enter:/b", "exit:/b", "enter:/c", "exit:/c"]);
    expect(results).toEqual([
      { path: "/a", ok: true },
      { path: "/b", ok: true },
      { path: "/c", ok: true },
    ]);
  });

  test("continues after partial failures and collects errors", async () => {
    const results = await runBulk(["/a", "/b", "/c"], async (path) =>
      path === "/b" ? { ok: false, error: "denied" } : { ok: true },
    );

    expect(results).toEqual([
      { path: "/a", ok: true },
      { path: "/b", ok: false, error: "denied" },
      { path: "/c", ok: true },
    ]);
  });

  test("turns a thrown runner error into a failed item", async () => {
    const results = await runBulk(["/boom"], async () => {
      throw new Error("window gone");
    });

    expect(results).toEqual([{ path: "/boom", ok: false, error: "window gone" }]);
  });

  test("reports progress after each settled item with the next path", async () => {
    const progress: { results: readonly string[]; current: string | null }[] = [];

    await runBulk(["/a", "/b"], async () => ({ ok: true }), (results, current) => {
      progress.push({ results: results.map((result) => result.path), current });
    });

    expect(progress).toEqual([
      { results: ["/a"], current: "/b" },
      { results: ["/a", "/b"], current: null },
    ]);
  });

  test("failed subsets can be retried by passing their paths back into runBulk", async () => {
    const first = await runBulk(["/a", "/b", "/c"], async (path) =>
      path === "/b" ? { ok: false, error: "temporary" } : { ok: true },
    );
    const retried = await runBulk(
      first.filter((result) => !result.ok).map((result) => result.path),
      async () => ({ ok: true }),
    );

    expect(retried).toEqual([{ path: "/b", ok: true }]);
  });
});

describe("withPresenceGuard", () => {
  test("fails a path that left the board between launch and its turn", async () => {
    const present = new Set(["/a", "/b"]);
    const delivered: string[] = [];
    const guarded = withPresenceGuard(
      () => present,
      "вузол зник",
      async (path) => {
        delivered.push(path);
        return { ok: true };
      },
    );

    const results = await runBulk(["/a", "/b"], async (path) => {
      if (path === "/a") present.delete("/b");
      return guarded(path);
    });

    expect(delivered).toEqual(["/a"]);
    expect(results).toEqual([
      { path: "/a", ok: true },
      { path: "/b", ok: false, error: "вузол зник" },
    ]);
  });
});

describe("bulk eligibility", () => {
  test("message and remove are available for every scheme node", () => {
    const child = schemeNode({ path: "/child", isRoot: false });
    expect(canBulkMessage(child)).toBe(true);
    expect(canBulkRemove(child)).toBe(true);
  });

  test("interrupt requires a live pane pid", () => {
    expect(canBulkInterrupt(schemeNode({ path: "/live", file: entry({ path: "/live", pid: 123 }) }))).toBe(true);
    expect(canBulkInterrupt(schemeNode({ path: "/quiet", file: entry({ path: "/quiet", pid: null }) }))).toBe(false);
  });

  test("kill is limited to root nodes", () => {
    expect(canBulkKill(schemeNode({ path: "/root", isRoot: true }))).toBe(true);
    expect(canBulkKill(schemeNode({ path: "/child", isRoot: false }))).toBe(false);
  });

  test("flow eligibility delegates to active flow and file shape rules", () => {
    const root = schemeNode({ path: "/root" });
    const child = schemeNode({ path: "/child", file: entry({ path: "/child", parent: "/root" }), isRoot: false });
    const active = new Map<string, Flow>([["/root", flow("/root")]]);

    expect(canBulkFlow(root, new Map())).toBe(true);
    expect(canBulkFlow(root, active)).toBe(false);
    expect(canBulkFlow(child, new Map())).toBe(false);
  });
});
