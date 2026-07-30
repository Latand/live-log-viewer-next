import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { acceptDirectDeployIntent } from "@/lib/bridge/deployIntent";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel, readBridgeReportLog } from "@/lib/bridge/store";
import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import { ViewerDeploymentCoordinator, type ViewerDeploymentAdapter } from "./deployment";
import { RuntimeJournal } from "./journal";

/**
 * The one checkpoint every deploy converges on (#691 §4).
 *
 * Three distinct callers can ask for a deploy — the MCP binding, the HTTP route, and
 * anything speaking the runtime-host protocol over its Unix socket. Gating them one
 * at a time produced two closed doors and a third behind them, so the authorization
 * moved here, to admission, where all three arrive.
 *
 * These run against the DEFAULT authorizer — the production one, reading the real
 * bridge files — because a test that injected its own would prove only that the seam
 * exists, which is exactly the shape of gate that let the third door open.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const stores: RuntimeJournal[] = [];

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const OWNER = { pid: 10, startIdentity: "10:1" };

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-admission-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_admission");
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function journal(name: string): RuntimeJournal {
  const store = new RuntimeJournal(path.join(sandboxes.at(-1)!, `${name}.sqlite`));
  stores.push(store);
  return store;
}

/**
 * Resolves whatever it is handed, so the SHA the gate sees is the SHA requested, and
 * records builds so a refused admission can be shown to have produced none.
 *
 * Everything past `build` throws: these tests are about whether admission happens at
 * all, and a deployment that gets that far has already passed the gate.
 */
class PassthroughAdapter {
  builds: string[] = [];
  async resolveRevision(revision: string): Promise<string> {
    return /^[0-9a-f]{40}$/.test(revision) ? revision : SHA;
  }
  async build(revision: string): Promise<ViewerReleaseIdentity> {
    this.builds.push(revision);
    throw new Error("this suite stops at admission");
  }
}

function coordinator(name: string): { coordinator: ViewerDeploymentCoordinator; adapter: PassthroughAdapter } {
  const adapter = new PassthroughAdapter();
  return {
    coordinator: new ViewerDeploymentCoordinator(
      journal(name),
      adapter as unknown as ViewerDeploymentAdapter,
      OWNER,
    ),
    adapter,
  };
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

test("a raw socket caller with no bridge proof is refused at admission", async () => {
  const { coordinator: deployments, adapter } = coordinator("no-proof");

  /* Exactly the request `host.ts` builds from a `viewer-deployment-request` frame:
     a revision and an idempotency key, and nothing else. This is the shape the third
     door accepted. */
  await expect(deployments.requestViewerDeployment({ revision: SHA, idempotencyKey: "socket-1" }))
    .rejects.toThrow(/deploy authorization/i);
  expect(adapter.builds).toEqual([]);
});

test("a proof with a wrong nonce, a wrong SHA or an unknown ref is refused at admission", async () => {
  const { coordinator: deployments, adapter } = coordinator("bad-proof");
  const { ref, nonce } = confirmed();

  await expect(deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k1", bridgeProof: { ref, nonce: "wrong" },
  })).rejects.toThrow(/nonce_mismatch/);
  await expect(deployments.requestViewerDeployment({
    revision: "b".repeat(40), idempotencyKey: "k2", bridgeProof: { ref, nonce },
  })).rejects.toThrow(/sha_mismatch/);
  await expect(deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k3", bridgeProof: { ref: 9_999, nonce },
  })).rejects.toThrow(/no_confirmation/);
  expect(adapter.builds).toEqual([]);

  /* None of those spent it, so the operator's actual yes still works. */
  const receipt = await deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k4", bridgeProof: { ref, nonce },
  });
  expect(receipt.state).toBe("accepted");
});

test("an expired confirmation is refused at admission", async () => {
  const { coordinator: deployments } = coordinator("expired");
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: new Date(Date.now() - 60 * 60_000) });
  recordManagerReport({
    key: "confirm-expired", class: "confirmation_request", at: new Date().toISOString(), body: "stale", confirmation,
  });
  const ref = drainBridgeReports().reports.at(-1)!.seq;

  await expect(deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k1", bridgeProof: { ref, nonce: confirmation.nonce },
  })).rejects.toThrow(/expired/);
});

test("one confirmation authorizes one deploy, and a fresh key cannot reuse it", async () => {
  const { coordinator: deployments } = coordinator("single-use");
  const { ref, nonce } = confirmed();

  expect((await deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k1", bridgeProof: { ref, nonce },
  })).state).toBe("accepted");

  await expect(deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k2", bridgeProof: { ref, nonce },
  })).rejects.toThrow(/consumed/);
});

test("an identical retry after a lost response succeeds on the original receipt", async () => {
  /* The confirmation was spent by the first attempt. Checking it before the replay
     lookup would refuse the retry as `consumed` and turn a dropped response into a
     permanently failed deploy — so the recorded receipt for that idempotency key is
     itself the proof that this key was authorized once. */
  const { coordinator: deployments } = coordinator("lost-response");
  const { ref, nonce } = confirmed();

  const first = await deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "same-key", bridgeProof: { ref, nonce },
  });
  expect(first).toMatchObject({ state: "accepted", replayed: false });

  const retry = await deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "same-key", bridgeProof: { ref, nonce },
  });
  expect(retry).toMatchObject({ state: "accepted", replayed: true });
  if (first.state === "accepted" && retry.state === "accepted") {
    expect(retry.deploymentId).toBe(first.deploymentId);
  }
});

test("a retry that lost its proof entirely still replays, because the receipt carries the authority", () => {
  const { coordinator: deployments } = coordinator("proofless-retry");
  const proof = confirmed();

  return deployments
    .requestViewerDeployment({ revision: SHA, idempotencyKey: "k1", bridgeProof: proof })
    .then(async (first) => {
      /* No proof at all on the retry — the recorded receipt for this key is the
         authority, and re-presenting a spent nonce would be refused. */
      const retry = await deployments.requestViewerDeployment({ revision: SHA, idempotencyKey: "k1" });
      expect(retry).toMatchObject({ state: "accepted", replayed: true });
      if (first.state === "accepted" && retry.state === "accepted") {
        expect(retry.deploymentId).toBe(first.deploymentId);
      }
    });
});

test("a refused admission spends nothing, so the record still shows an unused confirmation", async () => {
  const { coordinator: deployments } = coordinator("unspent");
  const { ref } = confirmed();

  await expect(deployments.requestViewerDeployment({
    revision: SHA, idempotencyKey: "k1", bridgeProof: { ref, nonce: "wrong" },
  })).rejects.toThrow();

  const stored = readBridgeReportLog().reports.find((report) => report.seq === ref);
  expect(stored?.confirmation?.consumedAt).toBeUndefined();
});

/* ── #795: the SAME admission gate consumes a direct operator intent ─────── */

test("#795: a direct operator intent admits a deploy through the unchanged production gate", async () => {
  const { coordinator: deployments } = coordinator("direct-intent");
  const intent = await acceptDirectDeployIntent({
    directiveId: "bridge_d_turn_1_0",
    project: "proj-a",
    seatConversationId: "conversation_manager",
    origin: { kind: "gateway", conversationId: "conversation_root", role: null },
    instruction: "deploy it",
    resolveRemoteMain: async () => SHA,
  });

  const receipt = await deployments.requestViewerDeployment({
    revision: intent.sha, idempotencyKey: "k1", bridgeProof: { ref: intent.ref, nonce: intent.nonce },
  });
  expect(receipt.state).toBe("accepted");

  /* Single-use holds for intents exactly as for legacy confirmations. */
  await expect(deployments.requestViewerDeployment({
    revision: intent.sha, idempotencyKey: "k2", bridgeProof: { ref: intent.ref, nonce: intent.nonce },
  })).rejects.toThrow(/consumed/);
});

test("#795: an intent superseded by the operator's newer word is refused at admission", async () => {
  const { coordinator: deployments, adapter } = coordinator("superseded-intent");
  const accept = (directiveId: string, sha: string) => acceptDirectDeployIntent({
    directiveId,
    project: "proj-a",
    seatConversationId: "conversation_manager",
    origin: { kind: "gateway", conversationId: "conversation_root", role: null },
    instruction: "deploy it",
    resolveRemoteMain: async () => sha,
  });
  const stale = await accept("bridge_d_turn_1_0", SHA);
  const fresh = await accept("bridge_d_turn_2_0", "c".repeat(40));

  await expect(deployments.requestViewerDeployment({
    revision: stale.sha, idempotencyKey: "k1", bridgeProof: { ref: stale.ref, nonce: stale.nonce },
  })).rejects.toThrow(/superseded/);
  expect(adapter.builds).toEqual([]);

  /* The operator's latest word still deploys. */
  expect((await deployments.requestViewerDeployment({
    revision: fresh.sha, idempotencyKey: "k2", bridgeProof: { ref: fresh.ref, nonce: fresh.nonce },
  })).state).toBe("accepted");
});
