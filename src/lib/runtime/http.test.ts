import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { RuntimeJournal } from "@/runtime-host/journal";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { handleRuntimeCommand, handleRuntimeDiscard, handleRuntimeRetry, type RuntimeHttpDependencies } from "./http";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { resolveSendReceipt, sendIsSettled, sendReceiptFor } from "./sendSettlement";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";
import { humanReceiptReasonKey } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";

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

test("runtime send records operator activity before delivery failure and excludes self-named agents", async () => {
  const recorded: unknown[] = [];
  const enqueued: unknown[] = [];
  const agentCapability = "b".repeat(43);
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    recordOperatorActivity: (input) => {
      recorded.push(input);
      return { key: "b".repeat(64), engine: "codex", project: "fixture", atMs: Date.now() };
    },
    enqueue: async (input) => {
      enqueued.push(input);
      throw new Error("delivery unavailable");
    },
  };
  setCallerConversationResolverForTests(() => "conversation_agent");
  try {
    const direct = await handleRuntimeCommand(request({
      conversationId: "conversation_direct",
      text: "retain direct activity",
      idempotencyKey: "direct-runtime-one",
    }), "send", dependencies);
    const agent = await handleRuntimeCommand(request({
      conversationId: "conversation_direct",
      text: "bridge traffic",
      idempotencyKey: "bridge-runtime-one",
    }, {
      host: "127.0.0.1",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: agentCapability,
    }), "send", dependencies);

    expect(direct.status).toBe(503);
    expect(agent.status).toBe(503);
    expect(recorded).toEqual([{
      conversationId: "conversation_direct",
      idempotencyKey: "direct-runtime-one",
    }]);
  } finally {
    setCallerConversationResolverForTests(null);
  }
});

test("#1202 an operator's structured message retires that conversation's reply drafts; an agent's does not", async () => {
  /* Retired by the path that accepts the message, so a closed dock, an
     unmounted pane or a second device changes nothing about it. */
  const retired: { conversationId: string; at: number }[] = [];
  const agentCapability = "c".repeat(43);
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    enqueue: async () => null,
    retireReplySuggestions: (conversationId, at) => {
      retired.push({ conversationId, at: at.getTime() });
      return { cleared: true, pending: false };
    },
  };
  setCallerConversationResolverForTests(() => "conversation_agent");
  const before = Date.now();
  try {
    await handleRuntimeCommand(request({
      conversationId: "conversation_asked",
      text: "hold the deploy then",
      idempotencyKey: "operator-answer-one",
    }), "send", dependencies);
    await handleRuntimeCommand(request({
      conversationId: "conversation_asked",
      text: "worker status",
      idempotencyKey: "agent-traffic-one",
    }, { host: "127.0.0.1", [VIEWER_SPAWN_CAPABILITY_HEADER]: agentCapability }), "send", dependencies);
    /* A permission answer is a keypress, not the sentence the drafts offered. */
    await handleRuntimeCommand(request({
      conversationId: "conversation_asked",
      option: "yes",
      idempotencyKey: "operator-dialog-one",
    }), "answer", dependencies);

    expect(retired.map((entry) => entry.conversationId)).toEqual(["conversation_asked"]);
    /* Stamped when the message was accepted, so the compare-and-clear in the
       store can spare a set offered while it was in flight. */
    expect(retired[0]!.at).toBeGreaterThanOrEqual(before);
  } finally {
    setCallerConversationResolverForTests(null);
  }
});

test("#1202 a structured message re-delivered under its own key spares drafts offered since it was admitted", async () => {
  /* The client retries a send it already had accepted — same idempotency key,
     minutes later. The manager has asked something else in between, and that
     question the operator has never seen must survive the retry. */
  const previousStateDir = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-suggestions-"));
  process.env.LLV_STATE_DIR = sandbox;
  const { readReplySuggestions, recordReplySuggestions } = await import("@/lib/suggestions/store");
  /* No stub: the durable store IS the thing under test here. */
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    enqueue: async () => null,
  };
  const conversationId = "conversation_asked_twice";
  const send = (idempotencyKey: string) => handleRuntimeCommand(
    request({ conversationId, text: "hold the deploy then", idempotencyKey }),
    "send",
    dependencies,
  );
  try {
    recordReplySuggestions({
      conversationId,
      replies: [{ label: "hold", text: "Hold. Explain the rollback first." }],
      origin: { kind: "manager", conversationId, role: "orchestrator" },
      at: new Date(Date.now() - 60_000),
    });
    await send("operator-answer-replayed");
    expect(readReplySuggestions(conversationId)).toBeNull();
    /* The route stamps the admission on the wall clock the record compares
       against, so the next offer has to land in a later millisecond. */
    await new Promise((resolve) => setTimeout(resolve, 10));

    const offeredSince = recordReplySuggestions({
      conversationId,
      replies: [{ label: "ship it", text: "Ship it." }],
      origin: { kind: "manager", conversationId, role: "orchestrator" },
    });
    await send("operator-answer-replayed");

    expect(readReplySuggestions(conversationId)?.setId).toBe(offeredSince.set.setId);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("runtime answer records authorized operator activity once and excludes self-named agents", async () => {
  const recorded: unknown[] = [];
  const commands: unknown[] = [];
  const agentCapability = "c".repeat(43);
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => ({
      command: async (command: unknown) => {
        commands.push(command);
        throw new Error("answer delivery unavailable");
      },
    }) as unknown as RuntimeHostClient,
    recordOperatorActivity: (input) => {
      recorded.push(input);
      return { key: "c".repeat(64), engine: "codex", project: "fixture", atMs: Date.now() };
    },
  };
  setCallerConversationResolverForTests(() => "conversation_agent");
  try {
    const body = {
      conversationId: "conversation_direct",
      attentionId: "attention-one",
      resolution: { answers: [[0]] },
      operationId: "answer-gesture-one",
    };
    const direct = await handleRuntimeCommand(request(body), "answer", dependencies);
    const agent = await handleRuntimeCommand(request(body, {
      host: "127.0.0.1",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: agentCapability,
    }), "answer", dependencies);

    expect(direct.status).toBe(503);
    expect(agent.status).toBe(503);
    expect(commands).toHaveLength(2);
    expect(recorded).toEqual([{
      conversationId: "conversation_direct",
      idempotencyKey: "answer-gesture-one",
    }]);
  } finally {
    setCallerConversationResolverForTests(null);
  }
});

test("disabled WakaTime leaves runtime answer delivery unchanged and touches no activity state", async () => {
  let registryReads = 0;
  const commands: unknown[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_direct",
    attentionId: "attention-disabled",
    resolution: { answers: [[0]] },
    operationId: "answer-disabled-gesture",
  }), "answer", {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => ({
      command: async (command: unknown) => {
        commands.push(command);
        return {
          operationId: "answer-disabled-gesture",
          replayed: false,
          receipt: {
            operationId: "answer-disabled-gesture",
            idempotencyKey: "answer-disabled-gesture",
            conversationId: "conversation_direct",
            kind: "answer" as const,
            status: "delivered" as const,
            at: "2026-08-15T10:00:00.000Z",
            revision: 1,
          },
        };
      },
    }) as unknown as RuntimeHostClient,
    recordOperatorActivity: (input) => recordDirectOperatorWakatimeActivity(input, {
      enabled: () => false,
      registrySnapshot: () => {
        registryReads += 1;
        throw new Error("disabled recording touched the registry");
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(commands).toHaveLength(1);
  expect(registryReads).toBe(0);
});

test("runtime image admission returns typed statuses before commands or delivery reservations", async () => {
  const commands: unknown[] = [];
  const enqueues: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      throw new Error("rejected image reached runtime command");
    },
  } as unknown as RuntimeHostClient;
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => client,
    enqueue: async (input) => {
      enqueues.push(input);
      throw new Error("rejected image reached delivery reservation");
    },
  };
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  const cases = [
    { images: [{ base64: "a===", mime: "image/png" }], status: 400 },
    { images: Array.from({ length: 17 }, () => ({ base64: png, mime: "image/png" })), status: 413 },
    { images: [{ base64: png, mime: "image/svg+xml" }], status: 415 },
    { images: [{ base64: Buffer.from("plain").toString("base64"), mime: "image/png" }], status: 415 },
  ];

  for (const candidate of cases) {
    const response = await handleRuntimeCommand(request({
      conversationId: "conv-images",
      text: "inspect",
      idempotencyKey: `image-${candidate.status}-${crypto.randomUUID()}`,
      images: candidate.images,
    }), "send", dependencies);
    expect(response.status).toBe(candidate.status);
  }
  expect(commands).toEqual([]);
  expect(enqueues).toEqual([]);
});

test("runtime image storage failures return 503 without issuing a runtime command", async () => {
  const commands: unknown[] = [];
  const client = { command: async (command: unknown) => { commands.push(command); } } as unknown as RuntimeHostClient;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  const response = await handleRuntimeCommand(request({
    conversationId: "conv-storage",
    text: "inspect",
    idempotencyKey: "image-storage-failure",
    images: [{ base64: png, mime: "image/png" }],
  }), "send", {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => client,
    enqueue: async () => { throw new Error("runtime image storage is unavailable"); },
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "runtime image storage is unavailable" });
  expect(commands).toEqual([]);
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

test("direct runtime send reaches durable admission while the runtime socket synchronizes", async () => {
  const admissions: unknown[] = [];
  const response = await handleRuntimeCommand(
    request({
      conversationId: "conversation_sync_window",
      text: "retain this first message",
      idempotencyKey: "sync-window-send",
    }),
    "send",
    {
      enabled: () => true,
      structuredEnabled: () => true,
      client: () => null,
      enqueue: async (input) => {
        admissions.push(input);
        return {
          ok: true,
          structured: true,
          target: "conversation_sync_window",
          outcome: "held",
          operationId: "op_sync_window_send",
        };
      },
    },
  );

  expect(response.status).toBe(202);
  /* #1131: the hold's own operation id comes back, so the composer's send is
     queryable through `message_receipt` like every other acceptance instead of
     being the one admission nobody could ask about afterwards. */
  expect(await response.json()).toEqual({ held: true, operationId: "op_sync_window_send" });
  expect(admissions).toMatchObject([{
    conversationId: "conversation_sync_window",
    clientMessageId: "sync-window-send",
    kind: "send",
    text: "retain this first message",
  }]);
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
  const sourceId = "cccccccc-cccc-0ccc-0ccc-cccccccccccc";
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
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
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

test("composer retry after delivery-uncertain re-arms one operation and cannot duplicate a late original (#1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-uncertain-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const operationId = "operation-uncertain-retry";
  const text = "continue the already approved operation";
  const reservation = registry.holdDelivery(
    conversation.id,
    text,
    "message-uncertain-retry",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  expect(registry.beginDeliveryAttempt(reservation.id, reservation.generationId!)?.state)
    .toBe("delivery-uncertain");

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "recipient-thread" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: "message-uncertain-retry",
    conversationId: conversation.id,
    text,
    policy: "queue",
  });
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain", { reason: "confirmation timed out" });
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    claimDeliveryAction: async (...args: Parameters<RuntimeHostClient["claimDeliveryAction"]>) =>
      journal.claimDeliveryAction(...args),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) => journal.retryOperation(...args),
  } as RuntimeHostClient;
  let kicks = 0;
  const response = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { kicks += 1; },
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operationId, receipt: { operationId, status: "queued" } });
  expect(registry.readOnlySnapshot().heldDeliveries[reservation.id]).toMatchObject({
    state: "delivery-uncertain",
    attempts: 2,
    command: { operationId },
    clientMessageId: "message-uncertain-retry",
  });
  expect(kicks).toBe(1);

  /* The original reached the recipient before its confirmation was lost. The
     explicit retry reaches the recipient adapter under the same id and is
     therefore a read of the first receipt, with no second user write. */
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger);
  await host.send({ id: operationId, text });
  await new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: () => false,
  }, () => host).drain();
  expect(ledger.writes).toHaveLength(1);
  expect(journal.operationResult(operationId)?.receipt.status).toBe("delivered");

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a concurrent retry winner refuses the discard that read stale uncertain state (#1366 #1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-action-retry-wins-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const operationId = ["operation", "action", "retry-wins"].join("-");
  const messageId = ["message", "action", "retry-wins"].join("-");
  const text = "deliver once after the retry decision";
  const reservation = registry.holdDelivery(
    conversation.id,
    text,
    messageId,
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(reservation.id, reservation.generationId!);

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "delivery-action-retry-wins" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: messageId,
    conversationId: conversation.id,
    text,
    policy: "queue",
  });
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain", { reason: "confirmation timed out" });

  let releaseDiscardRead!: () => void;
  const discardReadMayReturn = new Promise<void>((resolve) => { releaseDiscardRead = resolve; });
  let markDiscardRead!: () => void;
  const discardRead = new Promise<void>((resolve) => { markDiscardRead = resolve; });
  let statusReads = 0;
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => {
      const result = options?.currentRetryLeaf
        ? journal.currentRetryResult(id)
        : journal.operationResult(id);
      statusReads += 1;
      if (statusReads === 1) {
        markDiscardRead();
        await discardReadMayReturn;
      }
      return result;
    },
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) =>
      journal.retryOperation(...args),
    claimDeliveryAction: async (...args: Parameters<RuntimeHostClient["claimDeliveryAction"]>) =>
      journal.claimDeliveryAction(...args),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) =>
      journal.transitionOperation(...args),
  } as RuntimeHostClient;
  const ledger = createFakeDeliveryLedger();
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: () => false,
  }, () => new FakeEngineHost(ledger));
  let drain = Promise.resolve();

  const discard = handleRuntimeDiscard(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    { method: "DELETE", headers: { host: "127.0.0.1" } },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("discard must not wake delivery"); },
  });
  await discardRead;

  const retry = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { drain = queue.drain(); },
  });
  await drain;
  releaseDiscardRead();
  const refusedDiscard = await discard;

  expect(retry.status).toBe(202);
  expect(refusedDiscard.status).toBe(409);
  expect(await refusedDiscard.json()).toMatchObject({ error: expect.stringMatching(/retry.*won/i) });
  expect(ledger.writes).toHaveLength(1);
  expect(journal.operationResult(operationId)?.receipt.status).toBe("delivered");

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a retry reaching actuation while discard is mid-settlement names the durable discard winner (#1366 #1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-action-discard-wins-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const operationId = ["operation", "action", "discard-wins"].join("-");
  const messageId = ["message", "action", "discard-wins"].join("-");
  const text = "discard before this can reach the recipient";
  const reservation = registry.holdDelivery(
    conversation.id,
    text,
    messageId,
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(reservation.id, reservation.generationId!);

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "delivery-action-discard-wins" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: messageId,
    conversationId: conversation.id,
    text,
    policy: "queue",
  });
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain", { reason: "confirmation timed out" });

  let releaseDiscardClaim!: () => void;
  const discardClaimMayReturn = new Promise<void>((resolve) => { releaseDiscardClaim = resolve; });
  let markDiscardClaimed!: () => void;
  const discardClaimed = new Promise<void>((resolve) => { markDiscardClaimed = resolve; });
  const actionClaims: string[] = [];
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    claimDeliveryAction: async (...args: Parameters<RuntimeHostClient["claimDeliveryAction"]>) => {
      actionClaims.push(args[1]);
      const claim = journal.claimDeliveryAction(...args);
      if (args[1] === "discard") {
        markDiscardClaimed();
        await discardClaimMayReturn;
      }
      return claim;
    },
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) =>
      journal.retryOperation(...args),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) =>
      journal.transitionOperation(...args),
  } as RuntimeHostClient;

  const discard = handleRuntimeDiscard(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    { method: "DELETE", headers: { host: "127.0.0.1" } },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("discard must not wake delivery"); },
  });
  await discardClaimed;

  const refusedRetry = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("losing retry must not wake delivery"); },
  });
  releaseDiscardClaim();
  const completedDiscard = await discard;

  const ledger = createFakeDeliveryLedger();
  await new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: (id) => sendIsSettled(registry.readOnlySnapshot(), id),
  }, () => new FakeEngineHost(ledger)).drain();

  expect(actionClaims).toEqual(["discard", "retry"]);
  expect(completedDiscard.status).toBe(200);
  expect(refusedRetry.status).toBe(409);
  expect(await refusedRetry.json()).toMatchObject({ error: expect.stringMatching(/discard.*won/i) });
  expect(registry.readOnlySnapshot().heldDeliveries[reservation.id]).toMatchObject({
    state: "failed",
    error: "delivery-discarded",
  });
  expect(ledger.writes).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a terminalized unverified receipt still retries under its original identity (#1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-unverified-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const operationId = "operation-terminal-unverified";
  const held = registry.holdDelivery(
    conversation.id,
    "retry this unknown outcome safely",
    "message-terminal-unverified",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  registry.recordDeliveryOutcome(held.id, "failed", "delivery outcome is unverified", "unverified");
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "unverified-thread" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: "message-terminal-unverified",
    conversationId: conversation.id,
    text: "retry this unknown outcome safely",
    policy: "queue",
  });
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "failed", { reason: "delivery outcome is unverified" });
  let retryCalls = 0;
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    claimDeliveryAction: async (...args: Parameters<RuntimeHostClient["claimDeliveryAction"]>) =>
      journal.claimDeliveryAction(...args),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) => {
      retryCalls += 1;
      if (retryCalls === 1) throw new Error("runtime host response was lost");
      return journal.retryOperation(...args);
    },
  } as RuntimeHostClient;
  const retry = () => handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => {},
  });

  const unavailable = await retry();
  expect(unavailable.status).toBe(503);
  expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({
    state: "delivery-uncertain",
    attempts: 2,
    command: { operationId },
  });
  const response = await retry();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operationId, receipt: { operationId, status: "queued" } });
  expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({
    state: "delivery-uncertain",
    attempts: 3,
    command: { operationId },
  });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({ id: `effect:${operationId}`, payload: expect.objectContaining({ operationId }) }),
  ]);
  expect(retryCalls).toBe(2);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("discard terminalizes the visible receipt and fences every later delivery (#1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-uncertain-discard-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  const operationId = "operation-uncertain-discard";
  const held = registry.holdDelivery(
    conversation.id,
    "discard this pending instruction",
    "message-uncertain-discard",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "discard-thread" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: "message-uncertain-discard",
    conversationId: conversation.id,
    text: "discard this pending instruction",
    policy: "queue",
  });
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    claimDeliveryAction: async (...args: Parameters<RuntimeHostClient["claimDeliveryAction"]>) =>
      journal.claimDeliveryAction(...args),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) =>
      journal.retryOperation(...args),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) =>
      journal.transitionOperation(...args),
  } as RuntimeHostClient;
  const recordOutcome = registry.discardDeliveryForOperation.bind(registry);
  let outcomeWrites = 0;
  registry.discardDeliveryForOperation = (...args) => {
    outcomeWrites += 1;
    return outcomeWrites === 1 ? null : recordOutcome(...args);
  };
  const discard = () => handleRuntimeDiscard(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    { method: "DELETE", headers: { host: "127.0.0.1" } },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("discard must not wake delivery"); },
  });

  const interrupted = await discard();
  expect(interrupted.status).toBe(503);
  expect(journal.operationResult(operationId)?.receipt).toMatchObject({
    status: "failed",
    reason: "delivery-discarded",
  });
  let retryKicks = 0;
  const refusedDuringPartialSettlement = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { retryKicks += 1; },
  });
  expect(refusedDuringPartialSettlement.status).toBe(409);
  expect(journal.operationResult(operationId)?.receipt).toMatchObject({
    status: "failed",
    reason: "delivery-discarded",
  });
  expect(journal.effectBatch()).toEqual([]);
  expect(retryKicks).toBe(0);
  expect(await resolveSendReceipt(operationId, { registry, client })).toMatchObject({
    state: "failed",
    reason: "delivery-discarded",
  });

  const response = await discard();
  expect(response.status).toBe(200);
  const body = await response.json() as { receipt: { status: string; reason?: string | null; text?: string | null } };
  expect(body.receipt).toMatchObject({
    status: "failed",
    reason: "delivery-discarded",
    text: "discard this pending instruction",
  });
  const reasonKey = humanReceiptReasonKey(body.receipt.reason);
  expect(reasonKey && translate("en", reasonKey)).toBe("Discarded");
  expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    error: "delivery-discarded",
  });
  expect(registry.recordDeliveryOutcome(held.id, "delivered")).toMatchObject({
    state: "failed",
    error: "delivery-discarded",
  });
  expect(sendIsSettled(registry.readOnlySnapshot(), operationId)).toBeTrue();
  expect(journal.effectBatch()).toEqual([]);
  expect(outcomeWrites).toBe(2);

  const refusedRetry = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("discarded retry must not wake delivery"); },
  });
  expect(refusedRetry.status).toBe(409);

  /* Discard is absorbing in the journal too, including callers below HTTP. */
  expect(() => journal.retryOperation(operationId)).toThrow("discarded runtime operations cannot retry");
  const ledger = createFakeDeliveryLedger();
  await new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: (id) => sendIsSettled(registry.readOnlySnapshot(), id),
  }, () => new FakeEngineHost(ledger)).drain();
  expect(ledger.writes).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("discard settles an unactuated held reservation after fencing its journal operation (#1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-held-discard-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), "default");
  registry.requestConversationReseat(conversation.id, "successor-account");
  const operationId = "operation-held-discard";
  const held = registry.holdDelivery(
    conversation.id,
    "discard before migration completes",
    "message-held-discard",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  expect(held).toMatchObject({ state: "held", attempts: 0, command: { operationId } });

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "held-discard-thread" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: "message-held-discard",
    conversationId: conversation.id,
    text: "discard before migration completes",
    policy: "queue",
  });
  const client = {
    operationStatus: async (id: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(id)
      : journal.operationResult(id),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) =>
      journal.transitionOperation(...args),
  } as RuntimeHostClient;

  const response = await handleRuntimeDiscard(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${operationId}`,
    { method: "DELETE", headers: { host: "127.0.0.1" } },
  ), operationId, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: () => { throw new Error("discard must not wake delivery"); },
  });

  expect(response.status).toBe(200);
  expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    error: "delivery-discarded",
  });
  expect(journal.operationResult(operationId)?.receipt).toMatchObject({
    status: "failed",
    reason: "delivery-discarded",
  });
  expect(journal.effectBatch()).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runtime retry republishes an existing successor before retry admission", async () => {
  let hosted = false;
  let republishCalls = 0;
  let retryCalls = 0;
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-existing-successor-original",
        conversationId: "conversation_existing_successor",
        kind: "send" as const,
        status: "failed" as const,
        reason: "dead-host",
        at: "2026-07-20T11:49:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async (operationId: string, nextIdempotencyKey?: string) => {
      retryCalls += 1;
      if (!hosted) throw new Error("structured recovery ownership changed before retry admission");
      return {
        operationId: "op-existing-successor-replacement",
        replayed: false,
        receipt: {
          operationId: "op-existing-successor-replacement",
          retryOfOperationId: operationId,
          idempotencyKey: nextIdempotencyKey!,
          conversationId: "conversation_existing_successor",
          kind: "send" as const,
          status: "queued" as const,
          at: "2026-07-20T11:49:01.000Z",
          revision: 4,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const response = await handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-existing-successor-original",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-existing-successor-original", {
    enabled: () => true,
    client: () => client,
    kick: () => {},
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
    recover: async () => ({
      target: null,
      path: "/existing-successor.jsonl",
      conversationId: "conversation_existing_successor",
      spawned: false,
    }),
    republish: async (conversationId) => {
      expect(conversationId).toBe("conversation_existing_successor");
      republishCalls += 1;
      hosted = true;
      return true;
    },
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ receipt: { status: "queued" } });
  expect(republishCalls).toBe(1);
  expect(retryCalls).toBe(1);
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
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
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

test("runtime retry converges once when successor ownership changes during admission", async () => {
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
  let recoveryCalls = 0;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    recover: async () => {
      recoveryCalls += 1;
      projectHost("hosted");
      return {
        target: null,
        path: "/retry-host-loss.jsonl",
        conversationId: "conversation_retry_host_loss" as const,
        spawned: retryCalls > 0,
      };
    },
    kick: () => { kicks += 1; },
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
  };
  const retry = () => handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${original.operationId}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "key-http-retry-host-loss-replacement" }),
    },
  ), original.operationId, dependencies);

  const converged = await retry();
  expect(converged.status).toBe(202);
  expect(await converged.json()).toMatchObject({ receipt: { status: "queued" } });
  expect(recoveryCalls).toBe(2);
  expect(retryCalls).toBe(2);
  expect(journal.snapshot().recentOperations).toHaveLength(1);
  expect(journal.operationResult(original.operationId)?.receipt.status).toBe("failed");
  expect(journal.currentRetryResult(original.operationId)?.receipt).toMatchObject({
    retryOfOperationId: original.operationId,
    status: "queued",
    text: "deliver after ownership is stable",
  });
  expect(journal.effectBatch()).toHaveLength(1);
  expect(kicks).toBe(1);
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runtime retry stays loud after its bounded successor convergence attempt", async () => {
  let recoveryCalls = 0;
  let retryCalls = 0;
  let kicks = 0;
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-bounded-retry-original",
        conversationId: "conversation_bounded_retry",
        kind: "send" as const,
        status: "failed" as const,
        reason: "dead-host",
        at: "2026-07-20T11:49:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async () => {
      retryCalls += 1;
      throw new Error("structured recovery ownership changed before retry admission");
    },
  } as unknown as RuntimeHostClient;

  const response = await handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-bounded-retry-original",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-bounded-retry-original", {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
    recover: async () => {
      recoveryCalls += 1;
      return {
        target: null,
        path: "/bounded-retry.jsonl",
        conversationId: "conversation_bounded_retry",
        spawned: recoveryCalls === 1,
      };
    },
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "structured recovery ownership changed before retry admission",
    retryable: true,
  });
  expect(recoveryCalls).toBe(2);
  expect(retryCalls).toBe(2);
  expect(kicks).toBe(0);
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
    /* This attempt's durable row lands (#1131); these fixtures are about
       ownership, idempotency and convergence rather than persistence. */
    recordRetryAttempt: () => true,
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

test("runtime retry network replay returns the same replacement operation, and both responses have a durable row behind them", async () => {
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
  const retryRows = new Map<string, string>();
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
    /* The durable rows this endpoint may hand an id out against (#1131). The
       fresh admission writes one; the replay used to write none at all and
       return the leaf anyway, so a lost HTTP response left a caller holding an
       id that no query could answer and no deadline could end. */
    recordRetryAttempt: (previousOperationId: string, retryOperationId: string) => {
      retryRows.set(retryOperationId, previousOperationId);
      return true;
    },
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
  /* The id both responses handed back names a row, and the replay recorded it
     against the same presentation operation the fresh admission did. */
  expect(retryRows.get(firstBody.operationId)).toBe("op-retry-replay-original");
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
  expect(ledger.writes).toMatchObject([{
    id: firstBody.operationId,
    text: "deliver once after a lost HTTP response",
    expectedTurnId: null,
  }]);
  expect(journal.effectBatch()).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a retry attempt whose durable row does not land hands back no id", async () => {
  /* The persistence result used to be dropped on the floor, so an attempt whose
     row never landed was still answered with its id — an id no query could
     answer from during an outage, no deadline could end, and the delivery
     queue's own fence had nothing to read. A row that was refused and a row
     whose write could not be read are one answer here: the id stays in this
     process. The refusal is retryable and the attempt is admitted under its own
     idempotency key, so the next call converges on the same leaf and hands the
     id back once the row exists. */
  const client = {
    operationStatus: async (operationId: string) => ({
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: "send-orphan-original",
        conversationId: "conversation_retry_orphan",
        kind: "send" as const,
        status: "failed" as const,
        at: "2026-07-10T00:00:00.000Z",
        revision: 3,
      },
    }),
    retryOperation: async () => ({
      operationId: "op-orphan-replacement",
      replayed: false,
      receipt: {
        operationId: "op-orphan-replacement",
        idempotencyKey: "key-orphan-replacement",
        conversationId: "conversation_retry_orphan",
        kind: "send" as const,
        status: "queued" as const,
        at: "2026-07-10T00:00:01.000Z",
        revision: 4,
      },
    }),
  } as unknown as RuntimeHostClient;
  let kicks = 0;
  const attempt = (recordRetryAttempt: () => boolean) => handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-orphan-original",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-orphan-original", {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
    recordRetryAttempt,
    recover: async () => ({
      target: null,
      path: "/retry-orphan.jsonl",
      conversationId: "conversation_retry_orphan" as const,
      spawned: false,
    }),
  });

  const refused = await attempt(() => false);
  const refusedBody = await refused.json() as Record<string, unknown>;
  expect(refused.status).toBe(503);
  expect(Object.keys(refusedBody).sort()).toEqual(["error", "retryable"]);
  expect(refusedBody.retryable).toBeTrue();

  const unreadable = await attempt(() => { throw new Error("registry is unavailable"); });
  const unreadableBody = await unreadable.json() as Record<string, unknown>;
  expect(unreadable.status).toBe(503);
  expect(Object.keys(unreadableBody).sort()).toEqual(["error", "retryable"]);
  /* The read that failed says why, so an operator is not left guessing which
     store was unavailable. */
  expect(unreadableBody.error).toBe("registry is unavailable");

  /* And neither refusal woke the queue: nothing is being waited on. */
  expect(kicks).toBe(0);
});

test("a retry whose status read fails is retryable rather than not found", async () => {
  /* The read that says which attempt this call is about is failable too, and
     the catch below classifies by message — so an outage whose message carries
     the journal's own word for a missing operation could tell a caller its send
     never existed. Only a read that COMPLETED and found nothing answers 404. */
  const client = {
    operationStatus: async () => { throw new Error("runtime host is unknown to this process"); },
    retryOperation: async () => { throw new Error("unreachable"); },
  } as unknown as RuntimeHostClient;
  let kicks = 0;
  const response = await handleRuntimeRetry(new NextRequest(
    "http://127.0.0.1/api/runtime/operations/op-status-unreadable",
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), "op-status-unreadable", {
    enabled: () => true,
    client: () => client,
    kick: () => { kicks += 1; },
  });
  const body = await response.json() as Record<string, unknown>;

  expect(response.status).toBe(503);
  expect(body.retryable).toBeTrue();
  expect(kicks).toBe(0);
});

test("the id a retry hands back outlives the runtime and is fenced after its deadline", async () => {
  /* What the durable row is FOR, end to end. The caller holds the retry id; the
     runtime then goes away entirely. The id still answers, the deadline still
     ends it, and the record that ended it is the same one the delivery queue
     reads before it actuates anything — so the attempt cannot arrive after its
     caller was told it had not. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-http-retry-durable-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation("codex", "", "default");
  const held = registry.holdDelivery(conversation.id, "hold the cutover until I say go", "send-durable-retry");
  const originalOperationId = held.command.operationId;
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: "session-durable-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: originalOperationId,
    idempotencyKey: "send-durable-retry",
    conversationId: conversation.id,
    text: "hold the cutover until I say go",
    policy: "queue",
  });
  journal.transitionOperation(originalOperationId, "delivering");
  journal.transitionOperation(originalOperationId, "failed", { reason: "dead-host" });
  const client = {
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) => journal.retryOperation(...args),
  } as RuntimeHostClient;

  const response = await handleRuntimeRetry(new NextRequest(
    `http://127.0.0.1/api/runtime/operations/${originalOperationId}`,
    { method: "POST", headers: { host: "127.0.0.1" } },
  ), originalOperationId, {
    enabled: () => true,
    client: () => client,
    kick: () => {},
    /* The production write, against this sandbox's registry. */
    recordRetryAttempt: (previousOperationId, retryOperationId) =>
      registry.recordDeliveryRetryAttempt(previousOperationId, retryOperationId),
    recover: async () => ({
      target: null,
      path: "/retry-durable.jsonl",
      conversationId: conversation.id,
      spawned: false,
    }),
  });

  expect(response.status).toBe(202);
  const leafOperationId = (await response.json() as { operationId: string }).operationId;
  expect(leafOperationId).not.toBe(originalOperationId);

  /* The runtime is gone now. The id the caller holds still answers, from the
     record alone, and it answers about the ATTEMPT rather than the send it
     replaced. */
  expect(sendReceiptFor(registry.readOnlySnapshot(), leafOperationId)).toMatchObject({
    operationId: leafOperationId,
    state: "in-flight",
  });
  const settled = await resolveSendReceipt(leafOperationId, { registry, client: null, windowMs: 0 });
  expect(settled).toMatchObject({
    operationId: leafOperationId,
    state: "failed",
    duplicateRisk: true,
    resend: "verify-first",
    evidence: "delivery-record",
  });

  /* And the record that ended it is the fence the queue reads: the effect the
     retry admitted is still in the outbox, and it is not delivered. */
  expect(sendIsSettled(registry.readOnlySnapshot(), leafOperationId)).toBeTrue();
  expect(journal.effectBatch()).toHaveLength(1);
  const ledger = createFakeDeliveryLedger();
  await new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
    },
    status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
    settled: (operationId) => sendIsSettled(registry.readOnlySnapshot(), operationId),
  }, () => new FakeEngineHost(ledger)).drain();

  expect(ledger.writes).toEqual([]);
  expect(journal.operationResult(leafOperationId)?.receipt.status).toBe("uncertain");
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

test("a send no structured delivery owns is refused rather than admitted without a reservation", async () => {
  /* #1131: this was the last road by which `queued` could be a final answer.
     The structured path declines the conversation, and the direct command below
     used to admit the send straight into the runtime journal — an accepted
     operation with no durable reservation behind it, so nothing could settle it
     and a lasting outage left it neither executed nor queryable. A control on
     the same road reserves nothing and still goes through. */
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "op_unowned", receipt: { operationId: "op_unowned", status: "queued" } };
    },
  } as unknown as RuntimeHostClient;
  const dependencies: RuntimeHttpDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => client,
    enqueue: async () => null,
  };

  const send = await handleRuntimeCommand(
    request({ conversationId: "conversation_unowned", text: "continue", idempotencyKey: "unowned-send" }),
    "send",
    dependencies,
  );
  expect(send.status).toBe(503);
  expect(await send.json()).toMatchObject({ error: "structured delivery ownership is unavailable for this conversation" });
  expect(commands).toEqual([]);

  const interrupt = await handleRuntimeCommand(
    request({ conversationId: "conversation_unowned", operationId: "op_unowned_interrupt" }),
    "interrupt",
    dependencies,
  );
  expect(interrupt.status).toBe(202);
  expect(commands).toHaveLength(1);
});
