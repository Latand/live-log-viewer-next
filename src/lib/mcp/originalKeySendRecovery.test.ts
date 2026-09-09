import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

/* Type-only, so the module graph still loads in the order the state root needs. */
import type { McpRequestBinding } from "./server";

/*
 * Issue #1609: a delivered send stayed unrecoverable because the two halves of
 * one request disagreed about its text. The send route TRIMS before it reserves,
 * and original-key recovery compared the caller's untrimmed argument against the
 * trimmed record — so a report ending in a newline came back
 * "the delivery payload contradicts the bound request", with no ids, forever.
 *
 * Both halves here are the production ones: the real `conversationHostPOST`
 * performs the admission normalization, a real `AgentRegistry` holds the
 * reservation and settles it, and the real MCP `send_message.recover` reads it
 * back. Only the structured host boundary is a fixture — that is the seam the
 * route's own suite uses, and it is downstream of every transform under test.
 *
 * The suite owns a throwaway HOME/state root: importing these modules drags in
 * everything that resolves state from the environment, and no test may read or
 * migrate the operator's live state (AGENTS.md).
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-original-key-send-recovery-"));
const previous = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.LLV_STATE_DIR,
  codex: process.env.LLV_CODEX_HOME,
};
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.LLV_CODEX_HOME = path.join(root, "codex");

const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");

afterAll(() => {
  setConversationHostDependenciesForTests(null);
  for (const [key, value] of [
    ["HOME", previous.home],
    ["XDG_CONFIG_HOME", previous.xdg],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_CODEX_HOME", previous.codex],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { conversationHostPOST } = await import("@/app/api/conversation-host/handlers");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { sendDownstreamKey, viewerMcpRecoverableTools } = await import("./bindings");

const transcriptPath = path.join(root, "recipient.jsonl");
fs.writeFileSync(transcriptPath, "{}\n");
const registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
registry.reconcileConversations([{
  engine: "codex",
  path: transcriptPath,
  accountId: "recovery-fixture-account",
  launchProfile: emptyLaunchProfile({ cwd: root }),
  turn: { state: "idle", source: "assistant", terminalAt: null },
  observedAt: "2026-09-09T08:00:00.000Z",
}]);
const recipient = Object.values(registry.snapshot().conversations)[0]!;
const generationId = recipient.generations.at(-1)!.id;

/** Every text the structured host was handed, in order — the count is what
    says no recovery ever admitted a second copy of a message. */
const admitted: { clientMessageId: string; text: string }[] = [];

setConversationHostDependenciesForTests({
  collectImagePayloads: () => ({ images: [], error: null }),
  completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  recordDirectOperatorWakatimeActivity: () => null,
  /* Stands in for the structured host, and reserves exactly what the real
     `enqueueStructuredMessage` reserves for a text-only send: the text the
     route handed it, under the caller's own key, with no digest of its own
     (the registry stamps one from the stored text). */
  enqueueStructuredMessage: async (request) => {
    const clientMessageId = request.clientMessageId ?? "";
    admitted.push({ clientMessageId, text: request.text });
    const operationId = `op_${admitted.length}`;
    registry.holdDelivery(recipient.id, request.text, clientMessageId, "text", [], null, {
      operationId,
      kind: "send",
      policy: "queue",
    });
    return {
      ok: true,
      structured: true,
      target: recipient.id,
      outcome: "queued",
      operationId,
      receipt: { operationId, status: "queued" },
    } as never;
  },
});

const tools = viewerMcpRecoverableTools({
  registrySnapshot: () => registry.readOnlySnapshot(),
  sendSettlementPorts: () => ({ registry, client: null }),
} as never);
const recover = tools.send_message!.recover;

function bindingFor(downstreamKey: string): McpRequestBinding {
  return {
    version: 1,
    toolName: "send_message",
    clientRequestId: downstreamKey,
    caller: { kind: "worker", conversationId: "conversation_caller", project: null },
    target: { project: null, identity: recipient.id },
    downstreamKey,
    owner: { pid: process.pid, startIdentity: null },
    claimedAt: "2026-09-09T08:00:01.000Z",
  };
}

/** One send through the real route, exactly as `sendMessage` posts it. */
async function send(downstreamKey: string, text: string) {
  return conversationHostPOST(new NextRequest("http://127.0.0.1/api/conversation-host", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      pid: null,
      path: transcriptPath,
      conversationId: recipient.id,
      clientMessageId: downstreamKey,
      text,
      images: [],
    }),
  }));
}

/** Admit one send and drive it to the delivered state the defect was found in:
    settled, its reservation text blanked, its digest the only content evidence. */
async function deliver(requestId: string, text: string): Promise<{ key: string; operationId: string }> {
  const key = sendDownstreamKey(requestId);
  const response = await send(key, text);
  expect(response.status).toBe(200);
  const body = await response.json() as { operationId: string };
  const delivery = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  registry.beginDeliveryAttempt(delivery.id, generationId);
  registry.recordDeliveryOutcome(delivery.id, "delivered", null, "delivered");
  return { key, operationId: body.operationId };
}

test("the send route trims what it reserves, so the record never holds the caller's trailing newline", async () => {
  const before = admitted.length;
  const { key } = await deliver("route-normalization", "fixture report\n");

  expect(admitted.slice(before)).toEqual([{ clientMessageId: key, text: "fixture report" }]);
  const settled = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  /* Delivered records blank their text, so the digest of the TRIMMED text is
     what any later reader has to match. */
  expect(settled.text).toBe("");
  expect(settled.contentDigest).toBe(Object.values(registry.readOnlySnapshot().deliveryOperationOwners)
    .find((owner) => owner.clientMessageId === key)!.contentDigest);
});

test("original-key recovery of a delivered send whose text ended in a newline reports the actual operation", async () => {
  const originalText = "terminal report for the manager\n";
  const admissions = admitted.length;
  const { key, operationId } = await deliver("trailing-newline-report", originalText);

  /* The exact arguments the caller still holds — untrimmed, as it sent them. */
  const recovered = await recover(bindingFor(key), { legacy: false, args: { text: originalText } });

  const owner = Object.values(registry.readOnlySnapshot().deliveryOperationOwners)
    .find((entry) => entry.clientMessageId === key)!;
  expect(recovered.outcome).toBe("settled");
  expect(recovered.reason).toBeNull();
  expect(recovered.ids).toEqual({ operationId, conversationId: recipient.id, deliveryId: owner.deliveryId! });
  /* Recovery READ the record. It admitted nothing, and invented no delivery
     time of its own: the settlement it reports is the one the registry made. */
  expect(recovered.facts).toMatchObject({
    state: "delivered",
    resend: "not-needed",
    duplicateRisk: false,
    settledAt: owner.settledAt!,
  });
  expect(admitted.length).toBe(admissions + 1);
});

test("leading and trailing whitespace recovers the same way, and an untouched text still does", async () => {
  const spaced = "\n  spaced report  \n";
  const spacedSend = await deliver("surrounded-report", spaced);
  const recoveredSpaced = await recover(bindingFor(spacedSend.key), { legacy: false, args: { text: spaced } });
  expect(recoveredSpaced).toMatchObject({ outcome: "settled", ids: { operationId: spacedSend.operationId } });

  const exact = "report with nothing to trim";
  const exactSend = await deliver("exact-report", exact);
  const recoveredExact = await recover(bindingFor(exactSend.key), { legacy: false, args: { text: exact } });
  expect(recoveredExact).toMatchObject({ outcome: "settled", ids: { operationId: exactSend.operationId } });
});

test("a changed payload under the same key still contradicts, and discloses nothing", async () => {
  const { key, operationId } = await deliver("changed-payload-control", "the original instruction\n");

  for (const changed of [
    "the amended instruction\n",
    "the original instruction and one more sentence\n",
    "theoriginalinstruction\n",
    "The original instruction\n",
  ]) {
    const answer = await recover(bindingFor(key), { legacy: false, args: { text: changed } });
    expect(answer.outcome).toBe("unknown");
    expect(answer.reason).toBe("the delivery payload contradicts the bound request");
    expect(answer.ids).toEqual({});
    expect(JSON.stringify(answer)).not.toContain(operationId);
  }
});

test("a record reserved verbatim by the legacy path recovers under the same original arguments", async () => {
  /* `deliverConversationMessage` reserves the text it was given, untrimmed
     (`src/lib/delivery.ts`), so both admitted forms are reachable in durable
     records and recovery has to accept whichever one is stored. */
  const originalText = "legacy relay\n";
  const key = sendDownstreamKey("legacy-verbatim-record");
  const held = registry.holdDelivery(recipient.id, originalText, key, "text", [], null, {
    operationId: "op_legacy_verbatim",
    kind: "send",
    policy: "queue",
  });
  registry.beginDeliveryAttempt(held.id, generationId);
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");

  expect(await recover(bindingFor(key), { legacy: false, args: { text: originalText } }))
    .toMatchObject({ outcome: "settled", ids: { operationId: "op_legacy_verbatim" } });
  expect(await recover(bindingFor(key), { legacy: false, args: { text: "a different relay\n" } }))
    .toMatchObject({ outcome: "unknown", reason: "the delivery payload contradicts the bound request", ids: {} });
});

test("recovery leaves the durable records exactly as it found them", async () => {
  const originalText = "read-only report\n";
  const { key } = await deliver("read-only-recovery", originalText);
  const before = JSON.stringify(registry.readOnlySnapshot());
  const admissions = admitted.length;

  await recover(bindingFor(key), { legacy: false, args: { text: originalText } });
  await recover(bindingFor(key), { legacy: false, args: { text: "something else" } });

  expect(JSON.stringify(registry.readOnlySnapshot())).toBe(before);
  expect(admitted.length).toBe(admissions);
});
