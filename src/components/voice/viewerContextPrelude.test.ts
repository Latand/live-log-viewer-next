import { expect, test } from "bun:test";

import { composeViewerContextPrelude } from "./viewerContextPrelude";

/**
 * The context line the Viewer-global orchestrator carries into a turn: present
 * exactly when the operator is looking at something OTHER than the orchestrator
 * conversation itself, and bounded however much is selected.
 */

const SELF = { path: "/logs/orchestrator.jsonl", project: "home-lab" };

const slice = (focusedPath: string | null = null, selectedPaths: string[] = []) => ({ focusedPath, selectedPaths });

test("overview with nothing selected contributes nothing", () => {
  expect(composeViewerContextPrelude({ project: null }, slice(), SELF)).toBe("");
});

test("the operator looking at the orchestrator itself contributes nothing", () => {
  expect(composeViewerContextPrelude(
    { project: "home-lab" },
    slice(SELF.path, [SELF.path]),
    SELF,
  )).toBe("");
});

test("another project is named even with no selection", () => {
  expect(composeViewerContextPrelude({ project: "web-shop" }, slice(), SELF))
    .toBe("[viewer context — the operator is looking at: project web-shop]");
});

test("a focused conversation in the same project is context, and names the project", () => {
  expect(composeViewerContextPrelude(
    { project: "home-lab" },
    slice("/logs/worker-a.jsonl"),
    SELF,
  )).toBe("[viewer context — the operator is looking at: project home-lab; focused conversation /logs/worker-a.jsonl]");
});

test("selection lists paths, excludes the focus and the orchestrator, and folds the overflow", () => {
  const selected = [
    SELF.path,
    "/logs/worker-a.jsonl",
    "/logs/b.jsonl",
    "/logs/c.jsonl",
    "/logs/d.jsonl",
    "/logs/e.jsonl",
    "/logs/f.jsonl",
    "/logs/g.jsonl",
    "/logs/h.jsonl",
  ];
  const line = composeViewerContextPrelude(
    { project: "web-shop" },
    slice("/logs/worker-a.jsonl", selected),
    SELF,
  );
  expect(line).toContain("project web-shop");
  expect(line).toContain("focused conversation /logs/worker-a.jsonl");
  expect(line).toContain("selected /logs/b.jsonl");
  expect(line).toContain("(+1 more)");
  expect(line).not.toContain(SELF.path);
});
