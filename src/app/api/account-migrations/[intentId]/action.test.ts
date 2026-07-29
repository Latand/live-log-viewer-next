import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { AgentRegistry } from "@/lib/agent/registry";

import { updateMigrationAction } from "./action";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("stop settles held input as cancelled without a delivery attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-action-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const conversation = registry.ensureConversation("codex", "/migration-action.jsonl", "source");
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "stop-action",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const held = registry.holdDelivery(conversation.id, "fixture", "stop-action-held");

  const response = await updateMigrationAction(new NextRequest(
    `http://127.0.0.1/api/account-migrations/${intent.id}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "stop", expectedRevision: intent.revision }),
    },
  ), { params: Promise.resolve({ intentId: intent.id }) }, registry);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "stopped" });
  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    attempts: 0,
    generationId: null,
    deliveredAt: null,
    error: expect.stringContaining("migration was stopped"),
  });
});

test("operator retry authorizes an unknown Codex fork before restarting the migration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-action-retry-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const conversation = registry.ensureConversation("codex", "/migration-retry.jsonl", "source");
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "retry-action",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const requested = registry.conversation(conversation.id)!;
  const failed = registry.transitionConversationMigration(
    conversation.id,
    requested.migration!.revision,
    ["requested"],
    {
      phase: "failed-recoverable",
      error: "Codex fork outcome is awaiting recovery",
      errorCode: "codex-fork-outcome-unknown",
    },
  );
  const authorized: Array<{ operationId: string; conversationId: string }> = [];
  let ticks = 0;

  const response = await updateMigrationAction(new NextRequest(
    `http://127.0.0.1/api/account-migrations/${intent.id}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-failed", expectedRevision: intent.revision }),
    },
  ), { params: Promise.resolve({ intentId: intent.id }) }, registry, () => { ticks += 1; }, async (operationId, conversationId) => {
    authorized.push({ operationId, conversationId });
    return "reauthorized";
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ retried: 1 });
  expect(authorized).toEqual([{
    operationId: failed.migration!.operationId,
    conversationId: conversation.id,
  }]);
  expect(registry.conversation(conversation.id)?.migration).toMatchObject({
    phase: "requested",
    operationId: failed.migration!.operationId,
  });
  expect(ticks).toBe(1);
});
