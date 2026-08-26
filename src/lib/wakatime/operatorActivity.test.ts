import { expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";

import { recordDirectOperatorWakatimeActivity, type DirectOperatorWakatimeAction } from "./operatorActivity";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const ENABLED = { enabled: () => true } as const;

function registry(): RegistryFile {
  return {
    conversationAliases: {},
    conversations: {
      conversation_direct: {
        id: "conversation_direct",
        engine: "codex",
        generations: [{
          id: "generation_direct",
          path: "/sessions/direct.jsonl",
          accountId: null,
          launchProfile: {
            cwd: "/workspace/repository",
            model: null,
            effort: null,
            fast: null,
            permissionMode: null,
            readOnly: null,
            allowSubagents: true,
            title: null,
            project: "project-fixture",
            parentConversationId: "conversation_parent",
            role: "builder",
            goal: null,
            plan: null,
          },
          historyHash: null,
          host: null,
          createdAt: new Date(NOW).toISOString(),
          archivedAt: null,
        }],
        continuityPaths: [],
        abandonedContinuityPaths: [],
        projectOwnership: {
          project: "project-fixture",
          source: "operator",
          setAt: new Date(NOW).toISOString(),
          operationId: "launch-fixture",
        },
        migration: null,
        migrationOptOut: null,
        supersededBy: null,
        agentRole: "builder",
        delegationDepth: 1,
        turn: { state: "idle", source: "lifecycle", observedAt: new Date(NOW).toISOString() },
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    },
  } as unknown as RegistryFile;
}

test("a direct operator action enters the existing heartbeat queue with no ingress content", () => {
  const enqueued: DirectOperatorWakatimeAction[] = [];
  const action = recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    path: "/sessions/direct.jsonl",
    idempotencyKey: "private-direct-message-id",
  }, {
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: (value) => { enqueued.push(value); },
    ...ENABLED,
  });

  expect(enqueued).toEqual([{
    key: expect.stringMatching(/^[a-f0-9]{64}$/),
    engine: "codex",
    project: "project-fixture",
    atMs: NOW,
  }]);
  expect(action).toEqual(enqueued[0]);
  expect(JSON.stringify(enqueued)).not.toContain("private-direct-message-id");
  expect(JSON.stringify(enqueued)).not.toContain("/sessions/direct.jsonl");
});

test("a stable ingress identity keeps one queue identity across retries", () => {
  const enqueued: Array<{ key: string; atMs: number }> = [];
  const record = (atMs: number) => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    idempotencyKey: "stable-request-id",
  }, {
    now: () => atMs,
    registrySnapshot: registry,
    enqueue: (value) => { enqueued.push(value); },
    ...ENABLED,
  });

  record(NOW);
  record(NOW + 30_000);

  expect(enqueued[0]!.key).toBe(enqueued[1]!.key);
});

test("each legacy id-less request gets one opaque heartbeat identity even in the same millisecond", () => {
  const enqueued: Array<{ key: string }> = [];
  const record = (atMs: number) => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
  }, {
    now: () => atMs,
    registrySnapshot: registry,
    enqueue: (value) => { enqueued.push(value); },
    ...ENABLED,
  });

  record(NOW);
  record(NOW);

  expect(enqueued).toHaveLength(2);
  expect(enqueued[0]!.key).not.toBe(enqueued[1]!.key);
});

test("conflicting canonical path and conversation evidence is rejected", () => {
  expect(() => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    path: "/sessions/unrelated.jsonl",
    idempotencyKey: "conflicting-target",
  }, {
    ...ENABLED,
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: () => undefined,
  })).toThrow("conflicting target evidence");
});

test("disabled direct recording is a zero-state pass-through", () => {
  let registryReads = 0;
  let enqueues = 0;
  const action = recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    idempotencyKey: "disabled-gesture",
  }, {
    enabled: () => false,
    registrySnapshot: () => {
      registryReads += 1;
      throw new Error("disabled recording touched the registry");
    },
    enqueue: () => { enqueues += 1; },
  });

  expect(action).toBeNull();
  expect(registryReads).toBe(0);
  expect(enqueues).toBe(0);
});

test("server-resolved spawn attribution avoids registry lookup", () => {
  const enqueued: unknown[] = [];
  const action = recordDirectOperatorWakatimeActivity({
    idempotencyKey: "spawn-attempt-one",
    resolvedAttribution: { engine: "claude", project: "project-fixture" },
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: () => { throw new Error("resolved attribution should avoid registry access"); },
    enqueue: (value) => { enqueued.push(value); },
  });

  expect(action).toMatchObject({ engine: "claude", project: "project-fixture", atMs: NOW });
  expect(enqueued).toEqual([action!]);
});

test("missing project attribution is rejected before a heartbeat is queued", () => {
  const snapshot = registry();
  const conversation = snapshot.conversations.conversation_direct!;
  conversation.projectOwnership = null;
  conversation.generations[0]!.launchProfile.cwd = "";
  conversation.generations[0]!.launchProfile.project = null;
  let enqueues = 0;

  expect(() => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    idempotencyKey: "unresolved-project-gesture",
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: () => snapshot,
    enqueue: () => { enqueues += 1; },
  })).toThrow("direct operator activity project is unavailable");
  expect(enqueues).toBe(0);
});
