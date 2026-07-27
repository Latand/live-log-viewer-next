import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

/**
 * The BINDING half of the deploy gate (#691 §4, §7.7).
 *
 * The confirmation is verified and SPENT at `/api/runtime/deployments` — the last
 * door, and the one every deploy path passes through — so what this file proves is
 * the binding's own two obligations: it refuses to call at all without proof, and it
 * forwards the proof it was given unaltered. The four checks themselves (nonce,
 * expiry, SHA match, replay) live in `src/app/api/runtime/deployments/route.test.ts`,
 * against the door that an attacker would use instead of this tool.
 *
 * Consumption deliberately does NOT happen here. Spending the nonce in the binding
 * and re-presenting it at the endpoint would have the real deploy refused as
 * `consumed`; spending it in both places would spend one yes twice.
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

test("the proof is forwarded to the endpoint unaltered, where it is verified and spent", async () => {
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
  expect(posted[0]).toMatchObject({
    pathname: "/api/runtime/deployments",
    body: { revision: SHA, bridgeRef: seq, bridgeNonce: nonce },
  });

  /* And the binding did NOT spend it: the endpoint is the one place that may, and a
     nonce spent here would have the real deploy refused as already consumed. */
  const stored = drainBridgeReports().reports.find((report) => report.seq === seq);
  expect(stored?.confirmation?.consumedAt).toBeUndefined();
});

test("a bridgeNonce without a bridgeRef, or the reverse, is refused before any call", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();

  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA, confirm: "deploy", bridgeNonce: nonce,
  })).rejects.toThrow(/confirmation/i);
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d2", revision: SHA, confirm: "deploy", bridgeRef: seq,
  })).rejects.toThrow(/confirmation/i);
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

test("an abbreviated SHA is refused before the endpoint is called at all", async () => {
  sandbox();
  const tools = bindings();
  const { seq, nonce } = confirmedDeploy();
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1", revision: SHA.slice(0, 12), confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  })).rejects.toThrow(/40-character/);
  expect(posted).toEqual([]);

  /* And the operator's yes is untouched, so the correct request still works. */
  await tools.deploy_exact_sha({
    clientRequestId: "d2", revision: SHA, confirm: "deploy", bridgeRef: seq, bridgeNonce: nonce,
  });
  expect(posted).toHaveLength(1);
});
