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

import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeHostClient } from "./client";
import type { EngineHost, HostState } from "./engineHost";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";
import { publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";

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
    if (receipt.state !== "path-pending" || !receipt.key || !receipt.artifactPath) continue;
    const entry = snapshot.entries[sessionKeyId(receipt.key)];
    if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") continue;
    const operation = await client.operationStatus(receipt.launchId);
    if (operation?.receipt.status !== "delivered") {
      const effect = spawnEffects.get(receipt.launchId);
      const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
      if (!prompt || effect?.conversationId !== receipt.conversationId || effect?.cwd !== receipt.cwd) {
        throw new Error(`structured spawn recovery is missing durable prompt admission for ${receipt.launchId}`);
      }
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
      await client.transitionOperation(receipt.launchId, "delivered");
    }
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

export function structuredClaudePermissionMode(mode: string | null | undefined): string {
  return !mode || mode === "bypassPermissions" ? "default" : mode;
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
  if (input.engine === "codex") {
    return await CodexAppServerHost.start({
      cwd: input.spec.cwd,
      codexHome: input.account.home,
      fileAuthCredentials: input.account.kind === "managed",
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      allowSubagents: profile.allowSubagents,
      sandbox: profile.readOnly ? "read-only" : "danger-full-access",
      approvalPolicy: profile.permissionMode ?? undefined,
      env,
    });
  }
  const sessionId = input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl") : undefined;
  return await ClaudeStreamBrokerHost.start({
    cwd: input.spec.cwd,
    ...(sessionId ? { sessionId } : {}),
    claudeConfigDir: input.account.home,
    claudeProjectsDir: input.account.transcriptRoot,
    spawnPolicyBaseSettingsPath: structuredClaudeSpawnPolicyBaseSettingsPath(input.account),
    allowSubagents: profile.allowSubagents,
    model: profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    permissionMode: structuredClaudePermissionMode(profile.permissionMode),
    env,
  });
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
  let binding: HostBinding = { stopPersistence: () => {}, unregister: async () => {} };
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
    await cleanupHost(host, binding);
    if (key) {
      input.registry.failStructuredSpawn(input.receipt.launchId, error instanceof Error ? error.message : "structured spawn failed");
      const entry = input.registry.snapshot().entries[sessionKeyId(key)];
      if (entry) {
        await input.client.append({
          scope: { type: "session", id: input.receipt.conversationId },
          kind: "session-status",
          producer: {
            kind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
            eventKey: `structured-spawn-failed:${input.receipt.launchId}`,
          },
          payload: {
            conversationId: input.receipt.conversationId,
            sessionKey: key,
            hostKind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
            host: "dead",
            turn: "idle",
            provenance: "structured",
            accountId: entry.accountId,
            parentConversationId: input.receipt.parentConversationId,
            cwd: entry.cwd,
            artifactPath: entry.artifactPath,
            capabilities: { steer: key.engine === "codex", structuredAttention: true },
            activeTurnId: null,
          },
        }).catch(() => {});
      }
    }
    else input.registry.failSpawn(input.receipt.launchId, "structured spawn failed before host binding");
    throw error;
  }
}
