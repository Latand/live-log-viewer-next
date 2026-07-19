import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { dispatchStructuredControl } from "./structuredControls";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-controls-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function structuredConversation(
  options: { parentConversationId?: `conversation_${string}`; registry?: AgentRegistry } = {},
): { registry: AgentRegistry; path: string; conversationId: string } {
  const id = crypto.randomUUID();
  const pathname = path.join(sandbox, `${id}.jsonl`);
  const registry = options.registry
    ?? new AgentRegistry(path.join(sandbox, `${id}.registry.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: sandbox,
    accountId: "codex-subscription",
    ...(options.parentConversationId ? { parentConversationId: options.parentConversationId } : {}),
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: id },
    artifactPath: pathname,
    cwd: sandbox,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: "turn-live",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  return { registry, path: pathname, conversationId: begun.receipt.conversationId };
}

test.each(["compact", "dialog-key", "resume"])(
  "structured ownership fences the %s control before legacy routing",
  async (action) => {
    const fixture = structuredConversation();
    const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action }, {
      registry: fixture.registry,
      client: null,
      enabled: () => true,
    });

    expect(result).toEqual({ status: 409, body: { error: `structured host does not support the ${action} control` } });
  },
);

test("structured reconfigure validates and enters the runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "reconfigure-one", receipt: { operationId: "reconfigure-one", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-sol", effort: "high", fast: true, accountId: "codex-work" },
  }, {
    registry: fixture.registry,
    client,
    operationId: () => "reconfigure-one",
    accountExists: () => true,
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { operationId: "reconfigure-one", receipt: { status: "queued" } } });
  expect(commands).toEqual([{
    kind: "reconfigure",
    operationId: "reconfigure-one",
    idempotencyKey: "reconfigure-one",
    conversationId: fixture.conversationId,
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
    accountId: "codex-work",
    previousProfile: { model: null, effort: null, fast: null },
  }]);

  const invalid = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "claude-opus-4-6", effort: "unknown", fast: true },
  }, { registry: fixture.registry, client, enabled: () => true });
  expect(invalid).toEqual({ status: 400, body: { error: "model is not supported by codex" } });
  expect(commands).toHaveLength(1);
});

test("structured ownership resolves from conversation identity", async () => {
  const fixture = structuredConversation();
  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({ status: 409, body: { error: "structured host does not support the resume control" } });
});

test("dead structured resume falls through to canonical recovery", async () => {
  const fixture = structuredConversation();
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const entry = fixture.registry.snapshot().entries[`${key.engine}:${key.sessionId}`]!;
  fixture.registry.setStructuredHostClaimed(key, {
    ...entry.structuredHost!,
    endpoint: "stdio:released",
    process: null,
    activeTurnRef: null,
  }, "dead", entry.claimOwner!, entry.claimEpoch, true);

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toBeNull();

  // every other control on the dead entry stays fenced (only resume recovers)
  const compact = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "compact" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });
  expect(compact).toEqual({ status: 409, body: { error: "structured host does not support the compact control" } });
});

test("structured interrupt uses the runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "interrupt-one", receipt: { operationId: "interrupt-one", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;
  let kicks = 0;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "interrupt" }, {
    registry: fixture.registry,
    client,
    operationId: () => "interrupt-one",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "interrupt",
    operationId: "interrupt-one",
    idempotencyKey: "interrupt-one",
    conversationId: fixture.conversationId,
    turnId: "turn-live",
  }]);
  expect(kicks).toBe(1);
});

test("structured kill enters the durable runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "kill-one", receipt: { operationId: "kill-one", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;
  let kicks = 0;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-one",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "kill",
    operationId: "kill-one",
    idempotencyKey: "kill-one",
    conversationId: fixture.conversationId,
    sessionKey: { engine: "codex", sessionId: expect.any(String) },
  }]);
  expect(kicks).toBe(1);
});

function terminateStructuredFixture(fixture: { registry: AgentRegistry; conversationId: string }): void {
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  fixture.registry.terminateStructuredHost({ engine: conversation.engine, sessionId: generation.id });
}

test("structured kill addressed by conversationId enters the durable command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "kill-by-id", receipt: { operationId: "kill-by-id", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-by-id",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "kill",
    operationId: "kill-by-id",
    idempotencyKey: "kill-by-id",
    conversationId: fixture.conversationId,
    sessionKey: { engine: "codex", sessionId: expect.any(String) },
  }]);
});

test("a delivered kill receipt resolves as a terminal success, not a failure", async () => {
  const fixture = structuredConversation();
  const client = {
    command: async () => ({
      operationId: "kill-delivered",
      receipt: { operationId: "kill-delivered", status: "delivered" },
      replayed: true,
    }),
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-delivered",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, receipt: { status: "delivered" } },
  });
});

test("a kill transport timeout after journal admission reports the durable receipt", async () => {
  const fixture = structuredConversation();
  const probes: string[] = [];
  let kicks = 0;
  const client = {
    command: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    operationStatus: async (operationId: string) => {
      probes.push(operationId);
      return {
        operationId,
        receipt: { operationId, status: "delivered", conversationId: fixture.conversationId },
        replayed: true,
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-timeout",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(probes).toEqual(["kill-timeout"]);
  expect(kicks).toBe(1);
  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, operationId: "kill-timeout", receipt: { status: "delivered" } },
  });
});

test("a kill transport timeout with no durable record stays a retryable failure", async () => {
  const fixture = structuredConversation();
  const client = {
    command: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-lost",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toEqual({ status: 503, body: { error: "runtime host request timed out" } });
});

test("a dead structured session replays its terminal kill outcome for path callers", async () => {
  const fixture = structuredConversation();
  terminateStructuredFixture(fixture);

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, outcome: "delivered" },
  });
});

test("a dead structured session replays its terminal kill outcome for conversation-id callers", async () => {
  const fixture = structuredConversation();
  terminateStructuredFixture(fixture);

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, outcome: "delivered" },
  });
});

test("a dead structured branch replays terminal kill without branch/root pane failures", async () => {
  const root = structuredConversation();
  const branch = structuredConversation({
    registry: root.registry,
    parentConversationId: root.conversationId as `conversation_${string}`,
  });
  terminateStructuredFixture(branch);
  terminateStructuredFixture(root);

  const branchResult = await dispatchStructuredControl({ path: branch.path, conversationId: "", action: "kill" }, {
    registry: root.registry,
    client: null,
    enabled: () => true,
  });
  const rootResult = await dispatchStructuredControl({ path: "", conversationId: root.conversationId, action: "kill" }, {
    registry: root.registry,
    client: null,
    enabled: () => true,
  });

  expect(branchResult).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: branch.conversationId, outcome: "delivered" },
  });
  expect(rootResult).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: root.conversationId, outcome: "delivered" },
  });
});

test("disabled structured hosting leaves persisted ownership on the legacy control path", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      throw new Error("disabled structured control reached the runtime host");
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "interrupt" }, {
    registry: fixture.registry,
    client,
    enabled: () => false,
  });

  expect(result).toBeNull();
  expect(commands).toEqual([]);
});

test("ordinary message routing remains outside the explicit-control module", async () => {
  const fixture = structuredConversation();
  expect(await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "" }, { registry: fixture.registry, enabled: () => true }))
    .toBeNull();
});
