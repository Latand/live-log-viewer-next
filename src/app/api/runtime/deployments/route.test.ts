import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { POST } from "./route";

/**
 * The HTTP deploy door, at parity with the MCP binding and the raw socket
 * (#795): the same request shape — one full commit SHA and an idempotency key —
 * forwarded to the same serialized admission. The deploy DECISION belongs to
 * the designated agent and is enforced at the deploy binding from
 * server-attributed identity; no confirmation proof exists anywhere for this
 * route to forward or verify.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const originalRollback = process.env.LLV_RUNTIME_EVENTS;

let requested: { revision?: string; idempotencyKey: string }[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployments-route-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  /* The endpoint stands down entirely when the events plane is off, so the
     handler below is only reachable with a socket configured. */
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(dir, "runtime.sock");
  delete process.env.LLV_RUNTIME_EVENTS;
  requested = [];
  setDeploymentRuntimeForTests(async (request) => {
    requested.push(request);
    return { deploymentId: "deployment_1", revision: request.revision!, state: "accepted", replayed: false };
  });
});

afterEach(() => {
  setDeploymentRuntimeForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalSocket;
  if (originalRollback === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRollback;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

function deployRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/deployments", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a well-formed exact-SHA request is forwarded to host admission as-is", async () => {
  const response = await POST(deployRequest({ revision: SHA, idempotencyKey: "k1" }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1" }]);
});

test("an uppercase revision is normalized to the lowercase exact SHA", async () => {
  const response = await POST(deployRequest({ revision: SHA.toUpperCase(), idempotencyKey: "k1" }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1" }]);
});

test("a revision-less or abbreviated deploy is refused: exact-SHA means one immutable commit", async () => {
  expect((await POST(deployRequest({ idempotencyKey: "k1" }))).status).toBe(400);
  expect((await POST(deployRequest({ revision: SHA.slice(0, 12), idempotencyKey: "k2" }))).status).toBe(400);
  expect((await POST(deployRequest({ revision: "origin/main", idempotencyKey: "k3" }))).status).toBe(400);
  expect(requested).toEqual([]);
});

test("the idempotencyKey requirement still holds", async () => {
  const response = await POST(deployRequest({ revision: SHA }));
  expect(response.status).toBe(400);
  expect(requested).toEqual([]);

  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k1" }))).status).toBe(202);
});

test("a cross-origin browser is still refused before anything else is read", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/deployments", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ revision: SHA, idempotencyKey: "k1" }),
  }));
  expect(response.status).toBe(403);
  expect(requested).toEqual([]);
});

test("the deployment endpoint reserves the disabled message for explicit rollback", async () => {
  process.env.LLV_RUNTIME_EVENTS = "0";
  const rolledBack = await POST(deployRequest({}));
  expect(rolledBack.status).toBe(503);
  expect(await rolledBack.json()).toEqual({
    error: "runtime events are disabled",
    code: RUNTIME_PLANE_ABSENT,
  });

  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  setDeploymentRuntimeForTests(null);
  const absent = await POST(deployRequest({ revision: SHA, idempotencyKey: "missing-runtime" }));
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({
    error: "runtime host socket is unavailable",
    code: RUNTIME_PLANE_ABSENT,
  });
});
