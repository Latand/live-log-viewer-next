import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authorizeBridgeDeploy } from "./service";
import { consumeBridgeConfirmation } from "./confirmation";
import { acceptDirectDeployIntent, DEPLOY_INTENT_TTL_MS } from "./deployIntent";
import { drainBridgeReports, openBridgeChannel, readBridgeReportLog } from "./store";
import type { BridgeReportOrigin } from "./types";

/**
 * #795 — intent acceptance and its adversarial edges.
 *
 * The operator's spoken deploy becomes ONE consumable authorization: pinned to
 * remote main at acceptance, bound to a project and seat, expiring, replayable
 * by directive identity, superseded by the operator's next word, and consumed
 * exactly once through the SAME production gate the legacy round trip uses —
 * so every property proven here is a property the deployed executor enforces.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const OTHER_SHA = "1111111111111111111111111111111111111111";
const GATEWAY: BridgeReportOrigin = { kind: "gateway", conversationId: "conversation_root", role: null };

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-intent-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_intent");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function accept(options: {
  directiveId?: string;
  project?: string;
  sha?: string;
  now?: Date;
} = {}) {
  return acceptDirectDeployIntent({
    directiveId: options.directiveId ?? "bridge_d_turn_1_0",
    project: options.project ?? "proj-a",
    seatConversationId: "conversation_manager",
    origin: GATEWAY,
    instruction: "deploy it",
    resolveRemoteMain: async () => options.sha ?? SHA,
    ...(options.now ? { now: options.now } : {}),
  });
}

test("acceptance pins remote main, records one authorization, and the operator's words are the audit body", async () => {
  const intent = await accept();
  expect(intent.replayed).toBe(false);
  expect(intent.sha).toBe(SHA);

  const row = readBridgeReportLog().reports.find((report) => report.seq === intent.ref)!;
  expect(row.class).toBe("confirmation_request");
  expect(row.directIntent).toBe(true);
  expect(row.project).toBe("proj-a");
  expect(row.targetSeatConversationId).toBe("conversation_manager");
  expect(row.origin).toMatchObject({ kind: "gateway" });
  expect(row.body).toContain("deploy it");
  expect(row.confirmation).toMatchObject({ sha: SHA, nonce: intent.nonce });
  expect(Date.parse(row.confirmation!.expiresAt) - Date.now()).toBeLessThanOrEqual(DEPLOY_INTENT_TTL_MS + 1_000);
});

test("the authorization never reaches the gateway: the drain skips direct-intent rows", async () => {
  await accept();
  expect(drainBridgeReports().reports).toEqual([]);
});

test("a relay retry replays the SAME authorization instead of stacking a second one", async () => {
  const first = await accept();
  const replay = await accept({ sha: OTHER_SHA });
  expect(replay.replayed).toBe(true);
  expect(replay.ref).toBe(first.ref);
  expect(replay.nonce).toBe(first.nonce);
  /* Replay returns the ORIGINAL pin, whatever main has since drifted to. */
  expect(replay.sha).toBe(SHA);
  expect(readBridgeReportLog().reports).toHaveLength(1);
});

test("the authorization consumes exactly once through the production gate", async () => {
  const intent = await accept();
  const spend = authorizeBridgeDeploy({ ref: intent.ref, nonce: intent.nonce, sha: intent.sha });
  expect(spend).toEqual({ ok: true, sha: SHA });

  /* Replay of a spent authorization. */
  expect(authorizeBridgeDeploy({ ref: intent.ref, nonce: intent.nonce, sha: intent.sha }))
    .toEqual({ ok: false, reason: "consumed" });
});

test("a wrong nonce and a drifted revision refuse without consuming", async () => {
  const intent = await accept();
  expect(consumeBridgeConfirmation(intent.ref, { sha: intent.sha, nonce: "forged" }))
    .toEqual({ ok: false, reason: "nonce_mismatch" });
  expect(consumeBridgeConfirmation(intent.ref, { sha: OTHER_SHA, nonce: intent.nonce }))
    .toEqual({ ok: false, reason: "sha_mismatch" });

  /* Neither refusal destroyed the operator's authorization. */
  expect(consumeBridgeConfirmation(intent.ref, { sha: intent.sha, nonce: intent.nonce }))
    .toEqual({ ok: true, sha: SHA });
});

test("a stale intent refuses past its expiry", async () => {
  const intent = await accept({ now: new Date("2100-01-01T00:00:00Z") });
  expect(consumeBridgeConfirmation(
    intent.ref,
    { sha: intent.sha, nonce: intent.nonce },
    new Date("2100-01-01T00:11:00Z"),
  )).toEqual({ ok: false, reason: "expired" });
});

test("the operator's next deploy word supersedes the previous live authorization for the project", async () => {
  const first = await accept({ directiveId: "bridge_d_turn_1_0" });
  const second = await accept({ directiveId: "bridge_d_turn_2_0", sha: OTHER_SHA });
  expect(second.supersededSeqs).toEqual([first.ref]);

  expect(consumeBridgeConfirmation(first.ref, { sha: first.sha, nonce: first.nonce }))
    .toEqual({ ok: false, reason: "superseded" });
  expect(consumeBridgeConfirmation(second.ref, { sha: OTHER_SHA, nonce: second.nonce }))
    .toEqual({ ok: true, sha: OTHER_SHA });
});

test("a cross-project intent supersedes nothing outside its own project", async () => {
  const projectA = await accept({ directiveId: "bridge_d_turn_1_0", project: "proj-a" });
  const projectB = await accept({ directiveId: "bridge_d_turn_2_0", project: "proj-b", sha: OTHER_SHA });
  expect(projectB.supersededSeqs).toEqual([]);
  expect(consumeBridgeConfirmation(projectA.ref, { sha: projectA.sha, nonce: projectA.nonce }))
    .toEqual({ ok: true, sha: SHA });
});

test("an unresolvable remote mints nothing — fail closed", async () => {
  await expect(acceptDirectDeployIntent({
    directiveId: "bridge_d_turn_9_0",
    project: "proj-a",
    seatConversationId: "conversation_manager",
    origin: GATEWAY,
    instruction: "deploy",
    resolveRemoteMain: async () => { throw new Error("remote unreachable"); },
  })).rejects.toThrow(/remote unreachable/);
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("a short or non-hex pin is refused rather than recorded", async () => {
  await expect(accept({ sha: "abc123" })).rejects.toThrow(/full 40-hex/i);
  expect(readBridgeReportLog().reports).toEqual([]);
});
