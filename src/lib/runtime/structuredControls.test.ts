import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import type { RuntimeHostClient } from "./client";
import { dispatchStructuredControl } from "./structuredControls";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-controls-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function structuredConversation(): { registry: AgentRegistry; path: string; conversationId: string } {
  const id = crypto.randomUUID();
  const pathname = path.join(sandbox, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, `${id}.registry.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: sandbox, accountId: "codex-subscription" });
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

test.each(["compact", "dialog-key", "reconfigure", "resume"])(
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
