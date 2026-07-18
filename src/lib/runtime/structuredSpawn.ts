import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentEngine, ResumeSpec } from "@/lib/agent/cli";
import type { AgentRegistry, AgentRegistryEntry, SpawnReceipt, StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { prepareManagedClaudeSpawnHome } from "@/lib/agent/spawnPolicy";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { procBackend } from "@/lib/proc";
import { hasUserAuthoredMessage } from "@/lib/session/reader";
import { hardenedRedact } from "@/lib/view/compactText";

import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeHostClient } from "./client";
import { StructuredHostAdoptionCleanupError, type EngineHost, type HostState } from "./engineHost";
import type { RuntimeOperationResult, RuntimeSession } from "./contracts";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";
import { publishStructuredDeliveryHost, releaseStructuredDeliveryHost } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { runtimeImageCapability } from "./runtimeImageStore";
import { parseStructuredImageRefs, structuredContent, type StructuredImageRef } from "./structuredContent";

export type SpawnedStructuredHost = EngineHost & {
  identity: { threadId: string; path: string | null } | { sessionId: string };
  onStateChange(listener: (state: HostState) => void): () => void;
};

export const INITIAL_MESSAGE_TIMEOUT_MS = 30_000;
const INITIAL_MESSAGE_POLL_MS = 250;
const INITIAL_MESSAGE_DELIVERED = new Set(["delivered", "turn-started", "steered"]);
const INITIAL_MESSAGE_FAILED = new Set(["failed", "rejected", "uncertain", "interrupted"]);

function structuredSpawnFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "structured spawn failed";
  return hardenedRedact(message).replace(/\s+/g, " ").trim().slice(0, 240) || "structured spawn failed";
}

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

function settleInitialMessageReservation(registry: AgentRegistry, launchId: string): void {
  const clientMessageId = `spawn_${launchId}`;
  const reservation = Object.values(registry.snapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === clientMessageId);
  if (reservation && reservation.state !== "delivered") {
    registry.recordDeliveryOutcome(reservation.id, "delivered");
  }
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
  if (current.state === "completed") {
    return { ...current, initialMessage: "delivered" };
  }
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
  const entry = current.key ? registry.snapshot().entries[sessionKeyId(current.key)] : null;
  const liveRegisteringSession = Boolean(runtimeSession
    && current.key
    && runtimeSession.host === "registering"
    && sessionKeyId(runtimeSession.sessionKey) === sessionKeyId(current.key)
    && runtimeSession.cwd === current.cwd
    && runtimeSession.artifactPath === current.artifactPath
    && entry?.structuredHostOperationId === launchId
    && entry.pendingAction === "spawn"
    && entry.claimOwner
    && entry.structuredHost?.process
    && entry.structuredHost.writerClaimEpoch === entry.claimEpoch
    && entry.status !== "dead"
    && entry.status !== "unhosted");
  const operationStartedAt = operation ? Date.parse(operation.receipt.at) : Number.NaN;
  const stageStartedAt = Number.isFinite(operationStartedAt) ? operationStartedAt : Date.parse(current.createdAt);
  const ageMs = (options.now ?? Date.now)() - stageStartedAt;
  const timeoutMs = options.timeoutMs ?? INITIAL_MESSAGE_TIMEOUT_MS;
  let terminalReason = failedOperationReason(operation, "structured initial message")
    ?? failedOperationReason(spawnOperation, "structured spawn");
  if (!terminalReason
    && current.state !== "failed"
    && runtime
    && !liveRegisteringSession
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
  imageRefs?: StructuredImageRef[];
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
      capabilities: {
        steer: key.engine === "codex",
        structuredAttention: true,
        imageInput: runtimeImageCapability(key.engine, false),
      },
      activeTurnId: null,
    },
  });
}

function resumeIdentityForReceipt(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
): { key: SessionKey; artifactPath: string } | null {
  if (receipt.purpose !== "resume-successor") return null;
  const conversation = registry.conversation(receipt.conversationId);
  const source = conversation?.generations.find((generation) => generation.path === receipt.resumeSourcePath)
    ?? conversation?.generations.at(-1);
  return source ? { key: { engine: receipt.engine, sessionId: source.id }, artifactPath: source.path } : null;
}

function releaseAdoptionClaim(
  registry: AgentRegistry,
  claimed: AgentRegistryEntry,
  terminal: boolean,
): void {
  if (!claimed.claimOwner || !claimed.structuredHost) return;
  if (terminal) {
    const projected = registry.setStructuredHostClaimed(claimed.key, {
      ...claimed.structuredHost,
      endpoint: "stdio:released",
      process: null,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "dead", claimed.claimOwner, claimed.claimEpoch, true);
    if (projected) return;
  }
  registry.releaseStructuredHostClaim(claimed.key, claimed.claimOwner, claimed.claimEpoch);
}

export interface StructuredSpawnDependencies {
  startHost?(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost>;
  bindHost?(
    registry: AgentRegistry,
    key: SessionKey,
    host: SpawnedStructuredHost,
    claimOwner: string,
    claimEpoch: number,
    releasedStatus?: "unhosted" | "dead",
  ): Promise<() => void>;
  publishHost?(key: SessionKey, host: SpawnedStructuredHost): Promise<() => Promise<void>>;
  deliverFirst?(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held">;
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
      const identity = resumeIdentityForReceipt(registry, receipt);
      let claimed: AgentRegistryEntry | null = null;
      if (identity) {
        const entry = registry.snapshot().entries[sessionKeyId(identity.key)];
        if (entry?.structuredHost) {
          claimed = registry.claimStructuredHost(identity.key, {
            pid: process.pid,
            startIdentity: procBackend.processIdentity(process.pid),
          }, { allowUnhosted: true });
          if (!claimed?.claimOwner) {
            registry.failStructuredSpawn(receipt.launchId, reason);
            continue;
          }
        }
        try {
          await projectDeadStructuredSpawn(
            client,
            receipt,
            entry ?? { accountId: receipt.accountId, cwd: receipt.cwd },
            `structured-spawn-failed:${receipt.launchId}`,
            identity,
          );
        } catch (error) {
          if (claimed) releaseAdoptionClaim(registry, claimed, false);
          throw error;
        }
        if (claimed) releaseAdoptionClaim(registry, claimed, true);
      }
      registry.failStructuredSpawn(receipt.launchId, reason);
      continue;
    }
    if (receipt.state !== "path-pending" || !receipt.key || !receipt.artifactPath) continue;
    const entry = snapshot.entries[sessionKeyId(receipt.key)];
    const operation = await client.operationStatus(receipt.launchId);
    const status = operation?.receipt.status;
    if (status && FAILED_SPAWN_OPERATION_STATUSES.has(status)) {
      const stagedByAnotherOperation = typeof entry?.structuredHostOperationId === "string"
        && entry.structuredHostOperationId !== receipt.launchId;
      if (stagedByAnotherOperation) {
        registry.failSpawn(
          receipt.launchId,
          operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
        );
        continue;
      }
      const ownedByFailedOperation = entry?.structuredHostOperationId === receipt.launchId
        || (entry?.structuredHostOperationId === undefined && entry?.pendingAction === "spawn");
      let recoveryClaim: AgentRegistryEntry | null = null;
      let releasedOwnedHost = false;
      if (entry?.structuredHost && !ownedByFailedOperation) {
        recoveryClaim = registry.claimStructuredHost(receipt.key, {
          pid: process.pid,
          startIdentity: procBackend.processIdentity(process.pid),
        }, { allowUnhosted: true });
        if (!recoveryClaim?.claimOwner) {
          registry.failSpawn(
            receipt.launchId,
            operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
          );
          continue;
        }
      }
      try {
        const releasedHost = await releaseStructuredDeliveryHost(receipt.key);
        releasedOwnedHost = ownedByFailedOperation && releasedHost;
        if (entry?.structuredHost && ownedByFailedOperation && !releasedHost) {
          recoveryClaim = registry.claimStructuredHost(receipt.key, {
            pid: process.pid,
            startIdentity: procBackend.processIdentity(process.pid),
          }, { allowUnhosted: true });
          if (!recoveryClaim?.claimOwner) {
            throw new Error(`structured spawn failed host is still owned for ${receipt.launchId}`);
          }
        }
        if (entry) await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-failed:${receipt.launchId}`,
        );
      } catch (error) {
        const failedClaim = recoveryClaim ?? (releasedOwnedHost ? entry : null);
        if (failedClaim) releaseAdoptionClaim(registry, failedClaim, false);
        throw error;
      }
      registry.failStructuredSpawn(
        receipt.launchId,
        operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
      );
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
        await releaseStructuredDeliveryHost(receipt.key);
        await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-delivered-host-dead:${receipt.launchId}`,
        );
        const settled = registry.recoverDeliveredStructuredSpawn(receipt.launchId);
        if (settled.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${settled.code}`);
      }
      continue;
    }
    if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") continue;
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    const imageRefs = parseStructuredImageRefs(effect?.images ?? [], 16);
    if (prompt === null || effect?.conversationId !== receipt.conversationId || effect?.cwd !== receipt.cwd) {
      throw new Error(`structured spawn recovery is missing durable prompt admission for ${receipt.launchId}`);
    }
    if (imageRefs === null) throw new Error(`structured spawn recovery has invalid image refs for ${receipt.launchId}`);
    if (prompt.trim() || imageRefs.length) {
      const delivered = await enqueueStructuredMessage({
        path: receipt.artifactPath,
        conversationId: receipt.conversationId,
        clientMessageId: `spawn_${receipt.launchId}`,
        operationId: `spawn_message_${receipt.launchId}`,
        text: prompt,
        imageRefs,
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      if (!delivered?.ok) throw new Error(delivered?.error ?? `structured spawn recovery could not admit ${receipt.launchId}`);
      if (delivered.outcome === "held") continue;
      if (delivered.outcome !== "delivered") {
        await waitForStructuredInitialMessage(client, delivered.operationId);
        settleInitialMessageReservation(registry, receipt.launchId);
      }
    }
    await client.transitionOperation(receipt.launchId, "delivered");
    const finalized = registry.finalizeStructuredSpawn(receipt.launchId);
    if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
  }
}

function pendingColumns(engine: AgentEngine, eventCursor = 0, writerClaimEpoch = 0): StructuredHostColumns {
  return {
    kind: engine === "codex" ? "codex-app-server" : "claude-broker",
    endpoint: "stdio:pending",
    process: null,
    eventCursor,
    protocolVersion: null,
    writerClaimEpoch,
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

/** Viewer-managed role launches run autonomously behind prompt and tool
    fences, so a role spawn keeps the full-permission mode regardless of which
    capability lane admitted it; only a role-less agent-initiated spawn loses
    the bypass. */
export function structuredClaudePermissionMode(
  mode: string | null | undefined,
  context: StructuredClaudePermissionContext,
): string {
  if (!mode) return "default";
  if (mode !== "bypassPermissions") return mode;
  return !context.agentInitiated || context.operatorAuthenticated || context.roleSpawn ? mode : "default";
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
  const initialEventCursor = resumeSessionId
    ? input.registry.snapshot().entries[sessionKeyId({ engine: input.engine, sessionId: resumeSessionId })]?.structuredHost?.eventCursor
    : undefined;
  if (initialEventCursor !== undefined
    && (!Number.isSafeInteger(initialEventCursor) || initialEventCursor < 0)) {
    throw new Error("structured resume event cursor is invalid");
  }
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
      initialEventCursor,
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
    readOnly: profile.readOnly === true,
    model: profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    permissionMode: profile.permissionMode ?? "default",
    initialEventCursor,
    env,
  };
  return resumeSessionId
    ? await ClaudeStreamBrokerHost.adopt(resumeSessionId, options)
    : await ClaudeStreamBrokerHost.start({ ...options, ...(sessionId ? { sessionId } : {}) });
}

export function structuredResumeSessionId(
  input: Pick<StructuredSpawnInput, "receipt" | "registry">,
): string | null {
  return resumeIdentityForReceipt(input.registry, input.receipt)?.key.sessionId ?? null;
}

async function defaultBindHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: SpawnedStructuredHost,
  claimOwner: string,
  claimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
): Promise<() => void> {
  return key.engine === "codex"
    ? await bindCodexHostPersistence(registry, key, host as CodexAppServerHost, claimOwner, claimEpoch, releasedStatus)
    : await bindClaudeHostPersistence(registry, key, host as ClaudeStreamBrokerHost, claimOwner, claimEpoch, releasedStatus);
}

async function defaultDeliverFirst(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held"> {
  if (!input.prompt.trim() && !input.imageRefs?.length) return;
  const delivered = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: input.receipt.conversationId,
    clientMessageId: `spawn_${input.receipt.launchId}`,
    operationId: `spawn_message_${input.receipt.launchId}`,
    text: input.prompt,
    imageRefs: input.imageRefs,
  }, {
    client: () => input.client,
    registry: () => input.registry,
    enabled: () => true,
  });
  if (!delivered?.ok) throw new Error(delivered?.error ?? "structured spawn first-message delivery was unavailable");
  if (delivered.outcome === "held") return "held";
  if (delivered.outcome !== "delivered") {
    await waitForStructuredInitialMessage(input.client, delivered.operationId);
    settleInitialMessageReservation(input.registry, input.receipt.launchId);
  }
}

async function cleanupHost(host: SpawnedStructuredHost | null, binding: HostBinding): Promise<void> {
  await host?.release();
  let unregisterError: unknown = null;
  try {
    await binding.unregister();
  } catch (error) {
    unregisterError = error;
  }
  binding.stopPersistence();
  if (unregisterError) throw unregisterError;
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
  const resumeSessionId = structuredResumeSessionId(input);
  const resumeKey = resumeSessionId ? sessionKey(input.engine, resumeSessionId) : null;
  const resumeIdentity = resumeIdentityForReceipt(input.registry, input.receipt);
  let host: SpawnedStructuredHost | null = null;
  const binding: HostBinding = { stopPersistence: () => {}, unregister: async () => {} };
  let key: SessionKey | null = null;
  let adoptionClaim: AgentRegistryEntry | null = null;
  let adoptionClaimTransferred = false;
  let adoptionClaimContended = false;
  try {
    /* Bypass acceptance and project trust are staged in the managed home
       before runtime admission: no structured launch may ever wait at an
       interactive acceptance gate, whichever caller reached this point. */
    if (input.engine === "claude" && input.account.kind === "managed") {
      prepareManagedClaudeSpawnHome(input.account.home, input.spec.cwd);
    }
    const imageRefs = input.imageRefs ?? [];
    const content = input.prompt.trim() || imageRefs.length
      ? structuredContent(input.prompt, imageRefs)
      : null;
    await input.client.command({
      kind: "spawn",
      operationId,
      idempotencyKey: operationId,
      conversationId: input.receipt.conversationId,
      engine: input.engine,
      cwd: input.spec.cwd,
      prompt: content?.content.text ?? "",
      ...(content?.content.images.length ? { images: content.content.images } : {}),
      ...(content ? { contentDigest: content.contentDigest } : {}),
      accountId: input.account.accountId,
      parentConversationId: input.receipt.parentConversationId,
      ...(input.receipt.purpose === "resume-successor" ? { sessionId: structuredResumeSessionId(input) } : {}),
    });
    const capability = input.registry.rotateSpawnCapabilityForReceipt(input.receipt.launchId);
    const resumeEntry = resumeKey ? input.registry.snapshot().entries[sessionKeyId(resumeKey)] : null;
    if (resumeEntry?.structuredHost) {
      adoptionClaim = input.registry.claimStructuredHost(resumeKey!, processIdentity(), { allowUnhosted: true });
      if (!adoptionClaim?.claimOwner) {
        adoptionClaimContended = true;
        throw new Error("structured resume host claim is unavailable");
      }
    }
    host = await startHost(input, capability);
    const identity = hostIdentity(input.engine, host, input);
    key = identity.key;
    if (resumeKey && sessionKeyId(key) !== sessionKeyId(resumeKey)) {
      throw new Error("structured resume returned a different session identity");
    }
    const stagedClaimEpoch = adoptionClaim?.claimEpoch ?? 0;
    const stagedClaimOwner = adoptionClaim?.claimOwner ?? null;
    const staged = input.registry.stageStructuredSpawn(input.receipt.launchId, {
      key,
      artifactPath: identity.path,
      cwd: input.spec.cwd,
      accountId: input.account.accountId,
      launchProfile: input.spec.launchProfile,
      status: "unhosted",
      host: null,
      structuredHost: pendingColumns(
        input.engine,
        adoptionClaim?.structuredHost?.eventCursor ?? 0,
        stagedClaimEpoch,
      ),
      claimEpoch: stagedClaimEpoch,
      claimOwner: stagedClaimOwner,
      pendingAction: "spawn",
    });
    if (staged.kind === "conflict") throw new Error(`structured spawn registry conflict: ${staged.code}`);
    const claimed = adoptionClaim
      ? staged.entry
      : input.registry.claimStructuredHost(key, processIdentity(), { allowUnhosted: true });
    if (!claimed?.claimOwner) throw new Error("structured spawn host claim is unavailable");
    adoptionClaimTransferred = adoptionClaim !== null;
    binding.stopPersistence = await bindHost(input.registry, key, host, claimed.claimOwner, claimed.claimEpoch);
    binding.unregister = await publishHost(key, host);
    const initialMessage = await deliverFirst(input, identity.path);
    if (initialMessage === "held") {
      return {
        ok: true,
        target: null,
        path: identity.path,
        ...(input.engine === "claude"
          ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
          : {}),
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "queued",
        state: "path-pending",
      };
    }
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
    const failureReason = structuredSpawnFailureReason(error);
    await input.client.transitionOperation(operationId, "failed", {
      reason: failureReason,
    }).catch(() => {});
    if (!host && error instanceof StructuredHostAdoptionCleanupError) {
      host = error.host as SpawnedStructuredHost;
      if (resumeKey && adoptionClaim?.claimOwner) {
        key = resumeKey;
        binding.stopPersistence = await bindHost(
          input.registry,
          resumeKey,
          host,
          adoptionClaim.claimOwner,
          adoptionClaim.claimEpoch,
          "dead",
        );
      }
    }
    try {
      await cleanupHost(host, binding);
    } catch {
      throw error;
    }
    let failedEntry: AgentRegistryEntry | null = null;
    let failedIdentity = resumeIdentity;
    if (key) {
      const entry = input.registry.snapshot().entries[sessionKeyId(key)];
      if (entry) {
        failedEntry = entry;
        failedIdentity = { key, artifactPath: entry.artifactPath };
      }
    } else {
      if (resumeIdentity) {
        failedEntry = input.registry.snapshot().entries[sessionKeyId(resumeIdentity.key)] ?? null;
      }
    }
    if (typeof failedEntry?.structuredHostOperationId === "string"
      && failedEntry.structuredHostOperationId !== input.receipt.launchId) {
      failedIdentity = null;
    }
    let projectionSucceeded = true;
    if (failedIdentity && !adoptionClaimContended) {
      try {
        await projectDeadStructuredSpawn(
          input.client,
          input.receipt,
          failedEntry ?? { accountId: input.account.accountId, cwd: input.spec.cwd },
          `structured-spawn-failed:${input.receipt.launchId}`,
          failedIdentity,
        );
      } catch {
        projectionSucceeded = false;
      }
    }
    if (adoptionClaim && (!adoptionClaimTransferred || !projectionSucceeded)) {
      releaseAdoptionClaim(input.registry, adoptionClaim, projectionSucceeded);
    }
    if (projectionSucceeded) {
      if (key) {
        input.registry.failStructuredSpawn(input.receipt.launchId, failureReason);
      } else {
        input.registry.failSpawn(input.receipt.launchId, failureReason);
      }
    }
    throw error;
  }
}
