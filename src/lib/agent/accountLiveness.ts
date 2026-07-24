import { procBackend } from "@/lib/proc";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { AgentEngine } from "./cli";
import { sessionKeyId } from "./sessionKey";
import type { AgentRegistryEntry, ProcessIdentity, RegistryConversation, RegistryFile, SpawnReceipt } from "./registry";

export type ManagedAccountEngine = Extract<AgentEngine, "claude" | "codex">;

/** Entry statuses that claim an agent process is (or is about to be) hosted. */
const HOSTED_ENTRY_STATUSES = new Set<AgentRegistryEntry["status"]>(["starting", "live", "idle", "handoff"]);
/** Receipt states of a launch that has not reached a durable terminal state. */
const OPEN_RECEIPT_STATES = new Set<SpawnReceipt["state"]>(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);
/** Migration phases with nothing left in flight. */
const SETTLED_MIGRATION_PHASES = new Set(["committed", "rolled-back"]);
/**
 * Held-delivery states where the Viewer still owes the conversation a message.
 *
 * `held`/`assigned` are unconditionally in flight: the queued turn has not been
 * attempted yet. `delivery-uncertain` is conditional (issue #652): an attempt
 * started but its outcome is unknown, and once its owning migration has settled
 * and the conversation has no live host/receipt it can never resolve, so past a
 * recovery grace it stops counting as live and the reaper terminalizes it.
 */
const UNDELIVERED_DELIVERY_STATES = new Set(["held", "assigned", "delivery-uncertain"]);

/**
 * How long a launch may claim liveness without any probe-able process.
 *
 * A `starting` entry or receipt carries no host evidence yet, so nothing can be
 * probed while the launching request is still running. Past this bound the
 * launch is registry rot: it mirrors `STALE_STRUCTURED_SPAWN_TIMEOUT_MS`, the
 * window after which the reaper itself terminalizes an unproven structured
 * spawn, so blocker evaluation and the reaper agree on when a launch is dead.
 */
export const UNPROVEN_LAUNCH_GRACE_MS = 5 * 60_000;

export interface AccountLivenessOptions {
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
}

interface LivenessProbe {
  now(): number;
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
}

export function livenessProbe(options: AccountLivenessOptions = {}): LivenessProbe {
  return {
    now: options.now ?? (() => Date.now()),
    pidAlive: options.pidAlive ?? ((pid) => procBackend.pidAlive(pid)),
    processIdentity: options.processIdentity ?? ((pid) => procBackend.processIdentity(pid)),
  };
}

/** A recorded process is live only while its pid *and* its start identity hold. */
function identityAlive(identity: ProcessIdentity | null | undefined, probe: LivenessProbe): boolean {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  if (!probe.pidAlive(identity.pid)) return false;
  return identity.startIdentity === null || probe.processIdentity(identity.pid) === identity.startIdentity;
}

function withinGrace(timestamp: string | null | undefined, probe: LivenessProbe): boolean {
  const recordedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(recordedAt)) return false;
  return probe.now() - recordedAt < UNPROVEN_LAUNCH_GRACE_MS;
}

/**
 * A registry entry is live when its recorded host process answers a probe, or
 * when it is young enough that no host evidence exists yet. A hosted status
 * whose evidence is gone — a dead pane, a reused pid, a `starting` entry from a
 * pipeline that ended days ago — is rot and owns nothing.
 */
export function entryIsLive(entry: AgentRegistryEntry, probe: LivenessProbe): boolean {
  if (!HOSTED_ENTRY_STATUSES.has(entry.status)) return false;
  if (identityAlive(entry.host?.agent, probe) || identityAlive(entry.host?.panePid, probe)) return true;
  if (identityAlive(entry.structuredHost?.process ?? null, probe)) return true;
  return withinGrace(entry.updatedAt, probe);
}

/**
 * An open launch receipt is live while its admission owner, its verified host,
 * or the entry it settled into is live — otherwise only inside the unproven
 * launch grace window.
 */
export function receiptIsLive(file: RegistryFile, receipt: SpawnReceipt, probe: LivenessProbe): boolean {
  if (!OPEN_RECEIPT_STATES.has(receipt.state)) return false;
  if (identityAlive(receipt.admissionOwner, probe)) return true;
  if (identityAlive(receipt.verifiedHost?.agent, probe) || identityAlive(receipt.pane?.panePid, probe)) return true;
  const entry = receipt.key ? file.entries[sessionKeyId(receipt.key)] : undefined;
  if (entry && entryIsLive(entry, probe)) return true;
  return withinGrace(receipt.createdAt, probe);
}

function conversationOwnsPath(conversation: RegistryConversation, artifactPath: string): boolean {
  return conversation.generations.some((generation) => generation.path === artifactPath)
    || conversation.continuityPaths.includes(artifactPath);
}

/** Canonical id behind a durable redirect, cycle-guarded. Mirrors the registry's
    own alias walk so a receipt written before adoption still names its owner. */
function canonicalId(file: RegistryFile, id: ViewerConversationId): ViewerConversationId {
  const seen = new Set<ViewerConversationId>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = file.conversationAliases[current];
    if (!next) return current;
    current = next;
  }
  return current;
}

/**
 * The four kinds of state that make a conversation genuinely current on its
 * account (issue #643): an active registered host, an in-flight launch/resume
 * receipt (the queued turn), a migration that has not settled, and a held
 * delivery the Viewer still owes it.
 *
 * A `busy` turn is deliberately not evidence on its own: a turn only runs on a
 * host, so a transcript whose tail was interrupted stays `busy` forever after
 * its agent dies. The host probe above already covers every turn that is
 * really running.
 */
export function conversationIsLive(
  file: RegistryFile,
  conversation: RegistryConversation,
  liveEntryPaths: ReadonlySet<string>,
  probe: LivenessProbe,
): boolean {
  const generation = conversation.generations.at(-1);
  if (generation && identityAlive(generation.host?.tmuxHost?.agent, probe)) return true;
  for (const artifactPath of liveEntryPaths) {
    if (conversationOwnsPath(conversation, artifactPath)) return true;
  }
  if (conversation.migration && !SETTLED_MIGRATION_PHASES.has(conversation.migration.phase)) return true;
  const owns = (id: ViewerConversationId) => canonicalId(file, id) === conversation.id;
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (!UNDELIVERED_DELIVERY_STATES.has(delivery.state)) continue;
    if (!owns(delivery.conversationId) && !owns(delivery.runtimeConversationId)) continue;
    /* held/assigned: the queued turn has not been attempted — always current. */
    if (delivery.state !== "delivery-uncertain") return true;
    /* delivery-uncertain (issue #652): reaching here means this conversation
       already has no live host and a settled migration (the checks above
       returned otherwise). The attempt can still recover only while its grace
       holds; a live receipt below is the one remaining in-flight signal, so a
       grace-expired uncertain delivery contributes nothing on its own. */
    if (withinGrace(delivery.createdAt, probe)) return true;
  }
  for (const receipt of Object.values(file.receipts)) {
    if (!owns(receipt.conversationId)) continue;
    if (receiptIsLive(file, receipt, probe)) return true;
  }
  return false;
}

/** Artifact paths held by a live registry entry, computed once per evaluation. */
function liveEntryPaths(file: RegistryFile, engine: ManagedAccountEngine, probe: LivenessProbe): Set<string> {
  const paths = new Set<string>();
  for (const entry of Object.values(file.entries)) {
    if (entry.key.engine !== engine || !entryIsLive(entry, probe)) continue;
    paths.add(entry.artifactPath);
  }
  return paths;
}

/** True when a live session (entry or open launch receipt) owns the account. */
export function accountHasLiveSessions(
  file: RegistryFile,
  engine: ManagedAccountEngine,
  accountId: string,
  options: AccountLivenessOptions = {},
): boolean {
  const probe = livenessProbe(options);
  /* A launch that has not resolved its account yet (accountId null) can still
     land on this home, so it counts for every managed account of the engine. */
  const owned = (candidate: string | null) => candidate === accountId || candidate === null;
  for (const entry of Object.values(file.entries)) {
    if (entry.key.engine !== engine || !owned(entry.accountId)) continue;
    if (entryIsLive(entry, probe)) return true;
  }
  for (const receipt of Object.values(file.receipts)) {
    if (receipt.engine !== engine || !owned(receipt.accountId)) continue;
    if (receiptIsLive(file, receipt, probe)) return true;
  }
  return false;
}

/**
 * Held deliveries that can never resolve and no longer keep any conversation
 * current (issue #652): a `delivery-uncertain` attempt past its recovery grace
 * whose canonical conversation is not live — its owning migration has settled
 * and it owns no live host, entry, or receipt. This is the exact set that
 * `conversationIsLive` has already stopped counting as live, surfaced so the
 * reaper can terminalize it durably and blocker evaluation and the reaper agree
 * on which deliveries are dead.
 */
export function staleUndeliverableHeldDeliveryIds(
  file: RegistryFile,
  options: AccountLivenessOptions = {},
): string[] {
  const probe = livenessProbe(options);
  const pathsByEngine = new Map<ManagedAccountEngine, Set<string>>();
  const livePathsFor = (engine: ManagedAccountEngine): Set<string> => {
    let paths = pathsByEngine.get(engine);
    if (!paths) {
      paths = liveEntryPaths(file, engine, probe);
      pathsByEngine.set(engine, paths);
    }
    return paths;
  };
  const ids: string[] = [];
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (delivery.state !== "delivery-uncertain") continue;
    if (withinGrace(delivery.createdAt, probe)) continue;
    const conversation = file.conversations[canonicalId(file, delivery.conversationId)];
    if (!conversation) continue;
    if (conversationIsLive(file, conversation, livePathsFor(conversation.engine), probe)) continue;
    ids.push(delivery.id);
  }
  return ids;
}

/** Conversations whose latest generation is genuinely live on the account. */
export function liveAccountConversationIds(
  file: RegistryFile,
  engine: ManagedAccountEngine,
  accountId: string,
  options: AccountLivenessOptions = {},
): ViewerConversationId[] {
  const probe = livenessProbe(options);
  const paths = liveEntryPaths(file, engine, probe);
  const live: ViewerConversationId[] = [];
  for (const conversation of Object.values(file.conversations)) {
    if (conversation.engine !== engine || conversation.generations.at(-1)?.accountId !== accountId) continue;
    if (conversationIsLive(file, conversation, paths, probe)) live.push(conversation.id);
  }
  return live;
}
