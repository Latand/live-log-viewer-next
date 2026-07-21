import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectResolutionStateKey } from "./projectState";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-state-"));
  process.env.LLV_STATE_DIR = sandbox;
  fs.writeFileSync(path.join(sandbox, "worktree-map.json"), "{}\n");
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeState(name: "flows.json" | "workflows.json", value: unknown): void {
  fs.writeFileSync(path.join(sandbox, name), JSON.stringify(value) + "\n");
}

test("status-only controller rewrites preserve the project resolution state key", () => {
  writeState("flows.json", {
    schemaVersion: 3,
    flows: [{
      id: "flow-1",
      project: "viewer",
      cwd: "/repo/viewer-worktree",
      implementerPath: "/sessions/implementer.jsonl",
      state: "running",
      stateDetail: "scanning",
      rounds: [{ reviewerPath: "/sessions/reviewer.jsonl", state: "running", updatedAt: 100 }],
    }],
  });
  writeState("workflows.json", {
    workflows: [{
      id: "workflow-1",
      project: "viewer",
      repoDir: "/repo/viewer",
      worktreeDir: "/repo/viewer-worktree",
      fixerPath: "/sessions/fixer.jsonl",
      state: "running",
      stageRuns: [{ agentPath: "/sessions/stage.jsonl", state: "running", heartbeatAt: 100 }],
    }],
  });
  const before = projectResolutionStateKey();

  writeState("flows.json", {
    schemaVersion: 3,
    flows: [{
      id: "flow-1",
      project: "viewer",
      cwd: "/repo/viewer-worktree",
      implementerPath: "/sessions/implementer.jsonl",
      state: "needs_decision",
      stateDetail: "controller deadline",
      rounds: [{ reviewerPath: "/sessions/reviewer.jsonl", state: "completed", updatedAt: 200 }],
    }],
  });
  writeState("workflows.json", {
    workflows: [{
      id: "workflow-1",
      project: "viewer",
      repoDir: "/repo/viewer",
      worktreeDir: "/repo/viewer-worktree",
      fixerPath: "/sessions/fixer.jsonl",
      state: "completed",
      stageRuns: [{ agentPath: "/sessions/stage.jsonl", state: "completed", heartbeatAt: 200 }],
    }],
  });

  expect(projectResolutionStateKey()).toBe(before);
});

test("project attribution path changes advance the project resolution state key", () => {
  writeState("flows.json", {
    flows: [{ project: "viewer", cwd: "/repo/first", implementerPath: "/sessions/first.jsonl", rounds: [] }],
  });
  writeState("workflows.json", { workflows: [] });
  const before = projectResolutionStateKey();

  writeState("flows.json", {
    flows: [{ project: "viewer", cwd: "/repo/second", implementerPath: "/sessions/second.jsonl", rounds: [] }],
  });

  expect(projectResolutionStateKey()).not.toBe(before);
});
