import { expect, test } from "bun:test";

import { projectDirectoryFallbacks } from "./projectDirectories";

test("an unmatched task-only project has no fabricated home-directory fallback", () => {
  const project = `missing-task-project-${process.pid}-${Date.now()}`;
  expect(projectDirectoryFallbacks([project])).toEqual({});
});
