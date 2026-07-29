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
