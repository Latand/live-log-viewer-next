import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { FakeEngineHost, createFakeDeliveryLedger, type FakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";

/**
 * The WHOLE chain for a native injection (#1560): the route the composer posts
 * to, the durable admission behind it, a real `RuntimeJournal`, the delivery
 * queue, and the engine boundary.
 *
 * This file exists because every layer of this feature passed its own tests
 * while the chain between them did not run once. Each layer's suite supplies
 * its own edges; only this one can catch a command that one layer builds and
 * the next refuses — which is exactly what happened: enqueue stamped an
 * `interrupt-active` policy onto every operation it forwarded, and the parser
 * refuses a policy on an injection, so every "Add to context" died at the
 * journal with `thread/inject_items` never called.
 */

const directories: string[] = [];
function scratch(name: string): string {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `llv-inject-http-${name}-`));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/inject", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Chain {
  dependencies: RuntimeHttpDependencies;
  registry: AgentRegistry;
  ledger: FakeDeliveryLedger;
  journal: RuntimeJournal;
  conversationId: string;
  drain(): Promise<void>;
}

function chain(name: string, options: { activeTurnRef?: string | null; inject?: boolean } = {}): Chain {
  const directory = scratch(name);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const activeTurnRef = options.activeTurnRef ?? null;
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "recipient-thread" },
      hostKind: "codex-app-server",
      host: "hosted",
      writerClaim: "owner:1",
      turn: activeTurnRef ? "running" : "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true, inject: options.inject ?? true },
      activeTurnId: activeTurnRef,
    },
  });
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger, {
    status: activeTurnRef ? "active" : "idle",
    sessionKey: "recipient-thread",
    endpoint: "fake:inject",
    pid: 1,
    processStartIdentity: "fake:1",
    eventCursor: 0,
    protocolVersion: "0.154.0",
    activeTurnRef,
    pendingAttention: [],
    activeFlags: ["native-inject"],
    account: null,
  });
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => journal.append(event),
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
  } as RuntimeHostClient;
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: () => false,
    hostClaim: () => "owner:1",
    injectionBinding: () => ({ threadId: "recipient-thread", accountId: null, writerClaim: "owner:1" }),
  }, () => host);
  return {
    ledger,
    journal,
    registry,
    conversationId: conversation.id,
    drain: () => queue.drain().then(() => {}),
    dependencies: {
      enabled: () => true,
      client: () => client,
      structuredEnabled: () => true,
      registry: () => registry,
      enqueue: enqueueStructuredMessage,
      kick: () => {},
    } as RuntimeHttpDependencies,
  };
}

test("an injection posted to the route reaches the engine as an injection", async () => {
  const link = chain("idle");
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "read the migration notes too",
    idempotencyKey: "inject-e2e-idle",
  }), "inject", link.dependencies);

  /* ACCEPTED. A 503 here is the whole defect this file was written for: the
     command enqueue builds must be one the journal will admit. */
  expect(response.status).toBe(202);
  const body = await response.json() as { operationId: string; receipt?: { kind: string; status: string } };
  expect(body.receipt).toMatchObject({ kind: "inject", status: "queued" });

  await link.drain();

  /* AND IT ARRIVED AS AN INJECTION. Not as a send, which would have started a
     turn, and not as a steer. */
  expect(link.ledger.injections).toHaveLength(1);
  expect(link.ledger.injections[0]).toMatchObject({
    text: "read the migration notes too",
    threadId: "recipient-thread",
  });
  expect(link.ledger.writes).toEqual([]);
  expect(link.journal.operationResult(body.operationId)?.receipt.status).toBe("delivered");
  link.journal.close();
});

test("an injection posted while a turn is running joins it without interrupting", async () => {
  const link = chain("active", { activeTurnRef: "turn-live" });
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "one more constraint",
    idempotencyKey: "inject-e2e-active",
  }), "inject", link.dependencies);

  expect(response.status).toBe(202);
  const body = await response.json() as { operationId: string };
  await link.drain();

  expect(link.ledger.injections).toHaveLength(1);
  /* The running turn was never written to as a message. */
  expect(link.ledger.writes).toEqual([]);
  const receipt = link.journal.operationResult(body.operationId)?.receipt;
  expect(receipt?.status).toBe("delivered");
  expect(receipt?.turnId).toBe("turn-live");
  link.journal.close();
});

test("a file attachment rides the injection as a path in the text", async () => {
  const link = chain("files");
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "use the attached spec",
    idempotencyKey: "inject-e2e-files",
    files: [{ name: "spec.md", base64: Buffer.from("# spec\n").toString("base64") }],
  }), "inject", link.dependencies);

  expect(response.status).toBe(202);
  await link.drain();

  expect(link.ledger.injections).toHaveLength(1);
  /* The route writes the bytes to the conversation inbox and names the path in
     the text, so a document reaches the thread without any engine image
     capability — exactly as it does on a send. */
  expect(link.ledger.injections[0]!.text).toContain("spec.md");
  expect(link.ledger.injections[0]!.text).toContain("use the attached spec");
  link.journal.close();
});

test("an image payload is refused by the route before any durable admission", async () => {
  const link = chain("images");
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "look at this",
    idempotencyKey: "inject-e2e-images",
    images: [{ base64: Buffer.from("not-really-a-png").toString("base64"), mime: "image/png" }],
  }), "inject", link.dependencies);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("cannot carry images") });
  await link.drain();
  expect(link.ledger.injections).toEqual([]);
  expect(link.ledger.writes).toEqual([]);
  link.journal.close();
});

test("a host without the capability is refused at admission, with no engine write", async () => {
  const link = chain("uncapable", { inject: false });
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "nowhere to go",
    idempotencyKey: "inject-e2e-uncapable",
  }), "inject", link.dependencies);

  expect(response.status).toBeGreaterThanOrEqual(400);
  await link.drain();
  expect(link.ledger.injections).toEqual([]);
  expect(link.ledger.writes).toEqual([]);
  link.journal.close();
});

test("replaying the same key returns the first operation and injects once", async () => {
  const link = chain("replay");
  const body = {
    conversationId: link.conversationId,
    text: "exactly once",
    idempotencyKey: "inject-e2e-replay",
  };
  const first = await handleRuntimeCommand(request(body), "inject", link.dependencies);
  const second = await handleRuntimeCommand(request(body), "inject", link.dependencies);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  const firstBody = await first.json() as { operationId: string };
  const secondBody = await second.json() as { operationId: string };
  expect(secondBody.operationId).toBe(firstBody.operationId);

  await link.drain();
  expect(link.ledger.injections).toHaveLength(1);
  link.journal.close();
});

/**
 * A conversation with a PERSISTED structured owner but no live runtime client.
 *
 * That combination is what reaches `holdDuringRuntimeSynchronization`'s
 * reservation-creating path — the one whose reservations only the migration
 * coordinator drains, against a successor generation.
 */
function ownedButUnreachable(name: string) {
  const directory = scratch(name);
  const sessionId = "dddddddd-dddd-0ddd-0ddd-dddddddddddd";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "account-one",
    launchProfile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-09-11T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: "account-one",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:inject-unreachable",
      process: null,
      eventCursor: 0,
      protocolVersion: "0.154.0",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  return {
    registry,
    conversationId: conversation.id,
    dependencies: {
      enabled: () => true,
      /* THE CONDITION: the runtime host socket is unavailable at admission. */
      client: () => null,
      structuredEnabled: () => true,
      registry: () => registry,
      enqueue: enqueueStructuredMessage,
      kick: () => {},
    } as RuntimeHttpDependencies,
  };
}

test("an ordinary send IS held when the runtime host is unreachable", async () => {
  /* The control for the test below: this fixture really does reach the hold,
     so the injection's refusal there is a refusal and not a fixture that never
     got that far. */
  const link = ownedButUnreachable("held-send");
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "a message that may wait for the successor",
    idempotencyKey: "send-unreachable",
  }), "send", link.dependencies);

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ held: true });
  const held = Object.values(link.registry.readOnlySnapshot().heldDeliveries);
  expect(held.map((delivery) => delivery.command?.kind)).toEqual(["send"]);
});

test("an injection is REFUSED where a send is held, so nothing can replay it into a successor", async () => {
  /* Held reservations are drained only by the migration coordinator, against
     the SUCCESSOR generation — a different thread. A message belongs there; an
     injection's whole meaning is the thread it was aimed at, so it is refused
     before any reservation exists rather than replayed elsewhere or dropped. */
  const link = ownedButUnreachable("refused-inject");
  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "context for this thread only",
    idempotencyKey: "inject-unreachable",
  }), "inject", link.dependencies);

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("cannot be held"),
  });
  expect(Object.values(link.registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
});

test("an injection is refused rather than held when the runtime host is unreachable", async () => {
  /* The other way into a held reservation (#1560). With no runtime client the
     admission falls to the synchronization hold, whose reservations are drained
     only by the migration coordinator — against the SUCCESSOR generation, which
     is a different thread. An injection replayed there would write the
     operator's context into a thread they never aimed at, so it is refused
     before any reservation exists. A SEND takes the hold as it always has. */
  const link = chain("unreachable");
  const withoutClient = { ...link.dependencies, client: () => null } as RuntimeHttpDependencies;

  const response = await handleRuntimeCommand(request({
    conversationId: link.conversationId,
    text: "context for this thread only",
    idempotencyKey: "inject-e2e-unreachable",
  }), "inject", withoutClient);

  expect(response.status).toBeGreaterThanOrEqual(400);
  /* THE INVARIANT, whichever refusal fires first: no reservation carrying
     `kind: "inject"` exists, so the migration coordinator has nothing to replay
     into a successor thread. */
  const held = Object.values(link.registry.readOnlySnapshot().heldDeliveries);
  expect(held.filter((delivery) => delivery.command?.kind === "inject")).toEqual([]);
  await link.drain();
  expect(link.ledger.injections).toEqual([]);
  expect(link.ledger.writes).toEqual([]);
  link.journal.close();
});
