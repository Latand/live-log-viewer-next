import type { AccountContext } from "@/lib/accounts/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { resolveContinuityAccount } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { ResumeSpec } from "@/lib/agent/cli";
import { agentRegistry, type AgentRegistry, type ProcessIdentity, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { cachedLimitsProvenance } from "@/lib/limits";
import { captureProcessIdentity, processIdentityMayOwn } from "@/lib/processIdentity";
import { derivedSpawnTitle, durableSemanticTitle } from "@/lib/title";

import { accountPark, type AccountPark } from "./accountPark";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { reconcileDeadStructuredRegistryHost } from "./registry";
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
  /** Set when the live host handed back cannot accept a turn yet because the
      provider has parked its account (#611). The host is healthy and keeps its
      claim; what it cannot do is start a turn before `hold.until`. A caller
      that can wait must hold the message rather than enqueue it — a queued
      item nobody watches is exactly the stall this reports. When
      `hold.resetKnown` is false the provider named no reset, so `until` is the
      bounded recheck the park reports instead of a deadline: the caller waits
      the same way, and says the reset is unknown while it does. */
  hold?: AccountPark | null;
}

/** Resolves whether the account behind a live host is parked by the provider.
    Injectable so a test states the provider's answer instead of reaching for
    the machine's limits cache. */
export type StructuredHostParkResolver = (
  engine: "claude" | "codex",
  accountId: string | null,
  snapshot: Pick<RegistryFile, "quotaObservations">,
) => AccountPark | null;

const defaultParkResolver: StructuredHostParkResolver = (engine, accountId, snapshot) => accountPark(engine, accountId, {
  quotaObservation: (forEngine, id) => snapshot.quotaObservations[forEngine]?.[id],
  limitsProvenance: cachedLimitsProvenance,
});

export interface StructuredRecoveryDependencies {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  transport?: () => "tmux" | "structured";
  resolveAccount?: (engine: "claude" | "codex", accountId: string | null, project: string | null) => AccountContext;
  spawn?: typeof spawnStructuredConversation;
  processIdentity?: () => ProcessIdentity;
  requestDeliveryDrain?: () => void;
  park?: StructuredHostParkResolver;
  ownership?: {
    operationId: string;
    revision: number;
    owns: () => Promise<boolean>;
    releaseHost: (key: SessionKey) => Promise<boolean>;
  };
}

class StructuredRecoverySupersededError extends Error {
  constructor() {
    super("structured recovery operation is superseded");
    this.name = "StructuredRecoverySupersededError";
  }
}

interface RecoveryCandidate {
  conversationId: ViewerConversationId;
  engine: "claude" | "codex";
  key: SessionKey;
  path: string;
  accountId: string | null;
  /** The project this conversation's work belongs to, so a resume that has to
      CHOOSE an account draws from that project's pool (#1279). */
  project: string | null;
  parentConversationId: ViewerConversationId | null;
  spec: ResumeSpec;
  /** The registered host is process-alive, claim-owned and not terminal. */
  hostLive: boolean;
  /** The provider limit parking that live host's account, if any. */
  park: AccountPark | null;
  /** A live host the provider has NOT parked: ready to receive a turn. */
  publishReady: boolean;
}

export function structuredHostProcessAlive(identity: ProcessIdentity | null): boolean {
  return identity ? processIdentityMayOwn(identity) : false;
}

const recoveryStore = globalThis as typeof globalThis & {
  __llvStructuredRecovery?: Map<string, Promise<StructuredRecoveryResult | null>>;
};
const recoveries = recoveryStore.__llvStructuredRecovery ??= new Map();

function candidateFor(
  registry: AgentRegistry,
  request: StructuredRecoveryRequest,
  durableProfileWins = false,
  park: StructuredHostParkResolver = defaultParkResolver,
): RecoveryCandidate | null {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as `conversation_${string}`)
    : registry.conversationForPath(request.path);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const snapshot = registry.readOnlySnapshot();
  const entry = snapshot.entries[sessionKeyId(key)];
  if (entry?.host) return null;
  /* Structured cutover covers every registered transcript. Historical Codex
     and Claude sessions reach their pane-less host through this recovery path,
     including conversations that predate registry entries. A verified live
     tmux owner returned above keeps ownership until that process exits. */
  const terminal = entry?.status === "dead" || entry?.status === "unhosted";
  const hostLive = Boolean(structuredHostProcessAlive(entry?.structuredHost?.process ?? null)
    && entry?.claimOwner
    && entry.pendingAction === null
    && !terminal);
  /* #611: a process-alive claim-owned host whose account the provider has
     parked cannot accept a turn, however alive it looks. Readiness says so
     here, so the enqueue that would sit `queued` past the parked window never
     happens; the host itself is untouched and keeps its claim. An exhaustion
     the provider named no reset for withholds publication the same way: it is
     reported with the bounded recheck the park carries, so the caller waits a
     wait that ends rather than enqueuing into a spent account. */
  const hostAccountId = entry?.accountId ?? generation.accountId ?? null;
  const hostPark = hostLive ? park(conversation.engine, hostAccountId, snapshot) : null;
  const publishReady = hostLive && !hostPark;
  const inheritedProfile = emptyLaunchProfile(durableProfileWins ? {
    ...(entry?.launchProfile ?? {}),
    ...generation.launchProfile,
    cwd: generation.launchProfile.cwd || entry?.launchProfile?.cwd || entry?.cwd,
  } : {
    ...generation.launchProfile,
    ...(entry?.launchProfile ?? {}),
    cwd: entry?.launchProfile?.cwd || generation.launchProfile.cwd || entry?.cwd,
  });
  const inheritedTitle = durableSemanticTitle(generation.launchProfile.title, 120)
    ?? durableSemanticTitle(entry?.launchProfile?.title, 120);
  const profile = emptyLaunchProfile({
    ...inheritedProfile,
    title: inheritedTitle ?? derivedSpawnTitle(
      "recovery",
      inheritedProfile.goal?.objective ?? inheritedProfile.cwd,
      "Conversation recovery",
    ),
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
    accountId: generation.accountId ?? entry?.accountId ?? null,
    /* A getter, because deriving a project can read the disk and most calls
       here never reach the account resolution — a live host is handed straight
       back. The MERGED profile, not the generation's own: a conversation the
       Viewer ADOPTED rather than spawned carries an empty generation profile,
       and the registry entry's durable one, folded in above, is the only thing
       left naming a project or a cwd to derive one from. */
    get project() { return conversationProjectKey(conversation.projectOwnership, profile); },
    parentConversationId: parentConversationId === conversation.id ? null : parentConversationId,
    spec: {
      command: "",
      cwd: profile.cwd,
      windowName: "structured-resume",
      engine: conversation.engine,
      "transcript": generation.path,
      launchProfile: profile,
    },
    hostLive,
    park: hostPark,
    publishReady,
  };
}

/** The live host as recovery hands it back. A publish-ready host is returned
    exactly as before; a host that is alive but not publish-ready is returned
    with the park that makes it unready, so the caller can wait for it instead
    of enqueuing into a host that cannot start the turn. */
function liveHostResult(candidate: RecoveryCandidate): StructuredRecoveryResult {
  return {
    target: null,
    path: candidate.path,
    conversationId: candidate.conversationId,
    spawned: false,
    ...(candidate.publishReady ? {} : { hold: candidate.park }),
  };
}

async function recoverCandidate(
  request: StructuredRecoveryRequest,
  dependencies: StructuredRecoveryDependencies,
  registry: AgentRegistry,
  candidate: RecoveryCandidate,
): Promise<StructuredRecoveryResult | null> {
  const ownership = dependencies.ownership;
  const assertOwnership = async (): Promise<void> => {
    if (ownership && !await ownership.owns()) throw new StructuredRecoverySupersededError();
  };
  const owner = (dependencies.processIdentity ?? (() => captureProcessIdentity(process.pid)))();
  return registry.withOperationLock(candidate.key, owner, async () => {
    await assertOwnership();
    const park = dependencies.park ?? defaultParkResolver;
    let current = candidateFor(registry, request, Boolean(ownership), park);
    if (!current) return null;
    /* A host wrapper can disappear before its live Viewer writer releases the
       claim. Retire that claim only through the registry's PID/start-identity
       check; a live or unverifiable host remains fenced. */
    if (!current.hostLive) {
      reconcileDeadStructuredRegistryHost(registry, current.conversationId, current.key);
      current = candidateFor(registry, request, Boolean(ownership), park);
      if (!current) return null;
    }
    if (current.hostLive) {
      /* A parked host is reported held, never replaced: the park belongs to the
         account, so a successor would start parked too, and terminating this
         one would throw away the very continuation the caller is trying to
         reach. An explicit ownership takeover still reseats. */
      if (!ownership) return liveHostResult(current);
      await ownership.releaseHost(current.key);
      await assertOwnership();
      registry.terminateStructuredHost(current.key);
      await assertOwnership();
      current = candidateFor(registry, request, true, park);
      if (!current) return null;
    }
    const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
    if (!client) throw new Error("structured recovery runtime host is unavailable");
    /* #1279: a resume whose conversation RECORDS an account continues on it —
       the session lives in that home and nothing is being chosen. A resume of a
       conversation that records none was choosing one, silently, from engine
       routing; that half now asks the project's pool and its capacity like
       every other automatic pick, and refuses before the spawn reservation
       exists when the binding record cannot be read. */
    const account = (dependencies.resolveAccount ?? resolveContinuityAccount)(
      current.engine,
      current.accountId,
      current.project,
    );
    const begun = registry.beginSpawnRequest({
      engine: current.engine,
      cwd: current.spec.cwd,
      transport: "structured",
      accountId: account.accountId,
      conversationId: current.conversationId,
      parentConversationId: current.parentConversationId,
      purpose: "resume-successor",
      origin: { kind: "successor" },
      expectedArtifactPath: current.path,
      launchProfile: current.spec.launchProfile,
    });
    if (begun.kind !== "created") throw new Error("structured recovery reservation is unavailable");
    try {
      await assertOwnership();
    } catch (error) {
      registry.failSpawn(begun.receipt.launchId, "structured recovery operation was superseded");
      throw error;
    }
    const response = await (dependencies.spawn ?? spawnStructuredConversation)({
      engine: current.engine,
      receipt: begun.receipt,
      spec: current.spec,
      account,
      "prompt": "",
      registry,
      client,
    });
    if (!response.ok || !response.path) throw new Error("structured recovery host did not publish its transcript");
    try {
      await assertOwnership();
    } catch (error) {
      await ownership?.releaseHost(current.key);
      registry.terminateStructuredHost(current.key);
      throw error;
    }
    (dependencies.requestDeliveryDrain ?? requestAccountMigrationTick)();
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
  if (dependencies.ownership && !await dependencies.ownership.owns()) {
    throw new StructuredRecoverySupersededError();
  }
  const candidate = candidateFor(
    registry,
    request,
    Boolean(dependencies.ownership),
    dependencies.park ?? defaultParkResolver,
  );
  if (!candidate) return null;
  const recoveryKey = dependencies.ownership
    ? `${registry.filename}:${candidate.conversationId}:${dependencies.ownership.operationId}:${dependencies.ownership.revision}`
    : `${registry.filename}:${candidate.conversationId}`;
  const pending = recoveries.get(recoveryKey);
  if (pending) return pending;
  if (candidate.hostLive && !dependencies.ownership) return liveHostResult(candidate);
  const recovery = recoverCandidate(request, dependencies, registry, candidate);
  recoveries.set(recoveryKey, recovery);
  try {
    return await recovery;
  } finally {
    if (recoveries.get(recoveryKey) === recovery) recoveries.delete(recoveryKey);
  }
}
