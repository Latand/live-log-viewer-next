import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";

const sandboxes: string[] = [];

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { client: null });
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (afterEventSeq) => journal.replay(afterEventSeq),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

test("legacy transport with a failed probe, live recorded host, and running turn projects one live liveness verdict", async () => {
  const sessionId = "56565656-5656-\x34565-8565-565656565656";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-live-verdict-"));
  sandboxes.push(directory);
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "busy", source: "tool", terminalAt: null },
    observedAt: "2026-08-31T18:03:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "default",
    launchProfile: profile,
    status: "live",
    host: {
      kind: "tmux",
      endpoint: "tmux:legacy-live",
      server: { pid: 201, startIdentity: "server:201" },
      paneId: "%20",
      panePid: { pid: 202, startIdentity: "pane:202" },
      windowName: "legacy-live",
      agent: { pid: 203, startIdentity: "agent:203" },
      argv: ["codex", "resume", sessionId],
    },
    /* The failed probe belongs to a stale structured adapter for the same
       generation. It is environmental evidence only; the durable legacy host
       above remains the transport that can receive this conversation. */
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:failed-probe",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const failedProbe = Object.assign(new FakeEngineHost(createFakeDeliveryLedger(), {
    status: "dead",
    sessionKey: sessionId,
    endpoint: "fake:failed-probe",
    pid: null,
    processStartIdentity: null,
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  }), { onStateChange: () => () => {} });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });

  await bindStructuredDeliveryQueue([{ key, host: failedProbe }], {
    registry,
    client: runtimeJournalClient(journal),
  });

  const sessions = journal.snapshot().sessions
    .filter((session) => session.conversationId === conversation.id);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    hostKind: "tmux-legacy",
    host: "hosted",
    turn: "running",
    provenance: "derived",
  });
  journal.close();
});
