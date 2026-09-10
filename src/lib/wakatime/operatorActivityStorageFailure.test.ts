import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegistryFile } from "@/lib/agent/registry";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import { recordDirectOperatorWakatimeActivity } from "./operatorActivity";
import { enqueueProductionOperatorHeartbeat } from "./sync";

const NOW = Date.parse("2026-09-10T09:00:00.000Z");

let stateDirectory: string;
let corruptStateFile: string;
let corruptBytes: ReturnType<typeof Buffer.alloc>;

/** The live incident's shape: a state file that is entirely NUL bytes, so
    `JSON.parse` throws before any queue work can begin. Isolated per test —
    no HOME, XDG_CONFIG_HOME, LLV_STATE_DIR or live state is read or written. */
beforeEach(() => {
  stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-corrupt-"));
  corruptStateFile = path.join(stateDirectory, "wakatime-state.json");
  corruptBytes = Buffer.alloc(8_192, 0);
  fs.writeFileSync(corruptStateFile, corruptBytes, { mode: 0o600 });
});

afterEach(() => {
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});

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
            parentConversationId: null,
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

test("a corrupt state file cannot refuse an attributed operator action, and keeps every byte", () => {
  const diagnostics: Array<{ event: string; fields: Record<string, string | number | boolean | null> }> = [];

  const action = recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    path: "/sessions/direct.jsonl",
    idempotencyKey: "operator-message-under-corrupt-state",
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: (heartbeat) => enqueueProductionOperatorHeartbeat(heartbeat, corruptStateFile, () => true),
    reportStorageFailure: (event, fields) => { diagnostics.push({ event, fields }); },
  });

  expect(action).toMatchObject({ engine: "codex", project: "project-fixture", atMs: NOW });
  expect(diagnostics).toEqual([{
    event: "operator_activity_not_stored",
    fields: { outcome: "state_unreadable" },
  }]);
  expect(fs.readFileSync(corruptStateFile)).toEqual(corruptBytes);
});

test("the storage diagnostic carries an outcome class only, never a path, key or state byte", () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    idempotencyKey: "private-operator-request-id",
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: (heartbeat) => enqueueProductionOperatorHeartbeat(heartbeat, corruptStateFile, () => true),
    reportStorageFailure: (event, fields) => { diagnostics.push({ event, ...fields }); },
  });

  const rendered = JSON.stringify(diagnostics);
  expect(rendered).not.toContain("private-operator-request-id");
  expect(rendered).not.toContain(corruptStateFile);
  expect(rendered).not.toContain(stateDirectory);
  expect(rendered).not.toContain("wakatime-state.json");
});

test("a storage outage classifies without leaking the underlying failure text", () => {
  const outcomes: string[] = [];
  const record = (failure: unknown) => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    idempotencyKey: "outage-class",
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: () => { throw failure; },
    reportStorageFailure: (_event, fields) => { outcomes.push(String(fields.outcome)); },
  });

  /* The failure text an `fs` refusal really carries: the state path it opened.
     That is exactly what must not reach a diagnostic. */
  const denied = Object.assign(new Error("EACCES: permission denied, open '/var/lib/viewer/state.json'"), { code: "EACCES" });
  expect(record(denied)).not.toBeNull();
  expect(record(new SyntaxError("JSON Parse error"))).not.toBeNull();
  expect(record(new FileTransactionBusyError("WakaTime state is busy"))).not.toBeNull();
  expect(record(new Error("something else entirely"))).not.toBeNull();
  expect(outcomes).toEqual(["EACCES", "state_unreadable", "busy", "unavailable"]);
});

test("an invalid target is still refused, and never reaches optional storage", () => {
  let enqueues = 0;
  const diagnostics: string[] = [];

  expect(() => recordDirectOperatorWakatimeActivity({
    conversationId: "conversation_direct",
    path: "/sessions/unrelated.jsonl",
    idempotencyKey: "conflicting-target-under-corrupt-state",
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: registry,
    enqueue: () => { enqueues += 1; },
    reportStorageFailure: (event) => { diagnostics.push(event); },
  })).toThrow("conflicting target evidence");

  expect(enqueues).toBe(0);
  expect(diagnostics).toEqual([]);
});

test("invalid server-resolved attribution is still refused under a corrupt state file", () => {
  expect(() => recordDirectOperatorWakatimeActivity({
    idempotencyKey: "unattributed-spawn",
    resolvedAttribution: { engine: "claude", project: "  " },
  }, {
    enabled: () => true,
    now: () => NOW,
    registrySnapshot: () => { throw new Error("resolved attribution should avoid registry access"); },
    enqueue: (heartbeat) => enqueueProductionOperatorHeartbeat(heartbeat, corruptStateFile, () => true),
    reportStorageFailure: () => undefined,
  })).toThrow("attribution is invalid");
});
