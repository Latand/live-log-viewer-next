import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import {
  emptyLaunchProfile,
  type AutoBalancePolicy,
  type ConversationMigration,
  type DurableQuotaObservation,
  type HeldDelivery,
  type LaunchProfile,
  type MigrationIntent,
  type MigrationOrigin,
  type NativeGeneration,
  type ProviderReceipt,
  sameProviderReceiptOutcome,
  type TurnState,
  type ViewerConversationId,
} from "@/lib/accounts/migration/contracts";

import type { AgentEngine } from "./cli";
import { sessionKeyFromTranscript, sessionKeyId, type SessionKey } from "./sessionKey";
import type { ResumePaneRecord } from "@/lib/resumePanesFile";

export type AgentHostStatus = "starting" | "live" | "idle" | "handoff" | "unhosted" | "dead";

export interface ProcessIdentity {
  pid: number;
  startIdentity: string | null;
}

export interface TmuxHostEvidence {
  kind: "tmux";
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  windowName: string;
  agent: ProcessIdentity;
  argv: string[];
}

export interface StructuredHostColumns {
  kind: "codex-app-server" | "claude-broker";
  endpoint: string;
  process: ProcessIdentity | null;
  eventCursor: number;
  protocolVersion: string | null;
  writerClaimEpoch: number;
  activeTurnRef: string | null;
  pendingAttention: string[];
  activeFlags: string[];
}

const STRUCTURED_CLAIM_PREFIX = "structured-host:";

function structuredClaimOwner(identity: ProcessIdentity): string {
  return `${STRUCTURED_CLAIM_PREFIX}${JSON.stringify(identity)}`;
}

function structuredClaimIdentity(owner: string): ProcessIdentity | null {
  if (!owner.startsWith(STRUCTURED_CLAIM_PREFIX)) return null;
  try {
    const identity = JSON.parse(owner.slice(STRUCTURED_CLAIM_PREFIX.length)) as Partial<ProcessIdentity>;
    return Number.isInteger(identity.pid) && identity.pid! > 0
      ? { pid: identity.pid!, startIdentity: typeof identity.startIdentity === "string" ? identity.startIdentity : null }
      : null;
  } catch {
    return null;
  }
}

/** Immutable tmux facts captured before readiness polling can expose a new
    pane to the observer. They are the only durable correlation between a
    launch receipt and an externally observed host. */
export interface TmuxSpawnBinding {
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  /** Current human-readable coordinates at creation time. */
  display?: string;
  /** Stable actuation target. Normalization upgrades legacy coordinates to paneId. */
  target: string;
}

export interface AgentRegistryEntry {
  key: SessionKey;
  artifactPath: string;
  cwd: string;
  accountId: string | null;
  launchProfile?: LaunchProfile;
  status: AgentHostStatus;
  host: TmuxHostEvidence | null;
  /** Structured hosting metadata lives beside legacy tmux evidence during migration. */
  structuredHost?: StructuredHostColumns | null;
  claimEpoch: number;
  claimOwner: string | null;
  pendingAction: "spawn" | "resume" | "handoff" | null;
  updatedAt: string;
}

export interface SpawnReceipt {
  launchId: string;
  /** Client-owned idempotency key. Legacy callers leave this null. */
  clientAttemptId: string | null;
  /** SHA-256 of the public launch shape. Prompt/image contents never persist. */
  requestDigest: string | null;
  /** Reserved at receipt birth so path discovery cannot choose the identity. */
  conversationId: ViewerConversationId;
  purpose: "launch" | "migration-successor" | "resume-successor";
  /** Generation current when a resume receipt was created. A completed
      source observation may advance from this path exactly once. */
  resumeSourcePath: string | null;
  /** Disk-backed Codex session metadata can recover this receipt after its
      pane disappears before transcript discovery completes. */
  pathCorrelation: { cwd: string; startedAt: string } | null;
  engine: AgentEngine;
  cwd: string;
  accountId: string | null;
  parentConversationId: ViewerConversationId | null;
  createdAt: string;
  state: "starting" | "pane-bound" | "host-verified" | "prompt-delivered" | "path-pending" | "completed" | "failed" | "conflicted";
  artifactPath: string | null;
  key: SessionKey | null;
  pane: TmuxSpawnBinding | null;
  verifiedHost: TmuxHostEvidence | null;
  target: string | null;
  completionMode: "route-completed" | "observed-completed" | "route-recovered" | null;
  error: string | null;
  launchProfile: LaunchProfile;
}

export interface SpawnLineageEdge {
  childConversationId: ViewerConversationId;
  parentConversationId: ViewerConversationId;
  childSessionKey: SessionKey | null;
  parentSessionKey: SessionKey | null;
  childArtifactPath: string | null;
  parentArtifactPath: string | null;
  kind: "spawn" | "review";
  role: string | null;
  reviewsConversationId: ViewerConversationId | null;
  source: "viewer-spawn" | "engine-native";
  evidence: {
    launchId: string | null;
    clientAttemptId: string | null;
  };
  createdAt: string;
}

export interface DurableConversationMembership {
  conversationId: ViewerConversationId;
  kind: "flow" | "pipeline";
  containerId: string;
  role: string;
  slot: string;
  stageId: string | null;
  stageOrder: number | null;
  round: number | null;
  parentConversationId: ViewerConversationId | null;
  createdAt: string;
}

export type DurableMembershipInput = Omit<DurableConversationMembership, "conversationId" | "createdAt">;

export interface SpawnRequest {
  engine: AgentEngine;
  cwd: string;
  launchProfile?: Partial<LaunchProfile>;
  clientAttemptId?: string | null;
  requestDigest?: string | null;
  accountId?: string | null;
  parentConversationId?: ViewerConversationId | null;
  parentSessionKey?: SessionKey | null;
  parentArtifactPath?: string | null;
  role?: string | null;
  reviewsConversationId?: ViewerConversationId | null;
  memberships?: DurableMembershipInput[];
  conversationId?: ViewerConversationId;
  purpose?: SpawnReceipt["purpose"];
  expectedArtifactPath?: string | null;
}

export type SpawnBeginResult =
  | { kind: "created"; receipt: SpawnReceipt }
  | { kind: "replay"; receipt: SpawnReceipt }
  | { kind: "conflict"; receipt: SpawnReceipt };

export type SpawnSettlement =
  | { kind: "settled"; receipt: SpawnReceipt; entry: AgentRegistryEntry; conversation: RegistryConversation }
  | { kind: "conflict"; receipt: SpawnReceipt; code: "spawn_artifact_conflict" | "spawn_pane_conflict" | "spawn_identity_conflict" };

export interface RegistryConversation {
  id: ViewerConversationId;
  engine: Extract<AgentEngine, "claude" | "codex">;
  generations: NativeGeneration[];
  /** Provider-created transcript artifacts that retain this conversation's
      identity while the canonical generation path advances. */
  continuityPaths: string[];
  /** Continuity artifacts from canceled successions that must stay outside board aliases. */
  abandonedContinuityPaths: string[];
  migration: ConversationMigration | null;
  /** Explicit Stop/Keep decision for one target at one routing revision. */
  migrationOptOut: { targetId: string; updatedAt: string } | null;
  turn: TurnState & { observedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFile {
  version: 2;
  entries: Record<string, AgentRegistryEntry>;
  receipts: Record<string, SpawnReceipt>;
  lineageEdges: Record<string, SpawnLineageEdge>;
  memberships: Record<string, DurableConversationMembership[]>;
  importedResumePanes: boolean;
  /** Compatibility evidence only. It never authorizes a pane until the live
      resolver proves server, process, engine, and transcript ownership. */
  legacyResumePanes: { serverPid: number | null; panes: Record<string, ResumePaneRecord> };
  conversations: Record<string, RegistryConversation>;
  /** Durable redirects for conversation IDs that escaped before scanner-owned
      provisional identities were adopted by their canonical owner. */
  conversationAliases: Record<string, ViewerConversationId>;
  conversationRevision: Record<Extract<AgentEngine, "claude" | "codex">, number>;
  migrationIntents: Record<string, MigrationIntent>;
  engineRouting: Record<Extract<AgentEngine, "claude" | "codex">, { activeAccountId: string | null; revision: number }>;
  autoBalance: Record<Extract<AgentEngine, "claude" | "codex">, AutoBalancePolicy>;
  quotaObservations: Record<Extract<AgentEngine, "claude" | "codex">, Record<string, DurableQuotaObservation>>;
  heldDeliveries: Record<string, HeldDelivery>;
  pendingSuccessorCleanups: Record<string, { conversationId: ViewerConversationId; receipt: ProviderReceipt; createdAt: string; lastError: string | null }>;
}

export interface ConversationLookup {
  conversationForPath(artifactPath: string): RegistryConversation | null;
  canonicalConversationId(id: ViewerConversationId): ViewerConversationId;
  conversation(id: ViewerConversationId): RegistryConversation | null;
}

type ConversationMigrationInput = Omit<ConversationMigration, "errorCode" | "operationId" | "sourceGenerationId" | "providerReceipt" | "pendingContinuityPaths" | "boardProject" | "boardOperationId" | "boardPlacementProject"> &
  Partial<Pick<ConversationMigration, "errorCode" | "operationId" | "sourceGenerationId" | "providerReceipt" | "pendingContinuityPaths" | "boardProject" | "boardOperationId" | "boardPlacementProject">>;
type SuccessorGenerationInput = Omit<NativeGeneration, "createdAt" | "archivedAt" | "launchProfile" | "historyHash" | "host"> &
  Partial<Pick<NativeGeneration, "launchProfile" | "historyHash" | "host">>;

export interface ConversationObservation {
  engine: Extract<AgentEngine, "claude" | "codex">;
  path: string;
  accountId: string | null;
  launchProfile: LaunchProfile;
  turn: TurnState;
  expectedTurnObservedAt?: string | null;
  startedAt?: string | null;
  observedAt: string;
}

export type MigrationScope = "active" | "all";

export interface MigrationScopeCounts {
  total: number;
  idle: number;
  busy: number;
  deferred: number;
  alreadyTarget: number;
}

function migrationReadiness(
  file: RegistryFile,
  conversation: RegistryConversation,
): "idle" | "busy" | "deferred" {
  if (conversation.turn.state === "busy" || conversation.turn.state === "unknown") return "busy";
  const deliveryInFlight = Object.values(file.heldDeliveries).some((delivery) =>
    delivery.conversationId === conversation.id && delivery.state === "delivery-uncertain");
  if (deliveryInFlight) return "busy";
  if (conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase)) return "idle";
  const sourcePath = conversation.generations.at(-1)?.path;
  const hasActiveHost = sourcePath !== undefined && Object.values(file.entries).some((entry) =>
    entry.artifactPath === sourcePath && ["starting", "live", "idle", "handoff"].includes(entry.status));
  if (hasActiveHost) return "idle";
  const hasPendingDelivery = Object.values(file.heldDeliveries).some((delivery) =>
    delivery.conversationId === conversation.id && delivery.state !== "delivered");
  return hasPendingDelivery ? "idle" : "deferred";
}

function resumeCanRebaseMigration(migration: ConversationMigration | null): boolean {
  return migration === null
    || migration.phase === "committed"
    || migration.phase === "rolled-back"
    || ((migration.phase === "waiting-turn" || migration.phase === "requested") && migration.providerReceipt === null);
}

function receiptStillAwaitsResumeSuccessor(receipt: SpawnReceipt): boolean {
  if (receipt.purpose !== "resume-successor" || receipt.state === "failed") return false;
  return receipt.state !== "completed"
    || receipt.resumeSourcePath === null
    || receipt.artifactPath === receipt.resumeSourcePath;
}

const PATH_CORRELATION_WINDOW_MS = 30_000;
const REGISTRY_LOCK_BACKOFF_MAX_MS = 50;
const REGISTRY_LOCK_PUBLICATION_GRACE_MS = 1_000;

interface RegistryLockClaim {
  lock: string;
  token: string;
  identity: { dev: number; ino: number };
  storage: string;
}

interface RegistryLockTiming {
  now(): number;
  wait(delayMs: number): Promise<void>;
}

const SYSTEM_LOCK_TIMING: RegistryLockTiming = {
  now: () => Date.now(),
  wait: async (delayMs) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); },
};

function correlatePathPendingReceipts(file: RegistryFile, observations: ConversationObservation[]): Map<string, string> {
  type PendingReceipt = { launchId: string; cwd: string; accountId: string | null; expectedStart: number };
  type PendingObservation = { path: string; cwd: string; accountId: string | null; observedStart: number };
  type Pair = [string, string];
  type Correlation = { count: number; distance: number; assignments: Pair[][] };
  const receipts: PendingReceipt[] = Object.values(file.receipts).flatMap((receipt) => {
    if (receipt.engine !== "codex" || receipt.state !== "path-pending" || receipt.artifactPath !== null || !receipt.pathCorrelation) return [];
    const expectedStart = Date.parse(receipt.pathCorrelation.startedAt);
    return Number.isFinite(expectedStart)
      ? [{ launchId: receipt.launchId, cwd: receipt.pathCorrelation.cwd, accountId: receipt.accountId, expectedStart }]
      : [];
  });
  if (receipts.length === 0) return new Map();
  const pendingObservations: PendingObservation[] = [];
  for (const observation of observations) {
    if (observation.engine !== "codex" || !observation.startedAt) continue;
    const observedStart = Date.parse(observation.startedAt);
    if (!Number.isFinite(observedStart)) continue;
    const nativeId = sessionKeyFromTranscript(observation.engine, observation.path)?.sessionId ?? null;
    const knownOwners = Object.values(file.conversations).filter((conversation) =>
      conversation.engine === observation.engine
      && (conversationOwnsPath(conversation, observation.path)
        || (nativeId !== null && conversation.generations.some((generation) => generation.id === nativeId))));
    if (knownOwners.some((owner) => !scannerAllocatedProvisionalOwner(owner, observation.path))) continue;
    pendingObservations.push({ path: observation.path, cwd: observation.launchProfile.cwd, accountId: observation.accountId, observedStart });
  }
  const matches = new Map<string, string>();
  const partitionKey = (value: { cwd: string; accountId: string | null }) => JSON.stringify([value.cwd, value.accountId]);
  const partitions = new Set([...receipts.map(partitionKey), ...pendingObservations.map(partitionKey)]);
  const advance = (table: Array<Array<Correlation | undefined>>, observationIndex: number, receiptIndex: number, candidate: Correlation) => {
    const current = table[observationIndex]![receiptIndex];
    if (!current || candidate.count > current.count || (candidate.count === current.count && candidate.distance < current.distance)) {
      table[observationIndex]![receiptIndex] = {
        ...candidate,
        assignments: candidate.assignments.map((assignment) => [...assignment]),
      };
      return;
    }
    if (candidate.count !== current.count || candidate.distance !== current.distance) return;
    const signatures = new Set(current.assignments.map((assignment) => JSON.stringify(assignment)));
    for (const assignment of candidate.assignments) {
      const signature = JSON.stringify(assignment);
      if (!signatures.has(signature)) {
        current.assignments.push(assignment);
        signatures.add(signature);
        if (current.assignments.length === 2) break;
      }
    }
  };
  for (const partition of partitions) {
    const cwdReceipts = receipts.filter((receipt) => partitionKey(receipt) === partition)
      .sort((left, right) => left.expectedStart - right.expectedStart || left.launchId.localeCompare(right.launchId));
    const cwdObservations = pendingObservations.filter((observation) => partitionKey(observation) === partition)
      .sort((left, right) => left.observedStart - right.observedStart || left.path.localeCompare(right.path));
    const compatible = (observation: PendingObservation, receipt: PendingReceipt) =>
      observation.observedStart >= receipt.expectedStart - 1_000
      && observation.observedStart <= receipt.expectedStart + PATH_CORRELATION_WINDOW_MS;
    if (cwdReceipts.length > 1 && cwdObservations.length > 1) {
      const ambiguousObservation = cwdObservations.some((observation) =>
        cwdReceipts.filter((receipt) => compatible(observation, receipt)).length > 1);
      const ambiguousReceipt = cwdReceipts.some((receipt) =>
        cwdObservations.filter((observation) => compatible(observation, receipt)).length > 1);
      if (ambiguousObservation || ambiguousReceipt) continue;
    }
    const table: Array<Array<Correlation | undefined>> = Array.from(
      { length: cwdObservations.length + 1 },
      () => Array<Correlation | undefined>(cwdReceipts.length + 1),
    );
    table[0]![0] = { count: 0, distance: 0, assignments: [[]] };
    for (let observationIndex = 0; observationIndex <= cwdObservations.length; observationIndex += 1) {
      for (let receiptIndex = 0; receiptIndex <= cwdReceipts.length; receiptIndex += 1) {
        const current = table[observationIndex]![receiptIndex];
        if (!current) continue;
        if (observationIndex < cwdObservations.length) advance(table, observationIndex + 1, receiptIndex, current);
        if (receiptIndex < cwdReceipts.length) advance(table, observationIndex, receiptIndex + 1, current);
        if (observationIndex >= cwdObservations.length || receiptIndex >= cwdReceipts.length) continue;
        const observation = cwdObservations[observationIndex]!;
        const receipt = cwdReceipts[receiptIndex]!;
        if (!compatible(observation, receipt)) continue;
        advance(table, observationIndex + 1, receiptIndex + 1, {
          count: current.count + 1,
          distance: current.distance + Math.abs(observation.observedStart - receipt.expectedStart),
          assignments: current.assignments.map((assignment) => [...assignment, [observation.path, receipt.launchId]]),
        });
      }
    }
    const assignment = table.at(-1)?.at(-1)?.assignments;
    if (assignment?.length === 1) {
      for (const [pathname, launchId] of assignment[0]!) matches.set(pathname, launchId);
    }
  }
  return matches;
}

function mergeResumeLaunchProfile(current: LaunchProfile, requested: LaunchProfile): LaunchProfile {
  return {
    cwd: requested.cwd || current.cwd,
    model: requested.model ?? current.model,
    effort: requested.effort ?? current.effort,
    fast: requested.fast ?? current.fast,
    permissionMode: requested.permissionMode ?? current.permissionMode,
    readOnly: requested.readOnly ?? current.readOnly,
    title: requested.title ?? current.title,
    project: requested.project ?? current.project,
    parentConversationId: requested.parentConversationId ?? current.parentConversationId,
    role: current.role === "root" || requested.role === "root" ? "root" : "worker",
    goal: requested.goal ?? current.goal,
    plan: requested.plan ?? current.plan,
  };
}

function migrationReadinessSignature(
  file: RegistryFile,
  engine: Extract<AgentEngine, "claude" | "codex">,
  paths: ReadonlySet<string>,
): string {
  return JSON.stringify(Object.values(file.conversations)
    .filter((conversation) => conversation.engine === engine
      && paths.has(conversation.generations.at(-1)?.path ?? ""))
    .map((conversation) => [conversation.id, migrationReadiness(file, conversation)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function activeHostPathsChangedByEntry(
  file: RegistryFile,
  keyId: string,
  replacement: Omit<AgentRegistryEntry, "updatedAt">,
): Set<string> {
  const previous = file.entries[keyId];
  const paths = new Set([previous?.artifactPath, replacement.artifactPath].filter((value): value is string => Boolean(value)));
  const activeStatuses = new Set<AgentRegistryEntry["status"]>(["starting", "live", "idle", "handoff"]);
  const activeAtPath = (pathname: string, replace: boolean): boolean => {
    for (const [candidateKey, current] of Object.entries(file.entries)) {
      const candidate = replace && candidateKey === keyId ? replacement : current;
      if (candidate.artifactPath === pathname && activeStatuses.has(candidate.status)) return true;
    }
    return replace && !(keyId in file.entries)
      && replacement.artifactPath === pathname
      && activeStatuses.has(replacement.status);
  };
  return new Set([...paths].filter((pathname) => activeAtPath(pathname, false) !== activeAtPath(pathname, true)));
}

function advanceMigrationScopeRevision(
  file: RegistryFile,
  engine: Extract<AgentEngine, "claude" | "codex">,
  previousSignature: string,
  paths: ReadonlySet<string>,
): void {
  if (migrationReadinessSignature(file, engine, paths) === previousSignature) return;
  file.conversationRevision[engine] += 1;
  file.engineRouting[engine].revision += 1;
}

function migrationScopeCounts(
  file: RegistryFile,
  engine: Extract<AgentEngine, "claude" | "codex">,
  targetId: string,
): MigrationScopeCounts {
  const counts: MigrationScopeCounts = { total: 0, idle: 0, busy: 0, deferred: 0, alreadyTarget: 0 };
  for (const conversation of Object.values(file.conversations)) {
    if (conversation.engine !== engine) continue;
    const source = conversation.generations.at(-1);
    if (!source || source.accountId === null) continue;
    if (source.accountId === targetId) {
      counts.alreadyTarget += 1;
      continue;
    }
    counts.total += 1;
    counts[migrationReadiness(file, conversation)] += 1;
  }
  return counts;
}

function conversationMigrationForIntent(
  conversation: RegistryConversation,
  source: NativeGeneration,
  intent: MigrationIntent,
  phase: ConversationMigration["phase"],
  changedAt: string,
): ConversationMigration {
  const boardProject = conversation.migration?.boardProject ?? null;
  const pendingContinuityPaths = conversation.migration && conversation.migration.phase !== "committed"
    ? conversation.migration.pendingContinuityPaths
    : [];
  return {
    intentId: intent.id,
    phase,
    targetId: intent.targetId,
    revision: intent.revision,
    error: null,
    errorCode: null,
    operationId: crypto.randomUUID(),
    sourceGenerationId: source.id,
    providerReceipt: null,
    pendingContinuityPaths,
    boardProject,
    boardOperationId: conversation.migration?.boardOperationId ?? null,
    boardPlacementProject: conversation.migration?.boardPlacementProject
      ?? boardProject
      ?? source.launchProfile.project,
    updatedAt: changedAt,
  };
}

function queueAbandonedMigrationCleanup(
  file: RegistryFile,
  conversation: RegistryConversation,
  changedAt: string,
): void {
  const receipt = conversation.migration?.phase === "committed"
    ? null
    : conversation.migration?.providerReceipt;
  if (!receipt) return;
  file.pendingSuccessorCleanups[receipt.operationId] ??= {
    conversationId: conversation.id,
    receipt,
    createdAt: changedAt,
    lastError: null,
  };
}

export class MigrationRevisionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super("migration preview is stale");
    this.name = "MigrationRevisionError";
  }
}

function emptyPolicy(): AutoBalancePolicy {
  return {
    enabled: true,
    revision: 0,
    cooldownUntil: null,
    departed: {},
    lastOutcome: null,
    lastTrigger: null,
    lastCheckAt: null,
    sustain: null,
    restartedAt: now(),
  };
}

const EMPTY: RegistryFile = {
  version: 2,
  entries: {},
  receipts: {},
  lineageEdges: {},
  memberships: {},
  importedResumePanes: false,
  legacyResumePanes: { serverPid: null, panes: {} },
  conversations: {},
  conversationAliases: {},
  conversationRevision: { claude: 0, codex: 0 },
  migrationIntents: {},
  engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } },
  autoBalance: { claude: emptyPolicy(), codex: emptyPolicy() },
  quotaObservations: { claude: {}, codex: {} },
  heldDeliveries: {},
  pendingSuccessorCleanups: {},
};

export class RegistryReadError extends Error {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function restoreOwnedChanges(current: unknown, retired: unknown, previous: unknown): unknown {
  if (JSON.stringify(retired) === JSON.stringify(previous)) return current;
  if (JSON.stringify(current) === JSON.stringify(retired)) return previous === undefined ? undefined : clone(previous);
  if (current && retired && previous && typeof current === "object" && typeof retired === "object" && typeof previous === "object"
    && !Array.isArray(current) && !Array.isArray(retired) && !Array.isArray(previous)) {
    const restored: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    const keys = new Set([...Object.keys(retired), ...Object.keys(previous)]);
    for (const key of keys) {
      const value = restoreOwnedChanges(
        (current as Record<string, unknown>)[key],
        (retired as Record<string, unknown>)[key],
        (previous as Record<string, unknown>)[key],
      );
      if (value === undefined) delete restored[key]; else restored[key] = value;
    }
    return restored;
  }
  return current;
}

function now(): string {
  return new Date().toISOString();
}

function nativeGenerationId(pathname: string): string {
  return path.basename(pathname).match(/([0-9a-f-]{36})(?:\.jsonl)?$/i)?.[1] ?? crypto.randomUUID();
}

function normalizeGeneration(value: NativeGeneration): NativeGeneration {
  return {
    ...value,
    launchProfile: emptyLaunchProfile(value.launchProfile ?? {}),
    historyHash: typeof value.historyHash === "string" ? value.historyHash : null,
    host: value.host && typeof value.host === "object" ? value.host : null,
  };
}

function normalizeStructuredHost(value: unknown): StructuredHostColumns | null {
  if (!value || typeof value !== "object") return null;
  const host = value as Partial<StructuredHostColumns>;
  if (host.kind !== "codex-app-server" && host.kind !== "claude-broker") return null;
  const processIdentity = host.process && typeof host.process === "object"
    && typeof host.process.pid === "number"
    ? { pid: host.process.pid, startIdentity: typeof host.process.startIdentity === "string" ? host.process.startIdentity : null }
    : null;
  return {
    kind: host.kind,
    endpoint: typeof host.endpoint === "string" ? host.endpoint : "",
    process: processIdentity,
    eventCursor: Number.isSafeInteger(host.eventCursor) && (host.eventCursor ?? -1) >= 0 ? host.eventCursor! : 0,
    protocolVersion: typeof host.protocolVersion === "string" ? host.protocolVersion : null,
    writerClaimEpoch: Number.isSafeInteger(host.writerClaimEpoch) && (host.writerClaimEpoch ?? -1) >= 0 ? host.writerClaimEpoch! : 0,
    activeTurnRef: typeof host.activeTurnRef === "string" ? host.activeTurnRef : null,
    pendingAttention: Array.isArray(host.pendingAttention)
      ? host.pendingAttention.filter((item): item is string => typeof item === "string")
      : [],
    activeFlags: Array.isArray(host.activeFlags)
      ? host.activeFlags.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function normalizeEntry(value: AgentRegistryEntry): AgentRegistryEntry {
  return {
    ...value,
    ...(value.launchProfile ? { launchProfile: emptyLaunchProfile(value.launchProfile) } : {}),
    host: value.host && typeof value.host === "object" && value.host.kind === "tmux" ? value.host : null,
    structuredHost: normalizeStructuredHost(value.structuredHost),
  };
}

function normalizeLineageEdge(value: SpawnLineageEdge): SpawnLineageEdge {
  const reviewsConversationId = typeof value.reviewsConversationId === "string" && value.reviewsConversationId.startsWith("conversation_")
    ? value.reviewsConversationId as ViewerConversationId
    : null;
  const role = typeof value.role === "string" && value.role.trim() ? value.role.trim() : null;
  return {
    ...value,
    kind: value.kind === "review" || reviewsConversationId || role === "reviewer" ? "review" : "spawn",
    role,
    reviewsConversationId,
  };
}

function normalizeMemberships(value: unknown): RegistryFile["memberships"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: RegistryFile["memberships"] = {};
  for (const [conversationId, rows] of Object.entries(value)) {
    if (!conversationId.startsWith("conversation_") || !Array.isArray(rows)) continue;
    const valid = rows.flatMap((candidate): DurableConversationMembership[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as Partial<DurableConversationMembership>;
      if ((row.kind !== "flow" && row.kind !== "pipeline")
        || typeof row.containerId !== "string" || !row.containerId
        || typeof row.role !== "string" || !row.role
        || typeof row.slot !== "string" || !row.slot) return [];
      return [{
        conversationId: conversationId as ViewerConversationId,
        kind: row.kind,
        containerId: row.containerId,
        role: row.role,
        slot: row.slot,
        stageId: typeof row.stageId === "string" ? row.stageId : null,
        stageOrder: Number.isInteger(row.stageOrder) ? row.stageOrder! : null,
        round: Number.isInteger(row.round) ? row.round! : null,
        parentConversationId: typeof row.parentConversationId === "string" && row.parentConversationId.startsWith("conversation_")
          ? row.parentConversationId as ViewerConversationId
          : null,
        createdAt: typeof row.createdAt === "string" ? row.createdAt : now(),
      }];
    });
    if (valid.length) normalized[conversationId] = valid;
  }
  return normalized;
}

function normalizeProviderReceipt(value: ProviderReceipt | null | undefined): ProviderReceipt | null {
  if (!value || typeof value !== "object") return null;
  return {
    ...value,
    continuityPaths: Array.isArray(value.continuityPaths)
      ? value.continuityPaths.filter((pathname): pathname is string => typeof pathname === "string")
      : [],
  };
}

function normalizeConversation(value: RegistryConversation): RegistryConversation {
  const generations = Array.isArray(value.generations) ? value.generations.map(normalizeGeneration) : [];
  const current = generations.at(-1);
  const legacyContinuity = (value.migration as (ConversationMigration & { continuityPaths?: unknown }) | null)?.continuityPaths;
  const providerReceipt = normalizeProviderReceipt(value.migration?.providerReceipt);
  const pendingContinuityPaths = Array.isArray(value.migration?.pendingContinuityPaths)
    ? value.migration.pendingContinuityPaths.filter((pathname): pathname is string => typeof pathname === "string")
    : value.migration?.phase !== "committed" && providerReceipt
      ? [...new Set([...providerReceipt.continuityPaths, providerReceipt.path])]
      : [];
  const migration = value.migration && typeof value.migration === "object"
    ? {
      ...value.migration,
      errorCode: value.migration.errorCode ?? null,
      operationId: value.migration.operationId ?? `${value.migration.intentId}:${value.id}:${value.migration.revision}`,
      sourceGenerationId: value.migration.sourceGenerationId ?? current?.id ?? "",
      providerReceipt,
      pendingContinuityPaths,
      boardProject: typeof value.migration.boardProject === "string" ? value.migration.boardProject : null,
      boardOperationId: typeof value.migration.boardOperationId === "string" ? value.migration.boardOperationId : null,
      boardPlacementProject: typeof value.migration.boardPlacementProject === "string" ? value.migration.boardPlacementProject : null,
    }
    : null;
  const continuityPaths = [...new Set([
    ...(Array.isArray(value.continuityPaths) ? value.continuityPaths.filter((pathname): pathname is string => typeof pathname === "string") : []),
    ...(Array.isArray(legacyContinuity) ? legacyContinuity.filter((pathname): pathname is string => typeof pathname === "string") : []),
    ...(migration?.providerReceipt?.continuityPaths ?? []),
  ])];
  const abandonedContinuityPaths = Array.isArray(value.abandonedContinuityPaths)
    ? [...new Set(value.abandonedContinuityPaths.filter((pathname): pathname is string => typeof pathname === "string"))]
    : [];
  const rawOptOut = (value as Partial<RegistryConversation>).migrationOptOut;
  const migrationOptOut = rawOptOut
    && typeof rawOptOut.targetId === "string"
    && typeof rawOptOut.updatedAt === "string"
    ? { targetId: rawOptOut.targetId, updatedAt: rawOptOut.updatedAt }
    : null;
  return {
    ...value,
    generations,
    continuityPaths,
    abandonedContinuityPaths,
    migration,
    migrationOptOut,
    turn: value.turn && typeof value.turn === "object"
      ? { state: value.turn.state, source: value.turn.source, terminalAt: value.turn.terminalAt ?? null, observedAt: value.turn.observedAt ?? null }
      : { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
  };
}

function normalizePolicy(value: AutoBalancePolicy | undefined): AutoBalancePolicy {
  const fallback = emptyPolicy();
  if (!value || typeof value !== "object") return fallback;
  return {
    ...fallback,
    ...value,
    departed: value.departed && typeof value.departed === "object" ? value.departed : {},
    lastOutcome: value.lastOutcome && typeof value.lastOutcome === "object" ? value.lastOutcome : null,
    sustain: value.sustain && typeof value.sustain === "object" ? value.sustain : null,
  };
}

function normalizeHeldDelivery(value: HeldDelivery): HeldDelivery {
  const state = value.state ?? "held";
  return {
    ...value,
    text: state === "delivered" ? "" : value.text,
    clientMessageId: value.clientMessageId ?? null,
    payloadKind: value.payloadKind ?? "text",
    artifactPaths: Array.isArray(value.artifactPaths)
      ? value.artifactPaths.filter((pathname): pathname is string => typeof pathname === "string")
      : [],
    state,
    generationId: value.generationId ?? null,
    attempts: Number.isInteger(value.attempts) ? value.attempts : 0,
    assignedAt: value.assignedAt ?? null,
    deliveredAt: value.deliveredAt ?? null,
    error: value.error ?? null,
  };
}

function compactDeliveryReservations(file: RegistryFile, onlyConversationId?: ViewerConversationId): number {
  const deliveredGroups = new Map<ViewerConversationId, HeldDelivery[]>();
  const failedGroups = new Map<ViewerConversationId, HeldDelivery[]>();
  for (const delivery of Object.values(file.heldDeliveries)) {
    const canonicalId = resolveConversationAlias(file, delivery.conversationId);
    if (onlyConversationId && canonicalId !== resolveConversationAlias(file, onlyConversationId)) continue;
    if (delivery.state === "delivered") {
      delivery.text = "";
      const group = deliveredGroups.get(canonicalId) ?? [];
      group.push(delivery);
      deliveredGroups.set(canonicalId, group);
    } else if (delivery.state === "failed") {
      const group = failedGroups.get(canonicalId) ?? [];
      group.push(delivery);
      failedGroups.set(canonicalId, group);
    }
  }
  let removed = 0;
  for (const deliveries of deliveredGroups.values()) {
    deliveries.sort((left, right) => (right.deliveredAt ?? right.createdAt).localeCompare(left.deliveredAt ?? left.createdAt) || right.id.localeCompare(left.id));
    for (const expired of deliveries.slice(100)) {
      delete file.heldDeliveries[expired.id];
      removed += 1;
    }
  }
  for (const [conversationId, deliveries] of failedGroups) {
    const activeCount = Object.values(file.heldDeliveries).filter((delivery) =>
      resolveConversationAlias(file, delivery.conversationId) === conversationId
      && ["held", "assigned", "delivery-uncertain"].includes(delivery.state)).length;
    const retainedFailed = Math.max(0, Math.min(50, 99 - activeCount));
    deliveries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    for (const expired of deliveries.slice(retainedFailed)) {
      delete file.heldDeliveries[expired.id];
      removed += 1;
    }
  }
  return removed;
}

function conversationOwnsPath(conversation: RegistryConversation, artifactPath: string): boolean {
  return conversation.generations.some((generation) => generation.path === artifactPath)
    || conversation.continuityPaths.includes(artifactPath);
}

function addConversationContinuityPath(conversation: RegistryConversation, pathname: string): void {
  if (conversation.generations.some((generation) => generation.path === pathname)) return;
  if (!conversation.continuityPaths.includes(pathname)) conversation.continuityPaths.push(pathname);
  if (conversation.migration && conversation.migration.phase !== "committed"
    && !conversation.migration.pendingContinuityPaths.includes(pathname)) {
    conversation.migration.pendingContinuityPaths.push(pathname);
  }
}

function abandonPendingContinuityPaths(conversation: RegistryConversation): void {
  const pending = conversation.migration?.pendingContinuityPaths ?? [];
  if (pending.length === 0) return;
  conversation.abandonedContinuityPaths = [...new Set([...conversation.abandonedContinuityPaths, ...pending])];
}

function scannerAllocatedProvisionalOwner(conversation: RegistryConversation, pathname: string): boolean {
  const generation = conversation.generations[0];
  return conversation.migration === null
    && conversation.generations.length === 1
    && generation?.path === pathname
    && conversation.continuityPaths.length === 0;
}

function conversationDurabilityScore(file: RegistryFile, conversation: RegistryConversation): number {
  let score = conversation.generations.length > 1 || conversation.migration !== null ? 100 : 0;
  for (const receipt of Object.values(file.receipts)) {
    if (receipt.conversationId === conversation.id) score += 20;
    if (receipt.parentConversationId === conversation.id) score += 5;
  }
  if (file.lineageEdges[conversation.id]) score += 10;
  for (const edge of Object.values(file.lineageEdges)) if (edge.parentConversationId === conversation.id) score += 5;
  if (file.memberships[conversation.id]?.length) score += 10;
  for (const delivery of Object.values(file.heldDeliveries)) if (delivery.conversationId === conversation.id) score += 5;
  return score;
}

function preferredConversationOwner(file: RegistryFile, candidates: RegistryConversation[]): RegistryConversation | null {
  return [...candidates].sort((left, right) =>
    conversationDurabilityScore(file, right) - conversationDurabilityScore(file, left)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id))[0] ?? null;
}

function recordObservedLineage(
  file: RegistryFile,
  conversation: RegistryConversation,
  artifactPath: string,
  observedAt: string,
): void {
  const generation = conversation.generations.find((candidate) => candidate.path === artifactPath)
    ?? conversation.generations.at(-1);
  const existing = file.lineageEdges[conversation.id];
  const parentConversationId = existing?.source === "viewer-spawn"
    ? existing.parentConversationId
    : generation?.launchProfile.parentConversationId;
  if (!generation || !parentConversationId || parentConversationId === conversation.id) return;
  const canonicalParentId = resolveConversationAlias(file, parentConversationId);
  const parent = file.conversations[canonicalParentId];
  if (!parent) return;
  const parentGeneration = parent.generations.at(-1);
  file.lineageEdges[conversation.id] = {
    childConversationId: conversation.id,
    parentConversationId: canonicalParentId,
    childSessionKey: sessionKeyFromTranscript(conversation.engine, artifactPath),
    parentSessionKey: parentGeneration ? sessionKeyFromTranscript(parent.engine, parentGeneration.path) : null,
    childArtifactPath: artifactPath,
    parentArtifactPath: parentGeneration?.path ?? null,
    kind: existing?.kind ?? "spawn",
    role: existing?.role ?? null,
    reviewsConversationId: existing?.reviewsConversationId ?? null,
    source: existing?.source ?? "engine-native",
    evidence: existing?.evidence ?? { launchId: null, clientAttemptId: null },
    createdAt: existing?.createdAt ?? observedAt,
  };
}

function resolveConversationAlias(file: Pick<RegistryFile, "conversationAliases">, id: ViewerConversationId): ViewerConversationId {
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

function recordMembership(
  file: RegistryFile,
  conversationId: ViewerConversationId,
  input: DurableMembershipInput,
  createdAt: string,
): DurableConversationMembership {
  if ((input.kind !== "flow" && input.kind !== "pipeline") || !input.containerId.trim() || !input.role.trim() || !input.slot.trim()) {
    throw new Error("durable membership is invalid");
  }
  const canonicalConversationId = resolveConversationAlias(file, conversationId);
  const parentConversationId = input.parentConversationId ? resolveConversationAlias(file, input.parentConversationId) : null;
  const membership: DurableConversationMembership = {
    conversationId: canonicalConversationId,
    kind: input.kind,
    containerId: input.containerId,
    role: input.role,
    slot: input.slot,
    stageId: input.stageId ?? null,
    stageOrder: Number.isInteger(input.stageOrder) ? input.stageOrder : null,
    round: Number.isInteger(input.round) ? input.round : null,
    parentConversationId,
    createdAt,
  };
  const rows = file.memberships[canonicalConversationId] ?? [];
  const existing = rows.find((row) => row.kind === membership.kind && row.containerId === membership.containerId && row.slot === membership.slot);
  if (existing) {
    const immutableShape = ({ createdAt: _createdAt, ...row }: DurableConversationMembership) => row;
    if (JSON.stringify(immutableShape(existing)) !== JSON.stringify(immutableShape(membership))) {
      throw new Error("durable membership is immutable");
    }
    return existing;
  }
  rows.push(membership);
  file.memberships[canonicalConversationId] = rows;
  return membership;
}

export function conversationLookupFromSnapshot(snapshot: RegistryFile): ConversationLookup {
  const byPath = new Map<string, RegistryConversation>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) {
      if (!byPath.has(generation.path)) byPath.set(generation.path, conversation);
    }
    for (const pathname of conversation.continuityPaths) {
      if (!byPath.has(pathname)) byPath.set(pathname, conversation);
    }
  }
  return {
    conversationForPath(artifactPath) {
      const conversation = byPath.get(artifactPath);
      return conversation ? clone(conversation) : null;
    },
    canonicalConversationId(id) {
      return resolveConversationAlias(snapshot, id);
    },
    conversation(id) {
      const conversation = snapshot.conversations[resolveConversationAlias(snapshot, id)];
      return conversation ? clone(conversation) : null;
    },
  };
}

function adoptProvisionalOwner(
  file: RegistryFile,
  owner: RegistryConversation,
  target: RegistryConversation,
  pathname: string,
): boolean {
  if (!scannerAllocatedProvisionalOwner(owner, pathname)) return false;
  if (owner.migrationOptOut
    && (!target.migrationOptOut || owner.migrationOptOut.updatedAt > target.migrationOptOut.updatedAt)) {
    target.migrationOptOut = { ...owner.migrationOptOut };
  }
  for (const receipt of Object.values(file.receipts)) {
    if (receipt.conversationId === owner.id) receipt.conversationId = target.id;
    if (receipt.parentConversationId === owner.id) receipt.parentConversationId = target.id;
    if (receipt.launchProfile.parentConversationId === owner.id) {
      receipt.launchProfile = { ...receipt.launchProfile, parentConversationId: target.id };
    }
  }
  const reassignedEdges: RegistryFile["lineageEdges"] = {};
  for (const edge of Object.values(file.lineageEdges)) {
    const reassigned = {
      ...edge,
      childConversationId: edge.childConversationId === owner.id ? target.id : edge.childConversationId,
      parentConversationId: edge.parentConversationId === owner.id ? target.id : edge.parentConversationId,
    };
    if (reassigned.childConversationId === reassigned.parentConversationId) continue;
    const existing = reassignedEdges[reassigned.childConversationId];
    if (!existing || edge.childConversationId === target.id) reassignedEdges[reassigned.childConversationId] = reassigned;
  }
  file.lineageEdges = reassignedEdges;
  const reassignedMemberships: RegistryFile["memberships"] = {};
  for (const [conversationId, memberships] of Object.entries(file.memberships)) {
    const reassignedConversationId = conversationId === owner.id ? target.id : conversationId as ViewerConversationId;
    const rows = memberships.map((membership) => ({
      ...membership,
      conversationId: reassignedConversationId,
      parentConversationId: membership.parentConversationId === owner.id ? target.id : membership.parentConversationId,
    }));
    const destination = reassignedMemberships[reassignedConversationId] ?? [];
    for (const row of rows) {
      if (!destination.some((existing) => existing.kind === row.kind && existing.containerId === row.containerId && existing.slot === row.slot)) {
        destination.push(row);
      }
    }
    reassignedMemberships[reassignedConversationId] = destination;
  }
  file.memberships = reassignedMemberships;
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (delivery.conversationId === owner.id) delivery.conversationId = target.id;
  }
  for (const entry of Object.values(file.entries)) {
    if (entry.launchProfile?.parentConversationId === owner.id) {
      entry.launchProfile = { ...entry.launchProfile, parentConversationId: target.id };
    }
  }
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) {
      if (generation.launchProfile.parentConversationId === owner.id) {
        generation.launchProfile = { ...generation.launchProfile, parentConversationId: target.id };
      }
    }
  }
  for (const [alias, destination] of Object.entries(file.conversationAliases)) {
    if (destination === owner.id) file.conversationAliases[alias] = target.id;
  }
  file.conversationAliases[owner.id] = target.id;
  delete file.conversations[owner.id];
  file.conversationRevision[target.engine] += 1;
  file.engineRouting[target.engine].revision += 1;
  return true;
}

function observationIsCurrent(currentObservedAt: string | null, observedAt: string): boolean {
  if (!currentObservedAt) return true;
  const currentTime = Date.parse(currentObservedAt);
  const observedTime = Date.parse(observedAt);
  if (Number.isFinite(currentTime) && Number.isFinite(observedTime)) return observedTime >= currentTime;
  return observedAt >= currentObservedAt;
}

function normalizeReceipt(value: SpawnReceipt): SpawnReceipt {
  const state = value.state === "completed" || value.state === "failed" || value.state === "pane-bound" || value.state === "host-verified" || value.state === "prompt-delivered" || value.state === "path-pending" || value.state === "conflicted"
    ? value.state
    : "starting";
  const pane = value.pane && typeof value.pane === "object" && typeof value.pane.paneId === "string" && typeof value.pane.target === "string"
    ? { ...value.pane, display: typeof value.pane.display === "string" ? value.pane.display : value.pane.target, target: value.pane.paneId }
    : null;
  return {
    ...value,
    clientAttemptId: typeof value.clientAttemptId === "string" ? value.clientAttemptId : null,
    requestDigest: typeof value.requestDigest === "string" ? value.requestDigest : null,
    conversationId: typeof value.conversationId === "string" && value.conversationId.startsWith("conversation_")
      ? value.conversationId as ViewerConversationId
      : `conversation_${crypto.randomUUID()}`,
    purpose: value.purpose === "migration-successor" || value.purpose === "resume-successor" ? value.purpose : "launch",
    resumeSourcePath: typeof value.resumeSourcePath === "string" ? value.resumeSourcePath : null,
    pathCorrelation: value.pathCorrelation
      && typeof value.pathCorrelation.cwd === "string"
      && typeof value.pathCorrelation.startedAt === "string"
      ? value.pathCorrelation
      : null,
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    parentConversationId: typeof value.parentConversationId === "string" && value.parentConversationId.startsWith("conversation_")
      ? value.parentConversationId as ViewerConversationId
      : null,
    state,
    key: value.key && typeof value.key === "object" && (value.key.engine === "claude" || value.key.engine === "codex") && typeof value.key.sessionId === "string" ? value.key : null,
    pane,
    verifiedHost: value.verifiedHost && typeof value.verifiedHost === "object" && value.verifiedHost.kind === "tmux" ? value.verifiedHost : null,
    target: pane?.paneId ?? (typeof value.target === "string" && /^%\d+$/.test(value.target) ? value.target : null),
    completionMode: value.completionMode === "route-completed" || value.completionMode === "observed-completed" || value.completionMode === "route-recovered" ? value.completionMode : null,
    launchProfile: emptyLaunchProfile({ ...(value.launchProfile ?? {}), cwd: value.launchProfile?.cwd ?? value.cwd }),
  };
}

function upgradeV1(parsed: Omit<Partial<RegistryFile>, "version">): RegistryFile {
  const legacy = parsed.legacyResumePanes;
  return {
    ...clone(EMPTY),
    entries: (parsed.entries as RegistryFile["entries"]) ?? {},
    receipts: Object.fromEntries(Object.entries((parsed.receipts as RegistryFile["receipts"]) ?? {}).map(([id, receipt]) => [id, normalizeReceipt(receipt)])),
    conversationAliases: {},
    importedResumePanes: parsed.importedResumePanes === true,
    legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
      ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
      : { serverPid: null, panes: {} },
  };
}

function readFile(filename: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Omit<Partial<RegistryFile>, "version"> & { version?: unknown };
    if (parsed.version === 1 && parsed.entries && parsed.receipts && typeof parsed.entries === "object" && typeof parsed.receipts === "object") {
      return upgradeV1(parsed);
    }
    if (parsed.version !== 2 || !parsed.entries || !parsed.receipts || typeof parsed.entries !== "object" || typeof parsed.receipts !== "object") {
      throw new RegistryReadError("agent registry schema is unsupported");
    }
    const legacy = parsed.legacyResumePanes;
    return {
      version: 2,
      entries: Object.fromEntries(Object.entries(parsed.entries).map(([id, entry]) => [id, normalizeEntry(entry)])),
      receipts: Object.fromEntries(Object.entries(parsed.receipts).map(([id, receipt]) => [id, normalizeReceipt(receipt)])),
      lineageEdges: parsed.lineageEdges && typeof parsed.lineageEdges === "object"
        ? Object.fromEntries(Object.entries(parsed.lineageEdges).map(([id, edge]) => [id, normalizeLineageEdge(edge)]))
        : {},
      memberships: normalizeMemberships(parsed.memberships),
      importedResumePanes: parsed.importedResumePanes === true,
      legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
        ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
        : { serverPid: null, panes: {} },
      conversations: parsed.conversations && typeof parsed.conversations === "object"
        ? Object.fromEntries(Object.entries(parsed.conversations).map(([id, conversation]) => [id, normalizeConversation(conversation)]))
        : {},
      conversationAliases: parsed.conversationAliases && typeof parsed.conversationAliases === "object"
        ? Object.fromEntries(Object.entries(parsed.conversationAliases).filter(([alias, destination]) => alias.startsWith("conversation_") && typeof destination === "string" && destination.startsWith("conversation_"))) as RegistryFile["conversationAliases"]
        : {},
      conversationRevision: parsed.conversationRevision && typeof parsed.conversationRevision === "object"
        ? { ...EMPTY.conversationRevision, ...parsed.conversationRevision }
        : clone(EMPTY.conversationRevision),
      migrationIntents: parsed.migrationIntents && typeof parsed.migrationIntents === "object" ? parsed.migrationIntents : {},
      engineRouting: parsed.engineRouting && typeof parsed.engineRouting === "object" ? { ...EMPTY.engineRouting, ...parsed.engineRouting } : clone(EMPTY.engineRouting),
      autoBalance: parsed.autoBalance && typeof parsed.autoBalance === "object"
        ? { claude: normalizePolicy(parsed.autoBalance.claude), codex: normalizePolicy(parsed.autoBalance.codex) }
        : { claude: emptyPolicy(), codex: emptyPolicy() },
      quotaObservations: parsed.quotaObservations && typeof parsed.quotaObservations === "object"
        ? { ...EMPTY.quotaObservations, ...parsed.quotaObservations }
        : clone(EMPTY.quotaObservations),
      heldDeliveries: parsed.heldDeliveries && typeof parsed.heldDeliveries === "object"
        ? Object.fromEntries(Object.entries(parsed.heldDeliveries).map(([id, delivery]) => [id, normalizeHeldDelivery(delivery)]))
        : {},
      pendingSuccessorCleanups: parsed.pendingSuccessorCleanups && typeof parsed.pendingSuccessorCleanups === "object"
        ? parsed.pendingSuccessorCleanups
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY);
    if (error instanceof RegistryReadError) throw error;
    throw new RegistryReadError(`agent registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compactLaunchProfile(profile: LaunchProfile): Partial<LaunchProfile> {
  const compact: Partial<LaunchProfile> = { ...profile };
  for (const key of Object.keys(compact) as Array<keyof LaunchProfile>) {
    if (compact[key] === null) delete compact[key];
  }
  if (compact.cwd === "") delete compact.cwd;
  if (compact.role === "worker") delete compact.role;
  return compact;
}

function serializeRegistry(value: RegistryFile): string {
  const storage = {
    ...value,
    entries: Object.fromEntries(Object.entries(value.entries).map(([id, entry]) => [id, {
      ...entry,
      ...(entry.launchProfile ? { launchProfile: compactLaunchProfile(entry.launchProfile) } : {}),
    }])),
    receipts: Object.fromEntries(Object.entries(value.receipts).map(([id, receipt]) => [id, {
      ...receipt,
      launchProfile: compactLaunchProfile(receipt.launchProfile),
    }])),
    conversations: Object.fromEntries(Object.entries(value.conversations).map(([id, conversation]) => [id, {
      ...conversation,
      generations: conversation.generations.map((generation) => ({
        ...generation,
        launchProfile: compactLaunchProfile(generation.launchProfile),
      })),
    }])),
  };
  return JSON.stringify(storage) + "\n";
}

function writeAtomic(filename: string, value: RegistryFile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = serializeRegistry(value);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filename);
    const dir = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename completed */ }
  }
}

/** Durable source for identity and handoff evidence. The lock directory is
    intentionally separate from in-memory promises, so a Viewer replacement
    cannot leave an imaginary owner behind. */
export class AgentRegistry {
  constructor(
    readonly filename = statePath("agent-registry.json"),
    private readonly ownerAlive: (owner: ProcessIdentity) => boolean = (owner) =>
      procBackend.pidAlive(owner.pid) && (owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity),
    private readonly lockTiming: RegistryLockTiming = SYSTEM_LOCK_TIMING,
  ) {
    this.cleanupStaleTempFiles();
    this.compactAtStartup();
  }

  private cleanupStaleTempFiles(): void {
    const directory = path.dirname(this.filename);
    const prefix = `${path.basename(this.filename)}.`;
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
      const owner = entry.slice(prefix.length, -4).split(".");
      const pid = Number(owner[0]);
      if (owner.length !== 2 || !Number.isInteger(pid) || pid <= 0
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner[1] ?? "")) continue;
      if (this.ownerAlive({ pid, startIdentity: null })) continue;
      try {
        fs.unlinkSync(path.join(directory, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private compactAtStartup(): void {
    if (!fs.existsSync(this.filename)) return;
    const lock = `${this.filename}.write-lock`;
    const claim = this.acquireLock(lock, { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) });
    try {
      let original: string;
      try {
        original = fs.readFileSync(this.filename, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      let file: RegistryFile;
      try {
        file = readFile(this.filename);
      } catch (error) {
        if (error instanceof RegistryReadError) {
          console.error("agent registry startup compaction skipped:", error);
          return;
        }
        throw error;
      }
      compactDeliveryReservations(file);
      if (serializeRegistry(file) !== original) writeAtomic(this.filename, file);
    } finally {
      this.releaseLock(claim);
    }
  }

  private sameLock(lock: string, expected: RegistryLockClaim["identity"]): boolean {
    try {
      const current = fs.statSync(lock);
      return current.dev === expected.dev && current.ino === expected.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private lockOwnerFile(lock: string): string {
    return fs.statSync(lock).isDirectory() ? path.join(lock, "owner.json") : lock;
  }

  private lockToken(lock: string): string | null {
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockOwnerFile(lock), "utf8")) as { token?: unknown };
      return typeof owner.token === "string" ? owner.token : null;
    } catch {
      return null;
    }
  }

  private finishRetirement(source: string, retired: string): void {
    try {
      fs.renameSync(source, retired);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        fs.rmSync(source, { recursive: true, force: true });
        return;
      }
      throw error;
    }
  }

  private restoreRecovery(lock: string, recovery: string): void {
    for (;;) {
      try {
        fs.renameSync(recovery, lock);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  private resolveInterruptedRelease(lock: string): void {
    const releasing = `${lock}.releasing`;
    if (!fs.existsSync(releasing)) return;
    let stat: fs.Stats;
    let owner: ProcessIdentity | null = null;
    try {
      stat = fs.statSync(releasing);
      owner = JSON.parse(fs.readFileSync(this.lockOwnerFile(releasing), "utf8")) as ProcessIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return;
    }
    if (Number.isInteger(owner.pid) && owner.pid > 0 && this.ownerAlive(owner)) return;
    if ((!Number.isInteger(owner.pid) || owner.pid <= 0)
      && this.lockTiming.now() - stat.mtimeMs < REGISTRY_LOCK_PUBLICATION_GRACE_MS) return;
    fs.rmSync(releasing, { recursive: true, force: true });
  }

  private retireObservedLock(
    lock: string,
    observed: RegistryLockClaim["identity"] & { isDirectory: boolean },
    token: string | null,
    fingerprint: string,
  ): void {
    const recovery = `${lock}.recovering`;
    if (!observed.isDirectory) {
      try {
        fs.linkSync(lock, recovery);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST") return;
        throw error;
      }
      if (!this.sameLock(recovery, observed) || this.lockToken(recovery) !== token
        || !this.sameLock(lock, observed) || this.lockToken(lock) !== token) {
        fs.rmSync(recovery, { force: true });
        return;
      }
      fs.rmSync(lock, { force: true });
      this.finishRetirement(recovery, `${lock}.retired-${fingerprint}`);
      return;
    }
    try {
      fs.renameSync(lock, recovery);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return;
      throw error;
    }
    if (!this.sameLock(recovery, observed) || this.lockToken(recovery) !== token) {
      this.restoreRecovery(lock, recovery);
      return;
    }
    this.finishRetirement(recovery, `${lock}.retired-${fingerprint}`);
  }

  private resolveInterruptedRecovery(lock: string): void {
    const recovery = `${lock}.recovering`;
    if (!fs.existsSync(recovery)) return;
    if (fs.existsSync(lock)) {
      let publishedStat: fs.Stats;
      let publishedOwner: (ProcessIdentity & { token?: unknown }) | null = null;
      try {
        publishedStat = fs.statSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      try {
        publishedOwner = JSON.parse(fs.readFileSync(this.lockOwnerFile(lock), "utf8")) as ProcessIdentity & { token?: unknown };
      } catch {
        return;
      }
      if (publishedOwner && Number.isInteger(publishedOwner.pid) && publishedOwner.pid > 0 && this.ownerAlive(publishedOwner)) return;
      const publishedToken = typeof publishedOwner?.token === "string" ? publishedOwner.token : null;
      const publishedFingerprint = publishedToken
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publishedToken)
        ? publishedToken
        : `abandoned-${publishedStat.dev}-${publishedStat.ino}-${publishedStat.ctimeMs}`;
      if (this.sameLock(lock, { dev: publishedStat.dev, ino: publishedStat.ino })
        && this.lockToken(lock) === publishedToken) {
        this.finishRetirement(lock, `${lock}.retired-${publishedFingerprint}`);
      }
    }
    let stat: fs.Stats;
    let owner: (ProcessIdentity & { token?: unknown }) | null = null;
    try {
      stat = fs.statSync(recovery);
      owner = JSON.parse(fs.readFileSync(this.lockOwnerFile(recovery), "utf8")) as ProcessIdentity & { token?: unknown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.finishRetirement(recovery, `${lock}.retired-interrupted-invalid`);
      return;
    }
    if (Number.isInteger(owner.pid) && owner.pid > 0 && this.ownerAlive(owner)) {
      if (fs.existsSync(lock)) return;
      this.restoreRecovery(lock, recovery);
      return;
    }
    const token = typeof owner.token === "string" ? owner.token : null;
    const fingerprint = token && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
      ? token
      : `interrupted-${stat.dev}-${stat.ino}-${stat.ctimeMs}`;
    this.finishRetirement(recovery, `${lock}.retired-${fingerprint}`);
  }

  private recoverContendedLock(lock: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let previous: (ProcessIdentity & { token?: unknown }) | null = null;
    try {
      previous = JSON.parse(fs.readFileSync(this.lockOwnerFile(lock), "utf8")) as ProcessIdentity & { token?: unknown };
    } catch {
      // Directory claims may still await descriptor-bound owner publication.
    }
    if (previous && Number.isInteger(previous.pid) && previous.pid > 0) {
      if (!this.ownerAlive(previous)) {
        const fingerprint = typeof previous.token === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previous.token)
          ? previous.token
          : `legacy-${stat.dev}-${stat.ino}-${stat.ctimeMs}`;
        this.retireObservedLock(lock, { dev: stat.dev, ino: stat.ino, isDirectory: stat.isDirectory() }, typeof previous.token === "string" ? previous.token : null, fingerprint);
      }
      return;
    }
    // An ownerless directory can belong to a paused legacy publisher. New
    // claims publish a fully populated staging directory atomically, so they
    // never require age-based recovery from this state.
  }

  private tryAcquireLock(lock: string, owner: ProcessIdentity): RegistryLockClaim | null {
    this.resolveInterruptedRelease(lock);
    if (fs.existsSync(`${lock}.releasing`)) return null;
    this.resolveInterruptedRecovery(lock);
    if (fs.existsSync(`${lock}.recovering`)) return null;
    const token = crypto.randomUUID();
    const staging = `${lock}.owner.pending-${token}`;
    let fd: number | null = null;
    let identity: RegistryLockClaim["identity"] | null = null;
    let ownerPublished = false;
    try {
      fs.mkdirSync(staging, 0o700);
      fd = fs.openSync(path.join(staging, "owner.json"), "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ...owner, token }), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      const directoryFd = fs.openSync(staging, "r");
      try {
        fs.fsyncSync(directoryFd);
        const stat = fs.fstatSync(directoryFd);
        identity = { dev: stat.dev, ino: stat.ino };
      } finally {
        fs.closeSync(directoryFd);
      }
      try {
        fs.symlinkSync(path.basename(staging), lock, "dir");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        fs.rmSync(staging, { recursive: true, force: true });
        this.recoverContendedLock(lock);
        return null;
      }
      ownerPublished = true;
      const claim = { lock, token, identity, storage: staging };
      if (!this.sameLock(lock, claim.identity) || this.lockToken(lock) !== token) return null;
      if (fs.existsSync(`${lock}.recovering`) || fs.existsSync(`${lock}.releasing`)) {
        this.releaseLock(claim);
        return null;
      }
      return claim;
    } catch (error) {
      if (fd !== null) fs.closeSync(fd);
      if (identity) {
        if (ownerPublished) this.releaseLock({ lock, token, identity, storage: staging });
        else this.retireObservedLock(lock, { ...identity, isDirectory: true }, null, `failed-${token}`);
      }
      if (!ownerPublished) fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private retireClaim(candidate: string, claim: RegistryLockClaim): boolean {
    const releasing = `${claim.lock}.releasing`;
    this.resolveInterruptedRelease(claim.lock);
    if (fs.existsSync(releasing)) return false;
    let candidateIsDirectory: boolean;
    try {
      candidateIsDirectory = fs.statSync(candidate).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (candidateIsDirectory) {
      try {
        fs.renameSync(candidate, releasing);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
        throw error;
      }
      if (!this.sameLock(releasing, claim.identity) || this.lockToken(releasing) !== claim.token) {
        this.restoreRecovery(candidate, releasing);
        return false;
      }
      fs.rmSync(releasing, { recursive: true, force: true });
      fs.rmSync(claim.storage, { recursive: true, force: true });
      return true;
    }
    try {
      fs.linkSync(candidate, releasing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code === "EEXIST") return false;
      throw error;
    }
    if (!this.sameLock(releasing, claim.identity) || this.lockToken(releasing) !== claim.token) {
      fs.rmSync(releasing, { force: true });
      return false;
    }
    if (this.sameLock(candidate, claim.identity) && this.lockToken(candidate) === claim.token) {
      fs.rmSync(candidate, { force: true });
    }
    fs.rmSync(releasing, { force: true });
    fs.rmSync(claim.storage, { recursive: true, force: true });
    return true;
  }

  private releaseLock(claim: RegistryLockClaim): void {
    for (const candidate of [claim.lock, `${claim.lock}.recovering`, claim.lock]) {
      if (!this.sameLock(candidate, claim.identity) || this.lockToken(candidate) !== claim.token) continue;
      if (this.retireClaim(candidate, claim)) return;
    }
  }

  private lockBackoff(attempt: number, remaining: number): number {
    const backoff = Math.min(5 * (2 ** Math.floor(attempt / 20)), REGISTRY_LOCK_BACKOFF_MAX_MS);
    return Math.min(backoff, remaining);
  }

  private acquireLock(lock: string, owner: ProcessIdentity): RegistryLockClaim {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    // Registry mutations stay queued while a verified writer remains live.
    // Dead and incomplete owners are recovered by tryAcquireLock().
    for (let attempt = 0; ; attempt += 1) {
      const claim = this.tryAcquireLock(lock, owner);
      if (claim) return claim;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.lockBackoff(attempt, REGISTRY_LOCK_BACKOFF_MAX_MS));
    }
  }

  private async acquireLockAsync(lock: string, owner: ProcessIdentity): Promise<RegistryLockClaim> {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    // Interactive callers stay queued while a verified owner remains live.
    // Dead and incomplete owners are recovered by tryAcquireLock().
    for (let attempt = 0; ; attempt += 1) {
      const claim = this.tryAcquireLock(lock, owner);
      if (claim) return claim;
      await this.lockTiming.wait(this.lockBackoff(attempt, REGISTRY_LOCK_BACKOFF_MAX_MS));
    }
  }

  private mutate<T>(fn: (file: RegistryFile) => T): T {
    const lock = `${this.filename}.write-lock`;
    const claim = this.acquireLock(lock, { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) });
    try {
      const file = readFile(this.filename);
      const result = fn(file);
      writeAtomic(this.filename, file);
      return result;
    } finally {
      this.releaseLock(claim);
    }
  }

  snapshot(): RegistryFile { return readFile(this.filename); }

  /** Create or replay a client-correlated durable launch receipt. Existing
      internal callers use beginSpawn() and receive an uncorrelated receipt. */
  beginSpawnRequest(input: SpawnRequest): SpawnBeginResult {
    return this.mutate((file) => {
      const conversationId = input.conversationId ? resolveConversationAlias(file, input.conversationId) : null;
      const parentConversationId = input.parentConversationId ? resolveConversationAlias(file, input.parentConversationId) : null;
      const reviewsConversationId = input.reviewsConversationId ? resolveConversationAlias(file, input.reviewsConversationId) : null;
      const role = typeof input.role === "string" && input.role.trim() ? input.role.trim() : null;
      if (role === "reviewer" && !reviewsConversationId) throw new Error("reviewer spawn requires reviewsConversationId");
      if (reviewsConversationId && role !== "reviewer") throw new Error("reviewsConversationId requires reviewer role");
      if (reviewsConversationId !== null && reviewsConversationId !== parentConversationId) {
        throw new Error("reviewer parent must be the reviewed conversation");
      }
      const existingConversation = conversationId ? file.conversations[conversationId] : null;
      const requestedProfile = emptyLaunchProfile({ cwd: input.cwd, ...(input.launchProfile ?? {}), parentConversationId });
      const currentProfile = existingConversation?.generations.at(-1)?.launchProfile;
      const profile = input.purpose === "resume-successor" && currentProfile
        ? mergeResumeLaunchProfile(currentProfile, requestedProfile)
        : requestedProfile;
      if (existingConversation && existingConversation.engine !== input.engine) {
        throw new Error("spawn conversation ownership is invalid");
      }
      if (input.purpose === "resume-successor" && existingConversation && !resumeCanRebaseMigration(existingConversation.migration)) {
        throw new Error("conversation migration prevents resume succession");
      }
      if (input.clientAttemptId) {
        const existing = Object.values(file.receipts).find((receipt) => receipt.clientAttemptId === input.clientAttemptId);
        if (existing) {
          const compatible = existing.requestDigest === (input.requestDigest ?? null) && existing.engine === input.engine && existing.cwd === input.cwd;
          return { kind: compatible ? "replay" : "conflict", receipt: clone(existing) };
        }
      }
      const createdAt = now();
      const receipt: SpawnReceipt = {
        launchId: crypto.randomUUID(),
        clientAttemptId: input.clientAttemptId ?? null,
        requestDigest: input.requestDigest ?? null,
        conversationId: conversationId ?? `conversation_${crypto.randomUUID()}`,
        purpose: input.purpose ?? "launch",
        resumeSourcePath: input.purpose === "resume-successor" ? existingConversation?.generations.at(-1)?.path ?? null : null,
        pathCorrelation: input.engine === "codex" && (input.purpose ?? "launch") === "launch"
          ? { cwd: input.cwd, startedAt: createdAt }
          : null,
        engine: input.engine,
        cwd: input.cwd,
        accountId: input.accountId ?? null,
        parentConversationId,
        createdAt,
        state: "starting",
        artifactPath: input.expectedArtifactPath ?? null,
        key: null,
        pane: null,
        verifiedHost: null,
        target: null,
        completionMode: null,
        error: null,
        launchProfile: profile,
      };
      file.receipts[receipt.launchId] = receipt;
      if (receipt.parentConversationId) {
        file.lineageEdges[receipt.conversationId] = {
          childConversationId: receipt.conversationId,
          parentConversationId: receipt.parentConversationId,
          childSessionKey: null,
          parentSessionKey: input.parentSessionKey ?? null,
          childArtifactPath: null,
          parentArtifactPath: input.parentArtifactPath ?? null,
          kind: reviewsConversationId ? "review" : "spawn",
          role,
          reviewsConversationId,
          source: "viewer-spawn",
          evidence: { launchId: receipt.launchId, clientAttemptId: receipt.clientAttemptId },
          createdAt: receipt.createdAt,
        };
      }
      for (const membership of input.memberships ?? []) {
        recordMembership(file, receipt.conversationId, membership, receipt.createdAt);
      }
      return { kind: "created", receipt: clone(receipt) };
    });
  }

  rememberMembership(conversationId: ViewerConversationId, membership: DurableMembershipInput): DurableConversationMembership {
    return this.mutate((file) => clone(recordMembership(file, conversationId, membership, now())));
  }

  beginSpawn(engine: AgentEngine, cwd: string, launchProfile: Partial<LaunchProfile> = {}): SpawnReceipt {
    const result = this.beginSpawnRequest({ engine, cwd, launchProfile });
    if (result.kind !== "created") throw new Error("could not create spawn receipt");
    return result.receipt;
  }

  bindSpawnPane(launchId: string, pane: TmuxSpawnBinding): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.pane && (receipt.pane.paneId !== pane.paneId || receipt.pane.server.startIdentity !== pane.server.startIdentity || receipt.pane.panePid.startIdentity !== pane.panePid.startIdentity)) {
        receipt.state = "conflicted";
        receipt.error = "spawn_pane_conflict";
        return clone(receipt);
      }
      if (receipt.state === "failed" || receipt.state === "conflicted") return clone(receipt);
      receipt.pane = { ...pane, display: pane.display ?? pane.target, target: pane.paneId };
      receipt.target = pane.paneId;
      if (receipt.state === "starting") receipt.state = "pane-bound";
      return clone(receipt);
    });
  }

  markSpawnHostVerified(launchId: string, host: TmuxHostEvidence): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (!receipt.pane ||
        receipt.pane.paneId !== host.paneId ||
        receipt.pane.server.pid !== host.server.pid ||
        receipt.pane.server.startIdentity !== host.server.startIdentity ||
        receipt.pane.panePid.pid !== host.panePid.pid ||
        receipt.pane.panePid.startIdentity !== host.panePid.startIdentity) {
        receipt.state = "conflicted";
        receipt.error = "spawn_host_identity_conflict";
        return clone(receipt);
      }
      if (receipt.state === "failed" || receipt.state === "conflicted") return clone(receipt);
      receipt.verifiedHost = host;
      receipt.target = host.paneId;
      if (receipt.state === "starting" || receipt.state === "pane-bound") receipt.state = "host-verified";
      return clone(receipt);
    });
  }

  markSpawnPromptDelivered(launchId: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.verifiedHost && (receipt.state === "host-verified" || receipt.state === "pane-bound" || receipt.state === "starting")) receipt.state = "prompt-delivered";
      return clone(receipt);
    });
  }

  markSpawnPathPending(launchId: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.verifiedHost && (receipt.state === "prompt-delivered" || receipt.state === "host-verified")) receipt.state = "path-pending";
      return clone(receipt);
    });
  }

  preserveSpawnArtifactOwnership(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state === "completed" || receipt.state === "failed") return;
      receipt.state = "path-pending";
      receipt.error = error;
      receipt.verifiedHost = null;
      receipt.target = null;
    });
  }

  private settleSpawnInFile(file: RegistryFile, launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">, completionMode: NonNullable<SpawnReceipt["completionMode"]>): SpawnSettlement {
    const receipt = file.receipts[launchId];
    if (!receipt) throw new Error("unknown spawn receipt");
    const prior = receipt.key ? file.entries[sessionKeyId(receipt.key)] : null;
    const conflict = (code: "spawn_artifact_conflict" | "spawn_pane_conflict" | "spawn_identity_conflict"): SpawnSettlement => {
      if (receipt.state !== "completed") {
        receipt.state = "conflicted";
        receipt.error = code;
      }
      return { kind: "conflict", receipt: clone(receipt), code };
    };
    if (receipt.state === "failed" || receipt.state === "conflicted") {
      return {
        kind: "conflict",
        receipt: clone(receipt),
        code: receipt.error === "spawn_artifact_conflict" || receipt.error === "spawn_pane_conflict" || receipt.error === "spawn_identity_conflict"
          ? receipt.error
          : "spawn_identity_conflict",
      };
    }
    if (receipt.engine !== entry.key.engine || receipt.cwd !== entry.cwd) return conflict("spawn_identity_conflict");
    if (receipt.pane && entry.host?.kind === "tmux" && (
      receipt.pane.paneId !== entry.host.paneId ||
      receipt.pane.server.pid !== entry.host.server.pid ||
      (receipt.pane.server.startIdentity !== null && entry.host.server.startIdentity !== receipt.pane.server.startIdentity) ||
      (receipt.pane.panePid.pid > 0 && receipt.pane.panePid.pid !== entry.host.panePid.pid) ||
      (receipt.pane.panePid.startIdentity !== null && entry.host.panePid.startIdentity !== receipt.pane.panePid.startIdentity)
    )) return conflict("spawn_pane_conflict");
    const existingConversation = file.conversations[receipt.conversationId];
    const ownedGeneration = existingConversation?.generations.find((generation) => generation.id === entry.key.sessionId);
    const successorNativeId = existingConversation
      ? sessionKeyFromTranscript(existingConversation.engine, entry.artifactPath)?.sessionId ?? nativeGenerationId(entry.artifactPath)
      : null;
    const advancesCompletedResume = receipt.state === "completed"
      && receipt.purpose === "resume-successor"
      && receipt.resumeSourcePath !== null
      && receipt.artifactPath === receipt.resumeSourcePath
      && receipt.artifactPath !== null
      && receipt.key !== null
      && existingConversation !== undefined
      && conversationOwnsPath(existingConversation, receipt.artifactPath)
      && conversationOwnsPath(existingConversation, entry.artifactPath)
      && sessionKeyId(receipt.key) === sessionKeyId(entry.key)
      && ownedGeneration?.id === entry.key.sessionId
      && successorNativeId === entry.key.sessionId;
    if (receipt.artifactPath && receipt.artifactPath !== entry.artifactPath && !advancesCompletedResume) return conflict("spawn_artifact_conflict");
    if (receipt.key && sessionKeyId(receipt.key) !== sessionKeyId(entry.key)) return conflict("spawn_identity_conflict");
    const occupied = file.entries[sessionKeyId(entry.key)];
    const occupiedPathOwned = occupied && existingConversation
      ? existingConversation.generations.some((generation) => generation.path === occupied.artifactPath)
        || existingConversation.continuityPaths.includes(occupied.artifactPath)
      : false;
    const replacesOwnedGeneration = receipt.purpose === "resume-successor"
      && occupiedPathOwned
      && ownedGeneration?.id === entry.key.sessionId
      && successorNativeId === entry.key.sessionId;
    if (occupied && occupied.artifactPath !== entry.artifactPath
      && (!prior || sessionKeyId(prior.key) !== sessionKeyId(entry.key))
      && !replacesOwnedGeneration) return conflict("spawn_artifact_conflict");

    const createdAt = now();
    const conversation = existingConversation ?? {
      id: receipt.conversationId,
      engine: receipt.engine as Extract<AgentEngine, "claude" | "codex">,
      generations: [],
      continuityPaths: [],
      abandonedContinuityPaths: [],
      migration: null,
      migrationOptOut: null,
      turn: { state: "unknown" as const, source: "empty" as const, terminalAt: null, observedAt: null },
      createdAt,
      updatedAt: createdAt,
    };
    if (conversation.engine !== receipt.engine) return conflict("spawn_identity_conflict");
    if (receipt.purpose === "resume-successor" && !resumeCanRebaseMigration(conversation.migration)) {
      return conflict("spawn_identity_conflict");
    }
    if (receipt.purpose === "migration-successor") {
      const provisionalOwner = Object.values(file.conversations).find((candidate) => candidate.id !== conversation.id
        && candidate.engine === conversation.engine && conversationOwnsPath(candidate, entry.artifactPath));
      if (provisionalOwner && !adoptProvisionalOwner(file, provisionalOwner, conversation, entry.artifactPath)) {
        return conflict("spawn_artifact_conflict");
      }
      addConversationContinuityPath(conversation, entry.artifactPath);
    }
    if (receipt.purpose === "launch") {
      const provisionalOwner = Object.values(file.conversations).find((candidate) => candidate.id !== conversation.id
        && candidate.engine === conversation.engine && conversationOwnsPath(candidate, entry.artifactPath));
      if (provisionalOwner && !adoptProvisionalOwner(file, provisionalOwner, conversation, entry.artifactPath)) {
        return conflict("spawn_artifact_conflict");
      }
    }
    if (receipt.purpose === "resume-successor" && !conversationOwnsPath(conversation, entry.artifactPath)) {
      const provisionalOwner = Object.values(file.conversations).find((candidate) => candidate.id !== conversation.id
        && candidate.engine === conversation.engine && conversationOwnsPath(candidate, entry.artifactPath));
      if (provisionalOwner && !adoptProvisionalOwner(file, provisionalOwner, conversation, entry.artifactPath)) {
        return conflict("spawn_artifact_conflict");
      }
      const nativeId = sessionKeyFromTranscript(conversation.engine, entry.artifactPath)?.sessionId ?? nativeGenerationId(entry.artifactPath);
      const continued = conversation.generations.find((generation) => generation.id === nativeId);
      if (continued) {
        if (!conversation.continuityPaths.includes(continued.path)) conversation.continuityPaths.push(continued.path);
        continued.path = entry.artifactPath;
        continued.accountId = receipt.accountId ?? continued.accountId;
        continued.launchProfile = { ...continued.launchProfile, ...receipt.launchProfile };
      } else {
        const previous = conversation.generations.at(-1);
        if (previous && previous.archivedAt === null) previous.archivedAt = createdAt;
        conversation.generations.push({
          id: nativeId,
          path: entry.artifactPath,
          accountId: receipt.accountId,
          launchProfile: receipt.launchProfile,
          historyHash: null,
          host: null,
          createdAt,
          archivedAt: null,
        });
      }
      file.conversationRevision[conversation.engine] += 1;
      file.engineRouting[conversation.engine].revision += 1;
      if (conversation.migration && (conversation.migration.phase === "waiting-turn" || conversation.migration.phase === "requested")) {
        const resumedSource = conversation.generations.at(-1);
        if (resumedSource) {
          conversation.migration = {
            ...conversation.migration,
            sourceGenerationId: resumedSource.id,
            updatedAt: createdAt,
          };
        }
      }
    }
    if (receipt.purpose !== "migration-successor" && !conversation.generations.some((generation) => generation.path === entry.artifactPath)) {
      conversation.generations.push({
        id: nativeGenerationId(entry.artifactPath),
        path: entry.artifactPath,
        accountId: receipt.accountId,
        launchProfile: receipt.launchProfile,
        historyHash: null,
        host: null,
        createdAt,
        archivedAt: null,
      });
      file.conversationRevision[conversation.engine] += 1;
      file.engineRouting[conversation.engine].revision += 1;
    }
    /* A spawn that began before an account switch remains attributable to its
       birth account. The already-active migration intent still applies to the
       new conversation through the existing coordinator contract. */
    const activeIntent = Object.values(file.migrationIntents).find((intent) => intent.engine === conversation.engine && intent.state === "draining");
    const source = conversation.generations.at(-1);
    if (activeIntent && source && source.accountId !== activeIntent.targetId && !conversation.migration) {
      conversation.migration = {
        intentId: activeIntent.id,
        phase: conversation.turn.state === "busy" || conversation.turn.state === "unknown" ? "waiting-turn" : "requested",
        targetId: activeIntent.targetId,
        revision: activeIntent.revision,
        error: null,
        errorCode: null,
        operationId: crypto.randomUUID(),
        sourceGenerationId: source.id,
        providerReceipt: null,
        pendingContinuityPaths: [],
        boardProject: null,
        boardOperationId: null,
        boardPlacementProject: source.launchProfile.project,
        updatedAt: createdAt,
      };
    }
    conversation.updatedAt = createdAt;
    file.conversations[conversation.id] = conversation;

    const full: AgentRegistryEntry = {
      ...entry,
      accountId: receipt.accountId,
      launchProfile: receipt.launchProfile,
      updatedAt: createdAt,
    };
    file.entries[sessionKeyId(entry.key)] = full;
    receipt.key = entry.key;
    receipt.artifactPath = entry.artifactPath;
    const lineage = file.lineageEdges[receipt.conversationId];
    if (lineage) {
      lineage.childSessionKey = entry.key;
      lineage.childArtifactPath = entry.artifactPath;
    }
    if (entry.host?.kind === "tmux") receipt.verifiedHost = entry.host;
    if (receipt.target === null && entry.host?.kind === "tmux") receipt.target = entry.host.paneId;
    receipt.state = "completed";
    receipt.error = null;
    receipt.completionMode = receipt.completionMode === "observed-completed" && completionMode === "route-completed"
      ? "route-recovered"
      : receipt.completionMode ?? completionMode;
    return { kind: "settled", receipt: clone(receipt), entry: clone(full), conversation: clone(conversation) };
  }

  settleSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">, completionMode: NonNullable<SpawnReceipt["completionMode"]> = "route-completed"): SpawnSettlement {
    return this.mutate((file) => {
      const paths = new Set([entry.artifactPath]);
      const signature = migrationReadinessSignature(file, entry.key.engine, paths);
      const settled = this.settleSpawnInFile(file, launchId, entry, completionMode);
      advanceMigrationScopeRevision(file, entry.key.engine, signature, paths);
      return settled;
    });
  }

  completeSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    const outcome = this.settleSpawn(launchId, entry);
    if (outcome.kind === "conflict") throw new Error(outcome.code);
    return outcome.entry;
  }

  failSpawn(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted") return;
      receipt.state = receipt.pane ? "conflicted" : "failed";
      receipt.error = error;
      if (receipt.state === "conflicted") receipt.verifiedHost = null;
    });
  }

  invalidateSpawnHost(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state === "failed" || receipt.state === "conflicted") return;
      receipt.state = "conflicted";
      receipt.error = error;
      receipt.verifiedHost = null;
    });
  }

  upsert(entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const keyId = sessionKeyId(entry.key);
      const existing = file.entries[keyId];
      const replacement = entry.structuredHost === undefined && existing?.structuredHost !== undefined
        ? { ...entry, structuredHost: existing.structuredHost }
        : entry;
      const changedHostPaths = activeHostPathsChangedByEntry(file, keyId, replacement);
      const readinessBefore = migrationReadinessSignature(file, entry.key.engine, changedHostPaths);
      const full = { ...replacement, updatedAt: now() };
      file.entries[keyId] = full;
      advanceMigrationScopeRevision(file, entry.key.engine, readinessBefore, changedHostPaths);
      return clone(full);
    });
  }

  setStructuredHost(
    key: SessionKey,
    structuredHost: StructuredHostColumns | null,
    status?: AgentHostStatus,
  ): AgentRegistryEntry {
    return this.mutate((file) => {
      const keyId = sessionKeyId(key);
      const entry = file.entries[keyId];
      if (!entry) throw new Error("agent registry entry is missing");
      const replacement = {
        ...entry,
        structuredHost: structuredHost ? normalizeStructuredHost(structuredHost) : null,
        status: status ?? entry.status,
      };
      const changedHostPaths = activeHostPathsChangedByEntry(file, keyId, replacement);
      const readinessBefore = migrationReadinessSignature(file, key.engine, changedHostPaths);
      entry.structuredHost = structuredHost ? normalizeStructuredHost(structuredHost) : null;
      if (status) entry.status = status;
      entry.updatedAt = now();
      advanceMigrationScopeRevision(file, key.engine, readinessBefore, changedHostPaths);
      return clone(entry);
    });
  }

  /** Writes mutable host state only while the caller still owns its writer fence. */
  setStructuredHostClaimed(
    key: SessionKey,
    structuredHost: StructuredHostColumns,
    status: AgentHostStatus,
    claimOwner: string,
    claimEpoch: number,
    releaseClaim = false,
  ): AgentRegistryEntry | null {
    return this.mutate((file) => {
      const keyId = sessionKeyId(key);
      const entry = file.entries[keyId];
      if (!entry?.structuredHost
        || entry.claimOwner !== claimOwner
        || entry.claimEpoch !== claimEpoch
        || entry.structuredHost.writerClaimEpoch !== claimEpoch) return null;
      const replacement = {
        ...entry,
        structuredHost: normalizeStructuredHost(structuredHost),
        status,
      };
      const changedHostPaths = activeHostPathsChangedByEntry(file, keyId, replacement);
      const readinessBefore = migrationReadinessSignature(file, key.engine, changedHostPaths);
      entry.structuredHost = replacement.structuredHost;
      entry.status = status;
      if (releaseClaim) entry.claimOwner = null;
      entry.updatedAt = now();
      advanceMigrationScopeRevision(file, key.engine, readinessBefore, changedHostPaths);
      return clone(entry);
    });
  }

  ownsStructuredHostClaim(key: SessionKey, claimOwner: string, claimEpoch: number): boolean {
    const entry = this.snapshot().entries[sessionKeyId(key)];
    return entry?.claimOwner === claimOwner
      && entry.claimEpoch === claimEpoch
      && entry.structuredHost?.writerClaimEpoch === claimEpoch;
  }

  /** Atomically claims a stale structured row and advances its writer fence. */
  claimStructuredHost(
    key: SessionKey,
    owner: ProcessIdentity,
    options: { allowUnhosted?: boolean } = {},
  ): AgentRegistryEntry | null {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry?.structuredHost) return null;
      if (entry.status === "unhosted" && options.allowUnhosted !== true) return null;
      const liveHost = entry.structuredHost.process;
      if (liveHost && this.ownerAlive(liveHost)) return null;
      const requestedOwner = structuredClaimOwner(owner);
      if (entry.claimOwner) {
        const priorOwner = structuredClaimIdentity(entry.claimOwner);
        if (!priorOwner || this.ownerAlive(priorOwner)) return null;
      }
      entry.claimOwner = requestedOwner;
      entry.claimEpoch += 1;
      entry.structuredHost.writerClaimEpoch = entry.claimEpoch;
      entry.updatedAt = now();
      return clone(entry);
    });
  }

  markUnhosted(key: SessionKey): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) return;
      const status = entry.structuredHost?.process ? entry.status : "unhosted";
      const replacement = { ...entry, host: null, status };
      const changedHostPaths = activeHostPathsChangedByEntry(file, sessionKeyId(key), replacement);
      const readinessBefore = migrationReadinessSignature(file, key.engine, changedHostPaths);
      entry.host = null;
      entry.status = status;
      entry.updatedAt = now();
      advanceMigrationScopeRevision(file, key.engine, readinessBefore, changedHostPaths);
    });
  }

  claim(key: SessionKey, owner: string): AgentRegistryEntry {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) throw new Error("agent registry entry is missing");
      if (entry.claimOwner && entry.claimOwner !== owner) throw new Error("agent session is claimed by another operation");
      entry.claimOwner = owner;
      entry.claimEpoch += 1;
      entry.updatedAt = now();
      return clone(entry);
    });
  }

  releaseClaim(key: SessionKey, owner: string): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (entry?.claimOwner === owner) {
        entry.claimOwner = null;
        entry.updatedAt = now();
      }
    });
  }

  /** Releases a structured writer only while both ownership fences still match. */
  releaseStructuredHostClaim(key: SessionKey, owner: string, claimEpoch: number): boolean {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry?.structuredHost
        || entry.claimOwner !== owner
        || entry.claimEpoch !== claimEpoch
        || entry.structuredHost.writerClaimEpoch !== claimEpoch) return false;
      entry.claimOwner = null;
      entry.updatedAt = now();
      return true;
    });
  }

  /** Cross-process operation lock. Stale owners include their process start
      identity and may be recovered by an explicit caller after verification. */
  async withOperationLock<T>(key: SessionKey, owner: ProcessIdentity, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.filename}.locks/${encodeURIComponent(sessionKeyId(key))}`;
    const claim = await this.acquireLockAsync(lock, owner);
    try {
      return await fn();
    } finally {
      this.releaseLock(claim);
    }
  }

  importResumePanes(serverPid: number, records: Map<string, ResumePaneRecord>): void {
    this.mutate((file) => {
      if (file.importedResumePanes && file.legacyResumePanes.serverPid === serverPid) return;
      file.legacyResumePanes = { serverPid, panes: Object.fromEntries(records) };
      file.importedResumePanes = true;
    });
  }

  resumePanes(serverPid: number): Map<string, ResumePaneRecord> {
    const saved = this.snapshot().legacyResumePanes;
    return saved.serverPid === serverPid ? new Map(Object.entries(saved.panes)) : new Map();
  }

  rememberResumePane(serverPid: number, pathname: string, record: ResumePaneRecord): void {
    this.mutate((file) => {
      if (file.legacyResumePanes.serverPid !== serverPid) file.legacyResumePanes = { serverPid, panes: {} };
      file.legacyResumePanes.panes[pathname] = record;
      file.importedResumePanes = true;
    });
  }

  reconcileSpawnReceipts(live: Iterable<SessionKey>): void {
    const liveIds = new Set([...live].map(sessionKeyId));
    this.mutate((file) => {
      for (const entry of Object.values(file.entries)) {
        if (liveIds.has(sessionKeyId(entry.key))) entry.pendingAction = null;
      }
      for (const receipt of Object.values(file.receipts)) {
        if (receipt.state !== "starting" || !receipt.artifactPath) continue;
        const key = Object.values(file.entries).find((entry) => entry.artifactPath === receipt.artifactPath)?.key;
        if (key && liveIds.has(sessionKeyId(key))) receipt.state = "completed";
      }
    });
  }

  /** Observation may enrich only the receipt named by the pane marker. Engine
      and cwd are validation evidence; they never select a launch receipt. */
  completeObservedSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): SpawnSettlement {
    return this.settleSpawn(launchId, entry, "observed-completed");
  }

  /** Allocates one Viewer-owned identity for every native generation. Paths
      remain an interoperability detail and can change on every account move. */
  ensureConversation(engine: Extract<AgentEngine, "claude" | "codex">, artifactPath: string, accountId: string | null): RegistryConversation {
    return this.mutate((file) => {
      const existing = Object.values(file.conversations).find((conversation) => conversation.engine === engine && conversationOwnsPath(conversation, artifactPath));
      if (existing) return clone(existing);
      const createdAt = now();
      const conversation: RegistryConversation = {
        id: `conversation_${crypto.randomUUID()}`,
        engine,
        generations: [{
          id: nativeGenerationId(artifactPath),
          path: artifactPath,
          accountId,
          launchProfile: emptyLaunchProfile(),
          historyHash: null,
          host: null,
          createdAt,
          archivedAt: null,
        }],
        continuityPaths: [],
        abandonedContinuityPaths: [],
        migration: null,
        migrationOptOut: null,
        turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
        createdAt,
        updatedAt: createdAt,
      };
      file.conversations[conversation.id] = conversation;
      file.conversationRevision[engine] += 1;
      file.engineRouting[engine].revision += 1;
      return clone(conversation);
    });
  }

  /** One inventory transaction owns identity allocation, launch-profile
      backfill, account provenance, and authoritative turn observations. */
  reconcileConversations(observations: ConversationObservation[]): RegistryFile {
    return this.mutate((file) => {
      const scopeChanged = new Set<Extract<AgentEngine, "claude" | "codex">>();
      const firstPathByNativeSession = new Map<string, string>();
      const pathPendingLaunches = correlatePathPendingReceipts(file, observations);
      const conversationsByPath = new Map<string, RegistryConversation[]>();
      const conversationsByNativeSession = new Map<string, RegistryConversation[]>();
      const indexConversation = (conversation: RegistryConversation) => {
        for (const generation of conversation.generations) {
          const pathOwners = conversationsByPath.get(generation.path) ?? [];
          if (!pathOwners.includes(conversation)) pathOwners.push(conversation);
          conversationsByPath.set(generation.path, pathOwners);
          const nativeOwners = conversationsByNativeSession.get(`${conversation.engine}:${generation.id}`) ?? [];
          if (!nativeOwners.includes(conversation)) nativeOwners.push(conversation);
          conversationsByNativeSession.set(`${conversation.engine}:${generation.id}`, nativeOwners);
        }
        for (const pathname of conversation.continuityPaths) {
          const owners = conversationsByPath.get(pathname) ?? [];
          if (!owners.includes(conversation)) owners.push(conversation);
          conversationsByPath.set(pathname, owners);
        }
      };
      for (const conversation of Object.values(file.conversations)) indexConversation(conversation);
      const resumeReceiptsByConversation = new Map<ViewerConversationId, SpawnReceipt[]>();
      const refreshResumeReceiptIndex = () => {
        resumeReceiptsByConversation.clear();
        for (const receipt of Object.values(file.receipts)) {
          if (receipt.purpose !== "resume-successor") continue;
          const conversationId = resolveConversationAlias(file, receipt.conversationId);
          const receipts = resumeReceiptsByConversation.get(conversationId) ?? [];
          receipts.push(receipt);
          resumeReceiptsByConversation.set(conversationId, receipts);
        }
      };
      refreshResumeReceiptIndex();
      const migrationReceiptByPath = new Map<string, SpawnReceipt>();
      for (const receipt of Object.values(file.receipts)) {
        const receiptPath = receipt.artifactPath ? `${receipt.engine}:${receipt.artifactPath}` : null;
        if (receiptPath && receipt.purpose === "migration-successor"
          && receipt.state !== "failed" && receipt.state !== "conflicted"
          && !migrationReceiptByPath.has(receiptPath)) {
          migrationReceiptByPath.set(receiptPath, receipt);
        }
      }
      for (const observation of observations) {
        const nativeId = sessionKeyFromTranscript(observation.engine, observation.path)?.sessionId ?? null;
        const pathPendingLaunchId = pathPendingLaunches.get(observation.path);
        if (nativeId && pathPendingLaunchId) {
          const pathPendingReceipt = file.receipts[pathPendingLaunchId];
          const recovered = pathPendingReceipt ? this.settleSpawnInFile(file, pathPendingLaunchId, {
            key: { engine: observation.engine, sessionId: nativeId },
            artifactPath: observation.path,
            cwd: pathPendingReceipt.cwd,
            accountId: pathPendingReceipt.accountId,
            status: "unhosted",
            host: null,
            claimEpoch: 0,
            claimOwner: null,
            pendingAction: null,
          }, "observed-completed") : null;
          if (recovered?.kind === "settled") {
            scopeChanged.add(observation.engine);
            refreshResumeReceiptIndex();
            const recoveredConversation = file.conversations[resolveConversationAlias(file, pathPendingReceipt!.conversationId)];
            if (recoveredConversation) indexConversation(recoveredConversation);
          }
        }
        const exactOwners = (conversationsByPath.get(observation.path) ?? []).filter((candidate) =>
          file.conversations[candidate.id] === candidate
          && candidate.engine === observation.engine
          && conversationOwnsPath(candidate, observation.path));
        let exactOwner = preferredConversationOwner(file, exactOwners);
        if (exactOwner) {
          let ownerAdopted = false;
          for (const duplicate of exactOwners) {
            if (duplicate.id !== exactOwner.id && scannerAllocatedProvisionalOwner(duplicate, observation.path)) {
              ownerAdopted = adoptProvisionalOwner(file, duplicate, exactOwner, observation.path) || ownerAdopted;
            }
          }
          if (ownerAdopted) refreshResumeReceiptIndex();
        }
        const nativeSessionId = nativeId ? `${observation.engine}:${nativeId}` : null;
        const firstObservedPath = nativeSessionId ? firstPathByNativeSession.get(nativeSessionId) : undefined;
        if (nativeSessionId && firstObservedPath === undefined) firstPathByNativeSession.set(nativeSessionId, observation.path);
        const nativeOwner = nativeId ? preferredConversationOwner(file, (conversationsByNativeSession.get(`${observation.engine}:${nativeId}`) ?? [])
          .filter((candidate) => file.conversations[candidate.id] === candidate
            && candidate.generations.some((generation) => generation.id === nativeId))) : null;
        const resumeInventoryFenced = nativeOwner !== null
          && !resumeCanRebaseMigration(nativeOwner.migration)
          && (resumeReceiptsByConversation.get(nativeOwner.id) ?? []).some(receiptStillAwaitsResumeSuccessor);
        let conversation = exactOwner ?? nativeOwner ?? null;
        let adoptedSuccessorPath = false;
        if (!resumeInventoryFenced && exactOwner && nativeOwner && exactOwner.id !== nativeOwner.id
          && adoptProvisionalOwner(file, exactOwner, nativeOwner, observation.path)) {
          exactOwner = nativeOwner;
          conversation = nativeOwner;
          adoptedSuccessorPath = true;
          refreshResumeReceiptIndex();
        }
        if (!resumeInventoryFenced && (!exactOwner || adoptedSuccessorPath) && nativeOwner && nativeId) {
          const generation = nativeOwner.generations.find((candidate) => candidate.id === nativeId);
          if (generation && generation.path !== observation.path) {
            if (firstObservedPath === undefined || firstObservedPath === observation.path) {
              if (!nativeOwner.continuityPaths.includes(generation.path)) nativeOwner.continuityPaths.push(generation.path);
              generation.path = observation.path;
            } else if (!nativeOwner.continuityPaths.includes(observation.path)) {
              nativeOwner.continuityPaths.push(observation.path);
            }
            nativeOwner.updatedAt = observation.observedAt;
            indexConversation(nativeOwner);
            scopeChanged.add(observation.engine);
          }
        }
        if (!conversation) {
          const migrationReceipt = migrationReceiptByPath.get(`${observation.engine}:${observation.path}`);
          const migrationOwner = migrationReceipt ? file.conversations[migrationReceipt.conversationId] : null;
          if (migrationOwner) {
            conversation = migrationOwner;
            addConversationContinuityPath(conversation, observation.path);
            indexConversation(conversation);
            conversation.updatedAt = observation.observedAt;
            scopeChanged.add(observation.engine);
          }
        }
        if (!conversation) {
          const createdAt = observation.observedAt;
          conversation = {
            id: `conversation_${crypto.randomUUID()}`,
            engine: observation.engine,
            generations: [{
              id: nativeGenerationId(observation.path),
              path: observation.path,
              accountId: observation.accountId,
              launchProfile: emptyLaunchProfile(observation.launchProfile),
              historyHash: null,
              host: null,
              createdAt,
              archivedAt: null,
            }],
            continuityPaths: [],
            abandonedContinuityPaths: [],
            migration: null,
            migrationOptOut: null,
            turn: { ...observation.turn, observedAt: observation.observedAt },
            createdAt,
            updatedAt: createdAt,
          };
          file.conversations[conversation.id] = conversation;
          indexConversation(conversation);
          recordObservedLineage(file, conversation, observation.path, observation.observedAt);
          scopeChanged.add(observation.engine);
          continue;
        }
        const generation = conversation.generations.find((candidate) => candidate.path === observation.path);
        if (!generation) continue;
        const priorAccountId = generation.accountId;
        const priorRole = generation.launchProfile.role;
        const priorTurnState = conversation.turn.state;
        const lineage = file.lineageEdges[conversation.id];
        const observedParentConversationId = observation.launchProfile.parentConversationId;
        generation.accountId = observation.accountId ?? generation.accountId;
        generation.launchProfile = {
          ...generation.launchProfile,
          ...observation.launchProfile,
          cwd: generation.launchProfile.cwd || observation.launchProfile.cwd,
          model: generation.launchProfile.model ?? observation.launchProfile.model,
          effort: generation.launchProfile.effort ?? observation.launchProfile.effort,
          fast: generation.launchProfile.fast ?? observation.launchProfile.fast,
          permissionMode: generation.launchProfile.permissionMode ?? observation.launchProfile.permissionMode,
          readOnly: generation.launchProfile.readOnly ?? observation.launchProfile.readOnly,
          title: generation.launchProfile.title ?? observation.launchProfile.title,
          project: observation.launchProfile.project ?? generation.launchProfile.project,
          parentConversationId: lineage?.source === "viewer-spawn"
            ? lineage.parentConversationId
            : observedParentConversationId ?? generation.launchProfile.parentConversationId,
          role: generation.launchProfile.role === "root" || observation.launchProfile.role === "root" ? "root" : "worker",
          goal: observation.launchProfile.goal ?? generation.launchProfile.goal,
          plan: observation.launchProfile.plan ?? generation.launchProfile.plan,
        };
        recordObservedLineage(file, conversation, observation.path, observation.observedAt);
        const turnBaseStillCurrent = observation.expectedTurnObservedAt === undefined
          || observation.expectedTurnObservedAt === conversation.turn.observedAt;
        if (turnBaseStillCurrent && observationIsCurrent(conversation.turn.observedAt, observation.observedAt)) {
          conversation.turn = { ...observation.turn, observedAt: observation.observedAt };
        }
        if (observationIsCurrent(conversation.updatedAt, observation.observedAt)) {
          conversation.updatedAt = observation.observedAt;
        }
        if (priorAccountId !== generation.accountId || priorRole !== generation.launchProfile.role || priorTurnState !== conversation.turn.state) {
          scopeChanged.add(observation.engine);
        }
      }
      for (const engine of scopeChanged) {
        file.conversationRevision[engine] += 1;
        file.engineRouting[engine].revision += 1;
      }
      return clone(file);
    });
  }

  conversationForPath(artifactPath: string): RegistryConversation | null {
    return Object.values(this.snapshot().conversations).find((conversation) => conversationOwnsPath(conversation, artifactPath)) ?? null;
  }

  canonicalConversationId(id: ViewerConversationId): ViewerConversationId {
    return resolveConversationAlias(this.snapshot(), id);
  }

  conversation(id: ViewerConversationId): RegistryConversation | null {
    const snapshot = this.snapshot();
    return snapshot.conversations[resolveConversationAlias(snapshot, id)] ?? null;
  }

  launchProfileForPath(artifactPath: string): LaunchProfile | null {
    const snapshot = this.snapshot();
    for (const conversation of Object.values(snapshot.conversations)) {
      const generation = conversation.generations.find((item) => item.path === artifactPath);
      if (generation) return clone(generation.launchProfile);
      if (conversation.continuityPaths.includes(artifactPath)) {
        const current = conversation.generations.at(-1);
        if (current) return clone(current.launchProfile);
      }
    }
    const receipt = Object.values(snapshot.receipts).find((item) => item.artifactPath === artifactPath);
    return receipt ? clone(receipt.launchProfile) : null;
  }

  canonicalPath(artifactPath: string): string {
    const conversation = this.conversationForPath(artifactPath);
    return conversation?.generations.at(-1)?.path ?? artifactPath;
  }

  setEngineRouting(engine: Extract<AgentEngine, "claude" | "codex">, accountId: string): number {
    return withAccountMutationLock(() => this.mutate((file) => {
      const route = file.engineRouting[engine];
      route.activeAccountId = accountId;
      route.revision += 1;
      return route.revision;
    }));
  }

  engineRouting(engine: Extract<AgentEngine, "claude" | "codex">): { activeAccountId: string | null; revision: number } {
    return clone(this.snapshot().engineRouting[engine]);
  }

  migrationScope(engine: Extract<AgentEngine, "claude" | "codex">, targetId: string): MigrationScopeCounts {
    return migrationScopeCounts(this.snapshot(), engine, targetId);
  }

  retireAccount(engine: Extract<AgentEngine, "claude" | "codex">, accountId: string, fallbackAccountId: string): void {
    withAccountMutationLock(() => this.mutate((file) => {
      const currentConversation = Object.values(file.conversations).find((conversation) =>
        conversation.engine === engine && conversation.generations.at(-1)?.accountId === accountId);
      if (currentConversation) throw new Error("account has current conversations");
      const changedAt = now();
      const route = file.engineRouting[engine];
      if (route.activeAccountId === accountId) {
        route.activeAccountId = fallbackAccountId;
        route.revision += 1;
      }
      const retiredIntentIds = new Set<string>();
      for (const intent of Object.values(file.migrationIntents)) {
        if (intent.engine !== engine || intent.targetId !== accountId) continue;
        retiredIntentIds.add(intent.id);
        if (intent.state === "stopped") continue;
        intent.state = "stopped";
        intent.revision += 1;
        intent.updatedAt = changedAt;
        intent.stoppedAt = changedAt;
      }
      if (retiredIntentIds.size === 0) return;
      for (const conversation of Object.values(file.conversations)) {
        if (!conversation.migration || !retiredIntentIds.has(conversation.migration.intentId)) continue;
        abandonPendingContinuityPaths(conversation);
        queueAbandonedMigrationCleanup(file, conversation, changedAt);
        const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
          ?? conversation.generations.at(-1);
        if (source) {
          for (const delivery of Object.values(file.heldDeliveries)) {
            if (delivery.conversationId !== conversation.id || delivery.state === "delivered" || delivery.state === "delivery-uncertain") continue;
            delivery.state = "assigned";
            delivery.generationId = source.id;
            delivery.assignedAt = changedAt;
            delivery.error = null;
          }
        }
        conversation.migration = null;
        conversation.updatedAt = changedAt;
        file.conversationRevision[conversation.engine] += 1;
      }
    }));
  }

  commitMigrationIntent(input: {
    engine: Extract<AgentEngine, "claude" | "codex">;
    targetId: string;
    origin: MigrationOrigin;
    requestId: string;
    expectedRevision: number;
    evidence?: MigrationIntent["evidence"];
    scope?: MigrationScope;
  }): MigrationIntent {
    return withAccountMutationLock(() => this.mutate((file) => {
      const repeated = Object.values(file.migrationIntents).find((intent) =>
        intent.engine === input.engine && intent.requestIds.includes(input.requestId));
      if (repeated) return clone(repeated);
      const route = file.engineRouting[input.engine];
      if (route.revision !== input.expectedRevision) throw new MigrationRevisionError(input.expectedRevision, route.revision);
      let intent = Object.values(file.migrationIntents).find((candidate) => candidate.engine === input.engine && candidate.state === "draining");
      if (intent?.origin === "manual" && input.origin === "auto") return clone(intent);
      const changedAt = now();
      if (intent) {
        intent.requestIds.push(input.requestId);
        intent.targetId = input.targetId;
        intent.origin = input.origin;
        intent.revision += 1;
        intent.evidence = input.evidence ?? null;
        intent.updatedAt = changedAt;
      } else {
        intent = {
          id: crypto.randomUUID(),
          engine: input.engine,
          targetId: input.targetId,
          origin: input.origin,
          revision: 1,
          state: "draining",
          createdAt: changedAt,
          updatedAt: changedAt,
          requestIds: [input.requestId],
          evidence: input.evidence ?? null,
          stoppedAt: null,
        };
        file.migrationIntents[intent.id] = intent;
      }
      route.activeAccountId = input.targetId;
      route.revision += 1;

      let scoped = 0;
      for (const conversation of Object.values(file.conversations)) {
        if (conversation.engine !== input.engine) continue;
        if (input.origin === "manual" && conversation.migrationOptOut?.targetId === input.targetId) {
          conversation.migrationOptOut = null;
        }
        if (input.origin === "auto" && conversation.migrationOptOut?.targetId === input.targetId) continue;
        const source = conversation.generations.at(-1);
        if (!source || source.accountId === null || source.accountId === input.targetId) {
          if (source && conversation.migration && conversation.migration.phase !== "committed") {
            abandonPendingContinuityPaths(conversation);
            queueAbandonedMigrationCleanup(file, conversation, changedAt);
            for (const delivery of Object.values(file.heldDeliveries)) {
              if (delivery.conversationId !== conversation.id
                || delivery.state === "delivered"
                || delivery.state === "delivery-uncertain") continue;
              delivery.state = "assigned";
              delivery.generationId = source.id;
              delivery.assignedAt = changedAt;
              delivery.error = null;
            }
            conversation.migration = null;
            conversation.updatedAt = changedAt;
          }
          continue;
        }
        const readiness = migrationReadiness(file, conversation);
        if ((input.scope ?? "all") === "active" && readiness === "deferred") continue;
        scoped += 1;
        queueAbandonedMigrationCleanup(file, conversation, changedAt);
        conversation.migration = conversationMigrationForIntent(
          conversation,
          source,
          intent,
          readiness === "busy" ? "waiting-turn" : "requested",
          changedAt,
        );
        conversation.updatedAt = changedAt;
      }
      if (scoped === 0) intent.state = "complete";
      return clone(intent);
    }));
  }

  requestConversationMigrationToActiveAccount(id: ViewerConversationId): RegistryConversation {
    return this.mutate((file) => {
      const canonicalId = resolveConversationAlias(file, id);
      const conversation = file.conversations[canonicalId];
      if (!conversation) throw new Error("viewer conversation is unknown");
      const targetId = file.engineRouting[conversation.engine].activeAccountId;
      const source = conversation.generations.at(-1);
      if (!targetId || !source || source.accountId === null || source.accountId === targetId) return clone(conversation);
      if (conversation.migrationOptOut?.targetId === targetId) return clone(conversation);
      if (conversation.migration?.targetId === targetId
        && !["committed", "rolled-back", "failed-recoverable"].includes(conversation.migration.phase)) {
        return clone(conversation);
      }

      const changedAt = now();
      let intent = Object.values(file.migrationIntents)
        .filter((candidate) => candidate.engine === conversation.engine && candidate.targetId === targetId && candidate.state !== "stopped")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!intent) {
        intent = {
          id: crypto.randomUUID(),
          engine: conversation.engine,
          targetId,
          origin: "manual",
          revision: 1,
          state: "draining",
          createdAt: changedAt,
          updatedAt: changedAt,
          requestIds: [`lazy:${file.engineRouting[conversation.engine].revision}:${canonicalId}`],
          evidence: null,
          stoppedAt: null,
        };
        file.migrationIntents[intent.id] = intent;
      } else {
        if (intent.state !== "draining") intent.revision += 1;
        intent.state = "draining";
        intent.updatedAt = changedAt;
      }

      const phase = migrationReadiness(file, conversation) === "busy" ? "waiting-turn" : "requested";
      queueAbandonedMigrationCleanup(file, conversation, changedAt);
      conversation.migration = conversationMigrationForIntent(conversation, source, intent, phase, changedAt);
      conversation.updatedAt = changedAt;
      file.conversationRevision[conversation.engine] += 1;
      file.engineRouting[conversation.engine].revision += 1;
      return clone(conversation);
    });
  }

  upsertMigrationIntent(engine: Extract<AgentEngine, "claude" | "codex">, targetId: string, origin: MigrationOrigin, requestId: string, evidence: MigrationIntent["evidence"] = null): MigrationIntent {
    return this.mutate((file) => {
      const active = Object.values(file.migrationIntents).find((intent) => intent.engine === engine && intent.state === "draining");
      if (active) {
        if (active.origin === "manual" && origin === "auto") return clone(active);
        if (!active.requestIds.includes(requestId)) active.requestIds.push(requestId);
        if (active.targetId !== targetId || active.origin !== origin) { active.targetId = targetId; active.origin = origin; active.revision += 1; active.evidence = evidence; }
        active.updatedAt = now();
        return clone(active);
      }
      const createdAt = now();
      const intent: MigrationIntent = { id: crypto.randomUUID(), engine, targetId, origin, revision: 1, state: "draining", createdAt, updatedAt: createdAt, requestIds: [requestId], evidence, stoppedAt: null };
      file.migrationIntents[intent.id] = intent;
      return clone(intent);
    });
  }

  setConversationMigration(id: ViewerConversationId, migration: ConversationMigrationInput | null): RegistryConversation {
    return this.mutate((file) => {
      const canonicalId = resolveConversationAlias(file, id);
      const conversation = file.conversations[canonicalId];
      if (!conversation) throw new Error("viewer conversation is unknown");
      const source = conversation.generations.at(-1);
      conversation.migration = migration ? {
        ...migration,
        errorCode: migration.errorCode ?? null,
        operationId: migration.operationId ?? `${migration.intentId}:${canonicalId}:${migration.revision}`,
        sourceGenerationId: migration.sourceGenerationId ?? source?.id ?? "",
        providerReceipt: migration.providerReceipt ?? null,
        pendingContinuityPaths: migration.pendingContinuityPaths ?? [],
        boardProject: migration.boardProject ?? null,
        boardOperationId: migration.boardOperationId ?? null,
        boardPlacementProject: migration.boardPlacementProject ?? migration.boardProject ?? null,
      } : null;
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  transitionConversationMigration(
    id: ViewerConversationId,
    expectedRevision: number,
    expectedPhases: ConversationMigration["phase"][],
    patch: Partial<Pick<ConversationMigration, "phase" | "error" | "errorCode" | "providerReceipt" | "targetId" | "revision">>,
  ): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[resolveConversationAlias(file, id)];
      const migration = conversation?.migration;
      if (!conversation || !migration) throw new Error("conversation has no migration");
      if (migration.revision !== expectedRevision || !expectedPhases.includes(migration.phase)) throw new Error("migration transition is stale");
      conversation.migration = { ...migration, ...patch, updatedAt: now() };
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  persistMigrationProviderReceipt(
    id: ViewerConversationId,
    expectedRevision: number,
    operationId: string,
    receipt: ProviderReceipt,
  ): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[resolveConversationAlias(file, id)];
      const migration = conversation?.migration;
      if (!conversation || !migration) throw new Error("conversation has no migration");
      if (migration.revision !== expectedRevision || migration.operationId !== operationId) {
        throw new Error("migration provider receipt is stale");
      }
      if (migration.phase === "successor-starting") {
        const receiptPaths = [...new Set([...receipt.continuityPaths, receipt.path])];
        for (const pathname of receiptPaths) {
          addConversationContinuityPath(conversation, pathname);
        }
        conversation.migration = {
          ...migration,
          phase: "verifying",
          providerReceipt: receipt,
          updatedAt: now(),
        };
        conversation.updatedAt = now();
        return clone(conversation);
      }
      const matchingReceipt = migration.providerReceipt !== null
        && sameProviderReceiptOutcome(migration.providerReceipt, receipt);
      if ((migration.phase === "verifying" || migration.phase === "committed") && matchingReceipt) {
        return clone(conversation);
      }
      throw new Error("migration provider receipt conflicts with durable state");
    });
  }

  recordConversationContinuityPath(id: ViewerConversationId, pathname: string): RegistryConversation {
    return this.mutate((file) => {
      const canonicalId = resolveConversationAlias(file, id);
      const conversation = file.conversations[canonicalId];
      if (!conversation) throw new Error("viewer conversation is unknown");
      const provisionalOwner = Object.values(file.conversations).find((candidate) =>
        candidate.id !== canonicalId && candidate.engine === conversation.engine && conversationOwnsPath(candidate, pathname));
      if (provisionalOwner) {
        if (!adoptProvisionalOwner(file, provisionalOwner, conversation, pathname)) {
          throw new Error("migration continuity path has another durable owner");
        }
      }
      addConversationContinuityPath(conversation, pathname);
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  markMigrationBoardProjects(updates: readonly { id: ViewerConversationId; operationId: string; project: string }[]): void {
    if (updates.length === 0) return;
    this.mutate((file) => {
      const updatedAt = now();
      for (const update of updates) {
        const conversation = file.conversations[resolveConversationAlias(file, update.id)];
        const migration = conversation?.migration;
        if (!conversation || !migration || migration.phase !== "committed" || migration.operationId !== update.operationId) continue;
        migration.boardProject = update.project;
        migration.boardOperationId = update.operationId;
        migration.boardPlacementProject = update.project;
        migration.updatedAt = updatedAt;
        conversation.updatedAt = updatedAt;
      }
    });
  }

  markMigrationBoardPlacementProjects(updates: readonly { id: ViewerConversationId; operationId: string; project: string }[]): void {
    if (updates.length === 0) return;
    this.mutate((file) => {
      const updatedAt = now();
      for (const update of updates) {
        const conversation = file.conversations[resolveConversationAlias(file, update.id)];
        const migration = conversation?.migration;
        if (!conversation || !migration || migration.phase !== "committed" || migration.operationId !== update.operationId) continue;
        migration.boardPlacementProject = update.project;
        migration.updatedAt = updatedAt;
        conversation.updatedAt = updatedAt;
      }
    });
  }

  retryConversationMigration(id: ViewerConversationId, expectedRevision?: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[resolveConversationAlias(file, id)];
      const current = conversation?.migration;
      if (!conversation || !current) throw new Error("conversation has no migration");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("migration revision is stale");
      const intent = file.migrationIntents[current.intentId];
      if (!intent || intent.state === "stopped") throw new Error("migration intent is inactive");
      if (intent.state === "complete" && current.phase === "failed-recoverable") {
        intent.state = "draining";
        intent.updatedAt = now();
      }
      const source = conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      conversation.migration = {
        ...current,
        phase: conversation.turn.state === "busy" || conversation.turn.state === "unknown" ? "waiting-turn" : "requested",
        targetId: intent.targetId,
        revision: intent.revision,
        operationId: current.errorCode === "codex-fork-outcome-unknown" ? current.operationId : crypto.randomUUID(),
        sourceGenerationId: source.id,
        providerReceipt: null,
        pendingContinuityPaths: current.phase === "committed" ? [] : current.pendingContinuityPaths,
        boardProject: current.boardProject,
        boardOperationId: current.boardOperationId,
        boardPlacementProject: current.boardPlacementProject,
        error: null,
        errorCode: null,
        updatedAt: now(),
      };
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  commitSuccessor(id: ViewerConversationId, successor: SuccessorGenerationInput, expectedRevision: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[resolveConversationAlias(file, id)];
      if (!conversation?.migration || conversation.migration.revision !== expectedRevision) throw new Error("migration revision is stale");
      if (conversation.migration.phase === "committed") {
        const current = conversation.generations.at(-1);
        if (current?.id === successor.id && current.path === successor.path) return clone(conversation);
        throw new Error("migration succession is already committed");
      }
      if (conversation.migration.phase !== "verifying") throw new Error("migration succession is not ready to commit");
      const predecessor = conversation.generations.at(-1);
      if (!predecessor) throw new Error("viewer conversation has no native generation");
      const committedAt = now();
      predecessor.archivedAt = committedAt;
      const generation: NativeGeneration = {
        ...successor,
        launchProfile: emptyLaunchProfile(successor.launchProfile ?? predecessor.launchProfile),
        historyHash: successor.historyHash ?? null,
        host: successor.host ?? null,
        createdAt: committedAt,
        archivedAt: null,
      };
      conversation.generations.push(generation);
      conversation.continuityPaths = conversation.continuityPaths.filter((pathname) => pathname !== generation.path);
      const committedContinuityPaths = new Set(conversation.migration.pendingContinuityPaths);
      conversation.abandonedContinuityPaths = conversation.abandonedContinuityPaths.filter(
        (pathname) => !committedContinuityPaths.has(pathname),
      );
      conversation.migration = { ...conversation.migration, phase: "committed", updatedAt: now() };
      conversation.updatedAt = now();
      for (const delivery of Object.values(file.heldDeliveries)) {
        if (delivery.conversationId !== id || delivery.state !== "held") continue;
        delivery.state = "assigned";
        delivery.generationId = generation.id;
        delivery.assignedAt = committedAt;
        delivery.error = null;
      }
      file.conversationRevision[conversation.engine] += 1;
      file.engineRouting[conversation.engine].revision += 1;
      return clone(conversation);
    });
  }

  setMigrationIntentState(id: string, state: MigrationIntent["state"], expectedRevision?: number): MigrationIntent {
    return this.mutate((file) => {
      const intent = file.migrationIntents[id];
      if (!intent) throw new Error("migration intent is unknown");
      if (expectedRevision !== undefined && intent.revision !== expectedRevision) throw new Error("migration intent revision is stale");
      const paths = new Set(Object.values(file.conversations)
        .filter((conversation) => conversation.engine === intent.engine)
        .map((conversation) => conversation.generations.at(-1)?.path)
        .filter((pathname): pathname is string => Boolean(pathname)));
      const signature = migrationReadinessSignature(file, intent.engine, paths);
      intent.state = state;
      intent.stoppedAt = state === "stopped" ? now() : intent.stoppedAt;
      intent.updatedAt = now();
      if (state === "stopped") {
        for (const conversation of Object.values(file.conversations)) {
          if (conversation.engine !== intent.engine) continue;
          const current = conversation.generations.at(-1);
          if (file.engineRouting[conversation.engine].activeAccountId === intent.targetId && current?.accountId !== intent.targetId) {
            conversation.migrationOptOut = { targetId: intent.targetId, updatedAt: intent.updatedAt };
            conversation.updatedAt = intent.updatedAt;
          }
          if (conversation.migration?.intentId !== id || conversation.migration.phase === "committed") continue;
          queueAbandonedMigrationCleanup(file, conversation, intent.updatedAt);
          const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
            ?? conversation.generations.at(-1);
          if (!source) continue;
          conversation.migration = { ...conversation.migration, phase: "rolled-back", error: null, errorCode: null, updatedAt: intent.updatedAt };
          for (const delivery of Object.values(file.heldDeliveries)) {
            if (delivery.conversationId !== conversation.id || delivery.state === "delivered" || delivery.state === "delivery-uncertain") continue;
            delivery.state = "assigned";
            delivery.generationId = source.id;
            delivery.assignedAt = intent.updatedAt;
            delivery.error = null;
          }
        }
      }
      advanceMigrationScopeRevision(file, intent.engine, signature, paths);
      return clone(intent);
    });
  }

  autoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">): AutoBalancePolicy {
    return clone(this.snapshot().autoBalance[engine]);
  }

  quotaObservations(engine: Extract<AgentEngine, "claude" | "codex">): DurableQuotaObservation[] {
    return clone(Object.values(this.snapshot().quotaObservations[engine]));
  }

  recordQuotaEvaluation(input: {
    engine: Extract<AgentEngine, "claude" | "codex">;
    observations: DurableQuotaObservation[];
    signature: string | null;
    evidence?: MigrationIntent["evidence"];
    bootId: string;
    now: string;
    minimumGapMs: number;
  }): { sustained: boolean; routeRevision: number; policy: AutoBalancePolicy } {
    return this.mutate((file) => {
      for (const observation of input.observations) {
        if (observation.engine === input.engine) file.quotaObservations[input.engine][observation.accountId] = observation;
      }
      const policy = file.autoBalance[input.engine];
      policy.lastCheckAt = input.now;
      let sustained = false;
      if (!input.signature) {
        policy.sustain = null;
      } else if (!policy.sustain || policy.sustain.signature !== input.signature || policy.sustain.bootId !== input.bootId) {
        policy.sustain = { signature: input.signature, firstAt: input.now, lastAt: input.now, bootId: input.bootId };
      } else {
        const firstAt = Date.parse(policy.sustain.firstAt);
        policy.sustain.lastAt = input.now;
        sustained = Number.isFinite(firstAt) && Date.parse(input.now) - firstAt >= input.minimumGapMs;
        if (sustained) {
          policy.sustain = null;
          policy.lastTrigger = input.evidence ?? null;
        }
      }
      policy.revision += 1;
      return { sustained, routeRevision: file.engineRouting[input.engine].revision, policy: clone(policy) };
    });
  }

  setAutoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">, enabled: boolean, expectedRevision?: number): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      if (expectedRevision !== undefined && policy.revision !== expectedRevision) throw new Error("automatic balance policy revision is stale");
      policy.enabled = enabled;
      if (!enabled) policy.sustain = null;
      policy.revision += 1;
      return clone(policy);
    });
  }

  recordAutoBalanceOutcome(
    engine: Extract<AgentEngine, "claude" | "codex">,
    outcome: "complete" | "stopped" | "failed-partial",
    evidence: AutoBalancePolicy["lastTrigger"],
    cooldownUntil: string,
  ): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      policy.cooldownUntil = cooldownUntil;
      policy.lastOutcome = {
        at: now(),
        kind: outcome === "complete" ? "switched" : outcome === "failed-partial" ? "failed" : "skipped",
        fromId: evidence?.sourceId ?? null,
        fromPercent: evidence?.sourcePercent ?? null,
        toId: evidence?.targetId ?? null,
        toPercent: evidence?.targetPercent ?? null,
        window: evidence?.sourceWindow ?? null,
        detail: outcome === "failed-partial" ? "one or more sessions need operator recovery" : null,
      };
      policy.lastTrigger = evidence;
      if (evidence) policy.departed[evidence.sourceId] = now();
      policy.revision += 1;
      return clone(policy);
    });
  }

  holdDelivery(
    conversationId: ViewerConversationId,
    text: string,
    clientMessageId: string | null = null,
    payloadKind: HeldDelivery["payloadKind"] = "text",
  ): HeldDelivery {
    if (payloadKind === "text" && (!text || text.length > 32_000)) throw new Error("held delivery must contain at most 32000 characters");
    return this.mutate((file) => {
      const canonicalId = resolveConversationAlias(file, conversationId);
      const existing = clientMessageId ? Object.values(file.heldDeliveries).find((item) => item.conversationId === canonicalId && item.clientMessageId === clientMessageId) : undefined;
      const conversation = file.conversations[canonicalId];
      const paths = new Set([conversation?.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = conversation ? migrationReadinessSignature(file, conversation.engine, paths) : "";
      const migrationBlocksDelivery = conversation?.migration
        && ["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase);
      const current = conversation?.generations.at(-1);
      const place = (delivery: HeldDelivery): HeldDelivery => {
        if (delivery.state === "delivered" || delivery.state === "delivery-uncertain") return clone(delivery);
        delivery.deliveredAt = null;
        delivery.error = null;
        if (migrationBlocksDelivery) {
          delivery.state = "held";
          delivery.generationId = null;
          delivery.assignedAt = null;
        } else if (current) {
          delivery.state = "assigned";
          delivery.generationId = current.id;
          delivery.assignedAt = now();
        } else {
          delivery.state = "failed";
          delivery.generationId = null;
          delivery.assignedAt = null;
          delivery.error = "delivery target is unavailable and remains recoverable";
        }
        if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
        return clone(delivery);
      };
      if (existing) return place(existing);
      const held: HeldDelivery = {
        id: crypto.randomUUID(),
        conversationId: canonicalId,
        text,
        createdAt: now(),
        clientMessageId,
        payloadKind,
        artifactPaths: [],
        state: "held",
        generationId: null,
        attempts: 0,
        assignedAt: null,
        deliveredAt: null,
        error: null,
      };
      compactDeliveryReservations(file, canonicalId);
      const count = Object.values(file.heldDeliveries).filter((item) => item.conversationId === canonicalId && item.state !== "delivered").length;
      if (count >= 100) throw new Error("held delivery limit reached for conversation");
      file.heldDeliveries[held.id] = held;
      return place(held);
    });
  }

  pendingDeliveries(conversationId: ViewerConversationId): HeldDelivery[] {
    const snapshot = this.snapshot();
    const canonicalId = resolveConversationAlias(snapshot, conversationId);
    return Object.values(snapshot.heldDeliveries)
      .filter((item) => item.conversationId === canonicalId && item.state !== "delivered")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  compactDeliveryReservations(): number {
    return this.mutate((file) => compactDeliveryReservations(file));
  }

  queueSuccessorCleanup(conversationId: ViewerConversationId, receipt: ProviderReceipt): void {
    this.mutate((file) => {
      const existing = file.pendingSuccessorCleanups[receipt.operationId];
      file.pendingSuccessorCleanups[receipt.operationId] = existing ?? {
        conversationId: resolveConversationAlias(file, conversationId), receipt, createdAt: now(), lastError: null,
      };
    });
  }

  recordSuccessorCleanupFailure(operationId: string, error: string): void {
    this.mutate((file) => {
      const pending = file.pendingSuccessorCleanups[operationId];
      if (pending) pending.lastError = error.slice(0, 240);
    });
  }

  completeSuccessorCleanup(operationId: string): void {
    this.mutate((file) => { delete file.pendingSuccessorCleanups[operationId]; });
  }

  beginDeliveryAttempt(id: string, generationId: string): HeldDelivery | null {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery || delivery.state !== "assigned" || delivery.generationId !== generationId) return null;
      const conversation = file.conversations[resolveConversationAlias(file, delivery.conversationId)];
      const paths = new Set([conversation?.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = conversation ? migrationReadinessSignature(file, conversation.engine, paths) : "";
      const migrationBlocksDelivery = conversation?.migration
        && ["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase);
      if (migrationBlocksDelivery || conversation?.generations.at(-1)?.id !== generationId) return null;
      delivery.state = "delivery-uncertain";
      delivery.attempts += 1;
      delivery.error = "delivery started; recovery requires an explicit outcome";
      if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
      return clone(delivery);
    });
  }

  recordDeliveryArtifacts(id: string, artifactPaths: string[]): HeldDelivery {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery) throw new Error("held delivery is unknown");
      if (delivery.state !== "delivery-uncertain") throw new Error("delivery attempt has not started");
      delivery.artifactPaths = [...new Set(artifactPaths)];
      return clone(delivery);
    });
  }

  restoreSnapshot(expectedCurrent: RegistryFile, replacement: RegistryFile): void {
    withAccountMutationLock(() => this.mutate((file) => {
      Object.assign(file, restoreOwnedChanges(file, expectedCurrent, replacement) as RegistryFile);
    }));
  }

  recordDeliveryOutcome(
    id: string,
    state: Extract<HeldDelivery["state"], "delivered" | "failed" | "delivery-uncertain">,
    error: string | null = null,
  ): HeldDelivery {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery) throw new Error("held delivery is unknown");
      if (delivery.state === "delivered") return clone(delivery);
      const conversation = file.conversations[resolveConversationAlias(file, delivery.conversationId)];
      const paths = new Set([conversation?.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = conversation ? migrationReadinessSignature(file, conversation.engine, paths) : "";
      delivery.state = state;
      delivery.deliveredAt = state === "delivered" ? now() : null;
      delivery.error = error?.slice(0, 240) ?? null;
      if (state === "delivered") delivery.text = "";
      if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
      const settled = clone(delivery);
      if (state === "delivered" || state === "failed") compactDeliveryReservations(file, delivery.conversationId);
      return settled;
    });
  }

  discardDelivery(id: string): void {
    this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      const conversation = delivery ? file.conversations[resolveConversationAlias(file, delivery.conversationId)] : undefined;
      const paths = new Set([conversation?.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = conversation ? migrationReadinessSignature(file, conversation.engine, paths) : "";
      delete file.heldDeliveries[id];
      if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
    });
  }

  requeueHeldDelivery(id: string): HeldDelivery {
    return this.placeDeliveryForRetry(id, false);
  }

  retryUncertainDelivery(id: string): HeldDelivery {
    return this.placeDeliveryForRetry(id, true);
  }

  requeueUnactuatedDelivery(id: string): HeldDelivery {
    return this.placeDeliveryForRetry(id, true);
  }

  private placeDeliveryForRetry(id: string, allowUncertain: boolean): HeldDelivery {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery) throw new Error("held delivery is unknown");
      if (delivery.state === "delivered") return clone(delivery);
      if (delivery.state === "delivery-uncertain" && !allowUncertain) {
        throw new Error("uncertain delivery requires an explicit client retry");
      }
      if (allowUncertain && delivery.state !== "delivery-uncertain") {
        throw new Error("delivery outcome is already resolved");
      }
      const conversation = file.conversations[resolveConversationAlias(file, delivery.conversationId)];
      const paths = new Set([conversation?.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = conversation ? migrationReadinessSignature(file, conversation.engine, paths) : "";
      const migrationBlocksDelivery = conversation?.migration
        && ["waiting-turn", "requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase);
      if (migrationBlocksDelivery) {
        delivery.state = "held";
        delivery.generationId = null;
        delivery.assignedAt = null;
        delivery.deliveredAt = null;
        delivery.error = null;
        if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
        return clone(delivery);
      }
      const current = conversation?.generations.at(-1);
      if (!current) {
        delivery.state = "failed";
        delivery.deliveredAt = null;
        delivery.error = "delivery target is unavailable and remains recoverable";
        if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
        return clone(delivery);
      }
      delivery.state = "assigned";
      delivery.generationId = current.id;
      delivery.assignedAt = now();
      delivery.deliveredAt = null;
      delivery.error = null;
      if (conversation) advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
      return clone(delivery);
    });
  }

  rollbackConversationMigration(id: ViewerConversationId, expectedRevision?: number): RegistryConversation {
    return this.mutate((file) => {
      const canonicalId = resolveConversationAlias(file, id);
      const conversation = file.conversations[canonicalId];
      if (!conversation?.migration) throw new Error("conversation has no migration");
      if (expectedRevision !== undefined && conversation.migration.revision !== expectedRevision) throw new Error("migration revision is stale");
      const paths = new Set([conversation.generations.at(-1)?.path].filter((pathname): pathname is string => Boolean(pathname)));
      const signature = migrationReadinessSignature(file, conversation.engine, paths);
      const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
        ?? conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      const rolledAt = now();
      queueAbandonedMigrationCleanup(file, conversation, rolledAt);
      const route = file.engineRouting[conversation.engine];
      if (route.activeAccountId === conversation.migration.targetId) {
        conversation.migrationOptOut = {
          targetId: conversation.migration.targetId,
          updatedAt: rolledAt,
        };
      }
      for (const delivery of Object.values(file.heldDeliveries)) {
        if (delivery.conversationId !== canonicalId || delivery.state === "delivered" || delivery.state === "delivery-uncertain") continue;
        delivery.state = "assigned";
        delivery.generationId = source.id;
        delivery.assignedAt = rolledAt;
        delivery.error = null;
      }
      conversation.migration = { ...conversation.migration, phase: "rolled-back", error: null, errorCode: null, updatedAt: rolledAt };
      conversation.updatedAt = rolledAt;
      advanceMigrationScopeRevision(file, conversation.engine, signature, paths);
      return clone(conversation);
    });
  }
}

let registry: AgentRegistry | null = null;
export function agentRegistry(): AgentRegistry {
  registry ??= new AgentRegistry();
  return registry;
}

export function setAgentRegistryForTests(value: AgentRegistry | null): void {
  registry = value;
}
