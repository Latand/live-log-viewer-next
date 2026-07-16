import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentEngine, ResumeSpec } from "@/lib/agent/cli";
import type { AgentRegistry, SpawnReceipt, StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { procBackend } from "@/lib/proc";
import { hasUserAuthoredMessage } from "@/lib/session/reader";

import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeHostClient } from "./client";
import type { RuntimeOperationResult, RuntimeSession } from "./contracts";
import type { EngineHost, HostState } from "./engineHost";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";
import { publishStructuredDeliveryHost, releaseStructuredDeliveryHost } from "./structuredDeliveryController";

export type SpawnedStructuredHost = EngineHost & {
  identity: { threadId: string; path: string | null } | { sessionId: string };
  onStateChange(listener: (state: HostState) => void): () => void;
};

export const INITIAL_MESSAGE_TIMEOUT_MS = 30_000;
const INITIAL_MESSAGE_POLL_MS = 250;
const INITIAL_MESSAGE_DELIVERED = new Set(["delivered", "turn-started", "steered"]);
const INITIAL_MESSAGE_FAILED = new Set(["failed", "rejected", "uncertain", "interrupted"]);

function runtimeEntryStatus(session: RuntimeSession): "dead" | "live" | "idle" {
  if (session.host === "dead" || session.host === "unhosted") return "dead";
  if (session.turn === "running") return "live";
  return "idle";
}

function failedOperationReason(operation: RuntimeOperationResult | null, subject: string): string | null {
  const status = operation?.receipt.status;
  if (!status || !INITIAL_MESSAGE_FAILED.has(status)) return null;
  return operation.receipt.reason ?? `${subject} ended as ${status}`;
}

function reconciledInitialMessage(
  receipt: SpawnReceipt,
  status: string | undefined,
  runtimeDelivered: boolean,
): "pending" | "queued" | "delivered" | "failed" {
  if (receipt.state === "failed" || (status !== undefined && INITIAL_MESSAGE_FAILED.has(status))) return "failed";
  if (runtimeDelivered || receipt.state === "completed") return "delivered";
  if (status === "queued" || status === "pending" || status === "delivering") return "queued";
  return "pending";
}

export async function waitForStructuredInitialMessage(
  client: RuntimeHostClient,
  operationId: string,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? INITIAL_MESSAGE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? INITIAL_MESSAGE_POLL_MS;
  const deadline = now() + timeoutMs;
  let lastStatus: string | undefined;
  let lastReadError: string | null = null;
  for (;;) {
    let operation: Awaited<ReturnType<RuntimeHostClient["operationStatus"]>> = null;
    try {
      operation = await client.operationStatus(operationId, { currentRetryLeaf: true });
      lastStatus = operation?.receipt.status ?? lastStatus;
      lastReadError = null;
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : "runtime status read failed";
    }
    const status = operation?.receipt.status ?? lastStatus;
    if (status && INITIAL_MESSAGE_DELIVERED.has(status)) return;
    if (status && INITIAL_MESSAGE_FAILED.has(status)) {
      throw new Error(operation?.receipt.reason ?? `structured initial message ended as ${status}`);
    }
    if (now() >= deadline) {
      if (lastReadError) {
        throw new Error(`structured initial message status remained unavailable for ${timeoutMs}ms: ${lastReadError}`);
      }
      throw new Error(`structured initial message remained ${status ?? "pending"} for ${timeoutMs}ms`);
    }
    await sleep(Math.min(pollMs, deadline - now()));
  }
}

export async function reconcileStructuredSpawnReplay(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: {
    now?: () => number;
    timeoutMs?: number;
    releaseHost?: (key: SessionKey) => Promise<boolean>;
  } = {},
): Promise<SpawnReceipt & { initialMessage: "pending" | "queued" | "delivered" | "failed" }> {
  const current = registry.snapshot().receipts[launchId];
  if (!current) throw new Error("unknown spawn receipt");
  const [operation, spawnOperation, runtime] = await Promise.all([
    client.operationStatus(`spawn_message_${launchId}`, { currentRetryLeaf: true }).catch(() => null),
    client.operationStatus(launchId, { currentRetryLeaf: true }).catch(() => null),
    client.snapshot().catch(() => null),
  ]);
  const runtimeDelivered = Boolean(operation
    && operation.receipt.conversationId === current.conversationId
    && INITIAL_MESSAGE_DELIVERED.has(operation.receipt.status));
  const transcriptDelivered = Boolean(current.artifactPath
    && hasUserAuthoredMessage(current.artifactPath, current.engine));
  if (runtimeDelivered || transcriptDelivered) {
    const session = runtime?.sessions.find((candidate) => candidate.conversationId === current.conversationId);
    const sessionMatches = session
      && session.sessionKey.engine === current.engine
      && session.cwd === current.cwd
      && typeof session.artifactPath === "string"
      ? session
      : null;
    const evidence = sessionMatches ? {
      key: sessionMatches.sessionKey,
      artifactPath: sessionMatches.artifactPath!,
      cwd: current.cwd,
      accountId: current.accountId,
      launchProfile: current.launchProfile,
      status: runtimeEntryStatus(sessionMatches),
      host: null,
      structuredHost: sessionMatches.hostKind === "codex-app-server" || sessionMatches.hostKind === "claude-broker"
        ? {
          kind: sessionMatches.hostKind,
          endpoint: "runtime:reconciled",
          process: null,
          eventCursor: sessionMatches.revision,
          protocolVersion: null,
          writerClaimEpoch: 0,
          activeTurnRef: sessionMatches.activeTurnId,
          pendingAttention: sessionMatches.attentionIds,
          activeFlags: [],
        }
        : null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    } : undefined;
    const recovered = registry.recoverStructuredSpawnFromEvidence(launchId, evidence);
    if (recovered.kind === "settled") {
      return { ...recovered.receipt, initialMessage: "delivered" };
    }
  }
  const messageStatus = operation?.receipt.status;
  const runtimeSession = runtime?.sessions.find((candidate) => candidate.conversationId === current.conversationId) ?? null;
  const ageMs = (options.now ?? Date.now)() - Date.parse(current.createdAt);
  const timeoutMs = options.timeoutMs ?? INITIAL_MESSAGE_TIMEOUT_MS;
  let terminalReason = failedOperationReason(operation, "structured initial message")
    ?? failedOperationReason(spawnOperation, "structured spawn");
  if (!terminalReason
    && current.state !== "completed"
    && current.state !== "failed"
    && runtime
    && ageMs >= timeoutMs) {
    terminalReason = runtimeSession
      ? `structured initial message remained ${messageStatus ?? "pending"} for ${timeoutMs}ms`
      : `structured spawn runtime snapshot has no session after ${timeoutMs}ms`;
  }
  if (terminalReason) {
    registry.failStructuredSpawn(launchId, terminalReason.slice(0, 240));
    if (current.key) {
      await (options.releaseHost ?? releaseStructuredDeliveryHost)(current.key).catch(() => false);
    }
    const failed = registry.snapshot().receipts[launchId] ?? current;
    return { ...failed, initialMessage: "failed" };
  }
  const receipt = registry.snapshot().receipts[launchId] ?? current;
  return {
    ...receipt,
    initialMessage: reconciledInitialMessage(receipt, messageStatus, runtimeDelivered),
  };
}

export interface StructuredSpawnInput {
  engine: AgentEngine;
  receipt: SpawnReceipt;
  spec: ResumeSpec;
  account: AccountContext;
  prompt: string;
  registry: AgentRegistry;
  client: RuntimeHostClient;
}

interface HostBinding {
  stopPersistence(): void;
  unregister(): Promise<void>;
}

const FAILED_SPAWN_OPERATION_STATUSES = new Set([
  "failed",
  "rejected",
  "uncertain",
  "turn-started",
  "steered",
  "interrupted",
  "answered",
]);

async function projectDeadStructuredSpawn(
  client: RuntimeHostClient,
  receipt: SpawnReceipt,
  entry: { accountId: string | null; cwd: string },
  eventKey: string,
  identity?: { key: SessionKey; artifactPath: string },
): Promise<void> {
  const key = identity?.key ?? receipt.key;
  const artifactPath = identity?.artifactPath ?? receipt.artifactPath;
  if (!key || !artifactPath) return;
  await client.append({
    scope: { type: "session", id: receipt.conversationId },
    kind: "session-status",
    producer: {
      kind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
      eventKey,
    },
    payload: {
      conversationId: receipt.conversationId,
      sessionKey: key,
      hostKind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "dead",
      turn: "idle",
      provenance: "structured",
      accountId: entry.accountId,
      parentConversationId: receipt.parentConversationId,
      cwd: entry.cwd,
      artifactPath,
      capabilities: { steer: key.engine === "codex", structuredAttention: true },
      activeTurnId: null,
    },
  });
}

export interface StructuredSpawnDependencies {
  startHost?(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost>;
  bindHost?(registry: AgentRegistry, key: SessionKey, host: SpawnedStructuredHost, claimOwner: string, claimEpoch: number): Promise<() => void>;
  publishHost?(key: SessionKey, host: SpawnedStructuredHost): Promise<() => Promise<void>>;
  deliverFirst?(input: StructuredSpawnInput, artifactPath: string): Promise<void>;
  processIdentity?(): { pid: number; startIdentity: string | null };
}

export async function recoverPendingStructuredSpawns(
  registry: AgentRegistry,
  client: RuntimeHostClient,
): Promise<void> {
  const spawnEffects = new Map<string, Record<string, unknown>>();
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(["runtime.spawn"], afterEventSeq);
    for (const effect of batch) {
      const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : null;
      if (operationId) spawnEffects.set(operationId, effect.payload);
    }
    if (batch.length < 100) break;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) throw new Error("structured spawn recovery effect page did not advance");
    afterEventSeq = next;
  }

  const snapshot = registry.snapshot();
  for (const receipt of Object.values(snapshot.receipts)) {
    const effect = spawnEffects.get(receipt.launchId);
    if (receipt.state === "starting" && !receipt.key && receipt.transport !== "tmux") {
      const operation = await client.operationStatus(receipt.launchId);
      if (receipt.transport !== "structured" && !effect && !operation) continue;
      let reason: string;
      if (operation?.receipt.status === "queued" || operation?.receipt.status === "pending" || operation?.receipt.status === "delivering") {
        reason = `structured spawn interrupted before identity staging: ${receipt.launchId}`;
        await client.transitionOperation(receipt.launchId, "failed", { reason });
      } else if (!operation) {
        reason = `structured spawn interrupted before runtime admission: ${receipt.launchId}`;
      } else {
        reason = operation.receipt.reason
          ?? `structured spawn operation ended as ${operation.receipt.status} before identity staging`;
      }
      registry.failStructuredSpawn(receipt.launchId, reason);
      continue;
    }
    if (receipt.state !== "path-pending" || !receipt.key || !receipt.artifactPath) continue;
    const entry = snapshot.entries[sessionKeyId(receipt.key)];
    const operation = await client.operationStatus(receipt.launchId);
    const status = operation?.receipt.status;
    if (status && FAILED_SPAWN_OPERATION_STATUSES.has(status)) {
      if (entry) await projectDeadStructuredSpawn(
        client,
        receipt,
        entry,
        `structured-spawn-failed:${receipt.launchId}`,
      );
      registry.failStructuredSpawn(
        receipt.launchId,
        operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
      );
      await releaseStructuredDeliveryHost(receipt.key).catch(() => false);
      continue;
    }
    if (status === "delivered") {
      const hostReady = entry?.structuredHost?.process
        && entry.claimOwner
        && entry.status !== "dead"
        && entry.status !== "unhosted";
      if (hostReady) {
        const finalized = registry.finalizeStructuredSpawn(receipt.launchId);
        if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
      } else {
        if (!entry) throw new Error(`structured spawn recovery identity is unavailable for ${receipt.launchId}`);
        await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-delivered-host-dead:${receipt.launchId}`,
        );
        const settled = registry.recoverDeliveredStructuredSpawn(receipt.launchId);
        if (settled.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${settled.code}`);
        await releaseStructuredDeliveryHost(receipt.key).catch(() => false);
      }
      continue;
    }
    if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") continue;
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    if (prompt === null || effect?.conversationId !== receipt.conversationId || effect?.cwd !== receipt.cwd) {
      throw new Error(`structured spawn recovery is missing durable prompt admission for ${receipt.launchId}`);
    }
    if (prompt.trim()) {
      const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
      const delivered = await enqueueStructuredMessage({
        path: receipt.artifactPath,
        conversationId: receipt.conversationId,
        clientMessageId: `spawn_${receipt.launchId}`,
        operationId: `spawn_message_${receipt.launchId}`,
        text: prompt,
        hasImages: false,
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      if (!delivered?.ok) throw new Error(delivered?.error ?? `structured spawn recovery could not admit ${receipt.launchId}`);
    }
    await client.transitionOperation(receipt.launchId, "delivered");
    const finalized = registry.finalizeStructuredSpawn(receipt.launchId);
    if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
  }
}

function pendingColumns(engine: AgentEngine): StructuredHostColumns {
  return {
    kind: engine === "codex" ? "codex-app-server" : "claude-broker",
    endpoint: "stdio:pending",
    process: null,
    eventCursor: 0,
    protocolVersion: null,
    writerClaimEpoch: 0,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
}

function hostIdentity(engine: AgentEngine, host: SpawnedStructuredHost, input: StructuredSpawnInput): { key: SessionKey; path: string } {
  if (engine === "codex") {
    const identity = host.identity as { threadId?: string; path?: string | null };
    if (!identity.threadId) throw new Error("structured Codex spawn returned no thread identity");
    if (!identity.path) throw new Error("structured Codex spawn feature gap: app-server returned no transcript path");
    const key = sessionKey("codex", identity.threadId);
    if (!key) throw new Error("structured Codex spawn returned an invalid thread identity");
    return { key, path: identity.path };
  }
  const identity = host.identity as { sessionId?: string };
  if (!identity.sessionId) throw new Error("structured Claude spawn returned no session identity");
  const key = sessionKey("claude", identity.sessionId);
  if (!key) throw new Error("structured Claude spawn returned an invalid session identity");
  return {
    key,
    path: input.spec.transcript ?? claudeTranscriptPath(input.spec.cwd, identity.sessionId, input.account.transcriptRoot),
  };
}

export interface StructuredClaudePermissionContext {
  agentInitiated: boolean;
  operatorAuthenticated: boolean;
  roleSpawn: boolean;
}

export function structuredClaudePermissionMode(
  mode: string | null | undefined,
  context: StructuredClaudePermissionContext,
): string {
  if (!mode) return "default";
  if (mode !== "bypassPermissions") return mode;
  return context.operatorAuthenticated || (context.roleSpawn && !context.agentInitiated) ? mode : "default";
}

export function structuredClaudeSpawnPolicyBaseSettingsPath(
  account: Pick<AccountContext, "kind">,
  sharedSettingsPath: () => string | null = claudeSettingsPath,
): string | null {
  return account.kind === "managed" ? sharedSettingsPath() : null;
}

async function defaultStartHost(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost> {
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  const env = { ...input.account.env, LLV_SPAWN_CAPABILITY: capability };
  const resumeSessionId = structuredResumeSessionId(input);
  if (input.engine === "codex") {
    const options = {
      cwd: input.spec.cwd,
      codexHome: input.account.home,
      fileAuthCredentials: input.account.kind === "managed",
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      allowSubagents: profile.allowSubagents,
      sandbox: profile.readOnly ? "read-only" : "danger-full-access",
      approvalPolicy: profile.permissionMode ?? undefined,
      env,
    };
    return resumeSessionId
      ? await CodexAppServerHost.adopt(resumeSessionId, options)
      : await CodexAppServerHost.start(options);
  }
  const sessionId = resumeSessionId ?? (input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl") : undefined);
  const options = {
    cwd: input.spec.cwd,
    claudeConfigDir: input.account.home,
    claudeProjectsDir: input.account.transcriptRoot,
    spawnPolicyBaseSettingsPath: structuredClaudeSpawnPolicyBaseSettingsPath(input.account),
    allowSubagents: profile.allowSubagents,
    model: profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    permissionMode: profile.permissionMode ?? "default",
    env,
  };
  return resumeSessionId
    ? await ClaudeStreamBrokerHost.adopt(resumeSessionId, options)
    : await ClaudeStreamBrokerHost.start({ ...options, ...(sessionId ? { sessionId } : {}) });
}

export function structuredResumeSessionId(
  input: Pick<StructuredSpawnInput, "receipt" | "registry">,
): string | null {
  if (input.receipt.purpose !== "resume-successor") return null;
  const conversation = input.registry.conversation(input.receipt.conversationId);
  const source = conversation?.generations.find((generation) => generation.path === input.receipt.resumeSourcePath)
    ?? conversation?.generations.at(-1);
  return source?.id ?? null;
}

async function defaultBindHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: SpawnedStructuredHost,
  claimOwner: string,
  claimEpoch: number,
): Promise<() => void> {
  return key.engine === "codex"
    ? await bindCodexHostPersistence(registry, key, host as CodexAppServerHost, claimOwner, claimEpoch)
    : await bindClaudeHostPersistence(registry, key, host as ClaudeStreamBrokerHost, claimOwner, claimEpoch);
}

async function defaultDeliverFirst(input: StructuredSpawnInput, artifactPath: string): Promise<void> {
  if (!input.prompt.trim()) return;
  const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
  const delivered = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: input.receipt.conversationId,
    clientMessageId: `spawn_${input.receipt.launchId}`,
    operationId: `spawn_message_${input.receipt.launchId}`,
    text: input.prompt,
    hasImages: false,
  }, {
    client: () => input.client,
    registry: () => input.registry,
    enabled: () => true,
  });
  if (!delivered?.ok) throw new Error(delivered?.error ?? "structured spawn first-message delivery was unavailable");
  if (delivered.outcome === "held") throw new Error("structured spawn first message entered a migration hold");
  if (delivered.outcome !== "delivered") {
    await waitForStructuredInitialMessage(input.client, delivered.operationId);
  }
}

async function cleanupHost(host: SpawnedStructuredHost | null, binding: HostBinding): Promise<void> {
  await binding.unregister().catch(() => {});
  binding.stopPersistence();
  await host?.release().catch(() => {});
}

export async function spawnStructuredConversation(
  input: StructuredSpawnInput,
  dependencies: StructuredSpawnDependencies = {},
): Promise<SpawnResponse> {
  const startHost = dependencies.startHost ?? defaultStartHost;
  const bindHost = dependencies.bindHost ?? defaultBindHost;
  const publishHost = dependencies.publishHost ?? ((key, host) => publishStructuredDeliveryHost({ key, host }));
  const deliverFirst = dependencies.deliverFirst ?? defaultDeliverFirst;
  const processIdentity = dependencies.processIdentity ?? (() => ({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) }));
  const operationId = input.receipt.launchId;
  let host: SpawnedStructuredHost | null = null;
  const binding: HostBinding = { stopPersistence: () => {}, unregister: async () => {} };
  let key: SessionKey | null = null;
  try {
    await input.client.command({
      kind: "spawn",
      operationId,
      idempotencyKey: operationId,
      conversationId: input.receipt.conversationId,
      engine: input.engine,
      cwd: input.spec.cwd,
      prompt: input.prompt,
      accountId: input.account.accountId,
      parentConversationId: input.receipt.parentConversationId,
      ...(input.receipt.purpose === "resume-successor" ? { sessionId: structuredResumeSessionId(input) } : {}),
    });
    const capability = input.registry.rotateSpawnCapabilityForReceipt(input.receipt.launchId);
    host = await startHost(input, capability);
    const identity = hostIdentity(input.engine, host, input);
    key = identity.key;
    const staged = input.registry.stageStructuredSpawn(input.receipt.launchId, {
      key,
      artifactPath: identity.path,
      cwd: input.spec.cwd,
      accountId: input.account.accountId,
      launchProfile: input.spec.launchProfile,
      status: "unhosted",
      host: null,
      structuredHost: pendingColumns(input.engine),
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (staged.kind === "conflict") throw new Error(`structured spawn registry conflict: ${staged.code}`);
    const claimed = input.registry.claimStructuredHost(key, processIdentity(), { allowUnhosted: true });
    if (!claimed?.claimOwner) throw new Error("structured spawn host claim is unavailable");
    binding.stopPersistence = await bindHost(input.registry, key, host, claimed.claimOwner, claimed.claimEpoch);
    binding.unregister = await publishHost(key, host);
    await deliverFirst(input, identity.path);
    await input.client.transitionOperation(operationId, "delivered");
    const settled = input.registry.finalizeStructuredSpawn(input.receipt.launchId);
    if (settled.kind === "conflict") throw new Error(`structured spawn registry conflict: ${settled.code}`);
    return {
      ok: true,
      target: null,
      path: identity.path,
      ...(input.engine === "claude"
        ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
        : {}),
      launchId: input.receipt.launchId,
      conversationId: settled.conversation.id,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  } catch (error) {
    await input.client.transitionOperation(operationId, "failed", {
      reason: error instanceof Error ? error.message.slice(0, 240) : "structured spawn failed",
    }).catch(() => {});
    await cleanupHost(host, binding);
    if (key) {
      input.registry.failStructuredSpawn(input.receipt.launchId, error instanceof Error ? error.message : "structured spawn failed");
      const entry = input.registry.snapshot().entries[sessionKeyId(key)];
      if (entry) {
        await projectDeadStructuredSpawn(
          input.client,
          input.receipt,
          entry,
          `structured-spawn-failed:${input.receipt.launchId}`,
          { key, artifactPath: entry.artifactPath },
        ).catch(() => {});
      }
    }
    else input.registry.failSpawn(input.receipt.launchId, "structured spawn failed before host binding");
    throw error;
  }
}
