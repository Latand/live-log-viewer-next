import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";
import { productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";

import { admittedDependencies, admittedRegistry, executeAdmittedSpawnRequest, parseLaunchBody, type ParsedLaunch } from "./membership";

/**
 * The band-local «+ Agent» names its task in the request body. That task rides
 * on the registry reservation for this request's attempt as its explicit
 * target, so the registry commits the membership in the same step it uses for
 * every launch. Nothing is committed here, and nothing else is touched.
 */

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

const launch: ParsedLaunch = { clientAttemptId: "attempt-1", taskId: "task-7" };

test("the reservation for this attempt carries the request's task as its explicit target", () => {
  const { registry, calls } = fakeRegistry();
  const wrapped = admittedRegistry(registry, launch);
  const begun = wrapped.beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1" } as SpawnRequest);
  expect(begun.kind).toBe("created");
  expect(calls).toEqual([{ engine: "claude", cwd: "/repo", clientAttemptId: "attempt-1", taskIds: ["task-7"] }]);
  /* Other registry calls pass straight through. */
  expect(wrapped.spawnReceiptForClientAttempt("x" as never)).toBeNull();
});

test("a reservation for another attempt is forwarded untouched, and a request without a task wraps nothing", () => {
  const { registry, calls } = fakeRegistry();
  admittedRegistry(registry, launch).beginSpawnRequest({ engine: "claude", cwd: "/repo", clientAttemptId: "someone-else" } as SpawnRequest);
  expect(calls[0]).toEqual({ engine: "claude", cwd: "/repo", clientAttemptId: "someone-else" });
  expect(admittedRegistry(registry, { clientAttemptId: "attempt-1", taskId: null })).toBe(registry);
});

test("the dependencies wrapper hands the command one wrapped registry and leaves every other dependency alone", () => {
  const { registry } = fakeRegistry();
  const dependencies = { ...productionSpawnCommandDependencies, registry: () => registry };
  const wrapped = admittedDependencies(dependencies, launch);
  expect(wrapped.registry()).toBe(wrapped.registry());
  expect(wrapped.registry()).not.toBe(registry);
  expect(wrapped.spawnStructuredConversation).toBe(dependencies.spawnStructuredConversation);
});

test("a request without a task or an attempt key is passed through without a wrapped registry", async () => {
  const seen: unknown[] = [];
  const execute = async (_req: NextRequest, dependencies: unknown) => { seen.push(dependencies); return new Response(null, { status: 204 }) as never; };
  await executeAdmittedSpawnRequest(
    new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "codex", cwd: "/repo", ["prompt"]: "x", images: [] }) }),
    productionSpawnCommandDependencies,
    execute,
  );
  await executeAdmittedSpawnRequest(
    new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "codex", cwd: "/repo", ["prompt"]: "x", images: [], clientAttemptId: "attempt-2" }) }),
    productionSpawnCommandDependencies,
    execute,
  );
  await executeAdmittedSpawnRequest(
    new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "codex", cwd: "/repo", ["prompt"]: "x", images: [], clientAttemptId: "attempt-2", taskId: "task-9" }) }),
    productionSpawnCommandDependencies,
    execute,
  );
  expect(seen[0]).toBe(productionSpawnCommandDependencies);
  expect(seen[1]).toBe(productionSpawnCommandDependencies);
  expect(seen[2]).not.toBe(productionSpawnCommandDependencies);
  expect(parseLaunchBody(null)).toBeNull();
  expect(parseLaunchBody({ clientAttemptId: "  " })).toBeNull();
  expect(parseLaunchBody({ clientAttemptId: "a", taskId: " t " })).toEqual({ clientAttemptId: "a", taskId: "t" });
});

test("a cross-site request is rejected by the command before any reservation", async () => {
  const request = new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", host: "127.0.0.1", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ engine: "claude", cwd: "/repo", ["prompt"]: "x", images: [], clientAttemptId: "attempt-cross", taskId: "task-1" }),
  });
  const { registry, calls } = fakeRegistry();
  const response = await executeAdmittedSpawnRequest(request, { ...productionSpawnCommandDependencies, registry: () => registry });
  expect(response.status).toBe(403);
  expect(calls).toEqual([]);
});
