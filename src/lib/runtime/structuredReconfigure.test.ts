import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { applyStructuredReconfigure } from "./structuredReconfigure";
import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-reconfigure-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const transcript = path.join(root, "rollout.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: root,
    accountId: "source",
    transport: "structured",
    launchProfile: { model: "gpt-5.5", effort: "medium", fast: false },
  });
  if (begun.kind !== "created") throw new Error("fixture spawn was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "thread-source" },
    artifactPath: transcript,
    cwd: root,
    accountId: "source",
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "test:host",
      process: { pid: process.pid, startIdentity: "test" },
      eventCursor: 1,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: null,
    launchProfile: begun.receipt.launchProfile,
  });
  if (settled.kind !== "settled") throw new Error("fixture settlement failed");
  return { registry, conversationId: begun.receipt.conversationId, transcript };
}

function effect(overrides: Partial<StructuredReconfigureEffect> = {}): StructuredReconfigureEffect {
  return {
    kind: "reconfigure",
    operationId: "switch-one",
    conversationId: "conversation_fixture",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
    eventSeq: 1,
    ...overrides,
  };
}

test("idle model reconfigure restarts the same generation with the updated launch profile", async () => {
  const target = fixture();
  const generationId = target.registry.conversation(target.conversationId)!.generations.at(-1)!.id;
  const released: string[] = [];
  const recoveredProfiles: unknown[] = [];

  const outcome = await applyStructuredReconfigure(effect({ conversationId: target.conversationId }), {
    registry: target.registry,
    releaseHost: async (key) => { released.push(`${key.engine}:${key.sessionId}`); return true; },
    recover: async (request) => {
      recoveredProfiles.push(target.registry.conversation(request.conversationId as ViewerConversationId)?.generations.at(-1)?.launchProfile);
      return { target: null, path: target.transcript, conversationId: target.conversationId, spawned: true };
    },
  });

  expect(outcome).toBe("applied");
  expect(released).toEqual([`codex:${generationId}`]);
  expect(recoveredProfiles).toEqual([expect.objectContaining({ model: "gpt-5.6-sol", effort: "high", fast: true })]);
  expect(target.registry.conversation(target.conversationId)!.generations).toHaveLength(1);
});

test("unauthenticated account reconfigure leaves profile and host ownership untouched", async () => {
  const target = fixture();
  const before = target.registry.conversation(target.conversationId)!;
  const generationId = before.generations.at(-1)!.id;
  let releases = 0;

  await expect(applyStructuredReconfigure(effect({
    conversationId: target.conversationId,
    accountId: "signed-out",
  }), {
    registry: target.registry,
    validateAccount: async () => { throw new Error("target codex account is not authenticated"); },
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
    releaseHost: async () => { releases += 1; return true; },
  })).rejects.toThrow("target codex account is not authenticated");

  const after = target.registry.conversation(target.conversationId)!;
  expect(after.generations.at(-1)?.launchProfile).toEqual(before.generations.at(-1)?.launchProfile);
  expect(after.generations.at(-1)?.accountId).toBe("source");
  expect(target.registry.snapshot().entries[`codex:${generationId}`]?.structuredHost?.process).not.toBeNull();
  expect(releases).toBe(0);
});

test("account reconfigure stays pending until the durable successor commits", async () => {
  const target = fixture();
  let releases = 0;
  const outcome = await applyStructuredReconfigure(effect({
    conversationId: target.conversationId,
    accountId: "target",
  }), {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
    releaseHost: async () => { releases += 1; return true; },
  });

  expect(outcome).toBe("pending");
  expect(releases).toBe(0);
  expect(target.registry.conversation(target.conversationId)!.generations).toHaveLength(1);
});

test("account reconfigure restores the admitted profile after a pending attempt later fails", async () => {
  const target = fixture();
  const request = effect({
    conversationId: target.conversationId,
    accountId: "target",
    previousProfile: { model: "gpt-5.5", effort: "medium", fast: false },
  } as never);
  const pending = await applyStructuredReconfigure(request, {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
  });
  expect(pending).toBe("pending");
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
  });

  await expect(applyStructuredReconfigure(request, {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => ({
      ...target.registry.conversation(target.conversationId)!,
      migration: { phase: "failed-recoverable", error: "successor authentication expired" },
    }) as never,
  })).rejects.toThrow("successor authentication expired");
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.5",
    effort: "medium",
    fast: false,
  });
});
