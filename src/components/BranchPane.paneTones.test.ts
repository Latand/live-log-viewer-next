import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { paneToneSurface } from "./BranchPane";
import type { PaneState } from "./paneState";

const STATES: PaneState[] = ["live", "waiting", "returned", "stalled", "done"];

/*
 * Issue #962 quiet-card tone: only an INACTIVE pane — `done`, i.e. finished
 * with nothing pending and no attention state — recedes onto the quiet
 * surface. Every state that asks for the operator's eye (live, waiting,
 * returned, stalled — NEEDS YOU, active, rate-limited flows resolve to these)
 * keeps the full card surface so its legibility is untouched.
 */
test("quiet surface applies only to the inactive done state", () => {
  expect(paneToneSurface("done")).toBe("bg-quiet");
  for (const state of STATES.filter((s) => s !== "done")) {
    expect(paneToneSurface(state)).toBe("bg-card");
  }
});

/*
 * Ownership fence (#962 review): the body-surface choice lives in its own
 * PANE_SURFACES map. PANE_TONES — the shared header/status tone table — is
 * #961's territory and must carry no `surface` entries from this lane.
 */
test("PANE_TONES stays free of body-surface entries (fence to #961)", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "BranchPane.tsx"), "utf8");
  const tones = source.match(/const PANE_TONES[^=]*=\s*\{[\s\S]*?\n\};/);
  expect(tones).not.toBeNull();
  expect(tones![0]).not.toContain("surface");
  expect(source).toContain("const PANE_SURFACES: Record<PaneState, string>");
});
