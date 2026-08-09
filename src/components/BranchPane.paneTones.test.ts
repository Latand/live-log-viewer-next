import { expect, test } from "bun:test";

import { paneToneSurface } from "./BranchPane";
import type { PaneState } from "./paneState";

/*
 * Issue #962 quiet-card tone: only an INACTIVE pane — `done`, i.e. finished
 * with nothing pending and no attention state — recedes onto the quiet
 * surface. Every state that asks for the operator's eye (live, waiting,
 * returned, stalled — NEEDS YOU, active, rate-limited flows resolve to these)
 * keeps the full card surface so its legibility is untouched.
 */
test("quiet surface applies only to the inactive done state", () => {
  expect(paneToneSurface("done")).toBe("bg-quiet");
  for (const state of ["live", "waiting", "returned", "stalled"] as PaneState[]) {
    expect(paneToneSurface(state)).toBe("bg-card");
  }
});
