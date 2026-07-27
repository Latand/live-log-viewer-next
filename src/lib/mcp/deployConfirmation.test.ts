import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

/**
 * The confirmation gate is the only thing between a spoken yes and a production
 * deploy (#691 §4, §7.7). A deploy that can be issued without presenting one is a
 * path around the entire round trip, so these assert the refusals — and that a
 * refusal never reaches the deployment endpoint at all.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-confirm-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_deploy_gate");
}

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

let posted: { pathname: string; body: Record<string, unknown> }[] = [];

function bindings() {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { deploymentId: "deploy-1", revision: body.revision, state: "accepted" };
    },
  };
  return viewerMcpBindings(undefined, control);
}

function confirmedDeploy(): { seq: number; nonce: string } {
  const confirmation = mintBridgeConfirmation({ sha: SHA });
  recordManagerReport({
    key: `confirm-${confirmation.nonce}`,
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "gates green",
    confirmation,
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;
  return { seq, nonce: confirmation.nonce };
}

test("a deploy with no bridge confirmation is refused and never reaches the endpoint", async () => {
  sandbox();
  const tools = bindings();
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1",
    revision: SHA,
    confirm: "deploy",
  })).rejects.toThrow(/confirmation/i);
  expect(posted).toEqual([]);
});

test("a confirmed deploy reaches the endpoint exactly once, and a replay does not", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();

  const receipt = await tools.deploy_exact_sha({
    clientRequestId: "d1",
    revision: SHA,
    confirm: "deploy",
    bridgeRef: seq,
    bridgeNonce: nonce,
  });
  expect(receipt).toMatchObject({ revision: SHA });
  expect(posted).toHaveLength(1);

  /* The nonce is spent. A second call presenting it deploys nothing, whatever its
     clientRequestId says. */
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d2",
    revision: SHA,
    confirm: "deploy",
    bridgeRef: seq,
    bridgeNonce: nonce,
  })).rejects.toThrow(/consumed/);
  expect(posted).toHaveLength(1);
});

test("a wrong nonce, a wrong SHA and an unknown ref each deploy nothing", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();

  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA, confirm: "deploy", bridgeRef: seq, bridgeNonce: "wrong",
  })).rejects.toThrow(/nonce_mismatch/);

  await expect(tools.deploy_exact_sha({
    clientRequestId: "d2", revision: "b".repeat(40), confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  })).rejects.toThrow(/sha_mismatch/);

  await expect(tools.deploy_exact_sha({
    clientRequestId: "d3", revision: SHA, confirm: "deploy", bridgeRef: 9_999, bridgeNonce: nonce,
  })).rejects.toThrow(/no_confirmation/);

  expect(posted).toEqual([]);

  /* None of those refusals spent the confirmation, so the right answer still works. */
  await tools.deploy_exact_sha({
    clientRequestId: "d4", revision: SHA, confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  });
  expect(posted).toHaveLength(1);
});

test("an expired confirmation deploys nothing", async () => {
  sandbox();
  const tools = bindings();
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: new Date(Date.now() - 60 * 60_000) });
  recordManagerReport({
    key: "confirm-expired",
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "stale",
    confirmation,
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;

  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA, confirm: "deploy", bridgeRef: seq, bridgeNonce: confirmation.nonce,
  })).rejects.toThrow(/expired/);
  expect(posted).toEqual([]);
});

test("confirm=deploy is still required on top of the confirmation", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA, bridgeRef: seq, bridgeNonce: nonce,
  })).rejects.toThrow(/confirm/);
  expect(posted).toEqual([]);
});

test("an abbreviated SHA is still refused before any confirmation is spent", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA.slice(0, 12), confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  })).rejects.toThrow(/40-character/);

  /* Still spendable: a malformed request must not burn the operator's yes. */
  await tools.deploy_exact_sha({
    clientRequestId: "d2", revision: SHA, confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  });
  expect(posted).toHaveLength(1);
});
