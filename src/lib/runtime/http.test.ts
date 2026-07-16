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
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
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
  const deps = { enabled: () => true, structuredEnabled: () => true, client: () => client };

  const accepted = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", deps);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ operationId: "op-one", receipt: { status: "pending" } });
  expect(commands).toHaveLength(1);

  const malformed = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "", idempotencyKey: "send-one" }), "send", deps);
  expect(malformed.status).toBe(400);

  const forbidden = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }, { host: "evil.example", origin: "https://evil.example" }), "send", deps);
  expect(forbidden.status).toBe(403);

  const conflictClient = { command: async () => { throw new RuntimeHostUnavailableError("conflict", "idempotency-conflict"); } } as unknown as RuntimeHostClient;
  const conflict = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", { enabled: () => true, structuredEnabled: () => true, client: () => conflictClient });
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

test("direct structured commands stop before runtime admission when hosting is disabled", async () => {
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      throw new Error("disabled command reached the runtime host");
    },
  } as unknown as RuntimeHostClient;
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => false,
    client: () => client,
  };

  const send = await handleRuntimeCommand(
    request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-disabled" }),
    "send",
    dependencies,
  );
  const interrupt = await handleRuntimeCommand(
    request({ conversationId: "conv-one", operationId: "interrupt-disabled" }),
    "interrupt",
    dependencies,
  );

  expect(send.status).toBe(503);
  expect(interrupt.status).toBe(503);
  expect(await send.json()).toEqual({ error: "structured hosts are disabled" });
  expect(await interrupt.json()).toEqual({ error: "structured hosts are disabled" });
  expect(commands).toEqual([]);
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
      { enabled: () => true, structuredEnabled: () => true, client: () => client, kick: () => { kicks += 1; } },
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
  const dependencies = { enabled: () => true, structuredEnabled: () => true, client: () => client, kick: () => { kicks += 1; } };

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

test("runtime retry with an empty body recovers ownership and starts a fresh durable operation", async () => {
  const retried: Array<[string, string | undefined]> = [];
  const recoveries: unknown[] = [];
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-original",
        conversationId: "conversation_retry_empty",
        kind: "send" as const,
        status: "failed" as const,
        at: "2026-07-10T00:00:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async (operationId: string, nextIdempotencyKey?: string) => {
      retried.push([operationId, nextIdempotencyKey]);
      return {
        operationId: "op-empty-replacement",
        replayed: false,
        receipt: {
          operationId: "op-empty-replacement",
          idempotencyKey: nextIdempotencyKey!,
          conversationId: "conversation_retry_empty",
          kind: "send" as const,
          status: "queued" as const,
          at: "2026-07-10T00:00:00.000Z",
          revision: 4,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const retryRequest = new NextRequest("http://127.0.0.1/api/runtime/operations/op-empty-original", {
    method: "POST",
    headers: { host: "127.0.0.1" },
  });

  const response = await handleRuntimeRetry(retryRequest, "op-empty-original", {
    enabled: () => true,
    client: () => client,
    kick: () => {},
    recover: async (input) => {
      recoveries.push(input);
      return {
        target: null,
        path: "/retry-empty.jsonl",
        conversationId: "conversation_retry_empty",
        spawned: true,
      };
    },
  });

  expect(response.status).toBe(202);
  expect(recoveries).toEqual([{ path: "", conversationId: "conversation_retry_empty" }]);
  expect(retried).toHaveLength(1);
  expect(retried[0]?.[0]).toBe("op-empty-original");
  expect(retried[0]?.[1]).toBeString();
  expect(retried[0]?.[1]).not.toBe("send-original");
});

test("runtime retry waits for confirmed recovery before creating a replacement", async () => {
  const retried: Array<[string, string | undefined]> = [];
  let recoveryCalls = 0;
  let kicks = 0;
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-recovery-gate-original",
        conversationId: "conversation_recovery_gate",
        kind: "send" as const,
        status: "failed" as const,
        reason: "dead-host",
        at: "2026-07-15T00:00:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async (operationId: string, nextIdempotencyKey?: string) => {
      retried.push([operationId, nextIdempotencyKey]);
      return {
        operationId: "op-recovery-gate-replacement",
        replayed: false,
        receipt: {
          operationId: "op-recovery-gate-replacement",
          idempotencyKey: nextIdempotencyKey!,
          conversationId: "conversation_recovery_gate",
          kind: "send" as const,
          status: "queued" as const,
          at: "2026-07-15T00:00:01.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
    recover: async () => {
      recoveryCalls += 1;
      return recoveryCalls === 1 ? null : {
        target: null,
        path: "/recovery-gate.jsonl",
        conversationId: "conversation_recovery_gate" as const,
        spawned: true,
      };
    },
  };
  const retry = () => handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-recovery-gate-original",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-recovery-gate-original", dependencies);

  const unavailable = await retry();
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "structured recovery ownership is unavailable", retryable: true });
  expect(retried).toEqual([]);
  expect(kicks).toBe(0);

  const healthy = await retry();
  expect(healthy.status).toBe(202);
  expect(await healthy.json()).toMatchObject({
    operationId: "op-recovery-gate-replacement",
    receipt: { status: "queued" },
  });
  expect(retried).toHaveLength(1);
  expect(kicks).toBe(1);
});

test("runtime retry returns a retryable response when host ownership is lost during admission", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-http-retry-host-loss-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const projectHost = (host: "hosted" | "dead") => journal.append({
    scope: { type: "session", id: "conversation_retry_host_loss" },
    kind: "session-status",
    payload: {
      conversationId: "conversation_retry_host_loss",
      sessionKey: { engine: "codex", sessionId: `session-${host}` },
      hostKind: "codex-app-server",
      host,
      turn: host === "hosted" ? "idle" : "unknown",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  projectHost("hosted");
  const original = journal.executeOperation({
    kind: "send",
    operationId: "op-http-retry-host-loss-original",
    idempotencyKey: "key-http-retry-host-loss-original",
    conversationId: "conversation_retry_host_loss",
    text: "deliver after ownership is stable",
    policy: "queue",
  });
  journal.transitionOperation(original.operationId, "delivering");
  journal.transitionOperation(original.operationId, "failed", { reason: "dead-host" });
  let retryCalls = 0;
  let kicks = 0;
  const client = {
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) => {
      retryCalls += 1;
      if (retryCalls === 1) projectHost("dead");
      return journal.retryOperation(...args);
    },
  } as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    recover: async () => {
      projectHost("hosted");
      return {
        target: null,
        path: "/retry-host-loss.jsonl",
        conversationId: "conversation_retry_host_loss" as const,
        spawned: retryCalls > 0,
      };
    },
    kick: () => { kicks += 1; },
  };
  const retry = () => handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${original.operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "key-http-retry-host-loss-replacement" }),
    },
  ), original.operationId, dependencies);

  const raced = await retry();
  expect(raced.status).toBe(503);
  expect(await raced.json()).toEqual({
    error: "structured recovery ownership changed before retry admission",
    retryable: true,
  });
  expect(journal.snapshot().recentOperations).toHaveLength(1);
  expect(journal.effectBatch()).toEqual([]);
  expect(kicks).toBe(0);

  const healthy = await retry();
  expect(healthy.status).toBe(202);
  expect(await healthy.json()).toMatchObject({ receipt: { status: "queued" } });
  expect(journal.snapshot().recentOperations).toHaveLength(1);
  expect(journal.operationResult(original.operationId)?.receipt.status).toBe("failed");
  expect(journal.effectBatch()).toHaveLength(1);
  expect(kicks).toBe(1);
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runtime retry accepts an explicit fresh idempotency key", async () => {
  const retried: Array<[string, string | undefined]> = [];
  const recoveries: unknown[] = [];
  let kicks = 0;
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-one",
        conversationId: "conversation_retry",
        kind: "send" as const,
        status: "failed" as const,
        at: "2026-07-10T00:00:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async (operationId: string, nextIdempotencyKey?: string) => {
      retried.push([operationId, nextIdempotencyKey]);
      return {
        operationId: "op-two",
        replayed: false,
        receipt: {
          operationId: "op-two",
          idempotencyKey: nextIdempotencyKey!,
          conversationId: "conversation_retry",
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
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "send-two" }),
  });

  const response = await handleRuntimeRetry(retryRequest, "op-one", {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
    recover: async (input) => {
      recoveries.push(input);
      return {
        target: null,
        path: "/retry.jsonl",
        conversationId: "conversation_retry",
        spawned: true,
      };
    },
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operationId: "op-two", receipt: { idempotencyKey: "send-two", status: "queued" } });
  expect(recoveries).toEqual([{ path: "", conversationId: "conversation_retry" }]);
  expect(retried).toEqual([["op-one", "send-two"]]);
  expect(kicks).toBe(1);

  const conflict = await handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/op-one", {
    method: "POST",
    headers: { host: "127.0.0.1" },
  }), "op-one", {
    enabled: () => true,
    client: () => ({
      operationStatus: async () => ({
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "send-one",
          conversationId: "conversation_retry",
          kind: "send",
          status: "failed",
          at: "2026-07-10T00:00:00.000Z",
          revision: 3,
        },
      }),
      retryOperation: async () => {
        throw new RuntimeHostUnavailableError(
          "idempotency key already belongs to another request",
          "idempotency-conflict",
        );
      },
    }) as unknown as RuntimeHostClient,
    recover: async () => ({
      target: null,
      path: "/retry.jsonl",
      conversationId: "conversation_retry",
      spawned: false,
    }),
    kick: () => { throw new Error("conflicted retry kicked delivery"); },
  });
  expect(conflict.status).toBe(409);
});

test("runtime retry network replay returns the same replacement operation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-http-retry-replay-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation_retry_replay" },
    kind: "session-status",
    payload: {
      conversationId: "conversation_retry_replay",
      sessionKey: { engine: "codex", sessionId: "session-retry-replay" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-retry-replay-original",
    idempotencyKey: "send-retry-replay-original",
    conversationId: "conversation_retry_replay",
    text: "deliver once after a lost HTTP response",
    policy: "queue",
  });
  journal.transitionOperation("op-retry-replay-original", "delivering");
  journal.transitionOperation("op-retry-replay-original", "failed", { reason: "dead-host" });
  const client = {
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId: string, nextIdempotencyKey?: string) =>
      journal.retryOperation(operationId, nextIdempotencyKey),
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    recover: async () => ({
      target: null,
      path: "/retry-replay.jsonl",
      conversationId: "conversation_retry_replay" as const,
      spawned: false,
    }),
    kick: () => {},
  };
  const retry = () => handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-retry-replay-original",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-retry-replay-original", dependencies);

  const first = await retry();
  const replayed = await retry();
  const firstBody = await first.json() as { operationId: string; receipt: { operationId: string; idempotencyKey: string } };
  const replayedBody = await replayed.json() as { operationId: string; receipt: { operationId: string; idempotencyKey: string } };

  expect(first.status).toBe(202);
  expect(replayed.status).toBe(202);
  expect(replayedBody).toEqual(firstBody);
  expect(firstBody.receipt.operationId).toBe("op-retry-replay-original");
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: `effect:${firstBody.operationId}`,
      payload: expect.objectContaining({ idempotencyKey: firstBody.receipt.idempotencyKey }),
    }),
  ]);
  const ledger = createFakeDeliveryLedger();
  await new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
    },
  }, () => new FakeEngineHost(ledger)).drain();
  expect(ledger.writes).toEqual([{
    id: firstBody.operationId,
    text: "deliver once after a lost HTTP response",
    expectedTurnId: null,
  }]);
  expect(journal.effectBatch()).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runtime retry rejects malformed JSON before retrying an operation", async () => {
  let retries = 0;
  const response = await handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/op-one", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: "{",
  }), "op-one", {
    enabled: () => true,
    client: () => ({
      retryOperation: async () => {
        retries += 1;
        throw new Error("malformed retry reached the runtime host");
      },
    }) as unknown as RuntimeHostClient,
    kick: () => {},
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid JSON" });
  expect(retries).toBe(0);
});

test("runtime retry leaves an in-flight operation and its ownership unchanged", async () => {
  let recoveries = 0;
  let retries = 0;
  const response = await handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/op-live", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "fresh-live-key" }),
  }), "op-live", {
    enabled: () => true,
    client: () => ({
      operationStatus: async () => ({
        operationId: "op-live",
        replayed: false,
        receipt: {
          operationId: "op-live",
          idempotencyKey: "live-key",
          conversationId: "conversation-live",
          kind: "send",
          status: "delivering",
          at: "2026-07-15T00:00:00.000Z",
          revision: 2,
        },
      }),
      retryOperation: async () => {
        retries += 1;
        throw new Error("in-flight operation reached retry admission");
      },
    }) as unknown as RuntimeHostClient,
    recover: async () => {
      recoveries += 1;
      throw new Error("in-flight operation reached host recovery");
    },
    kick: () => {},
  });

  expect(response.status).toBe(409);
  expect(recoveries).toBe(0);
  expect(retries).toBe(0);
});
