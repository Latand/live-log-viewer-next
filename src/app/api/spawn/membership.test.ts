import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";
import { productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { MembershipInput, MembershipResult } from "@/lib/tasks/membership";

import { admittedDependencies, admittedRegistry, executeAdmittedSpawnRequest, parseLaunchBody, TaskMembershipError, type ParsedLaunch, type SpawnMembershipPorts } from "./membership";

/**
 * Membership is committed at the launch receipt reservation — after every
 * admission check the spawn command performs, before any actuation — with the
 * reserved identity written in the same step. A refused or unwritable
 * membership aborts the reservation; a rejected request never reaches it.
 */

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

const launch: ParsedLaunch = { clientAttemptId: "attempt-1", taskId: null, engine: "claude", cwd: "/repo", promptText: "Restore search results\nwith details", title: null };

function fakeRegistry(result: SpawnBeginResult["kind"] = "created") {
  const calls: SpawnRequest[] = [];
  const registry = {
    beginSpawnRequest(input: SpawnRequest): SpawnBeginResult {
      calls.push(input);
      return { kind: result, receipt: { launchId: "launch-1", conversationId: "conversation_one", clientAttemptId: input.clientAttemptId ?? null } } as unknown as SpawnBeginResult;
    },
    spawnReceiptForClientAttempt() { return null; },
  } as unknown as AgentRegistry;
  return { registry, calls };
}

test("reserving the receipt commits membership first and records the reserved identity before returning", () => {
  const membership = ports();
  const { registry, calls } = fakeRegistry();
  const order: string[] = [];
  const commit = membership.commit.bind(membership);
  membership.commit = (input) => { order.push("commit"); return commit(input); };
  const record = membership.recordIdentity.bind(membership);
  membership.recordIdentity = (ids, identity) => { order.push("identity"); record(ids, identity); };
  const wrapped = admittedRegistry(registry, launch, membership);
  const begun = wrapped.beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest);
  expect(begun.kind).toBe("created");
  expect(calls.length).toBe(1);
  expect(order).toEqual(["commit", "identity"]);
  expect(membership.commits[0]).toEqual({ project: "project-for:/repo", origin: { kind: "launch", key: "attempt-1" }, title: "Restore search results\nwith details", identity: { clientAttemptId: "attempt-1", engine: "claude" } });
  expect(membership.identities).toEqual([{ taskIds: ["placeholder-1"], identity: { clientAttemptId: "attempt-1", launchId: "launch-1", conversationId: "conversation_one", engine: "claude" } }]);
  /* Other registry calls pass straight through. */
  expect(wrapped.spawnReceiptForClientAttempt("x" as never)).toBeNull();
});

test("a band-local launch names its task; a missing task or an unwritable store aborts the reservation and nothing is reserved", () => {
  const membership = ports();
  const { registry, calls } = fakeRegistry();
  admittedRegistry(registry, { ...launch, taskId: "task-7" }, membership).beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest);
  expect(membership.commits[0]!.explicitTaskIds).toEqual(["task-7"]);
  expect(membership.commits[0]!.project).toBe("");
  membership.refuse = { ok: false, error: "task task-9 is not available", status: 404 };
  expect(() => admittedRegistry(registry, { ...launch, taskId: "task-9" }, membership).beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest)).toThrow(TaskMembershipError);
  membership.refuse = undefined;
  membership.throwOnCommit = true;
  let thrown: unknown;
  try {
    admittedRegistry(registry, launch, membership).beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TaskMembershipError);
  expect((thrown as TaskMembershipError).status).toBe(503);
  expect(calls.length).toBe(1);
});

test("a reservation for another attempt, or a conflicting one, leaves membership untouched", () => {
  const membership = ports();
  const { registry } = fakeRegistry("conflict");
  const wrapped = admittedRegistry(registry, launch, membership);
  wrapped.beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "someone-else" } as SpawnRequest);
  expect(membership.commits).toEqual([]);
  wrapped.beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest);
  expect(membership.commits.length).toBe(1);
  expect(membership.identities).toEqual([]);
});

test("the dependencies wrapper hands the command one wrapped registry and leaves every other dependency alone", () => {
  const membership = ports();
  const { registry } = fakeRegistry();
  const dependencies = { ...productionSpawnCommandDependencies, registry: () => registry };
  const wrapped = admittedDependencies(dependencies, launch, membership);
  expect(wrapped.registry()).toBe(wrapped.registry());
  expect(wrapped.registry()).not.toBe(registry);
  expect(wrapped.spawnStructuredConversation).toBe(dependencies.spawnStructuredConversation);
});

test("a cross-site request is rejected by the command before any membership is committed", async () => {
  const membership = ports();
  const request = new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", host: "127.0.0.1", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ engine: "claude", cwd: "/repo", ["prompt"]: "x", images: [], clientAttemptId: "attempt-cross" }),
  });
  const response = await executeAdmittedSpawnRequest(request, productionSpawnCommandDependencies, membership);
  expect(response.status).toBe(403);
  expect(membership.commits).toEqual([]);
  expect(membership.identities).toEqual([]);
});

test("a request without an attempt key is passed through without a wrapped registry", async () => {
  const membership = ports();
  let seen: unknown = null;
  await executeAdmittedSpawnRequest(
    new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "codex", cwd: "/repo", ["prompt"]: "x", images: [] }) }),
    productionSpawnCommandDependencies,
    membership,
    async (_req, dependencies) => { seen = dependencies; return new Response(null, { status: 204 }) as never; },
  );
  expect(seen).toBe(productionSpawnCommandDependencies);
  expect(parseLaunchBody(null)).toBeNull();
  expect(parseLaunchBody({ clientAttemptId: "  " })).toBeNull();
});
