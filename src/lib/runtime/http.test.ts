import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { handleRuntimeCommand, handleRuntimeRetry, type RuntimeHttpDependencies } from "./http";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

function request(body: unknown, headers: Record<string, string> = { host: "127.0.0.1" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("runtime command HTTP handling preserves validation, CSRF, status, and conflict contracts", async () => {
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return {
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "send-one",
          conversationId: "conv-one",
          kind: "send" as const,
          status: "pending" as const,
          at: "2026-07-10T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const deps = { enabled: () => true, client: () => client };

  const accepted = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", deps);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ operationId: "op-one", receipt: { status: "pending" } });
  expect(commands).toHaveLength(1);

  const malformed = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "", idempotencyKey: "send-one" }), "send", deps);
  expect(malformed.status).toBe(400);

  const forbidden = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }, { host: "evil.example", origin: "https://evil.example" }), "send", deps);
  expect(forbidden.status).toBe(403);

  const conflictClient = { command: async () => { throw new RuntimeHostUnavailableError("conflict", "idempotency-conflict"); } } as unknown as RuntimeHostClient;
  const conflict = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", { enabled: () => true, client: () => conflictClient });
  expect(conflict.status).toBe(409);
});

test("runtime command routes fail closed while activation is disabled", async () => {
  const response = await handleRuntimeCommand(
    request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }),
    "send",
    { enabled: () => false, client: () => null },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "runtime events are disabled" });
});

test("direct runtime send and steer commands kick queued delivery for an idle host", async () => {
  const commands: unknown[] = [];
  let kicks = 0;
  const client = {
    command: async (command: { kind: "send" | "steer"; idempotencyKey: string }) => {
      commands.push(command);
      return {
        operationId: `op-${command.kind}`,
        replayed: false,
        receipt: {
          operationId: `op-${command.kind}`,
          idempotencyKey: command.idempotencyKey,
          conversationId: "conv-one",
          kind: command.kind,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-10T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  for (const kind of ["send", "steer"] as const) {
    const response = await handleRuntimeCommand(
      request({ conversationId: "conv-one", text: `${kind} message`, idempotencyKey: `${kind}-one` }),
      kind,
      { enabled: () => true, client: () => client, kick: () => { kicks += 1; } },
    );
    expect(response.status).toBe(202);
  }

  expect(commands).toMatchObject([{ kind: "send" }, { kind: "steer" }]);
  expect(kicks).toBe(2);
});

test("answer and interrupt commands kick their queued host controls", async () => {
  let kicks = 0;
  const client = {
    command: async (command: { kind: "answer" | "interrupt"; operationId: string; idempotencyKey: string }) => ({
      operationId: command.operationId,
      replayed: false,
      receipt: {
        operationId: command.operationId,
        idempotencyKey: command.idempotencyKey,
        conversationId: "conversation-one",
        kind: command.kind,
        status: "queued" as const,
        at: "2026-07-14T00:00:00.000Z",
        revision: 1,
      },
    }),
  } as unknown as RuntimeHostClient;
  const dependencies = { enabled: () => true, client: () => client, kick: () => { kicks += 1; } };

  const answer = await handleRuntimeCommand(request({
    conversationId: "conversation-one",
    attentionId: "question-one",
    resolution: { answer: "yes" },
    operationId: "answer-operation-one",
  }), "answer", dependencies);
  const interrupt = await handleRuntimeCommand(request({
    conversationId: "conversation-one",
    turnId: "turn-one",
    operationId: "interrupt-operation-one",
  }), "interrupt", dependencies);

  expect(answer.status).toBe(202);
  expect(interrupt.status).toBe(202);
  expect(kicks).toBe(2);
});

test("direct runtime send and steer stay held while their conversation migrates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-http-migration-"));
  const sourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sourcePath = path.join(directory, `${sourceId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-14T13:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.upsert({
    key: { engine: "codex", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: directory,
    accountId: "source",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:runtime-http-source",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => journal.append(event),
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
  } as RuntimeHostClient;
  const idleLedger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: Object.assign(new FakeEngineHost(idleLedger), { onStateChange: () => () => {} }),
  }], { registry, client });
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "runtime-http-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const dependencies = {
    enabled: () => true,
    client: () => client,
    structuredEnabled: () => true,
    registry: () => registry,
    enqueue: enqueueStructuredMessage,
    kick: () => kickStructuredDeliveryQueue(),
  } as RuntimeHttpDependencies;

  const sendResponse = await handleRuntimeCommand(request({
    conversationId: conversation.id,
    text: "queue through migration",
    idempotencyKey: "direct-send-migration",
    policy: "queue",
  }), "send", dependencies);
  await kickStructuredDeliveryQueue();

  const activeLedger = createFakeDeliveryLedger();
  await publishStructuredDeliveryHost({
    key: { engine: "codex", sessionId: sourceId },
    host: Object.assign(new FakeEngineHost(activeLedger, {
      status: "active",
      sessionKey: sourceId,
      endpoint: "fake:runtime-http-source-active",
      pid: 1,
      processStartIdentity: "fake:1",
      eventCursor: 1,
      protocolVersion: "fake-v1",
      activeTurnRef: "turn-source",
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }), { onStateChange: () => () => {} }),
  });
  const steerResponse = await handleRuntimeCommand(request({
    conversationId: conversation.id,
    text: "steer through migration",
    idempotencyKey: "direct-steer-migration",
    turnId: "turn-source",
  }), "steer", dependencies);
  await kickStructuredDeliveryQueue();

  expect(sendResponse.status).toBe(202);
  expect(steerResponse.status).toBe(202);
  expect(await sendResponse.json()).toMatchObject({ held: true });
  expect(await steerResponse.json()).toMatchObject({ held: true });
  expect(idleLedger.writes).toEqual([]);
  expect(activeLedger.writes).toEqual([]);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([
    { clientMessageId: "direct-send-migration", state: "held" },
    { clientMessageId: "direct-steer-migration", state: "held" },
  ]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runtime retry requeues the durable operation and kicks delivery", async () => {
  const retried: string[] = [];
  let kicks = 0;
  const client = {
    retryOperation: async (operationId: string) => {
      retried.push(operationId);
      return {
        operationId,
        replayed: false,
        receipt: {
          operationId,
          idempotencyKey: "send-one",
          conversationId: "conv-one",
          kind: "send" as const,
          status: "queued" as const,
          at: "2026-07-10T00:00:00.000Z",
          revision: 4,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const retryRequest = new NextRequest("http://127.0.0.1/api/runtime/operations/op-one", {
    method: "POST",
    headers: { host: "127.0.0.1" },
  });

  const response = await handleRuntimeRetry(retryRequest, "op-one", {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operationId: "op-one", receipt: { status: "queued" } });
  expect(retried).toEqual(["op-one"]);
  expect(kicks).toBe(1);
});
