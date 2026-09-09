import { expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

import { productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { MembershipInput, MembershipResult } from "@/lib/tasks/membership";

import { executeAdmittedSpawnRequest, parseLaunchBody, type SpawnMembershipPorts } from "./membership";

/**
 * Membership is committed before the spawn command runs, refused launches never
 * execute, and the receipt's identity lands on the recorded assignment.
 */

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function ports(): SpawnMembershipPorts & { commits: MembershipInput[]; identities: unknown[]; refuse?: MembershipResult; throwOnCommit?: boolean } {
  const state = {
    commits: [] as MembershipInput[],
    identities: [] as unknown[],
    refuse: undefined as MembershipResult | undefined,
    throwOnCommit: false,
    commit(input: MembershipInput): MembershipResult {
      if (state.throwOnCommit) throw new Error("task state is busy");
      state.commits.push(input);
      return state.refuse ?? { ok: true, tasks: [], taskIds: input.explicitTaskIds ? [...input.explicitTaskIds] : ["placeholder-1"], created: input.explicitTaskIds ? [] : ["placeholder-1"], changed: true };
    },
    recordIdentity(taskIds: readonly string[], identity: unknown) {
      state.identities.push({ taskIds: [...taskIds], identity });
    },
    projectForCwd: (cwd: string) => `project-for:${cwd}`,
  };
  return state;
}

const body = { engine: "claude", model: "opus", cwd: "/repo", ["prompt"]: "Restore search results\nwith details", images: [], clientAttemptId: "attempt-1" };

test("a global launch commits a placeholder keyed by its attempt before the spawn command runs, then records the receipt identity", async () => {
  const membership = ports();
  const order: string[] = [];
  const execute = async () => {
    order.push("execute");
    return NextResponse.json({ launched: true, launchId: "launch-1", conversationId: "conversation_one" }) as never;
  };
  const wrappedCommit = membership.commit.bind(membership);
  membership.commit = (input) => { order.push("commit"); return wrappedCommit(input); };
  const response = await executeAdmittedSpawnRequest(request(body), productionSpawnCommandDependencies, membership, execute);
  expect(response.status).toBe(200);
  expect(order).toEqual(["commit", "execute"]);
  expect(membership.commits[0]).toEqual({ project: "project-for:/repo", origin: { kind: "launch", key: "attempt-1" }, title: "Restore search results\nwith details", identity: { clientAttemptId: "attempt-1", engine: "claude" } });
  expect(membership.identities).toEqual([{ taskIds: ["placeholder-1"], identity: { clientAttemptId: "attempt-1", launchId: "launch-1", conversationId: "conversation_one", engine: "claude" } }]);
});

test("a band-local launch names its task explicitly; a missing task refuses the launch and the spawn command never runs", async () => {
  const membership = ports();
  let executed = 0;
  const execute = async () => { executed += 1; return NextResponse.json({ launched: true, launchId: "l", conversationId: "c" }) as never; };
  await executeAdmittedSpawnRequest(request({ ...body, taskId: "task-7" }), productionSpawnCommandDependencies, membership, execute);
  expect(membership.commits[0]!.explicitTaskIds).toEqual(["task-7"]);
  expect(membership.commits[0]!.project).toBe("");
  expect(executed).toBe(1);
  membership.refuse = { ok: false, error: "task task-9 is not available", status: 404 };
  const refused = await executeAdmittedSpawnRequest(request({ ...body, clientAttemptId: "attempt-2", taskId: "task-9" }), productionSpawnCommandDependencies, membership, execute);
  expect(refused.status).toBe(404);
  expect(executed).toBe(1);
});

test("an unwritable task store refuses the launch instead of starting an agent outside every task", async () => {
  const membership = ports();
  membership.throwOnCommit = true;
  let executed = 0;
  const response = await executeAdmittedSpawnRequest(request(body), productionSpawnCommandDependencies, membership, async () => { executed += 1; return NextResponse.json({}) as never; });
  expect(response.status).toBe(503);
  expect(executed).toBe(0);
});

test("a failed spawn keeps the committed membership and records no identity; a replay of the same attempt commits under the same key", async () => {
  const membership = ports();
  const failing = async () => NextResponse.json({ error: "no healthy account" }, { status: 409 }) as never;
  const first = await executeAdmittedSpawnRequest(request(body), productionSpawnCommandDependencies, membership, failing);
  expect(first.status).toBe(409);
  expect(membership.identities).toEqual([]);
  await executeAdmittedSpawnRequest(request(body), productionSpawnCommandDependencies, membership, failing);
  expect(membership.commits.map((commit) => commit.origin.key)).toEqual(["attempt-1", "attempt-1"]);
});

test("a request without an attempt key is passed through untouched", async () => {
  const membership = ports();
  let executed = 0;
  await executeAdmittedSpawnRequest(request({ engine: "codex", cwd: "/repo", ["prompt"]: "x", images: [] }), productionSpawnCommandDependencies, membership, async () => { executed += 1; return NextResponse.json({}) as never; });
  expect(executed).toBe(1);
  expect(membership.commits).toEqual([]);
  expect(parseLaunchBody(null)).toBeNull();
  expect(parseLaunchBody({ clientAttemptId: "  " })).toBeNull();
});
