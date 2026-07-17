import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectDirectoryFallbacks, resetProjectDirectoryCacheForTests } from "./projectDirectories";

test("an unmatched task-only project has no fabricated home-directory fallback", () => {
  resetProjectDirectoryCacheForTests();
  const project = `missing-task-project-${process.pid}-${Date.now()}`;
  expect(projectDirectoryFallbacks([project])).toEqual({});
});

test("reuses the directory snapshot until a project root changes", () => {
  resetProjectDirectoryCacheForTests();
  const roots = new Set([
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), ".agents", "tools"),
  ]);
  let rootVersion = 1;
  let rootReads = 0;
  let now = Date.now();
  const originalStat = fs.statSync.bind(fs);
  const originalRead = fs.readdirSync.bind(fs);
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (roots.has(String(target))) {
      return {
        ctimeMs: rootVersion,
        dev: 1,
        ino: String(target).endsWith("Projects") ? 1 : 2,
        mtimeMs: rootVersion,
        size: 0,
      } as fs.Stats;
    }
    return originalStat(target, options as never);
  }) as typeof fs.statSync);
  const read = spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (roots.has(String(target))) {
      rootReads += 1;
      return [];
    }
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync);

  try {
    expect(projectDirectoryFallbacks([])).toEqual({});
    expect(rootReads).toBe(2);

    now += 60 * 60 * 1_000;
    expect(projectDirectoryFallbacks([])).toEqual({});
    expect(rootReads).toBe(2);

    rootVersion += 1;
    expect(projectDirectoryFallbacks([])).toEqual({});
    expect(rootReads).toBe(4);
  } finally {
    clock.mockRestore();
    stat.mockRestore();
    read.mockRestore();
    resetProjectDirectoryCacheForTests();
  }
});
