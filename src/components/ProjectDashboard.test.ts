import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { pendingFocusTarget } from "./ProjectDashboard";

test("a catalog focus waits for its pinned conversation to hydrate", () => {
  const path = "/sessions/capped-out.jsonl";
  expect(pendingFocusTarget(path, [])).toBeNull();
  expect(pendingFocusTarget(path, [{ path } as FileEntry])).toBe(path);
});
