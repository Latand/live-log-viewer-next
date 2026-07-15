import type { AccountContext } from "@/lib/accounts/contracts";
import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { ResumeSpec } from "@/lib/agent/cli";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { spawnStructuredConversation } from "./structuredSpawn";
import { spawnTransport } from "./spawnTransport";

export interface StructuredRecoveryRequest {
  path: string;
  conversationId?: string | null;
}

export interface StructuredRecoveryResult {
  target: null;
  path: string;
  conversationId: ViewerConversationId;
  spawned: boolean;
}

export interface StructuredRecoveryDependencies {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  transport?: () => "tmux" | "structured";
  resolveAccount?: (engine: "claude" | "codex", accountId: string | null) => AccountContext;
  spawn?: typeof spawnStructuredConversation;
  processIdentity?: () => { pid: number; startIdentity: string | null };
}

interface RecoveryCandidate {
  conversationId: ViewerConversationId;
  engine: "claude" | "codex";
  key: SessionKey;
  path: string;
  accountId: string | null;
  parentConversationId: ViewerConversationId | null;
  spec: ResumeSpec;
  publishReady: boolean;
}

const recoveryStore = globalThis as typeof globalThis & {
  __llvStructuredRecovery?: Map<string, Promise<StructuredRecoveryResult | null>>;
};
const recoveries = recoveryStore.__llvStructuredRecovery ??= new Map();

function candidateFor(
  registry: AgentRegistry,
  request: StructuredRecoveryRequest,
): RecoveryCandidate | null {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as `conversation_${string}`)
    : registry.conversationForPath(request.path);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const snapshot = registry.snapshot();
  const entry = snapshot.entries[sessionKeyId(key)];
  if (!entry || entry.host) return null;
  const structuredReceipt = Object.values(snapshot.receipts).some((receipt) =>
    receipt.transport === "structured"
      && receipt.state === "completed"
      && registry.canonicalConversationId(receipt.conversationId) === conversation.id);
  if (!entry.structuredHost && !structuredReceipt) return null;
  const terminal = entry.status === "dead" || entry.status === "unhosted";
  const publishReady = Boolean(entry.structuredHost?.process
    && entry.claimOwner
    && entry.pendingAction === null
    && !terminal);
  const profile = emptyLaunchProfile({
    ...generation.launchProfile,
    ...(entry.launchProfile ?? {}),
    cwd: entry.launchProfile?.cwd || generation.launchProfile.cwd || entry.cwd,
  });
  const recordedParent = snapshot.lineageEdges[conversation.id]?.parentConversationId
    ?? profile.parentConversationId;
  const parentConversationId = recordedParent && recordedParent !== conversation.id
    ? registry.canonicalConversationId(recordedParent)
    : null;
  return {
    conversationId: conversation.id,
    engine: conversation.engine,
    key,
    path: generation.path,
    accountId: generation.accountId ?? entry.accountId,
    parentConversationId: parentConversationId === conversation.id ? null : parentConversationId,
    spec: {
      command: "",
      cwd: profile.cwd,
      windowName: "structured-resume",
      engine: conversation.engine,
      transcript: generation.path,
      launchProfile: profile,
    },
    publishReady,
  };
}

async function recoverCandidate(
  request: StructuredRecoveryRequest,
  dependencies: StructuredRecoveryDependencies,
  registry: AgentRegistry,
  candidate: RecoveryCandidate,
): Promise<StructuredRecoveryResult | null> {
  const owner = (dependencies.processIdentity ?? (() => ({
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
  })))();
  return registry.withOperationLock(candidate.key, owner, async () => {
    const current = candidateFor(registry, request);
    if (!current) return null;
    if (current.publishReady) {
      return {
        target: null,
        path: current.path,
        conversationId: current.conversationId,
        spawned: false,
      };
    }
    const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
    if (!client) throw new Error("structured recovery runtime host is unavailable");
    const account = (dependencies.resolveAccount ?? accountManager.resolveSpawn)(current.engine, current.accountId);
    const begun = registry.beginSpawnRequest({
      engine: current.engine,
      cwd: current.spec.cwd,
      transport: "structured",
      accountId: account.accountId,
      conversationId: current.conversationId,
      parentConversationId: current.parentConversationId,
      purpose: "resume-successor",
      expectedArtifactPath: current.path,
      launchProfile: current.spec.launchProfile,
    });
    if (begun.kind !== "created") throw new Error("structured recovery reservation is unavailable");
    const response = await (dependencies.spawn ?? spawnStructuredConversation)({
      engine: current.engine,
      receipt: begun.receipt,
      spec: current.spec,
      account,
      prompt: "",
      registry,
      client,
    });
    if (!response.ok || !response.path) throw new Error("structured recovery host did not publish its transcript");
    return {
      target: null,
      path: response.path,
      conversationId: current.conversationId,
      spawned: true,
    };
  });
}

export async function recoverDeadStructuredConversation(
  request: StructuredRecoveryRequest,
  dependencies: StructuredRecoveryDependencies = {},
): Promise<StructuredRecoveryResult | null> {
  if ((dependencies.transport ?? spawnTransport)() !== "structured") return null;
  const registry = dependencies.registry ?? agentRegistry();
  const candidate = candidateFor(registry, request);
  if (!candidate) return null;
  const recoveryKey = `${registry.filename}:${candidate.conversationId}`;
  const pending = recoveries.get(recoveryKey);
  if (pending) return pending;
  if (candidate.publishReady) {
    return {
      target: null,
      path: candidate.path,
      conversationId: candidate.conversationId,
      spawned: false,
    };
  }
  const recovery = recoverCandidate(request, dependencies, registry, candidate);
  recoveries.set(recoveryKey, recovery);
  try {
    return await recovery;
  } finally {
    if (recoveries.get(recoveryKey) === recovery) recoveries.delete(recoveryKey);
  }
}
