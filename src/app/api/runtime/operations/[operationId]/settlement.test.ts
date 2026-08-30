import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { handleRuntimeOperationQuery } from "@/lib/runtime/http";
import { resolveSendReceipt, sendReceiptFor } from "@/lib/runtime/sendSettlement";

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

test("a journal that answers queued and refuses the fence yields one terminal answer, not two", async () => {
  /* The half outage this route has to survive: the journal's READS work and its
     WRITES do not — a socket that died between the two, a database gone
     read-only. Settlement is built for it and settles the durable record from
     the record alone, because a host that cannot be written to would otherwise
     make `queued` permanent exactly as a full outage would.

     The route then read the journal a second time and preferred it
     unconditionally, so one query answered `send: failed` beside
     `receipt: queued`. The consistency rule: a terminal durable settlement is
     authoritative once it is written. The journal's still-open status is not
     reported next to it, and it is not a second answer the caller has to
     reconcile. */
  const { registry } = sandboxRegistry("half-outage");
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const held = registry.holdDelivery(conversation.id, "hold the cutover", "operation-route-half-outage");
  const operationId = held.command.operationId;
  registry.beginDeliveryAttempt(held.id, held.generationId ?? "");

  const queued = {
    operationId,
    receipt: {
      operationId,
      idempotencyKey: "operation-route-half-outage",
      conversationId: conversation.id,
      kind: "send" as const,
      status: "queued" as const,
      reason: null,
      at: new Date().toISOString(),
      revision: 1,
    },
    replayed: false,
  };
  const reads: string[] = [];
  const client = {
    operationStatus: async (asked: string) => {
      reads.push(asked);
      return queued;
    },
    transitionOperation: async () => {
      throw new Error("attempt to write a readonly database");
    },
  } as unknown as RuntimeHostClient;

  const response = await handleRuntimeOperationQuery(operationId, {
    client: () => client,
    rolledBack: () => false,
    settle: (asked, asClient) => resolveSendReceipt(asked, { client: asClient, registry, windowMs: 0 }),
  });

  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, Record<string, unknown>>;
  /* One answer, and it is the terminal unverified one: the send may have
     reached the recipient, so a resend has to be verified first. */
  expect(body.send).toMatchObject({
    operationId,
    state: "failed",
    duplicateRisk: true,
    resend: "verify-first",
    evidence: "delivery-record",
  });
  const receiptStatus = body.receipt.status;
  expect(body.receipt).toMatchObject({ operationId, status: "failed" });
  expect(receiptStatus).not.toBe("queued");
  /* And the settled record is what the delivery queue reads before it actuates
     anything, so the operation the journal still shows open cannot arrive late
     and make this answer a lie. */
  expect(sendReceiptFor(registry.readOnlySnapshot(), operationId)?.state).toBe("failed");
  /* The journal was read once — by the settlement — and never re-asked for an
     answer that could contradict the one already written. */
  expect(reads).toEqual([operationId]);
});

test("an unreadable settlement is not answered as an open send", async () => {
  /* The authoritative store is a FAILABLE read like every other one here. When
     it could not be read, the journal's still-open status is not the answer:
     this endpoint may already have handed out a terminal settlement for this
     id, and reporting `queued` beside it would take that answer back. The query
     ends instead, retryably, and says which read was missing. */
  const { registry } = sandboxRegistry("settlement-unreadable");
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const held = registry.holdDelivery(conversation.id, "hold the cutover", "operation-route-unreadable");
  const operationId = held.command.operationId;
  const queued = {
    operationId,
    replayed: false,
    receipt: {
      operationId,
      idempotencyKey: "operation-route-unreadable",
      conversationId: conversation.id,
      kind: "send" as const,
      status: "queued" as const,
      reason: null,
      at: new Date().toISOString(),
      revision: 1,
    },
  };
  const client = { operationStatus: async () => queued } as unknown as RuntimeHostClient;
  const dependencies = {
    client: () => client,
    rolledBack: () => false,
    settle: async () => { throw new Error("delivery record is unavailable"); },
  };

  const open = await handleRuntimeOperationQuery(operationId, dependencies);
  const openBody = await open.json() as Record<string, unknown>;
  expect(open.status).toBe(503);
  expect(openBody).toMatchObject({ error: "delivery record is unavailable", retryable: true });

  /* A journal answer that is itself terminal is proof on its own — the record
     is projected from it, so the two cannot disagree about it — and it is
     answered even while the record cannot be read. */
  const terminal = await handleRuntimeOperationQuery(operationId, {
    ...dependencies,
    client: () => ({
      operationStatus: async () => ({
        ...queued,
        receipt: { ...queued.receipt, status: "delivered" as const },
      }),
    }) as unknown as RuntimeHostClient,
  });
  expect(terminal.status).toBe(200);
  expect(await terminal.json()).toMatchObject({ operationId, receipt: { status: "delivered" } });
});
