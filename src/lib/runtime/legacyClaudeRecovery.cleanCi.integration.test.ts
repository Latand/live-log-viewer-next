import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { createTranscriptHostObserver, reconcileObservedTranscriptHosts } from "@/lib/agent/transcriptHost";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import type { FileEntry } from "@/lib/types";
import { RuntimeJournal } from "@/runtime-host/journal";

import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import type { RuntimeHostClient } from "./client";
import { FileRuntimeEventStore } from "./eventStore";
import { spawnClaudeRecoveryFixture } from "./fixtures/claude-stream-json-recovery";
import { bindStructuredDeliveryQueue, republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { spawnStructuredConversation } from "./structuredSpawn";
import { structuredContent } from "./structuredContent";

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

function noClaimCounts(registry: AgentRegistry, journal: RuntimeJournal) {
  return {
    registry: Object.values(registry.snapshot().heldDeliveries)
      .filter((delivery) => delivery.error === "no-claim").length,
    journal: journal.replay(0).events
      .filter((event) => event.kind === "receipt" && event.payload.reason === "no-claim").length,
  };
}

function providerDeliveries(filename: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filename, "utf8").trim().split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("production acceptance recovers a lifecycle-busy legacy Fable tail from a stale registering projection through MCP", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-clean-ci-legacy-fable-"));
  const workspace = path.join(directory, "fixture-workspace");
  const projectsRoot = path.join(directory, "claude-projects");
  const accountHome = path.join(directory, "selected-account");
  const registryFilename = path.join(directory, "agent-registry.json");
  const runtimeFilename = path.join(directory, "runtime.sqlite");
  const eventDirectory = path.join(directory, "broker-events");
  const deliveryDirectory = path.join(directory, "broker-deliveries");
  const deliveryLog = path.join(directory, "provider-deliveries.jsonl");
  const sessionId = crypto.randomUUID();
  const parentConversationId = `conversation_${crypto.randomUUID()}` as const;
  const artifactPath = claudeTranscriptPath(workspace, sessionId, projectsRoot);
  const originalIdempotencyKey = `message_${crypto.randomUUID()}`;
  const mcpClientRequestId = `mcp_probe_${crypto.randomUUID()}`;
  const message = " \tReturn RECOVERY_OK for this privacy-safe recovery probe.\nПривіт, світе 🌍\n ";
  const messageSha256 = crypto.createHash("sha256").update(message).digest("hex");
  const profile = emptyLaunchProfile({
    cwd: workspace,
    model: "claude-fable-fixture",
    effort: "high",
    permissionMode: "bypassPermissions",
    readOnly: false,
    allowSubagents: true,
    parentConversationId,
  });
  const transcriptBytes = Buffer.from([
    JSON.stringify({
      type: "user",
      uuid: "fixture-user-before-restart",
      timestamp: "2026-07-20T20:00:00.000Z",
      cwd: workspace,
      sessionId,
      message: { role: "user", content: [{ type: "text", text: "privacy-safe fixture input" }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "fixture-assistant-before-restart",
      timestamp: "2026-07-20T20:00:01.000Z",
      cwd: workspace,
      sessionId,
      message: {
        role: "assistant",
        model: "claude-fable-fixture",
        content: [{ type: "text", text: "privacy-safe fixture output" }],
        stop_reason: null,
      },
    }),
    /* Production #518 tail shape: the dead conversation ends with a `user`
       role record carrying only a `tool_result` block — no text, no image, no
       content digest. The stale pre-#389 runtime-host image failed promptless
       resume adoption on exactly this row with "message content is required";
       the promptless recovery below must adopt through it with zero synthetic
       user sends. */
    JSON.stringify({
      type: "user",
      uuid: "fixture-tool-result-before-restart",
      timestamp: "2026-07-20T20:00:02.000Z",
      cwd: workspace,
      sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "fixture-tool-use", content: [{ type: "text", text: "privacy-safe tool output" }] }],
      },
    }),
  ].join("\n") + "\n");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(artifactPath, transcriptBytes, { mode: 0o600 });
  const beforeTranscript = fs.readFileSync(artifactPath);
  const brokerEventStore = new FileRuntimeEventStore(eventDirectory);
  brokerEventStore.append(sessionId, { kind: "turn-started", turnId: "turn-before-restart", seq: 1 });
  brokerEventStore.append(sessionId, { kind: "turn-ended", turnId: "turn-before-restart", status: "interrupted", seq: 2 });
  brokerEventStore.append(sessionId, { kind: "session-status", status: "unhosted", seq: 3 });
  brokerEventStore.append(sessionId, { kind: "turn-started", turnId: "turn-after-restart", seq: 4 });
  brokerEventStore.append(sessionId, { kind: "session-status", status: "dead", seq: 5 });
  const brokerDeliveryLedger = new FileClaudeDeliveryLedger(deliveryDirectory);
  let registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
  let journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
  let client = runtimeClient(journal);
  const brokers: ClaudeStreamBrokerHost[] = [];
  let brokerStarts = 0;
  let journalClosed = false;

  try {
    const original = registry.beginSpawnRequest({
      engine: "claude",
      cwd: workspace,
      transport: "structured",
      accountId: "fixture-account-before-switch",
      parentConversationId,
      expectedArtifactPath: artifactPath,
      launchProfile: profile,
    });
    if (original.kind !== "created") throw new Error("fixture launch receipt was unavailable");
    const conversationId = original.receipt.conversationId;
    const key = { engine: "claude" as const, sessionId };
    const settled = registry.settleSpawn(original.receipt.launchId, {
      key,
      artifactPath,
      cwd: workspace,
      accountId: "fixture-account-before-switch",
      launchProfile: profile,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:released",
        process: null,
        eventCursor: 5,
        protocolVersion: "fixture-v1",
        writerClaimEpoch: 4,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 4,
      claimOwner: null,
      pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("fixture launch did not settle");

    const historicalNoClaim = registry.holdDelivery(
      conversationId,
      "preserve this historical no-claim receipt",
      `historical_${crypto.randomUUID()}`,
      "text",
      [],
      null,
      { operationId: `historical_operation_${crypto.randomUUID()}`, kind: "send", policy: "queue", turnId: null },
    );
    registry.beginDeliveryAttempt(historicalNoClaim.id, historicalNoClaim.generationId!);
    registry.recordDeliveryOutcome(historicalNoClaim.id, "failed", "no-claim");
    const content = structuredContent(message, []);
    const retrySource = registry.holdDelivery(
      conversationId,
      content.content.text,
      originalIdempotencyKey,
      "text",
      [],
      content.contentDigest,
    );
    registry.beginDeliveryAttempt(retrySource.id, retrySource.generationId!);
    registry.recordDeliveryOutcome(retrySource.id, "failed", "dead-host");
    const originalOperationId = retrySource.command.operationId;

    journal.append({
      scope: { type: "session", id: conversationId },
      kind: "session-status",
      payload: {
        conversationId,
        sessionKey: { engine: "claude", sessionId: conversationId },
        hostKind: "claude-broker",
        host: "registering",
        turn: "unknown",
        provenance: "structured",
        accountId: "fixture-account-before-switch",
        cwd: workspace,
        artifactPath: null,
        capabilities: { steer: false, structuredAttention: true },
        activeTurnId: null,
      },
    });
    const originalRuntimeReceipt = journal.executeOperation({
      kind: "send",
      operationId: originalOperationId,
      idempotencyKey: originalIdempotencyKey,
      conversationId,
      text: message,
      contentDigest: content.contentDigest,
      policy: "interrupt-active",
    }).receipt;
    expect(originalRuntimeReceipt).toMatchObject({ status: "rejected", reason: "no-claim" });
    expect(journal.snapshot().sessions).toContainEqual(expect.objectContaining({
      conversationId,
      host: "registering",
      artifactPath: null,
    }));
    const baselineNoClaimCounts = noClaimCounts(registry, journal);
    expect(baselineNoClaimCounts).toEqual({ registry: 1, journal: 1 });

    journal.close();
    journalClosed = true;
    registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
    journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
    journalClosed = false;
    client = runtimeClient(journal);

    const stat = fs.statSync(artifactPath);
    const fileEntry = {
      path: artifactPath,
      root: "claude-projects",
      name: `${sessionId}.jsonl`,
      project: "fixture-workspace",
      title: "legacy Fable recovery fixture",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "live",
      proc: "running",
      pid: 200,
      model: "claude-fable-fixture",
      effort: "high",
      pendingQuestion: null,
      waitingInput: null,
    } satisfies FileEntry;
    const observe = createTranscriptHostObserver({
      listFiles: async () => [fileEntry],
      panes: async () => ({ kind: "available" as const, panes: new Map([[100, { paneId: "%1", target: "fixture:1.0" }]]) }),
      ppidMap: () => new Map([[200, 100]]),
      agents: () => [{ pid: 200, engine: "claude" as const, argv: ["claude"], cwd: workspace, tty: 1 }],
      serverPid: async () => 900,
      resumeRecords: async () => null,
      identity: (pid) => `${pid}:fixture`,
      writesPath: () => false,
    });
    const observed = await observe(true);
    expect(observed.canonicalFor(artifactPath)).toBeNull();
    const evidence: TmuxHostEvidence = {
      kind: "tmux",
      endpoint: path.join(directory, "fixture.sock"),
      server: { pid: 900, startIdentity: "900:fixture" },
      paneId: "%1",
      panePid: { pid: 100, startIdentity: "100:fixture" },
      windowName: "fixture",
      agent: { pid: 200, startIdentity: "200:fixture" },
      argv: ["claude"],
    };
    reconcileObservedTranscriptHosts(observed.hosts, { registry, evidenceForHost: () => evidence });
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({ status: "dead", host: null });

    registry.reconcileConversations([{
      engine: "claude",
      path: artifactPath,
      accountId: "fixture-account-after-switch",
      launchProfile: profile,
      turn: { state: "busy", source: "lifecycle", terminalAt: null },
      observedAt: "2026-07-20T20:05:00.000Z",
    }]);
    expect(registry.conversation(conversationId)?.generations.at(-1)?.accountId)
      .toBe("fixture-account-after-switch");
    expect(registry.conversation(conversationId)?.turn).toMatchObject({
      state: "busy",
      source: "lifecycle",
      terminalAt: null,
    });
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "dead",
      host: null,
      structuredHost: { process: null },
    });
    expect(journal.snapshot().sessions).toContainEqual(expect.objectContaining({
      conversationId,
      host: "registering",
      artifactPath: null,
    }));
    const historicalSpawnReceipt = structuredClone(registry.snapshot().receipts[original.receipt.launchId]);

    await bindStructuredDeliveryQueue([], { registry, client });
    journal.append({
      scope: { type: "session", id: conversationId },
      kind: "session-status",
      payload: {
        conversationId,
        sessionKey: { engine: "claude", sessionId: conversationId },
        hostKind: "claude-broker",
        host: "registering",
        turn: "unknown",
        provenance: "structured",
        accountId: "fixture-account-after-switch",
        cwd: workspace,
        artifactPath: null,
        capabilities: { steer: false, structuredAttention: true },
        activeTurnId: null,
      },
    });
    expect(journal.snapshot().sessions).toContainEqual(expect.objectContaining({
      conversationId,
      host: "registering",
      artifactPath: null,
    }));
    const recover = (request: { path: string; conversationId?: string | null }) =>
      recoverDeadStructuredConversation(request, {
        registry,
        client,
        transport: () => "structured",
        resolveAccount: (engine, accountId) => {
          expect({ engine, accountId }).toEqual({ engine: "claude", accountId: "fixture-account-after-switch" });
          return {
            engine: "claude",
            accountId: "fixture-account-after-switch",
            kind: "managed",
            home: accountHome,
            transcriptRoot: projectsRoot,
            env: { NODE_ENV: "test", PATH: process.env.PATH },
          };
        },
        spawn: (input) => spawnStructuredConversation(input, {
          startHost: async () => {
            brokerStarts += 1;
            const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
              cwd: workspace,
              claudeConfigDir: accountHome,
              claudeProjectsDir: projectsRoot,
              allowSubagents: true,
              permissionMode: "bypassPermissions",
              initialEventCursor: 5,
              eventStore: brokerEventStore,
              deliveryLedger: brokerDeliveryLedger,
              requestTimeoutMs: 2_000,
              shutdownGraceMs: 100,
              readAuthStatus: () => ({
                loggedIn: true,
                authMethod: "claude.ai",
                subscriptionType: "fixture",
                version: "fixture-v1",
              }),
              signalProcess: () => { throw new Error("recovery fixture has no process group"); },
              spawnProcess: (_command, args) => {
                const marker = args.indexOf("--resume");
                expect(args[marker + 1]).toBe(sessionId);
                return spawnClaudeRecoveryFixture(sessionId, deliveryLog);
              },
            });
            brokers.push(host);
            return host;
          },
        }),
        requestDeliveryDrain: () => { void kickStructuredDeliveryQueue(); },
      });
    const mcpBodies: Record<string, unknown>[] = [];
    const bindings = viewerMcpBindings(undefined, {
      post: async (pathname, body) => {
        expect(pathname).toBe("/api/tmux");
        mcpBodies.push(structuredClone(body));
        const outcome = await enqueueStructuredMessage({
          path: typeof body.path === "string" ? body.path : "",
          conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
          clientMessageId: typeof body.clientMessageId === "string" ? body.clientMessageId : null,
          text: typeof body.text === "string" ? body.text : "",
          images: [],
        }, {
          enabled: () => true,
          client: () => client,
          registry: () => registry,
          recover: (request) => recover(request),
          republish: async () => republishStructuredDeliveryHost(key),
          kick: () => kickStructuredDeliveryQueue(),
        });
        if (!outcome) throw new Error("structured MCP delivery was unavailable");
        if (!outcome.ok) throw new Error(outcome.error);
        await kickStructuredDeliveryQueue();
        return outcome as unknown as Record<string, unknown>;
      },
    });
    const sendProbe = () => bindings.send_message({
      clientRequestId: mcpClientRequestId,
      conversationId,
      text: message,
    });
    const [firstRetry, concurrentRetry] = await Promise.all([
      sendProbe(),
      sendProbe(),
    ]);
    expect(mcpBodies).toHaveLength(2);
    expect(mcpBodies).toEqual(mcpBodies.map(() => expect.objectContaining({
      conversationId,
      clientMessageId: mcpClientRequestId,
      text: message,
      images: [],
    })));
    expect(new Set([firstRetry.operationId, concurrentRetry.operationId]).size).toBe(1);
    const retryOperationId = String(firstRetry.operationId);
    await waitFor(
      () => journal.operationResult(retryOperationId)?.receipt.status === "delivered",
      "the real Claude broker did not settle the MCP retry",
    );
    await waitFor(
      () => brokerEventStore.load(sessionId)
        .some((event) => event.kind === "delta" && event.text === "RECOVERY_OK"),
      "the recovered Claude turn did not return RECOVERY_OK",
    );
    await waitFor(
      () => journal.snapshot().sessions.some((session) =>
        session.conversationId === conversationId && session.host === "hosted" && session.turn === "idle"),
      "the recovered Claude host projection did not settle idle",
    );
    expect(await republishStructuredDeliveryHost(key)).toBe(true);

    expect(brokerStarts).toBe(1);
    expect(Object.values(registry.snapshot().receipts).filter((receipt) =>
      receipt.conversationId === conversationId && receipt.purpose === "resume-successor")).toHaveLength(1);
    expect(brokerDeliveryLedger.load(sessionId).filter((delivery) => delivery.delivered)).toHaveLength(1);
    expect(providerDeliveries(deliveryLog)).toEqual([{ sessionId, deliveryCount: 1, textSha256: messageSha256 }]);
    expect(brokerEventStore.load(sessionId).filter((event) => event.kind === "delta" && event.text === "RECOVERY_OK"))
      .toHaveLength(1);
    const mcpProbe = Object.values(registry.snapshot().heldDeliveries)
      .find((delivery) => delivery.clientMessageId === mcpClientRequestId);
    expect(mcpProbe).toMatchObject({ state: "delivered", text: "", error: null });
    expect(registry.snapshot().heldDeliveries[retrySource.id]).toMatchObject({ state: "failed", error: "dead-host" });
    expect(registry.snapshot().heldDeliveries[historicalNoClaim.id]).toMatchObject({ state: "failed", error: "no-claim" });
    expect(registry.snapshot().receipts[original.receipt.launchId]).toEqual(historicalSpawnReceipt);
    expect(journal.operationResult(originalOperationId)?.receipt).toEqual(originalRuntimeReceipt);
    expect(noClaimCounts(registry, journal)).toEqual(baselineNoClaimCounts);
    expect(fs.readFileSync(artifactPath)).toEqual(beforeTranscript);

    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    journalClosed = true;
    registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
    journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
    journalClosed = false;
    client = runtimeClient(journal);
    await bindStructuredDeliveryQueue([{ key, host: brokers[0]! }], { registry, client });
    await kickStructuredDeliveryQueue();

    const deployedReplay = await sendProbe();
    expect(deployedReplay).toMatchObject({ operationId: retryOperationId, outcome: "delivered" });
    expect(mcpBodies).toHaveLength(3);
    expect(mcpBodies).toEqual(mcpBodies.map(() => expect.objectContaining({
      conversationId,
      clientMessageId: mcpClientRequestId,
      text: message,
      images: [],
    })));
    expect(brokerStarts).toBe(1);
    expect(brokerDeliveryLedger.load(sessionId).filter((delivery) => delivery.delivered)).toHaveLength(1);
    expect(providerDeliveries(deliveryLog)).toEqual([{ sessionId, deliveryCount: 1, textSha256: messageSha256 }]);
    expect(brokerEventStore.load(sessionId).filter((event) => event.kind === "delta" && event.text === "RECOVERY_OK"))
      .toHaveLength(1);
    expect(noClaimCounts(registry, journal)).toEqual(baselineNoClaimCounts);
    expect(registry.snapshot().receipts[original.receipt.launchId]).toEqual(historicalSpawnReceipt);
    expect(journal.operationResult(originalOperationId)?.receipt).toEqual(originalRuntimeReceipt);
    expect(fs.readFileSync(artifactPath)).toEqual(beforeTranscript);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    for (const broker of new Set(brokers)) await broker.release().catch(() => {});
    if (!journalClosed) journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
