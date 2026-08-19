import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegistryFile } from "@/lib/agent/registry";

import {
  acknowledgeDirectOperatorWakatimeActions,
  readDirectOperatorWakatimeActions,
  recordDirectOperatorWakatimeActivity,
  settleDirectOperatorWakatimeCompatibility,
} from "./operatorActivity";

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

test("a direct operator action at delegation depth one is durably keyed once without raw ingress identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-operator-"));
  const filename = path.join(directory, "operator-actions.json");
  try {
    const dependencies = { filename, now: () => NOW, registrySnapshot: registry, ...ENABLED };
    const input = {
      conversationId: "conversation_direct",
      path: "/sessions/direct.jsonl",
      idempotencyKey: "private-direct-message-id",
    };

    const first = recordDirectOperatorWakatimeActivity(input, dependencies);
    const replay = recordDirectOperatorWakatimeActivity(input, { ...dependencies, now: () => NOW + 30_000 });
    const actions = readDirectOperatorWakatimeActions(filename, ENABLED.enabled);

    expect(replay).toEqual(first);
    expect(actions).toEqual([{
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      engine: "codex",
      project: "project-fixture",
      atMs: NOW,
    }]);
    const persisted = fs.readFileSync(filename, "utf8");
    expect(persisted).not.toContain("private-direct-message-id");
    expect(persisted).not.toContain("/sessions/direct.jsonl");
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);

    acknowledgeDirectOperatorWakatimeActions([first!.key], filename, ENABLED.enabled);
    expect(readDirectOperatorWakatimeActions(filename, ENABLED.enabled)).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an id-less retry reuses a privacy-safe fingerprint briefly while a later identical gesture stays distinct", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-operator-"));
  const filename = path.join(directory, "operator-actions.json");
  const fingerprint = "f".repeat(64);
  try {
    const input = {
      conversationId: "conversation_direct",
      compatibilityFingerprint: fingerprint,
    };
    const first = recordDirectOperatorWakatimeActivity(input, {
      filename,
      ...ENABLED,
      now: () => NOW,
      registrySnapshot: registry,
    });
    const retry = recordDirectOperatorWakatimeActivity(input, {
      filename,
      ...ENABLED,
      now: () => NOW + 1_000,
      registrySnapshot: registry,
    });
    settleDirectOperatorWakatimeCompatibility(first!.key, filename, ENABLED.enabled);
    const laterGesture = recordDirectOperatorWakatimeActivity(input, {
      filename,
      ...ENABLED,
      now: () => NOW + 1_001,
      registrySnapshot: registry,
    });

    expect(retry!.key).toBe(first!.key);
    expect(laterGesture!.key).not.toBe(first!.key);
    expect(readDirectOperatorWakatimeActions(filename, ENABLED.enabled)).toHaveLength(2);
    const persisted = fs.readFileSync(filename, "utf8");
    expect(persisted).toContain(fingerprint);
    expect(persisted).not.toContain("conversation_direct");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed id-less delivery retains its retry identity until the retry succeeds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-operator-"));
  const filename = path.join(directory, "operator-actions.json");
  const input = { conversationId: "conversation_direct", compatibilityFingerprint: "d".repeat(64) };
  try {
    const first = recordDirectOperatorWakatimeActivity(input, { filename, ...ENABLED, now: () => NOW, registrySnapshot: registry });
    const failedRetry = recordDirectOperatorWakatimeActivity(input, {
      filename,
      ...ENABLED,
      now: () => NOW + 2_000,
      registrySnapshot: registry,
    });
    expect(failedRetry!.key).toBe(first!.key);

    settleDirectOperatorWakatimeCompatibility(failedRetry!.key, filename, ENABLED.enabled);
    const nextGesture = recordDirectOperatorWakatimeActivity(input, {
      filename,
      ...ENABLED,
      now: () => NOW + 2_001,
      registrySnapshot: registry,
    });
    expect(nextGesture!.key).not.toBe(first!.key);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("conflicting canonical path and conversation evidence is rejected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-operator-"));
  try {
    expect(() => recordDirectOperatorWakatimeActivity({
      conversationId: "conversation_direct",
      path: "/sessions/unrelated.jsonl",
      idempotencyKey: "conflicting-target",
    }, {
      filename: path.join(directory, "operator-actions.json"),
      ...ENABLED,
      now: () => NOW,
      registrySnapshot: registry,
    })).toThrow("conflicting target evidence");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disabled direct recording is a zero-state pass-through", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-disabled-"));
  const filename = path.join(directory, "operator-actions.json");
  let registryReads = 0;
  try {
    const action = recordDirectOperatorWakatimeActivity({
      conversationId: "conversation_direct",
      idempotencyKey: "disabled-gesture",
    }, {
      filename,
      enabled: () => false,
      registrySnapshot: () => {
        registryReads += 1;
        throw new Error("disabled recording touched the registry");
      },
    });

    expect(action).toBeNull();
    expect(registryReads).toBe(0);
    expect(fs.existsSync(filename)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enabled direct recording accepts server-resolved spawn attribution", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-resolved-"));
  const filename = path.join(directory, "operator-actions.json");
  try {
    const action = recordDirectOperatorWakatimeActivity({
      idempotencyKey: "spawn-attempt-one",
      resolvedAttribution: { engine: "claude", project: "project-fixture" },
    }, {
      filename,
      enabled: () => true,
      now: () => NOW,
      registrySnapshot: () => { throw new Error("resolved attribution should avoid registry access"); },
    });

    expect(action).toMatchObject({ engine: "claude", project: "project-fixture", atMs: NOW });
    expect(readDirectOperatorWakatimeActions(filename, () => true)).toEqual([action!]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
