import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentEngine, ResumeSpec } from "@/lib/agent/cli";
import type { AgentRegistry, AgentRegistryEntry, SpawnReceipt, StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { procBackend } from "@/lib/proc";

import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeHostClient } from "./client";
import { StructuredHostAdoptionCleanupError, type EngineHost, type HostState } from "./engineHost";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";
import { publishStructuredDeliveryHost, releaseStructuredDeliveryHost } from "./structuredDeliveryController";

export type SpawnedStructuredHost = EngineHost & {
  identity: { threadId: string; path: string | null } | { sessionId: string };
  onStateChange(listener: (state: HostState) => void): () => void;
};

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
      state: "settled",
    };
  } catch (error) {
    await input.client.transitionOperation(operationId, "failed", {
      reason: error instanceof Error ? error.message.slice(0, 240) : "structured spawn failed",
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
        input.registry.failStructuredSpawn(input.receipt.launchId, error instanceof Error ? error.message : "structured spawn failed");
      } else {
        input.registry.failSpawn(input.receipt.launchId, "structured spawn failed before host binding");
      }
    }
    throw error;
  }
}
