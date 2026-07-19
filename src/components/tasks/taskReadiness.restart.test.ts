import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadTasksFile, saveTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { buildReadinessIndex, partitionReadiness } from "./taskReadiness";

/*
 * Restart determinism (issue #290): every classification input lives in the
 * durable tasks store (status, assignments) — a store round-trip through the
 * real load/save path is the moral equivalent of a viewer restart, and the
 * partition must reproduce identical counts and membership, byte-preserving
 * every task field on the way.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-readiness-restart-"));
const file = path.join(dir, "tasks.json");

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const iso = "2026-07-01T00:00:00.000Z";

function seed(): BoardTask[] {
  return [
    {
      id: "t-now",
      project: "demo",
      status: "assigned",
      text: "Wire the readiness strip #290",
      placement: "pinned",
      pos: { x: 100, y: 100 },
      assignments: [{ path: "/tmp/agent.jsonl", panePid: null, state: "delivered", error: null, at: iso }],
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: "t-blocked",
      project: "demo",
      status: "assigned",
      text: "Failed delivery card",
      placement: "pinned",
      pos: { x: 160, y: 100 },
      assignments: [{ path: null, panePid: null, state: "failed", error: "delivery failed", at: iso }],
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: "t-planned",
      project: "demo",
      status: "inbox",
      text: "Backlog card",
      placement: "unplaced",
      assignments: [],
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: "t-done",
      project: "demo",
      status: "done",
      text: "Finished card",
      placement: "pinned",
      pos: { x: 220, y: 100 },
      assignments: [],
      createdAt: iso,
      updatedAt: iso,
    },
  ];
}

test("a tasks.json round-trip through the real store reproduces identical sections and preserves every field", () => {
  fs.writeFileSync(file, JSON.stringify({ tasks: seed() }, null, 2), "utf8");
  const index = buildReadinessIndex([], []);

  const first = loadTasksFile(file);
  expect(first.tasks).toHaveLength(4);
  const before = partitionReadiness(first.tasks, index);

  /* Restart: persist through the store's own writer, then reload cold. */
  saveTasksFile(first, file);
  const second = loadTasksFile(file);
  const after = partitionReadiness(second.tasks, index);

  expect(after.map((section) => ({ readiness: section.readiness, ids: section.items.map((item) => item.id) }))).toEqual(
    before.map((section) => ({ readiness: section.readiness, ids: section.items.map((item) => item.id) })),
  );
  expect(after.find((section) => section.readiness === "now")!.items.map((item) => item.id)).toEqual(["t-now"]);
  expect(after.find((section) => section.readiness === "blocked")!.items.map((item) => item.id)).toEqual(["t-blocked"]);
  expect(after.find((section) => section.readiness === "planned")!.items.map((item) => item.id)).toEqual(["t-planned"]);
  expect(after.find((section) => section.readiness === "done")!.items.map((item) => item.id)).toEqual(["t-done"]);

  /* No migration: the store round-trip preserves the tasks verbatim —
     ids, text, source, assignments, placement, positions, timestamps. */
  expect(second.tasks).toEqual(first.tasks);
});
