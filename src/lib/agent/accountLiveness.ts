import fs from "node:fs";

import { procBackend } from "@/lib/proc";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import type { AgentEngine } from "./cli";
import { sessionKeyId } from "./sessionKey";
import type { AgentRegistryEntry, ProcessIdentity, RegistryConversation, RegistryFile, SpawnReceipt } from "./registry";

export type ManagedAccountEngine = Extract<AgentEngine, "claude" | "codex">;

export type SpawnAccountAdmissionEvidence = {
  enabled: boolean;
  authentication: "authenticated" | "failed" | "unknown";
  limits: "available" | "exhausted" | "unknown";
  stale: boolean;
  retryAt: string | null;
};

export type SpawnAccountAdmission =
  | { kind: "admissible"; basis: "current" | "last-known"; stale: boolean; retryAt: null }
  | { kind: "retry-at"; reason: "hard-limit"; stale: boolean; retryAt: string }
  | { kind: "unavailable"; reason: "auth-failed" | "hard-limit" | "account-disabled"; stale: boolean; retryAt: null };

const queuedPinnedSpawnBootstrap = globalThis as typeof globalThis & {
  __llvQueuedPinnedSpawnBootstrap?: boolean;
  __llvQueuedPinnedSpawnWakeups?: Map<string, ReturnType<typeof setTimeout>>;
};

const QUEUED_PIN_WAKE_RETRY_MS = 30_000;
const QUEUED_PIN_WAKE_MAX_TIMER_MS = 2_147_000_000;

function queuedPinnedSpawnRetryAt(filename: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(`${filename}.queued-pinned-spawns.json`, "utf8")) as {
      records?: Record<string, { retryAt?: unknown }>;
    };
    const deadlines = Object.values(parsed.records ?? {}).flatMap((record) => {
      const deadline = typeof record.retryAt === "string" ? Date.parse(record.retryAt) : Number.NaN;
      return Number.isFinite(deadline) ? [deadline] : [];
    });
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  } catch {
    return null;
  }
}

function queuedPinnedSpawnDrainUrl(): string {
  const configured = process.env.PORT?.trim() ?? "8898";
  const port = /^\d{1,5}$/.test(configured) ? configured : "8898";
  return `http://127.0.0.1:${port}/api/spawn?drainQueuedPinnedSpawns=1`;
}

export function scheduleQueuedPinnedSpawnWake(filename: string): void {
  if (process.env.NODE_ENV === "test") return;
  const wakeups = queuedPinnedSpawnBootstrap.__llvQueuedPinnedSpawnWakeups ??= new Map();
  const existing = wakeups.get(filename);
  if (existing) clearTimeout(existing);
  wakeups.delete(filename);
  const retryAt = queuedPinnedSpawnRetryAt(filename);
  if (retryAt === null) return;
  const delay = Math.min(Math.max(0, retryAt - Date.now()), QUEUED_PIN_WAKE_MAX_TIMER_MS);
  const timer = setTimeout(() => {
    wakeups.delete(filename);
    void fetch(queuedPinnedSpawnDrainUrl(), {
      headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`queued pinned spawn wake returned ${response.status}`);
      })
      .catch((error) => console.error("[spawn] queued pinned launch wake failed", { error }))
      .finally(() => {
        const next = queuedPinnedSpawnRetryAt(filename);
        if (next !== null && next <= Date.now()) {
          const retry = setTimeout(() => scheduleQueuedPinnedSpawnWake(filename), QUEUED_PIN_WAKE_RETRY_MS);
          retry.unref?.();
          wakeups.set(filename, retry);
        } else {
          scheduleQueuedPinnedSpawnWake(filename);
        }
      });
  }, delay);
  timer.unref?.();
  wakeups.set(filename, timer);
}

if (process.env.NEXT_RUNTIME === "nodejs"
  && process.env.NODE_ENV !== "test"
  && process.env.NEXT_PHASE !== "phase-production-build"
  && !queuedPinnedSpawnBootstrap.__llvQueuedPinnedSpawnBootstrap) {
  queuedPinnedSpawnBootstrap.__llvQueuedPinnedSpawnBootstrap = true;
  queueMicrotask(() => {
    void import("./registry")
      .then(({ agentRegistry }) => scheduleQueuedPinnedSpawnWake(agentRegistry().filename))
      .catch((error) => console.error("[spawn] queued pinned launch bootstrap failed", { error }));
  });
}

function futureRetryAt(value: string | null, now: number): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? new Date(parsed).toISOString() : null;
}

/**
 * Classifies spawn evidence without turning an observation gap into a launch
 * outage. Unknown stale evidence remains the last known state. Only explicit
 * account disablement, failed authentication, or exhausted quota closes
 * admission; a future hard-limit reset makes that closure queueable.
 */
export function classifySpawnAccountAdmission(
  evidence: SpawnAccountAdmissionEvidence,
  now = Date.now(),
): SpawnAccountAdmission {
  if (!evidence.enabled) {
    return { kind: "unavailable", reason: "account-disabled", stale: evidence.stale, retryAt: null };
  }
  if (evidence.authentication === "failed") {
    return { kind: "unavailable", reason: "auth-failed", stale: evidence.stale, retryAt: null };
  }
  if (evidence.limits === "exhausted") {
    const retryAt = futureRetryAt(evidence.retryAt, now);
    return retryAt
      ? { kind: "retry-at", reason: "hard-limit", stale: evidence.stale, retryAt }
      : { kind: "unavailable", reason: "hard-limit", stale: evidence.stale, retryAt: null };
  }
  return {
    kind: "admissible",
    basis: evidence.stale || evidence.authentication === "unknown" ? "last-known" : "current",
    stale: evidence.stale,
    retryAt: null,
  };
}

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

export interface LivenessProbe {
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
export function identityAlive(identity: ProcessIdentity | null | undefined, probe: LivenessProbe): boolean {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  if (!probe.pidAlive(identity.pid)) return false;
  return identity.startIdentity === null || probe.processIdentity(identity.pid) === identity.startIdentity;
}

function withinGrace(timestamp: string | null | undefined, probe: LivenessProbe): boolean {
  const recordedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(recordedAt)) return false;
  return probe.now() - recordedAt < UNPROVEN_LAUNCH_GRACE_MS;
}

function isDurableQueuedPinnedSpawn(receipt: SpawnReceipt): boolean {
  if (receipt.transport !== "structured" || !receipt.accountPin || receipt.state !== "path-pending") return false;
  const title = receipt.launchProfile.title ?? "";
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title);
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
  if (isDurableQueuedPinnedSpawn(receipt)) return true;
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
