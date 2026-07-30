import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";

import { setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { POST } from "./route";

/**
 * One of three doors — and, deliberately, not the lock.
 *
 * The MCP binding, this route and a raw runtime-host socket are three ways to ask
 * for the same deploy. Gating each closed only that one, which is how a third door
 * was found behind the first two, so the verification and the single-use spend both
 * live at host admission now (`src/runtime-host/deployment.authorization.test.ts`,
 * against the real coordinator).
 *
 * What this route still owes: refuse an obviously unauthorized request early enough
 * to give the caller a useful answer, and forward the proof it was handed WITHOUT
 * consuming it — a spend here would have the real deploy refused as already
 * consumed.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const originalRollback = process.env.LLV_RUNTIME_EVENTS;

let requested: { revision?: string; idempotencyKey: string; bridgeProof?: { ref?: unknown; nonce?: unknown } }[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployments-route-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  /* The endpoint stands down entirely when the events plane is off, so the gate
     below is only reachable with a socket configured. */
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(dir, "runtime.sock");
  delete process.env.LLV_RUNTIME_EVENTS;
  requested = [];
  openBridgeChannel("root_deploy_route");
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

function confirmed(sha = SHA): { ref: number; nonce: string } {
  const confirmation = mintBridgeConfirmation({ sha });
  recordManagerReport({
    key: `confirm-${confirmation.nonce}`,
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "gates green",
    confirmation,
  });
  return { ref: drainBridgeReports().reports.at(-1)!.seq, nonce: confirmation.nonce };
}

test("a deploy with no bridge proof is refused and never reaches the runtime host", async () => {
  const response = await POST(deployRequest({ revision: SHA, idempotencyKey: "k1" }));
  expect(response.status).toBe(403);
  expect(requested).toEqual([]);
});

test("the proof is forwarded to host admission, verbatim and unspent", async () => {
  const { ref, nonce } = confirmed();
  const response = await POST(deployRequest({
    revision: SHA, idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: nonce,
  }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1", bridgeProof: { ref, nonce } }]);

  /* Unspent HERE. Consuming at this layer would leave admission — the one gate that
     matters — with an already-consumed nonce and no deploy. */
  const stored = drainBridgeReports().reports.find((report) => report.seq === ref);
  expect(stored?.confirmation?.consumedAt).toBeUndefined();
});

test("a half-presented proof is refused before the runtime is reached", async () => {
  const { ref, nonce } = confirmed();
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k1", bridgeRef: ref }))).status).toBe(403);
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k2", bridgeNonce: nonce }))).status).toBe(403);
  expect(requested).toEqual([]);
});

test("a revision-less deploy is refused: there is nothing a confirmation could authorize", async () => {
  /* The endpoint used to accept an absent revision and let the host choose. With a
     per-SHA authorization that is meaningless — the operator agreed to a commit. */
  const { ref, nonce } = confirmed();
  const response = await POST(deployRequest({ idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: nonce }));
  expect(response.status).toBe(400);
  expect(requested).toEqual([]);
});

test("the idempotencyKey requirement still holds ahead of the confirmation", async () => {
  const { ref, nonce } = confirmed();
  const response = await POST(deployRequest({ revision: SHA, bridgeRef: ref, bridgeNonce: nonce }));
  expect(response.status).toBe(400);
  expect(requested).toEqual([]);

  /* And the malformed attempt did not burn the operator's yes. */
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: nonce }))).status).toBe(202);
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
  const { ref, nonce } = confirmed();
  const absent = await POST(deployRequest({
    revision: SHA,
    idempotencyKey: "missing-runtime",
    bridgeRef: ref,
    bridgeNonce: nonce,
  }));
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({
    error: "runtime host socket is unavailable",
    code: RUNTIME_PLANE_ABSENT,
  });
});
