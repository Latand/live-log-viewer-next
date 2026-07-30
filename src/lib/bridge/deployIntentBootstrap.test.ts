import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authorizeBridgeDeploy } from "./service";
import {
  bootstrapDirectDeployIntent,
  DeployIntentBootstrapRefusal,
  type DeployIntentBootstrapSources,
} from "./deployIntentBootstrap";
import { drainBridgeReports, openBridgeChannel, readBridgeReportLog } from "./store";

/**
 * #795 bootstrap — the paradox-closing path, proven on its own terms.
 *
 * Production cannot run the new `bridge_directive` acceptance until the new
 * Viewer is deployed, and deploying it is what awaits authorization. The
 * bootstrap converts the operator's ALREADY-DELIVERED root directive into the
 * existing-format authorization — so the two things to prove are:
 *
 *  1. it needs NOTHING the new Viewer serves: only the local state directory
 *     and the root transcript on disk (the sources here contain no control
 *     surface at all), and the row it mints is consumed by the SAME
 *     production admission gate the old executor already runs;
 *  2. it refuses everything that is not the gateway's own recorded deploy
 *     relay — arbitrary prose, unattributed ids, non-deploy directives, stale
 *     directives — because attribution is the entire trust story.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const NOW = new Date("2100-01-02T12:00:00Z");

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-bootstrap-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_bootstrap");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The root transcript's record of the gateway's own bridge_directive call, as
    the session reader flattens it: tool name plus JSON arguments. */
function directiveCall(args: Record<string, unknown>, ts: string | null = "2100-01-02T11:30:00Z") {
  return { name: "mcp__viewer__bridge_directive", text: JSON.stringify(args), ts };
}

function sources(overrides: Partial<DeployIntentBootstrapSources> & {
  calls?: ReturnType<typeof directiveCall>[];
} = {}): DeployIntentBootstrapSources {
  const calls = overrides.calls ?? [
    directiveCall({ rootTurnId: "turn_42", utterance: 0, instruction: "deploy the viewer now" }),
  ];
  return {
    root: () => ({ conversationId: "conversation_root", transcriptPath: "/transcripts/root.jsonl", engine: "claude" }),
    toolCalls: () => calls,
    seats: () => [{ project: "proj-a", conversationId: "conversation_manager" }],
    rootProject: () => "proj-a",
    resolveRemoteMain: async () => SHA,
    now: () => NOW,
    ...overrides,
  };
}

test("the recorded root directive becomes an existing-format authorization the production gate consumes — no serving Viewer involved", async () => {
  const intent = await bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources());
  expect(intent.sha).toBe(SHA);
  expect(intent.project).toBe("proj-a");
  expect(intent.instruction).toBe("deploy the viewer now");

  const row = readBridgeReportLog().reports.find((report) => report.seq === intent.ref)!;
  expect(row.class).toBe("confirmation_request");
  expect(row.directIntent).toBe(true);

  /* No gateway drainage: the operator already spoke and is never re-prompted. */
  expect(drainBridgeReports().reports).toEqual([]);

  /* The exact check the ALREADY-DEPLOYED executor runs at admission. */
  expect(authorizeBridgeDeploy({ ref: intent.ref, nonce: intent.nonce, sha: intent.sha }, NOW))
    .toEqual({ ok: true, sha: SHA });
});

test("a re-run replays the same single authorization", async () => {
  const first = await bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources());
  const again = await bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources());
  expect(again.replayed).toBe(true);
  expect(again.ref).toBe(first.ref);
  expect(again.nonce).toBe(first.nonce);
  expect(readBridgeReportLog().reports).toHaveLength(1);
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeployIntentBootstrapRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a bootstrap refusal");
}

test("arbitrary prose authorizes nothing: the argument must be a delivery id", async () => {
  expect(await refusal(bootstrapDirectDeployIntent("please deploy the viewer", sources())))
    .toBe("delivery_id_malformed");
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("an id the root transcript never relayed is refused as unattributed", async () => {
  expect(await refusal(bootstrapDirectDeployIntent("bridge_d_turn_999_0", sources())))
    .toBe("directive_not_attributed");
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("an attributed directive that is not a deploy ask converts to nothing", async () => {
  const code = await refusal(bootstrapDirectDeployIntent("bridge_d_turn_7_0", sources({
    calls: [directiveCall({ rootTurnId: "turn_7", utterance: 0, instruction: "start a reviewer on the auth branch" })],
  })));
  expect(code).toBe("directive_not_a_deploy_ask");
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("a directive outside the bootstrap window (or without a timestamp) is stale", async () => {
  expect(await refusal(bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources({
    calls: [directiveCall({ rootTurnId: "turn_42", utterance: 0, instruction: "deploy" }, "2100-01-01T11:00:00Z")],
  })))).toBe("directive_stale");
  expect(await refusal(bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources({
    calls: [directiveCall({ rootTurnId: "turn_42", utterance: 0, instruction: "deploy" }, null)],
  })))).toBe("directive_stale");
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("no live root session, no conversion", async () => {
  expect(await refusal(bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources({ root: () => null }))))
    .toBe("no_root_session");
});

test("a directive with no designated seat for its project is refused", async () => {
  expect(await refusal(bootstrapDirectDeployIntent("bridge_d_turn_42_0", sources({ seats: () => [] }))))
    .toBe("manager_not_designated");
  expect(readBridgeReportLog().reports).toEqual([]);
});

test("the Ukrainian deploy ask the operator actually speaks is recognized", async () => {
  const intent = await bootstrapDirectDeployIntent("bridge_d_turn_8_0", sources({
    calls: [directiveCall({ rootTurnId: "turn_8", utterance: 0, instruction: "задеплой в'ювер" })],
  }));
  expect(intent.sha).toBe(SHA);
});
