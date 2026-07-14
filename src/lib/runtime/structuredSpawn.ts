import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentEngine, ResumeSpec } from "@/lib/agent/cli";
import type { AgentRegistry, SpawnReceipt, StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, type SessionKey } from "@/lib/agent/sessionKey";
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
    const settled = input.registry.settleSpawn(input.receipt.launchId, {
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
    if (settled.kind === "conflict") throw new Error(`structured spawn registry conflict: ${settled.code}`);
    const claimed = input.registry.claimStructuredHost(key, processIdentity(), { allowUnhosted: true });
    if (!claimed?.claimOwner) throw new Error("structured spawn host claim is unavailable");
    binding.stopPersistence = await bindHost(input.registry, key, host, claimed.claimOwner, claimed.claimEpoch);
    binding.unregister = await publishHost(key, host);
    await deliverFirst(input, identity.path);
    await input.client.transitionOperation(operationId, "delivered");
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
      input.registry.markUnhosted(key);
      input.registry.invalidateSpawnHost(input.receipt.launchId, error instanceof Error ? error.message : "structured spawn failed");
    }
    else input.registry.failSpawn(input.receipt.launchId, "structured spawn failed before host binding");
    throw error;
  }
}
