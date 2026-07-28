import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { parseBridgeTrailer } from "@/lib/bridge/directive";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";
import { adoptOrchestratorRecord } from "@/lib/orchestrator/store";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

/**
 * Intent, flowing user -> voice -> manager, through production code (#691 §4).
 *
 * The gateway does not compose a directive id or address a recipient: it says what
 * the user asked for and which turn it belongs to, and this tool derives the rest.
 * That is what makes retry-after-a-lost-receipt safe — the id is a function of the
 * turn, so the manager's durable receipt recognizes the retry instead of taking the
 * instruction twice.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

let posted: { pathname: string; body: Record<string, unknown> }[] = [];

function sandbox(withManager = true): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-directive-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_directive");
  if (withManager) {
    adoptOrchestratorRecord({
      conversationId: "conversation_manager",
      path: null,
      createdAt: new Date().toISOString(),
    });
  }
}

function bindings() {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { outcome: "delivered", operationId: "op-1" };
    },
  };
  return viewerMcpBindings(undefined, control);
}

test("a directive is addressed to the manager the record names, not to whoever the caller says", async () => {
  sandbox();
  const tools = bindings();
  const receipt = await tools.bridge_directive({
    clientRequestId: "ignored-by-the-derivation",
    rootTurnId: "turn_0199",
    utterance: 0,
    instruction: "start a reviewer on the auth branch",
    /* A gateway that tried to redirect its own relay must not be able to. */
    conversationId: "conversation_some_worker",
  });

  expect(posted).toHaveLength(1);
  expect(posted[0]!.body.conversationId).toBe("conversation_manager");
  expect(receipt).toMatchObject({ managerConversationId: "conversation_manager" });
});

test("the delivery id is derived from the root turn, so a retry is one instruction", async () => {
  sandbox();
  const tools = bindings();
  const args = {
    clientRequestId: "d1",
    rootTurnId: "turn_0199",
    utterance: 0,
    instruction: "start a reviewer",
  };
  await tools.bridge_directive(args);
  await tools.bridge_directive({ ...args, clientRequestId: "a-different-request-id" });

  const keys = posted.map((call) => call.body.clientMessageId);
  expect(keys).toEqual(["bridge_d_turn_0199_0", "bridge_d_turn_0199_0"]);

  /* A second utterance in the same turn is a different instruction. */
  await tools.bridge_directive({ ...args, utterance: 1 });
  expect(posted.at(-1)!.body.clientMessageId).toBe("bridge_d_turn_0199_1");
});

test("the user's words travel as prose, with the correlation trailer on its own line", async () => {
  sandbox();
  const tools = bindings();
  recordManagerReport({
    key: "q1",
    class: "question",
    at: new Date().toISOString(),
    body: "merge #726 despite the flaky test?",
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;

  await tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0200",
    utterance: 0,
    instruction: "he says hold it until the test is fixed",
    ref: seq,
  });

  const body = String(posted[0]!.body.text);
  expect(body.startsWith("he says hold it until the test is fixed")).toBe(true);
  expect(parseBridgeTrailer(body)).toEqual({ ref: seq });
});

test("a deploy answer carries the nonce and SHA the manager must verify", async () => {
  sandbox();
  const tools = bindings();
  const sha = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
  const confirmation = mintBridgeConfirmation({ sha });
  recordManagerReport({
    key: "c1",
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "gates green",
    confirmation,
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;

  await tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0201",
    utterance: 0,
    instruction: "yes, ship it",
    ref: seq,
    nonce: confirmation.nonce,
    sha,
  });

  expect(parseBridgeTrailer(String(posted[0]!.body.text))).toEqual({ ref: seq, nonce: confirmation.nonce, sha });
});

test("a half-formed confirmation answer is refused rather than relayed as a bare reference", async () => {
  sandbox();
  const tools = bindings();
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0202",
    utterance: 0,
    instruction: "yes",
    ref: 1,
    nonce: "abc",
  })).rejects.toThrow(/nonce and sha/);
  expect(posted).toEqual([]);
});

test("with no manager designated the directive is refused, not delivered somewhere else", async () => {
  sandbox(false);
  const tools = bindings();
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0203",
    utterance: 0,
    instruction: "start a reviewer",
  })).rejects.toThrow(/manager/i);
  expect(posted).toEqual([]);
});

test("a directive refuses input that would break its own id derivation", async () => {
  sandbox();
  const tools = bindings();
  for (const args of [
    { rootTurnId: "turn with spaces", utterance: 0, instruction: "go" },
    { rootTurnId: "turn_1", utterance: -1, instruction: "go" },
    { rootTurnId: "turn_1", utterance: 0, instruction: "   " },
  ]) {
    await expect(tools.bridge_directive({ clientRequestId: "d1", ...args })).rejects.toThrow();
  }
  expect(posted).toEqual([]);
});
