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

function structuredConversation(): { registry: AgentRegistry; path: string; conversationId: string; id: string } {
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
  return { registry, path: pathname, conversationId: begun.receipt.conversationId, id };
}

/** Transition a structured entry to a dead host while retaining its structured
    columns and releasing the writer claim — the shape terminal persistence
    leaves behind after the host process exits (registry.ts terminal path). */
function killStructuredHost(registry: AgentRegistry, id: string): void {
  registry.setStructuredHostClaimed(
    { engine: "codex", sessionId: id },
    {
      kind: "codex-app-server", endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 1, protocolVersion: "fake-v1", writerClaimEpoch: 1,
      activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    "dead",
    "structured-host:test",
    1,
    true,
  );
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

test("a dead structured host lets resume fall through to canonical recovery (issue #247 §5)", async () => {
  const fixture = structuredConversation();
  killStructuredHost(fixture.registry, fixture.id);
  // resume on a dead entry returns null → the route runs the legacy respawn path
  const dead = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });
  expect(dead).toBeNull();
  // every other control on the dead entry stays fenced (only resume recovers)
  const compact = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "compact" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });
  expect(compact).toEqual({ status: 409, body: { error: "structured host does not support the compact control" } });
});

test("a live structured host still rejects resume (no duplicate host)", async () => {
  const fixture = structuredConversation();
  const live = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });
  expect(live).toEqual({ status: 409, body: { error: "structured host does not support the resume control" } });
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
