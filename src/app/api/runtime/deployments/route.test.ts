import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";

import { setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";

import { POST } from "./route";

/**
 * The second door into the deploy room.
 *
 * Gating `deploy_exact_sha` stops the manager's TOOL CALL; it does not stop anything
 * that can reach this endpoint, and any local caller can. So the confirmation is
 * verified and spent here, immediately before the runtime host is asked to deploy,
 * and these prove that no shape of request gets past it without the operator's yes.
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

test("a confirmed deploy reaches the runtime host exactly once", async () => {
  const { ref, nonce } = confirmed();
  const response = await POST(deployRequest({
    revision: SHA, idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: nonce,
  }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1" }]);

  /* Replay: a fresh idempotencyKey must not resurrect a spent authorization. */
  const replay = await POST(deployRequest({
    revision: SHA, idempotencyKey: "k2", bridgeRef: ref, bridgeNonce: nonce,
  }));
  expect(replay.status).toBe(403);
  expect(await replay.json()).toMatchObject({ reason: "consumed" });
  expect(requested).toHaveLength(1);
});

test("a wrong nonce, a wrong SHA and an unknown ref each deploy nothing", async () => {
  const { ref, nonce } = confirmed();

  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: "wrong" }))).status).toBe(403);
  expect((await POST(deployRequest({ revision: "b".repeat(40), idempotencyKey: "k2", bridgeRef: ref, bridgeNonce: nonce }))).status).toBe(403);
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k3", bridgeRef: 9_999, bridgeNonce: nonce }))).status).toBe(403);
  expect(requested).toEqual([]);

  /* None of those spent the confirmation, so the correct answer still deploys. */
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k4", bridgeRef: ref, bridgeNonce: nonce }))).status).toBe(202);
  expect(requested).toHaveLength(1);
});

test("an expired confirmation deploys nothing", async () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: new Date(Date.now() - 60 * 60_000) });
  recordManagerReport({
    key: "confirm-expired",
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "stale",
    confirmation,
  });
  const ref = drainBridgeReports().reports.at(-1)!.seq;

  const response = await POST(deployRequest({
    revision: SHA, idempotencyKey: "k1", bridgeRef: ref, bridgeNonce: confirmation.nonce,
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ reason: "expired" });
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
