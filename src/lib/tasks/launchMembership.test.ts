import { expect, test } from "bun:test";

import type { MembershipInput, MembershipResult } from "./membership";
import { admitReservedLaunch, LaunchMembershipError, launchMembershipInput, type LaunchMembershipPorts } from "./launchMembership";

/**
 * The shared launch boundary: every reserved receipt commits its membership
 * with the reserved identity, in the launch's own project, keyed so that a
 * replay converges; pipelines bound to tasks join them, task-less containers
 * get one fallback task, and a failure retires the receipt.
 */

const receipt = { launchId: "launch-1", conversationId: "conversation_one" };
const noPipelines = () => null;
const projectFor = (cwd: string) => `derived:${cwd}`;

test("an operator or agent launch is keyed by its attempt (or launch id) and titled from its prompt, in its explicit project when it has one", () => {
  const plain = launchMembershipInput({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1", launchDisplay: { prompt: "Restore search results\nlong prompt" } }, receipt, noPipelines, projectFor);
  expect(plain).toEqual({ project: "derived:/repo", origin: { kind: "launch", key: "attempt-1" }, title: "Restore search results\nlong prompt", identity: { launchId: "launch-1", conversationId: "conversation_one", clientAttemptId: "attempt-1", engine: "claude" } });
  const keyless = launchMembershipInput({ engine: "codex", cwd: "/repo", explicitProject: "selected-project", launchProfile: { title: "Helper" } }, receipt, noPipelines, projectFor);
  expect(keyless.origin).toEqual({ kind: "launch", key: "launch-1" });
  expect(keyless.project).toBe("selected-project");
  expect(keyless.title).toBe("Helper");
  expect(keyless.identity.clientAttemptId).toBeNull();
});

test("a pipeline stage joins the pipeline's recorded tasks; a task-less pipeline or flow gets one fallback task per container", () => {
  const bound = launchMembershipInput({ engine: "codex", cwd: "/repo", origin: { kind: "container", container: "pipeline", containerId: "p1" } }, receipt, (id) => (id === "p1" ? ["task-a", "task-b"] : null), projectFor);
  expect(bound.explicitTaskIds).toEqual(["task-a", "task-b"]);
  expect(bound.origin).toEqual({ kind: "launch", key: "launch-1" });
  const fallback = launchMembershipInput({ engine: "codex", cwd: "/repo", origin: { kind: "container", container: "pipeline", containerId: "p2" } }, receipt, () => [], projectFor);
  expect(fallback.origin).toEqual({ kind: "pipeline", key: "p2" });
  expect(fallback.explicitTaskIds).toBeUndefined();
  const flow = launchMembershipInput({ engine: "claude", cwd: "/repo", origin: { kind: "container", container: "flow", containerId: "f1" } }, receipt, noPipelines, projectFor);
  expect(flow.origin).toEqual({ kind: "flow", key: "f1" });
});

function ports(commit: (input: MembershipInput) => MembershipResult): LaunchMembershipPorts {
  return { commit, pipelineTaskIds: () => ["gone-task"], projectForCwd: projectFor };
}

test("a failed commit retires the receipt and aborts with the refusal's status; a deleted pipeline task falls back to the container task", () => {
  const failures: string[] = [];
  expect(() => admitReservedLaunch({ engine: "claude", cwd: "/repo", clientAttemptId: "a" }, receipt, (reason) => failures.push(reason), ports(() => { throw new Error("task state is busy"); }))).toThrow(LaunchMembershipError);
  expect(failures).toEqual(["task membership could not be recorded: task state is busy"]);
  let thrown: unknown;
  try {
    admitReservedLaunch({ engine: "claude", cwd: "/repo", clientAttemptId: "a" }, receipt, () => undefined, ports(() => ({ ok: false, error: "project is required", status: 400 })));
  } catch (error) {
    thrown = error;
  }
  expect((thrown as LaunchMembershipError).status).toBe(400);
  const commits: MembershipInput[] = [];
  const result = admitReservedLaunch(
    { engine: "codex", cwd: "/repo", origin: { kind: "container", container: "pipeline", containerId: "p9" } },
    receipt,
    () => undefined,
    ports((input) => {
      commits.push(input);
      if (input.explicitTaskIds) return { ok: false, error: "task gone-task is not available", status: 404 };
      return { ok: true, tasks: [], taskIds: ["fallback"], created: ["fallback"], changed: true };
    }),
  );
  expect(result.ok && result.taskIds).toEqual(["fallback"]);
  expect(commits.map((input) => input.origin)).toEqual([{ kind: "launch", key: "launch-1" }, { kind: "pipeline", key: "p9" }]);
});
