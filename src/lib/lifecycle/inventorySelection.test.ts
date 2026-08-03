import { expect, test } from "bun:test";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import {
  completedGenerationSelection,
  hydrateWithBudget,
  selectConversationEntries,
  type CompletedGenerationRead,
} from "./inventorySelection";

/**
 * #860 — the selection seam that bounds project-scoped catalog reads.
 *
 * Every assertion here is about work NOT done: rows filtered before hydration,
 * one completed generation instead of a private fresh sweep, and a hydration
 * pass that stops at its concurrency, byte and time bounds instead of walking
 * whatever the corpus happens to hold.
 */

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects" as FileEntry["root"],
    name: path.basename(overrides.path),
    project: "viewer",
    title: "agent",
    engine: "codex",
    kind: "session",
    fmt: "claude" as FileEntry["fmt"],
    parent: null,
    mtime: 1_700_000_000,
    size: 4096,
    activity: "idle",
    activityReason: "mtime_old",
    proc: null,
    pid: null,
    ...overrides,
  } as FileEntry;
}

/** 10,000 historical rows, 1,000 of them in the requested project, six live. */
function productionShapedCorpus(): FileEntry[] {
  const files: FileEntry[] = [];
  for (let index = 0; index < 10_000; index += 1) {
    const inProject = index % 10 === 0;
    files.push(entry({
      path: `/corpus/${inProject ? "viewer" : `other-${index % 37}`}/session-${index}.jsonl`,
      project: inProject ? "viewer" : `other-${index % 37}`,
      mtime: 1_700_000_000 - index,
      activity: inProject && index < 60 && index % 10 === 0 ? "live" : "idle",
      engine: index % 3 === 0 ? "claude" : "codex",
    }));
  }
  return files;
}

test("selection filters project, engine and liveness and applies the row limit before any hydration", () => {
  const files = productionShapedCorpus();

  const selection = selectConversationEntries(files, { project: "viewer", liveOnly: true, limit: 10 });

  expect(selection.scanned).toBe(10_000);
  /* Six live rows exist; the limit never had to truncate them, and the 994
     other project rows were dropped before anything opened a transcript. */
  expect(selection.matched).toBe(6);
  expect(selection.entries).toHaveLength(6);
  expect(selection.entries.every((row) => row.project === "viewer")).toBe(true);
  expect(selection.entries.every((row) => row.activity === "live")).toBe(true);
});

test("the row limit truncates the project selection before hydration, newest first", () => {
  const files = productionShapedCorpus();

  const selection = selectConversationEntries(files, { project: "viewer", limit: 10 });

  expect(selection.matched).toBe(1_000);
  expect(selection.entries).toHaveLength(10);
  expect(selection.entries[0]!.path).toBe("/corpus/viewer/session-0.jsonl");
  expect(selection.entries.at(-1)!.path).toBe("/corpus/viewer/session-90.jsonl");
});

test("shell rows never enter a conversation selection", () => {
  const selection = selectConversationEntries(
    [entry({ path: "/corpus/viewer/shell.log", engine: "shell" }), entry({ path: "/corpus/viewer/a.jsonl" })],
    { limit: 10 },
  );

  expect(selection.entries.map((row) => row.path)).toEqual(["/corpus/viewer/a.jsonl"]);
});

test("a runtime-hosted path passes the liveness filter the completed generation still projects as idle", () => {
  /* The completed generation predates this launch: its projection says idle
     while the registry holds a live host for it. Dropping the row here is what
     forced the fresh whole-corpus sweep this seam replaces. */
  const files = [
    entry({ path: "/corpus/viewer/just-launched.jsonl", activity: "idle" }),
    entry({ path: "/corpus/viewer/old.jsonl", activity: "idle" }),
  ];

  const selection = selectConversationEntries(files, {
    liveOnly: true,
    limit: 10,
    hostedPaths: new Set(["/corpus/viewer/just-launched.jsonl"]),
  });

  expect(selection.entries.map((row) => row.path)).toEqual(["/corpus/viewer/just-launched.jsonl"]);
});

test("the query filter matches title, project and path", () => {
  const files = [
    entry({ path: "/corpus/viewer/a.jsonl", title: "Bound the latency" }),
    entry({ path: "/corpus/viewer/b.jsonl", title: "something else" }),
  ];

  expect(selectConversationEntries(files, { query: "LATENCY", limit: 10 }).entries.map((row) => row.path))
    .toEqual(["/corpus/viewer/a.jsonl"]);
});

test("the completed-generation read consumes the published generation and never asks for a fresh scan", async () => {
  const reads: Array<{ revalidate?: boolean; signal?: AbortSignal | null }> = [];
  const read: CompletedGenerationRead = async (options) => {
    reads.push(options ?? {});
    return {
      snapshot: { files: productionShapedCorpus(), projectCatalog: [], complete: true },
      generation: 7,
      targetGeneration: 7,
      cacheStatus: "hit",
      requestCount: 1,
      cloneDurationMs: 0,
    };
  };

  const selection = await completedGenerationSelection({ project: "viewer", liveOnly: true, limit: 10 }, { completedFileScan: read });

  expect(selection.generation).toBe(7);
  expect(selection.cacheStatus).toBe("hit");
  expect(selection.freshScan).toBe(false);
  expect(selection.entries).toHaveLength(6);
  expect(reads).toHaveLength(1);
  expect(selection.selectionMs).toBeGreaterThanOrEqual(0);
});

test("an already-cancelled caller never reaches the generation", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const read: CompletedGenerationRead = async () => {
    reads += 1;
    throw new Error("unreachable");
  };

  await expect(completedGenerationSelection({ limit: 10 }, { completedFileScan: read, signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBe(0);
});

test("hydration never runs more than its concurrency and reports the bytes it charged", async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ index, size: 1_000 }));
  let inFlight = 0;
  let peak = 0;

  const outcome = await hydrateWithBudget(
    items,
    (item) => item.size,
    async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item.index;
    },
    { concurrency: 4, maxBytes: 1_000_000, deadlineAt: null },
  );

  expect(peak).toBeLessThanOrEqual(4);
  expect(outcome.hydrated).toBe(20);
  expect(outcome.skipped).toBe(0);
  expect(outcome.bytes).toBe(20_000);
  expect(outcome.stopped).toBe("complete");
  expect([...outcome.results.keys()]).toHaveLength(20);
});

test("hydration stops at the byte budget and reports the rows it refused", async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ index, size: 100 }));
  const started: number[] = [];

  const outcome = await hydrateWithBudget(
    items,
    (item) => item.size,
    async (item) => {
      started.push(item.index);
      return item.index;
    },
    { concurrency: 1, maxBytes: 500, deadlineAt: null },
  );

  expect(started).toHaveLength(5);
  expect(outcome.hydrated).toBe(5);
  expect(outcome.skipped).toBe(15);
  expect(outcome.bytes).toBe(500);
  expect(outcome.stopped).toBe("byte_budget");
});

test("hydration stops at its deadline and leaves the remaining rows unread", async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ index, size: 1 }));
  const started: number[] = [];
  let clock = 1_000;

  const outcome = await hydrateWithBudget(
    items,
    () => 1,
    async (item) => {
      started.push(item.index);
      clock += 10;
      return item.index;
    },
    { concurrency: 1, maxBytes: 1_000, deadlineAt: 1_030, now: () => clock },
  );

  expect(started).toEqual([0, 1, 2]);
  expect(outcome.hydrated).toBe(3);
  expect(outcome.skipped).toBe(7);
  expect(outcome.stopped).toBe("deadline");
});

test("a cancelled caller stops the hydration pass and starts no further reads", async () => {
  const controller = new AbortController();
  const items = Array.from({ length: 20 }, (_, index) => ({ index, size: 1 }));
  const started: number[] = [];

  const pending = hydrateWithBudget(
    items,
    () => 1,
    async (item) => {
      started.push(item.index);
      if (item.index === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return item.index;
    },
    { concurrency: 1, maxBytes: 1_000, deadlineAt: null, signal: controller.signal },
  );

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const settled = started.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started.length).toBe(settled);
  expect(settled).toBeLessThanOrEqual(3);
});

test("a cancelled pass with several workers in flight leaves no unhandled rejection behind", async () => {
  const controller = new AbortController();
  const items = Array.from({ length: 40 }, (_, index) => ({ index, size: 1 }));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = hydrateWithBudget(
      items,
      () => 1,
      async (item) => {
        if (item.index === 3) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
        return item.index;
      },
      { concurrency: 4, maxBytes: 1_000, deadlineAt: null, signal: controller.signal },
    );

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    /* Three siblings were mid-read when the fourth aborted; each rejects after
       the pass already failed. */
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
