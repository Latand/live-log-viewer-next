import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectForCwd } from "./describe";
import {
  projectDirectoryCandidates,
  projectDirectoryFallbacks,
  resetProjectDirectoryCacheForTests,
} from "./projectDirectories";

test("an unmatched task-only project has no fabricated home-directory fallback", () => {
  resetProjectDirectoryCacheForTests();
  const project = `missing-task-project-${process.pid}-${Date.now()}`;
  expect(projectDirectoryFallbacks([project])).toEqual({});
});

test("durable scanner state discovers repository roots under arbitrary parent directories", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-directories-"));
  const previousState = process.env.LLV_STATE_DIR;
  const state = path.join(sandbox, "state");
  const repository = path.join(sandbox, "arbitrary", "checkout");
  try {
    process.env.LLV_STATE_DIR = state;
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "config"), [
      '[remote "origin"]',
      "\turl = ssh://git@example.invalid/team/repository.git",
      "",
    ].join("\n"));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "project-catalog.json"), JSON.stringify({
      version: 2,
      resolutionVersion: 4,
      files: {
        fixture: {
          cwd: repository,
          projectRoot: repository,
        },
      },
    }));
    resetProjectDirectoryCacheForTests();
    const project = projectForCwd(repository)!;

    expect(projectDirectoryCandidates(project)).toEqual([repository]);
    expect(projectDirectoryFallbacks([project])).toEqual({ [project]: repository });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
    resetProjectDirectoryCacheForTests();
  }
});
