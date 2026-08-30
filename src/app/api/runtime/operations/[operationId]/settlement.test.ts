import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { sendReceiptFor } from "@/lib/runtime/sendSettlement";

import { GET } from "./route";

/**
 * The operation API is the OTHER surface a caller can ask what became of a send
 * (#1131). It used to report the delivery journal's raw state and nothing else,
 * which made `queued` a possible final answer for the length of an outage and
 * an accepted send unqueryable once the socket was gone. Both surfaces read the
 * same settlement now.
 */
const sandboxes: string[] = [];
const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;

afterEach(() => {
  setAgentRegistryForTests(null);
  if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
});
afterAll(() => {
  for (const sandbox of sandboxes) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandboxRegistry(name: string): { registry: AgentRegistry; filename: string } {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-operation-${name}-`));
  sandboxes.push(sandbox);
  const filename = path.join(sandbox, "agent-registry.json");
  return { registry: new AgentRegistry(filename), filename };
}

test("an accepted send stays queryable through a runtime outage instead of answering 503", async () => {
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  const { registry } = sandboxRegistry("outage");
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const held = registry.holdDelivery(conversation.id, "hold the cutover", "operation-route-outage");
  const operationId = held.command.operationId;
  /* Settled while the runtime was unreachable — the answer a receipt query
     gives during exactly this outage, and the answer this route must keep
     giving afterwards. */
  registry.recordDeliveryOutcome(
    held.id,
    "failed",
    "delivery was accepted and the runtime host could not give it a terminal answer",
    "unverified",
  );
  expect(sendReceiptFor(registry.readOnlySnapshot(), operationId)?.state).toBe("failed");

  const response = await GET(
    new Request(`http://127.0.0.1/api/runtime/operations/${operationId}`),
    { params: Promise.resolve({ operationId }) },
  );

  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, Record<string, unknown>>;
  expect(body.send).toMatchObject({
    operationId,
    state: "failed",
    duplicateRisk: true,
    resend: "verify-first",
  });
  /* The receipt shape every reader of this route already expects, projected off
     the durable record because the journal is what cannot be reached. */
  expect(body.receipt).toMatchObject({ operationId, kind: "send", status: "failed" });
});

test("an operation nothing accepted still answers that the plane is absent", async () => {
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  const { registry } = sandboxRegistry("unknown");
  setAgentRegistryForTests(registry);

  const response = await GET(
    new Request("http://127.0.0.1/api/runtime/operations/operation_never_admitted"),
    { params: Promise.resolve({ operationId: "operation_never_admitted" }) },
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: "runtime host socket is unavailable" });
});
