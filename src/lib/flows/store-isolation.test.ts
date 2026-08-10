import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Regression for the flows.json clobber: the flow store used to bake its file
 * path at module load, so a test that imported it (even transitively, e.g. via
 * workflows/store which pulls atomicWriteText from flows/store) before pinning
 * LLV_STATE_DIR would bind to the user's REAL ~/.config/agent-log-viewer/state,
 * and a later saveFlows() clobbered real flows. Resolving the path per call
 * fixes it: a saveFlows after the env changes must land in the NEW sandbox.
 */

// Import the flow store transitively FIRST, with LLV_STATE_DIR pointing at dir A.
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "llv-store-iso-A-"));
process.env.LLV_STATE_DIR = dirA;
await import("@/lib/workflows/store");
const { saveFlows, loadFlows } = await import("./store");

// Now repoint LLV_STATE_DIR at a fresh sandbox B, AFTER the store was imported.
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "llv-store-iso-B-"));
process.env.LLV_STATE_DIR = dirB;

afterAll(() => {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("saveFlows honors an LLV_STATE_DIR change made after the store was imported", () => {
  const flow = {
    id: "iso-test",
    template: "implement-review-loop" as const,
    project: "demo",
    cwd: "/tmp/iso",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    implementerPath: "/tmp/iso/impl",
    baseRef: "main",
    baseMode: "head" as const,
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
    state: "reviewing" as const,
    stateDetail: null,
    pausedState: null,
    rounds: [],
    createdAt: "2026-07-08T00:00:00Z",
    closedAt: null,
  };
  saveFlows([flow]);

  // The write must land in the CURRENT sandbox (B), never in dir A and never in
  // the real state dir.
  expect(fs.existsSync(path.join(dirB, "state.sqlite"))).toBe(true);
  expect(fs.existsSync(path.join(dirA, "state.sqlite"))).toBe(false);
  expect(loadFlows().map((f) => f.id)).toEqual(["iso-test"]);
});
