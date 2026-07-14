import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { boardFirstPaintReady, pendingFocusTarget } from "./ProjectDashboard";

test("a catalog focus waits for its pinned conversation to hydrate", () => {
  const path = "/sessions/capped-out.jsonl";
  expect(pendingFocusTarget(path, [])).toBeNull();
  expect(pendingFocusTarget(path, [{ path } as FileEntry])).toBe(path);
});

test("the board holds its skeleton until BOTH the scan and the persisted state load (#172)", () => {
  /* The flash was painting the raw scan snapshot before the persisted board
     state (closes, worker collapse, caps) landed, then culling it. The first
     real frame is gated on both signals, so neither alone lets nodes paint. */
  expect(boardFirstPaintReady(false, false)).toBe(false);
  expect(boardFirstPaintReady(true, false)).toBe(false);
  expect(boardFirstPaintReady(false, true)).toBe(false);
  expect(boardFirstPaintReady(true, true)).toBe(true);
});
