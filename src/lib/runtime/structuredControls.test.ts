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

test.each(["compact", "dialog-key", "kill", "reconfigure", "resume"])(
  "structured ownership fences the %s control before legacy routing",
  async (action) => {
    const fixture = structuredConversation();
    const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action }, {
      registry: fixture.registry,
      client: null,
    });

    expect(result).toEqual({ status: 409, body: { error: `structured host does not support the ${action} control` } });
  },
);

test("structured ownership resolves from conversation identity", async () => {
  const fixture = structuredConversation();
  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "resume" }, {
    registry: fixture.registry,
    client: null,
  });

  expect(result).toEqual({ status: 409, body: { error: "structured host does not support the resume control" } });
});

test("structured interrupt uses the runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "interrupt-one", receipt: { operationId: "interrupt-one", status: "pending" }, replayed: false };
    },
  } as RuntimeHostClient;
  let kicks = 0;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "interrupt" }, {
    registry: fixture.registry,
    client,
    operationId: () => "interrupt-one",
    kick: () => { kicks += 1; },
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

test("ordinary message routing remains outside the explicit-control module", async () => {
  const fixture = structuredConversation();
  expect(await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "" }, { registry: fixture.registry }))
    .toBeNull();
});
