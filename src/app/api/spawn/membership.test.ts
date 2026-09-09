import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";

import { POST } from "./route";

/**
 * A band-local «+ Agent» (#1586) names the task it launches into, and the
 * request body is the only place that task is known. What these pin is the one
 * step that carries it: the task rides on the ordinary spawn request into the
 * registry's receipt reservation, where the registry validates the target and
 * commits the membership in the same transaction it uses for every other
 * launch (`launchMembership.registry.test.ts` holds that half), so no agent
 * starts outside every task and nothing is actuated before it is decided.
 *
 * Task ids and account names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-membership-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** The band the operator pressed «+ Agent» in. */
const BAND = "task-band-atlas";

const ACCOUNT = {
  engine: "claude" as const,
  accountId: "acct-atlas",
  kind: "managed" as const,
  home: path.join(SANDBOX, "account"),
  transcriptRoot: path.join(SANDBOX, "projects"),
  env: { NODE_ENV: "test" as const },
};

type SpawnRouteDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

/**
 * One board launch, answered at the reservation. The reservation reports a
 * conflict so the command stops there: what the request asked the registry to
 * reserve is the whole of what this seam decides.
 */
async function launch(attempt: string, body: Record<string, unknown>, site = "same-origin"): Promise<{ status: number; reserved: SpawnRequest[] }> {
  const reserved: SpawnRequest[] = [];
  const registry = {
    beginSpawnRequest(input: SpawnRequest): SpawnBeginResult {
      reserved.push(input);
      return { kind: "conflict", receipt: { launchId: "launch-1", conversationId: "conversation_atlas", clientAttemptId: input.clientAttemptId ?? null } } as unknown as SpawnBeginResult;
    },
    spawnReceiptForClientAttempt: () => null,
  } as unknown as AgentRegistry;
  const dependencies = {
    ...POST.productionDependencies,
    registry: () => registry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => ACCOUNT,
    resolveSpawnAccount: () => ACCOUNT,
    defer: () => {},
  } as unknown as SpawnRouteDependencies;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": site },
    body: JSON.stringify({ title: "Chart the atlas", engine: "claude", model: "sonnet", cwd: SANDBOX, ["prompt"]: "chart it", clientAttemptId: attempt, ...body }),
  }), dependencies);
  return { status: response.status, reserved };
}

test("the task named in the body is the launch's explicit target on the reservation", async () => {
  const attempt = await launch("spawn_band_member", { taskId: BAND });

  expect(attempt.status).toBe(409);
  expect(attempt.reserved).toHaveLength(1);
  expect(attempt.reserved[0]!.taskIds).toEqual([BAND]);
  /* The launch is otherwise the one every other surface makes. */
  expect(attempt.reserved[0]!.clientAttemptId).toBe("spawn_band_member");
});

test("a request that names no task, or names a blank one, reserves no target and keeps the membership the launch derives", async () => {
  const none = await launch("spawn_band_none", {});
  const blank = await launch("spawn_band_blank", { taskId: "   " });

  expect(none.reserved[0]!.taskIds).toBeUndefined();
  expect(blank.reserved[0]!.taskIds).toBeUndefined();
});

test("a task target is trimmed, so a padded id is the task it names", async () => {
  const attempt = await launch("spawn_band_padded", { taskId: ` ${BAND} ` });

  expect(attempt.reserved[0]!.taskIds).toEqual([BAND]);
});

test("a cross-site request is refused before any reservation", async () => {
  const attempt = await launch("spawn_band_cross", { taskId: BAND }, "cross-site");

  expect(attempt.status).toBe(403);
  expect(attempt.reserved).toEqual([]);
});
