import { expect, test } from "bun:test";

import { commitPipelineStage, provisionPipelineWorktree, resetPipelineStage } from "./git";
import type { Pipeline } from "./types";
import type { ExecPort } from "@/lib/workflows/provision";

function pipeline(): Pipeline {
  return {
    id: "12345678", task: "task", project: "viewer", repoDir: "/repo", worktreeDir: "/repo-pipeline-12345678",
    branch: "pipeline/task-12345678", baseBranch: "", baseRef: "", lastPassedCommit: "base",
    stages: [], runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  };
}

test("worktree provision captures branch and base SHA", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(provisionPipelineWorktree(pipeline(), exec)).toEqual({ ok: true, sha: "base", baseBranch: "main" });
  expect(calls).toContain("git worktree add -b pipeline/task-12345678 /repo-pipeline-12345678 HEAD");
});
test("pass commits a dirty stage and retry resets plus cleans", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "stage-sha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(commitPipelineStage(pipeline(), "build", true, exec)).toEqual({ ok: true, sha: "stage-sha" });
  expect(resetPipelineStage(pipeline(), exec)).toEqual({ ok: true, sha: "base" });
  expect(calls).toContain("git add -A");
  expect(calls).toContain("git reset --hard base");
  expect(calls).toContain("git clean -fd");
});
