import crypto from "node:crypto";
import fs from "node:fs";

import { accountManager } from "@/lib/accounts/manager";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import {
  agentRegistry,
  type AgentRegistry,
  type ConversationObservation,
  type MigrationScope,
  type RegistryConversation,
  type RegistryFile,
} from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { headCwd, headSessionStartedAt } from "@/lib/agent/transcript";
import {
  boardFor,
  remapBoardPaths as remapDurableBoardPaths,
  transferBoardPathPlacements as transferDurableBoardPathPlacements,
} from "@/lib/board/store";
import { forEachCooperatively, yieldToRuntime } from "@/lib/cooperative";
import { procBackend } from "@/lib/proc";
import { listFiles } from "@/lib/scanner";
import { recordTranscriptComposerRelease, transcriptTurnResult, type TranscriptTurnResult } from "@/lib/scanner/activity";
import { nativeCodexForkSourceThreadId } from "@/lib/scanner/codexNative";
import { writingHolders } from "@/lib/scanner/process";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { isStructuredDeliveryControllerUnavailable } from "@/lib/runtime/structuredDeliveryController";

import {
  emptyLaunchProfile,
  sameGenerationHostEvidence,
  sameProviderReceiptOutcome,
  type HistoryCopyPort,
  type HeldDelivery,
  type MigrationEngine,
  type MigrationIntent,
  type MigrationOrigin,
  type ProviderReceipt,
  type SuccessorProviderPort,
  type TurnState,
  type ViewerConversationId,
} from "./contracts";
import { CodexForkOutcomeUnknownError, RegisteredSuccessorProvider, SuccessorPendingError } from "./provider";
import { safeProviderDiagnostic, sanitizeProviderError } from "./safeHistoryCopy";
import { AUTO_BALANCE_COOLDOWN_MS } from "./quotaPolicy";
import { MIGRATION_DELIVERY_CANCELLATION_PREFIX } from "./intentLiveness";

export interface MigrationPreview {
  targetId: string;
  targetLabel: string;
  counts: { total: number; idle: number; busy: number; deferred: number; alreadyTarget: number };
  previewRevision: number;
}

export interface HeldDeliveryPort {
  deliver(input: { delivery: HeldDelivery; path: string; clientMessageId: string }): Promise<"delivered" | "failed" | "delivery-uncertain" | "held">;
  reconcileUncertain?(input: { delivery: HeldDelivery; path: string; clientMessageId: string }): Promise<"delivered" | "failed" | "delivery-uncertain" | "held">;
}

const CLAIMABLE_RECEIPT_STATES = new Set(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);

function deliveryHasDurableClaimOwner(
  snapshot: RegistryFile,
  conversation: RegistryConversation,
  delivery: HeldDelivery,
): boolean {
  const current = conversation.generations.at(-1);
  if (!current || delivery.generationId !== current.id) return false;
  if (current.host !== null && current.host !== undefined) return true;
  if (Object.values(snapshot.entries).some((entry) =>
    entry.key.engine === conversation.engine
    && entry.key.sessionId === current.id
    && entry.artifactPath === current.path
    && ((entry.structuredHost !== null && entry.structuredHost !== undefined) !== (entry.host !== null)))) return true;
  return Object.values(snapshot.receipts).some((receipt) =>
    receipt.engine === conversation.engine
    && receipt.conversationId === conversation.id
    && CLAIMABLE_RECEIPT_STATES.has(receipt.state));
}

function engineOf(entry: FileEntry): MigrationEngine | null {
  return entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null;
}

/** A current pane usage wall (issue #97): the scanner only sets `rateLimit`
    from a live banner (historical prose is filtered per #56), which means the
    engine has surrendered the turn — the transcript will not advance before
    the reset, so for migration purposes the composer is effectively free. */
function currentPaneWall(entry: FileEntry): boolean {
  return entry.rateLimit != null;
}

/** A complete open turn can outlive its agent process when Codex or Claude
    exits before appending the terminal lifecycle record. After the scanner's
    three-minute stalled threshold, absent process and host evidence makes the
    composer safe to resume through a successor. */
function deadStalledTurn(entry: FileEntry, existing: RegistryConversation | null, hasActiveRegisteredHost: boolean): boolean {
  const generation = existing?.generations.at(-1);
  return entry.activity === "stalled"
    && entry.activityReason === "jsonl_turn_stalled"
    && entry.proc !== "running"
    && entry.pid === null
    && generation?.path === entry.path
    && generation.host === null
    && !hasActiveRegisteredHost;
}

/** Transcript paths a registered host still owns. A host in any of these
    statuses can append real provider work at any moment, so transcript-only
    release evidence must not outrank it. */
function activeRegisteredHostPaths(snapshot: ReturnType<AgentRegistry["readOnlySnapshot"]>): Set<string> {
  return new Set(Object.values(snapshot.entries)
    .filter((entry) => entry.artifactPath
      && ["starting", "live", "idle", "handoff"].includes(entry.status)
      && (entry.host !== null || entry.structuredHost !== null))
    .map((entry) => entry.artifactPath!));
}

function hasActiveRegisteredHost(registry: AgentRegistry, pathname: string): boolean {
  return activeRegisteredHostPaths(registry.readOnlySnapshot()).has(pathname);
}

/** Issue #516 — a Claude recovery tail (replayed continuation, synthetic
    `No response requested.` no-op, interrupt sentinel) releases the turn on
    transcript evidence alone. That evidence describes a session that already
    exited; while a host is still registered for the path the turn stays busy,
    because its next record can be genuine provider work. */
function hostFencedTurn(observed: TranscriptTurnResult, hasActiveHost: boolean): TurnState {
  return observed.recoveryReleased && hasActiveHost
    ? { state: "busy", source: "lifecycle", terminalAt: null }
    : observed.turn;
}

/** A registered structured host owns its own turn lifecycle (issue #1028).
    A pane-less host has no composer for the scanner to observe, and Claude's
    CLI never writes a `result` record into its transcript, so re-deriving the
    turn from those bytes projects a FINISHED structured turn as busy forever
    and the switch waiting on it never leaves `waiting-turn`.

    The host's own durable `activeTurnRef` says it plainly, and says it live:
    it is persisted on every material host state change, it is re-read on each
    check, and it flips back the instant a turn starts — so unlike a recorded
    release it cannot outlive the state it describes. A dead or unhosted row is
    NOT evidence: its columns are cleared on release, and a source with no live
    host is exactly the case the transcript projection already governs. */
function structuredHostTurnReleased(
  registry: AgentRegistry,
  engine: MigrationEngine,
  generation: { id: string; path: string },
): boolean {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId({ engine, sessionId: generation.id })];
  const host = entry?.structuredHost;
  if (!host || entry!.artifactPath !== generation.path) return false;
  if (entry!.status !== "live" && entry!.status !== "idle") return false;
  /* Only a row a live engine process still backs is evidence. A released or
     restart-orphaned row keeps `activeTurnRef: null` because nothing recorded
     a turn on it, not because a turn ended — reading that as a release would
     hand the successor a source whose host may be mid-turn. Verified identity,
     not a bare pid: a recycled pid must not resurrect a dead row. */
  return host.process !== null
    && host.process.startIdentity !== null
    && procBackend.processIdentity(host.process.pid) === host.process.startIdentity
    && host.activeTurnRef === null;
}

/** The generation an in-flight migration is moving off, matching the source
    `advanceConversationMigration` resolves for the provider. */
function migrationSourceGeneration(conversation: RegistryConversation) {
  const sourceGenerationId = conversation.migration?.sourceGenerationId;
  return conversation.generations.find((generation) => generation.id === sourceGenerationId)
    ?? conversation.generations.at(-1);
}

function projectedInventoryTurn(
  entry: FileEntry,
  parsed: ConversationObservation["turn"] | null,
  existing: RegistryConversation | null,
  hasActiveRegisteredHost: boolean,
): ConversationObservation["turn"] {
  if (!parsed) {
    if (existing && (existing.turn.state === "busy" || existing.turn.state === "unknown")) {
      return { state: existing.turn.state, source: existing.turn.source, terminalAt: existing.turn.terminalAt };
    }
    return { state: "unknown", source: "empty", terminalAt: null };
  }

  const activityComplete = entry.derivationComplete !== false;
  if (parsed.state === "busy" && activityComplete && (
    entry.activityReason === "pane_at_composer"
    || currentPaneWall(entry)
    || deadStalledTurn(entry, existing, hasActiveRegisteredHost)
  )) {
    return { state: "idle", source: "empty", terminalAt: null };
  }
  if (parsed.state === "unknown" && activityComplete && (entry.activity === "idle" || entry.activity === "recent")) {
    return { state: "idle", source: "empty", terminalAt: null };
  }
  return parsed;
}

async function inventory(files: FileEntry[], registry: AgentRegistry): Promise<ConversationObservation[]> {
  const inventoryStartedAt = Date.now();
  const snapshot = registry.readOnlySnapshot();
  const conversationByPath = new Map<string, RegistryConversation>();
  const launchProfileByPath = new Map<string, RegistryConversation["generations"][number]["launchProfile"]>();
  const hostedPaths = activeRegisteredHostPaths(snapshot);
  await forEachCooperatively(Object.values(snapshot.conversations), (conversation) => {
    for (const generation of conversation.generations) {
      if (!conversationByPath.has(generation.path)) conversationByPath.set(generation.path, conversation);
      if (!launchProfileByPath.has(generation.path)) launchProfileByPath.set(generation.path, generation.launchProfile);
    }
    const current = conversation.generations.at(-1);
    for (const pathname of conversation.continuityPaths) {
      if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation);
      if (current && !launchProfileByPath.has(pathname)) launchProfileByPath.set(pathname, current.launchProfile);
    }
  });
  await forEachCooperatively(Object.values(snapshot.receipts), (receipt) => {
    if (receipt.artifactPath && !launchProfileByPath.has(receipt.artifactPath)) {
      launchProfileByPath.set(receipt.artifactPath, receipt.launchProfile);
    }
  });
  /* The root marker is a conversation identity, so it is resolved through the
     alias chain (#708): adopting a lookalike fork conversation into its source
     must not leave the configured root naming a merged-away id. */
  const configuredRootId = process.env.LLV_ROOT_CONVERSATION_ID;
  const configuredRoot = configuredRootId?.startsWith("conversation_")
    ? registry.canonicalConversationId(configuredRootId as ViewerConversationId)
    : configuredRootId;
  const observations: ConversationObservation[] = [];
  await forEachCooperatively(files, (entry) => {
    const engine = engineOf(entry);
    if (!engine) return;
    const existing = conversationByPath.get(entry.path) ?? null;
    const parentConversation = entry.parent ? conversationByPath.get(entry.parent) ?? null : null;
    const owner = accountManager.resolveTranscriptOwner(engine, entry.path);
    const mtimeMs = entry.mtime * 1000;
    const observedTurn = transcriptTurnResult(entry.path, entry.size, mtimeMs, engine === "codex");
    const hostedPath = hostedPaths.has(entry.path);
    const parsed = observedTurn.complete ? hostFencedTurn(observedTurn, hostedPath) : null;
    const releasedDeadTurn = deadStalledTurn(entry, existing, hostedPath);
    if (observedTurn.complete && entry.derivationComplete !== false && (
      entry.activityReason === "pane_at_composer"
      || currentPaneWall(entry)
      || releasedDeadTurn
    )) {
      recordTranscriptComposerRelease(entry.path, entry.size, mtimeMs, engine === "codex");
    }
    const turn = projectedInventoryTurn(entry, parsed, existing, hostedPath);
    const currentProfile = launchProfileByPath.get(entry.path)
      ?? existing?.generations.find((generation) => generation.path === entry.path)?.launchProfile;
    const transcriptIdentity = { size: entry.size, mtimeMs };
    observations.push({
      engine,
      path: entry.path,
      accountId: owner?.accountId ?? null,
      launchProfile: emptyLaunchProfile({
        cwd: currentProfile?.cwd || entry.cwd || headCwd(entry.path, { maxLines: 40, identity: transcriptIdentity }) || "",
        model: currentProfile?.model ?? entry.launchModel ?? entry.model,
        effort: currentProfile?.effort ?? entry.effort ?? null,
        fast: currentProfile?.fast ?? null,
        permissionMode: currentProfile?.permissionMode ?? null,
        readOnly: currentProfile?.readOnly ?? null,
        title: entry.title || currentProfile?.title || null,
        project: entry.project || currentProfile?.project || null,
        parentConversationId: parentConversation?.id ?? currentProfile?.parentConversationId ?? null,
        role: configuredRoot && existing?.id === configuredRoot ? "root" : currentProfile?.role ?? "worker",
        goal: entry.goal ?? currentProfile?.goal ?? null,
        plan: entry.plan ?? currentProfile?.plan ?? null,
      }),
      turn,
      // Path-derived engine-native parent (issue #339). The scanner already
      // resolved `entry.parent` from the subagent path grammar; carrying it as
      // an explicit observation field lets registry reconciliation establish the
      // lineage edge against the post-admission index, even for a parent first
      // discovered in this same inventory cycle.
      parentArtifactPath: entry.parent,
      // Provider-fork history (issue #708). The scanner resolved this from the
      // FIRST `session_meta` row — a fork replays its ancestor's header as row
      // two — and carries it on the entry, including through the persisted scan
      // snapshot. Reconciliation reads it there instead of opening the
      // transcript again; only an entry no scanner has described (an absent
      // field, not a null one) falls back to the header, which is what still
      // adopts forks discovered outside a scan.
      forkSourceThreadId: engine === "codex"
        ? entry.nativeForkSourceThreadId === undefined
          ? nativeCodexForkSourceThreadId(entry.path, entry.size, mtimeMs)
          : entry.nativeForkSourceThreadId
        : null,
      expectedTurnObservedAt: existing?.turn.observedAt ?? null,
      startedAt: entry.sessionStartedAt ?? headSessionStartedAt(entry.path, transcriptIdentity),
      observedAt: !observedTurn.complete && existing?.turn.observedAt
        ? existing.turn.observedAt
        : new Date(Math.max(entry.mtime * 1000, inventoryStartedAt)).toISOString(),
    });
  });
  return observations;
}

/**
 * Follow an adopted provider fork's board placement onto the conversation that
 * now owns it (#708).
 *
 * The fork used to render as its own card, so the operator's `manual` and
 * `expanded` entries name its transcript path. Aliasing that path to the
 * conversation's current generation keeps those decisions attached to the
 * surviving card instead of stranding them on a path that no longer renders.
 *
 * Pairs the board already records are dropped here, against the same read that
 * resolves `hidden`. `remapBoardPaths` would reach the same answer, but only
 * after taking the board write lock and re-reading the file — every 60s
 * controller tick and every reaper pass, per project with an adopted fork. A
 * project whose forks are all aliased is skipped outright, so a replay costs one
 * board read and no lock at all.
 *
 * The remap runs with the target's placement authoritative, because here the
 * survivor is not a successor generation of the fork — it is the conversation
 * the fork was always a duplicate of. A fork adopted before it ever rendered
 * carries no membership at all, and a default remap would read that absence as
 * "this card is not placed" and strip the root's own pin, taking the operator's
 * canonical card off the board with no way back.
 *
 * A fork the operator had already hidden is deliberately left unaliased. Hiding
 * a duplicate card is a statement about the duplicate, and an alias would carry
 * it onto the survivor and take the real conversation off the board. The hidden
 * entry stays on file untouched; it simply names a path that no longer draws.
 */
async function repairAdoptedForkBoardPlacements(
  conversations: readonly RegistryConversation[],
  remapPaths: typeof remapDurableBoardPaths,
): Promise<void> {
  const byProject = new Map<string, { from: string; to: string }[]>();
  const boards = new Map<string, BoardProjectStateV1 | null>();
  await forEachCooperatively(conversations, (conversation) => {
    if (conversation.engine !== "codex" || conversation.providerForkPaths.length === 0) return;
    const current = conversation.generations.at(-1);
    if (!current) return;
    const project = conversation.projectOwnership?.project || current.launchProfile.project;
    if (!project) return;
    if (!boards.has(project)) {
      try {
        boards.set(project, boardFor(project));
      } catch (error) {
        /* One project's board being malformed or unreadable used to abort the
           whole reconciliation cycle, taking every other project's inventory
           down with it. Skip this project's placement repair and carry on. */
        boards.set(project, null);
        console.warn("[account-migration] adopted fork board placement skipped", {
          project,
          error: safeProviderDiagnostic(error),
        });
      }
    }
    const board = boards.get(project);
    if (!board) return;
    const hidden = new Set(board.prefs.hidden);
    const aliases = board.pathAliases ?? {};
    const pairs = conversation.providerForkPaths
      .filter((pathname) => pathname !== current.path && !hidden.has(pathname) && aliases[pathname] !== current.path)
      .map((from) => ({ from, to: current.path }));
    if (pairs.length === 0) return;
    byProject.set(project, [...(byProject.get(project) ?? []), ...pairs]);
  });
  await forEachCooperatively([...byProject], ([project, pairs]) => {
    try {
      remapPaths(project, pairs, { targetPlacementAuthoritative: true });
    } catch (error) {
      console.warn("[account-migration] adopted fork board placement deferred", {
        project,
        paths: pairs.length,
        error: safeProviderDiagnostic(error),
      });
    }
  });
}

export async function reconcileMigrationInventory(
  registry: AgentRegistry = agentRegistry(),
  files?: FileEntry[],
  options: MigrationCoordinatorOptions = {},
): Promise<ReturnType<AgentRegistry["snapshot"]>> {
  const entries = files ?? await listFiles();
  const snapshot = registry.reconcileConversations(await inventory(entries, registry));
  if (!options.deferBoardRepair) {
    await repairAdoptedForkBoardPlacements(
      Object.values(snapshot.conversations),
      options.remapBoardPaths ?? remapDurableBoardPaths,
    );
  }
  return snapshot;
}

function previewFromSnapshot(engine: MigrationEngine, targetId: string, registry: AgentRegistry): MigrationPreview {
  const snapshot = registry.readOnlySnapshot();
  const target = (engine === "claude" ? accountManager.resolveSpawn("claude", targetId) : accountManager.resolveSpawn("codex", targetId));
  const targetLabel = (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find((account) => account.id === target.accountId)?.label ?? target.accountId;
  return {
    targetId,
    targetLabel,
    counts: registry.migrationScope(engine, targetId),
    previewRevision: snapshot.engineRouting[engine].revision,
  };
}

export async function previewMigration(
  engine: MigrationEngine,
  targetId: string,
  registry: AgentRegistry = agentRegistry(),
): Promise<MigrationPreview> {
  // AccountMigrationController owns inventory scans. The request path projects
  // its durable snapshot so preview stays mutation-free and avoids transcript I/O.
  return previewFromSnapshot(engine, targetId, registry);
}

export async function createMigrationIntent(
  engine: MigrationEngine,
  targetId: string,
  origin: MigrationOrigin,
  requestId: string = crypto.randomUUID(),
  previewRevision?: number,
  scope: MigrationScope = "active",
  registry: AgentRegistry = agentRegistry(),
  evidence: MigrationIntent["evidence"] = null,
): Promise<{ intent: MigrationIntent; preview: MigrationPreview }> {
  // The revision fence below detects controller updates after confirmation.
  // Re-scanning here would add request latency and invalidate its own preview.
  const preview = previewFromSnapshot(engine, targetId, registry);
  const intent = registry.commitMigrationIntent({
    engine,
    targetId,
    origin,
    requestId,
    expectedRevision: previewRevision ?? preview.previewRevision,
    evidence,
    scope,
  });
  return { intent, preview };
}

function isCopyOnly(value: SuccessorProviderPort | HistoryCopyPort): value is HistoryCopyPort {
  return "copy" in value;
}

function copyAdapter(copy: HistoryCopyPort): SuccessorProviderPort {
  return {
    virtualSource: true,
    async create(input) {
      const successor = await copy.copy({
        engine: input.engine,
        sourcePath: input.source.path,
        targetHome: input.targetAccountId,
        conversationId: input.conversationId,
      });
      return {
        operationId: input.operationId,
        nativeId: successor.nativeId,
        path: successor.path,
        continuityPaths: [],
        historyHash: "legacy-copy-port",
        host: { kind: "tmux", identity: "legacy-copy-port", epoch: 1, verifiedAt: new Date().toISOString() },
      };
    },
    async verify() {},
  };
}

function productionProvider(): SuccessorProviderPort {
  return new RegisteredSuccessorProvider();
}

function terminalMigrationPhase(phase: string): boolean {
  return phase === "committed" || phase === "rolled-back" || phase === "failed-recoverable";
}

function successorCreationReady(conversation: RegistryConversation, registry: AgentRegistry): boolean {
  const sourcePath = conversation.generations.at(-1)?.path;
  const unmaterializedEmptyTurn = conversation.turn.state === "unknown"
    && conversation.turn.source === "empty"
    && Boolean(sourcePath)
    && !fs.existsSync(sourcePath!);
  const source = migrationSourceGeneration(conversation);
  const hostReleased = source !== undefined && structuredHostTurnReleased(registry, conversation.engine, source);
  if (conversation.turn.state !== "terminal"
    && conversation.turn.state !== "idle"
    && !unmaterializedEmptyTurn
    && !hostReleased) return false;
  return !registry.pendingDeliveries(conversation.id).some((delivery) => delivery.state === "delivery-uncertain");
}

function completeProviderTurnObservation(
  conversation: RegistryConversation,
  source: RegistryConversation["generations"][number],
  virtualSource: boolean,
  registry: AgentRegistry,
): boolean {
  let before: fs.Stats;
  try {
    before = fs.statSync(source.path);
  } catch (error) {
    return virtualSource && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const observed = transcriptTurnResult(source.path, before.size, before.mtimeMs, conversation.engine === "codex");
  if (!observed.complete) return false;
  let after: fs.Stats;
  try {
    after = fs.statSync(source.path);
  } catch {
    return false;
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
  /* An explicit composer release is the operator's own signal and outranks
     the recovery-tail host fence: a live-but-idle host at the composer must
     not hold the reseat hostage. */
  if (observed.composerReleased) return true;
  /* The same statement, from the one host that can make it about itself: a
     live structured host with no active turn is at its composer, and its own
     lifecycle outranks a transcript projection that cannot release (#1028).
     It supersedes the coarse "a host is registered" fence below, which exists
     because a registered host MIGHT still write — this one says it is not. */
  if (structuredHostTurnReleased(registry, conversation.engine, source)) return true;
  /* A host registered between inventory and creation still owns a recovery
     tail's turn (issue #516), so its release must not reach the provider. */
  if (observed.recoveryReleased && hasActiveRegisteredHost(registry, source.path)) return false;
  if (observed.turn.state === "terminal") return true;

  /* A crashed Codex rollout can retain its final task_started record forever.
     An inventory release plus a stable file with no writable holder proves
     that this generation has no provider turn left to preserve. */
  const releasedAt = conversation.turn.observedAt ? Date.parse(conversation.turn.observedAt) : Number.NaN;
  const deadCodexSourceWasReleased = conversation.engine === "codex"
    && conversation.turn.state === "idle"
    && source.host === null
    && Number.isFinite(releasedAt)
    && releasedAt >= after.mtimeMs
    && !writingHolders([source.path], true).has(source.path);
  return deadCodexSourceWasReleased;
}

export interface MigrationCoordinatorOptions {
  /** The reconfigure operation executing this switch, when the caller IS that
      executor (issue #1028). Every other caller defers to it — see
      {@link reconfigureOwnsMigration}. */
  reconfigureOperationId?: string;
  remapBoardPaths?: typeof remapDurableBoardPaths;
  transferBoardPathPlacements?: typeof transferDurableBoardPathPlacements;
  deferBoardRepair?: boolean;
  ownsOperation?: () => Promise<boolean>;
}

interface BoardRepairPlan {
  conversationId: ViewerConversationId;
  operationId: string;
  project: string;
  previousProject: string | null;
  placementPaths: string[];
  pairs: { from: string; to: string }[];
  provisionalManual: string[];
}

function boardRepairPlan(conversation: RegistryConversation): BoardRepairPlan | null {
  if (conversation.migration?.phase !== "committed") return null;
  const successor = conversation.generations.at(-1);
  const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
    ?? conversation.generations.at(-2);
  if (!source || !successor || source.id === successor.id) return null;
  const project = successor.launchProfile.project || source.launchProfile.project || "other";
  if (conversation.migration.boardProject === project
    && conversation.migration.boardOperationId === conversation.migration.operationId) return null;
  const continuityPaths = [...new Set([
    ...conversation.continuityPaths,
    ...(conversation.migration.providerReceipt?.continuityPaths ?? []),
  ])];
  const archivedGenerationPaths = conversation.generations.slice(0, -1).map((generation) => generation.path);
  const sources = [...new Set([...archivedGenerationPaths, ...continuityPaths])].filter((pathname) => pathname !== successor.path);
  return {
    conversationId: conversation.id,
    operationId: conversation.migration.operationId,
    project,
    previousProject: conversation.migration.boardPlacementProject
      ?? conversation.migration.boardProject
      ?? source.launchProfile.project,
    placementPaths: [...new Set([source.path, successor.path, ...continuityPaths])],
    pairs: sources.map((from) => ({ from, to: successor.path })),
    provisionalManual: continuityPaths.filter((pathname) => pathname !== successor.path),
  };
}

async function repairCommittedBoardSuccessions(
  conversations: readonly RegistryConversation[],
  registry: AgentRegistry,
  remapPaths: typeof remapDurableBoardPaths,
  transferPlacements: typeof transferDurableBoardPathPlacements,
): Promise<void> {
  const plans: BoardRepairPlan[] = [];
  await forEachCooperatively(conversations, (conversation) => {
    const plan = boardRepairPlan(conversation);
    if (plan) plans.push(plan);
  });
  const placementTransfers: { fromProject: string; toProject: string; paths: string[] }[] = [];
  await forEachCooperatively(plans, (plan) => {
    if (plan.previousProject && plan.previousProject !== plan.project) {
      placementTransfers.push({ fromProject: plan.previousProject, toProject: plan.project, paths: plan.placementPaths });
    }
  });
  if (placementTransfers.length > 0) {
    try {
      transferPlacements(placementTransfers);
    } catch (error) {
      console.warn("[account-migration] board project repair deferred", {
        projects: placementTransfers.length,
        error: safeProviderDiagnostic(error),
      });
      return;
    }
  }
  registry.markMigrationBoardPlacementProjects(
    plans.map((plan) => ({ id: plan.conversationId, operationId: plan.operationId, project: plan.project })),
  );
  const byProject = new Map<string, BoardRepairPlan[]>();
  await forEachCooperatively(plans, (plan) => {
    const projectPlans = byProject.get(plan.project) ?? [];
    projectPlans.push(plan);
    byProject.set(plan.project, projectPlans);
  });
  const converged: { id: ViewerConversationId; operationId: string; project: string }[] = [];
  await forEachCooperatively([...byProject], ([project, projectPlans]) => {
    try {
      const repaired = remapPaths(
        project,
        projectPlans.flatMap((plan) => plan.pairs),
        { provisionalManual: [...new Set(projectPlans.flatMap((plan) => plan.provisionalManual))] },
      );
      const aliases = repaired.pathAliases ?? {};
      if (!projectPlans.every((plan) => plan.pairs.every(({ from, to }) => aliases[from] === to))) {
        throw new Error("board continuity aliases did not converge");
      }
      converged.push(...projectPlans.map((plan) => ({ id: plan.conversationId, operationId: plan.operationId, project })));
    } catch (error) {
      console.warn("[account-migration] board continuity repair deferred", {
        project,
        conversations: projectPlans.length,
        error: safeProviderDiagnostic(error),
      });
    }
  });
  registry.markMigrationBoardProjects(converged);
}

async function cleanupDiscardedSuccessor(
  provider: SuccessorProviderPort,
  receipt: ProviderReceipt | null,
  latest: RegistryConversation,
  registry: AgentRegistry,
): Promise<void> {
  if (!receipt) return;
  const committed = latest.migration?.phase === "committed";
  const current = latest.generations.at(-1);
  const ownsCommittedHost = current?.host !== null && current?.host !== undefined
    && sameGenerationHostEvidence(current.host, receipt.host);
  if (committed && current?.id === receipt.nativeId && current.path === receipt.path && ownsCommittedHost) {
    registry.completeSuccessorCleanup(receipt.operationId);
    return;
  }
  registry.queueSuccessorCleanup(latest.id, receipt);
  try {
    await provider.cleanup?.(receipt);
    registry.completeSuccessorCleanup(receipt.operationId);
  } catch (error) {
    registry.recordSuccessorCleanupFailure(receipt.operationId, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether an in-flight reconfigure owns this switch, so this caller must not
 * execute it (issue #1028).
 *
 * Committing is only half of an account switch: the predecessor's structured
 * host is still claimed, still running on the source account, and the ONLY
 * code that retires it is the reconfigure executor, which releases and
 * terminates the source session key straight after its own commit. A tick, a
 * send, or a route that commits behind that executor therefore leaves a live
 * host on the old account and hands the reconfigure a switch it did not make —
 * two writers for one transition. So exactly one of them proceeds: the owner.
 *
 * The owner re-runs on its own queue (re-queued at a turn boundary, re-fired
 * whenever the host's turn state changes), so deferring here delays nothing.
 */
function reconfigureOwnsMigration(conversation: RegistryConversation, executingOperationId?: string): boolean {
  const reconfigure = conversation.reconfigure;
  if (reconfigure?.status !== "applying" || reconfigure.accountId !== conversation.migration?.targetId) return false;
  return reconfigure.operationId !== executingOperationId;
}

function sameTargetReconfigureCanReuseSuccessor(
  conversation: RegistryConversation,
  receipt: ProviderReceipt,
): boolean {
  const migration = conversation.migration;
  const reconfigure = conversation.reconfigure;
  return migration?.phase === "verifying"
    && migration.providerReceipt !== null
    && sameProviderReceiptOutcome(migration.providerReceipt, receipt)
    && reconfigure?.status === "applying"
    && reconfigure.accountId === migration.targetId;
}

export async function advanceConversationMigration(
  conversationId: ViewerConversationId,
  registry: AgentRegistry = agentRegistry(),
  provider: SuccessorProviderPort | HistoryCopyPort = productionProvider(),
  options: MigrationCoordinatorOptions = {},
): Promise<RegistryConversation> {
  let conversation = registry.conversation(conversationId);
  if (!conversation?.migration) throw new Error("conversation has no migration");
  if (reconfigureOwnsMigration(conversation, options.reconfigureOperationId)) return conversation;
  let migration = conversation.migration;
  if (migration.phase === "waiting-turn") {
    if (!successorCreationReady(conversation, registry)) return conversation;
    conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["waiting-turn"], { phase: "requested" });
    migration = conversation.migration!;
  }
  if (migration.phase === "committed") {
    if (!options.deferBoardRepair) await repairCommittedBoardSuccessions(
      [conversation],
      registry,
      options.remapBoardPaths ?? remapDurableBoardPaths,
      options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
    );
    return registry.conversation(conversation.id) ?? conversation;
  }
  if (migration.phase === "rolled-back" || migration.phase === "failed-recoverable") return conversation;
  const successorProvider = isCopyOnly(provider) ? copyAdapter(provider) : provider;
  let receipt: ProviderReceipt | null = migration.providerReceipt;
  try {
    if (migration.providerReceipt) {
      receipt = migration.providerReceipt;
    } else {
      if (!successorCreationReady(conversation, registry)) return conversation;
      const creationFencePhase = migration.phase;
      const restoreCreationFence = (current: RegistryConversation): RegistryConversation => {
        const currentMigration = current.migration ?? migration;
        if (currentMigration.phase !== creationFencePhase
          && (currentMigration.phase === "preparing" || currentMigration.phase === "successor-starting")) {
          return registry.transitionConversationMigration(
            current.id,
            currentMigration.revision,
            [currentMigration.phase],
            { phase: creationFencePhase },
          );
        }
        return current;
      };
      let source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
        ?? conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      if (!completeProviderTurnObservation(conversation, source, successorProvider.virtualSource === true, registry)) return conversation;
      if (migration.phase === "requested") {
        conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["requested"], { phase: "preparing" });
        migration = conversation.migration!;
      }
      if (migration.phase === "preparing") {
        conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["preparing"], { phase: "successor-starting" });
        migration = conversation.migration!;
      }
      conversation = registry.conversation(conversation.id) ?? conversation;
      migration = conversation.migration ?? migration;
      if (!successorCreationReady(conversation, registry)) return restoreCreationFence(conversation);
      source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
        ?? conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      if (!completeProviderTurnObservation(conversation, source, successorProvider.virtualSource === true, registry)) return restoreCreationFence(conversation);
      const conversationId = conversation.id;
      const creationOwner = { operationId: migration.operationId, revision: migration.revision };
      receipt = await successorProvider.create({
        engine: conversation.engine,
        operationId: creationOwner.operationId,
        conversationId,
        source,
        targetAccountId: migration.targetId,
        recordContinuityPath(pathname) {
          registry.recordMigrationContinuityPath(conversationId, pathname, creationOwner);
        },
      });
      if (receipt.operationId !== creationOwner.operationId) throw new Error("successor receipt operation does not match");
      conversation = registry.persistMigrationProviderReceipt(conversationId, creationOwner.revision, creationOwner.operationId, receipt);
      migration = conversation.migration!;
      receipt = migration.providerReceipt ?? receipt;
    }
    const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
      ?? conversation.generations.at(-1);
    if (!source) throw new Error("conversation has no source generation");
    if (!receipt || receipt.operationId !== migration.operationId) throw new Error("persisted successor receipt operation does not match");
    await successorProvider.verify(receipt, { engine: conversation.engine, targetAccountId: migration.targetId, launchProfile: source.launchProfile });
    const publicationConversationId = conversation.id;
    const publicationReceipt = receipt;
    const publicationRevision = migration.revision;
    const publicationOperationId = migration.operationId;
    const ownsPublication = async (): Promise<boolean> => {
      if (options.ownsOperation && !await options.ownsOperation()) return false;
      const owner = registry.conversation(publicationConversationId);
      const ownerMigration = owner?.migration;
      return Boolean(owner
        && ownerMigration?.phase === "verifying"
        && ownerMigration.revision === publicationRevision
        && ownerMigration.operationId === publicationOperationId
        && ownerMigration.providerReceipt !== null
        && sameProviderReceiptOutcome(ownerMigration.providerReceipt, publicationReceipt));
    };
    let publishOwner = registry.conversation(publicationConversationId);
    if (!publishOwner || !await ownsPublication()) {
      if (publishOwner) {
        if (!sameTargetReconfigureCanReuseSuccessor(publishOwner, publicationReceipt)) {
          await cleanupDiscardedSuccessor(successorProvider, publicationReceipt, publishOwner, registry);
        }
        if (!options.deferBoardRepair) await repairCommittedBoardSuccessions(
          [publishOwner],
          registry,
          options.remapBoardPaths ?? remapDurableBoardPaths,
          options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
        );
      }
      return registry.conversation(publicationConversationId) ?? publishOwner ?? conversation;
    }
    await successorProvider.publishHost?.(publicationReceipt, {
      engine: conversation.engine,
      conversationId: publicationConversationId,
      targetAccountId: migration.targetId,
      launchProfile: source.launchProfile,
      ownsOperation: ownsPublication,
    });
    publishOwner = registry.conversation(publicationConversationId);
    if (!publishOwner || !await ownsPublication()) {
      if (publishOwner) {
        if (!sameTargetReconfigureCanReuseSuccessor(publishOwner, publicationReceipt)) {
          await cleanupDiscardedSuccessor(successorProvider, publicationReceipt, publishOwner, registry);
        }
        if (!options.deferBoardRepair) await repairCommittedBoardSuccessions(
          [publishOwner],
          registry,
          options.remapBoardPaths ?? remapDurableBoardPaths,
          options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
        );
      }
      return registry.conversation(publicationConversationId) ?? publishOwner ?? conversation;
    }
    const committed = registry.commitSuccessor(publicationConversationId, {
      id: publicationReceipt.nativeId,
      path: publicationReceipt.path,
      accountId: migration.targetId,
      launchProfile: source.launchProfile,
      historyHash: publicationReceipt.historyHash,
      host: publicationReceipt.host,
    }, publicationRevision, publicationOperationId, publicationReceipt);
    if (!options.deferBoardRepair) await repairCommittedBoardSuccessions(
      [committed],
      registry,
      options.remapBoardPaths ?? remapDurableBoardPaths,
      options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
    );
    return registry.conversation(committed.id) ?? committed;
  } catch (error) {
    const latest = registry.conversation(conversation.id);
    if (error instanceof SuccessorPendingError) return latest ?? conversation;
    if (isStructuredDeliveryControllerUnavailable(error)) return latest ?? conversation;
    const durableReceipt = latest?.migration?.providerReceipt;
    const fencedByDurableReceipt = receipt !== null && durableReceipt !== null && durableReceipt !== undefined
      && !sameProviderReceiptOutcome(durableReceipt, receipt);
    if (latest && (
      !latest.migration
      || latest.migration.revision !== migration.revision
      || latest.migration.operationId !== migration.operationId
      || terminalMigrationPhase(latest.migration.phase)
      || fencedByDurableReceipt
    )) {
      await cleanupDiscardedSuccessor(successorProvider, receipt, latest, registry);
      if (!options.deferBoardRepair) await repairCommittedBoardSuccessions(
        [latest],
        registry,
        options.remapBoardPaths ?? remapDurableBoardPaths,
        options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
      );
      return registry.conversation(latest.id) ?? latest;
    }
    console.warn("[account-migration] recoverable successor provider failure", {
      conversationId: conversation.id,
      engine: conversation.engine,
      phase: migration.phase,
      targetAccountId: migration.targetId,
      error: safeProviderDiagnostic(error),
    });
    const safe = error instanceof CodexForkOutcomeUnknownError
      ? { message: "Codex fork outcome is awaiting recovery", code: "codex-fork-outcome-unknown" }
      : sanitizeProviderError(error);
    const failed = registry.transitionConversationMigration(conversation.id, migration.revision, ["requested", "preparing", "successor-starting", "verifying"], {
      phase: "failed-recoverable",
      error: safe.message,
      errorCode: safe.code,
    });
    await cleanupDiscardedSuccessor(successorProvider, receipt, failed, registry);
    return failed;
  }
}

export async function drainHeldDeliveries(
  conversationId: ViewerConversationId,
  delivery: HeldDeliveryPort,
  registry: AgentRegistry = agentRegistry(),
): Promise<void> {
  const conversation = registry.conversation(conversationId);
  const current = conversation?.generations.at(-1);
  if (!current) return;
  await forEachCooperatively(registry.pendingDeliveries(conversationId), async (item) => {
    const reconciling = item.state === "delivery-uncertain";
    if (reconciling && !delivery.reconcileUncertain) return;
    if (!reconciling && (item.state !== "assigned" || item.generationId !== current.id)) return;
    if (item.payloadKind !== "text" && item.payloadKind !== "runtime-images") {
      registry.recordDeliveryOutcome(item.id, "failed", "request-local delivery requires client retry");
      return;
    }
    const claimed = reconciling ? item : registry.beginDeliveryAttempt(item.id, current.id);
    if (!claimed) return;
    const clientMessageId = claimed.clientMessageId ?? `migration:${claimed.id}`;
    try {
      const input = { delivery: claimed, path: current.path, clientMessageId };
      const outcome = reconciling
        ? await delivery.reconcileUncertain!(input)
        : await delivery.deliver(input);
      if (outcome === "held") {
        if (!reconciling) registry.requeueUnactuatedDelivery(claimed.id);
      }
      else registry.recordDeliveryOutcome(claimed.id, outcome, outcome === "failed" ? "delivery failed and remains recoverable" : null);
    } catch {
      registry.recordDeliveryOutcome(claimed.id, "delivery-uncertain", "delivery result is uncertain and remains recoverable");
    }
  });
}

export async function reconcileMigrations(
  provider: SuccessorProviderPort,
  delivery: HeldDeliveryPort,
  registry: AgentRegistry = agentRegistry(),
  options: MigrationCoordinatorOptions = {},
): Promise<void> {
  const orphanedDeliveryReason =
    `${MIGRATION_DELIVERY_CANCELLATION_PREFIX} its upgrade-era reservation has no durable owner evidence; send again to authorize a fresh delivery action`;
  const before = registry.readOnlySnapshot();
  await forEachCooperatively(Object.values(before.pendingSuccessorCleanups), async (pending) => {
    const owner = registry.conversation(pending.conversationId);
    if (owner) await cleanupDiscardedSuccessor(provider, pending.receipt, owner, registry);
  });
  const pendingDeliveries = new Set<ViewerConversationId>();
  await forEachCooperatively(Object.values(before.heldDeliveries), (item) => {
    if (item.state !== "delivered" && (item.state !== "delivery-uncertain" || delivery.reconcileUncertain)) {
      pendingDeliveries.add(item.conversationId);
    }
  });
  await forEachCooperatively(Object.values(before.conversations), async (snapshotConversation) => {
    const needsFreshSnapshot = snapshotConversation.migration !== null || pendingDeliveries.has(snapshotConversation.id);
    let conversation = needsFreshSnapshot ? registry.conversation(snapshotConversation.id) ?? snapshotConversation : snapshotConversation;
    if (conversation.migration
      && conversation.migration.phase !== "committed"
      && conversation.migration.phase !== "rolled-back"
      && delivery.reconcileUncertain
      && registry.pendingDeliveries(conversation.id).some((item) => item.state === "delivery-uncertain")) {
      await drainHeldDeliveries(conversation.id, delivery, registry);
      conversation = registry.conversation(conversation.id) ?? conversation;
    }
    if (!conversation.migration) {
      const pending = registry.pendingDeliveries(conversation.id);
      for (const item of pending) {
        if ((item.state === "held" || item.state === "assigned")
          && !deliveryHasDurableClaimOwner(before, conversation, item)) {
          registry.terminalizeHeldDelivery(item.id, orphanedDeliveryReason);
        }
      }
      if (pending.some((item) =>
        (item.state === "assigned" && deliveryHasDurableClaimOwner(before, conversation, item))
        || (item.state === "delivery-uncertain" && delivery.reconcileUncertain))) {
        await drainHeldDeliveries(conversation.id, delivery, registry);
      }
      return;
    }
    if (conversation.migration.phase === "rolled-back") {
      /* A rolled-back migration owns only the deliveries that already existed
         when it rolled back (#972): the rollback stamped `migration.updatedAt`,
         so anything created afterwards is a fresh message the settled migration
         has no claim on. Reconciliation can reach this residue before the
         hygiene sweep clears it, so the same ownership fence applies here. */
      const rolledBackAt = Date.parse(conversation.migration.updatedAt);
      for (const item of registry.pendingDeliveries(conversation.id)) {
        if (item.state !== "held" && item.state !== "assigned" && item.state !== "delivery-uncertain") continue;
        const createdAt = Date.parse(item.createdAt);
        if (!Number.isFinite(rolledBackAt) || (Number.isFinite(createdAt) && createdAt > rolledBackAt)) continue;
        registry.terminalizeHeldDelivery(
          item.id,
          "delivery cancelled because its owning account migration was rolled back; send again to authorize a fresh delivery action",
        );
      }
      return;
    }
    if (conversation.migration.phase === "committed") {
      if (registry.pendingDeliveries(conversation.id).some((item) =>
        item.state === "assigned"
        || (item.state === "delivery-uncertain" && delivery.reconcileUncertain))) {
        await drainHeldDeliveries(conversation.id, delivery, registry);
      }
      return;
    }
    const migration = conversation.migration;
    const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
      ?? conversation.generations.at(-1);
    if (source?.accountId === null && !migration.providerReceipt) {
      registry.rollbackConversationMigration(conversation.id, migration.revision);
      return;
    }
    const advanced = await advanceConversationMigration(conversation.id, registry, provider, { ...options, deferBoardRepair: true });
    if (advanced.migration?.phase === "committed"
      && registry.pendingDeliveries(advanced.id).some((item) =>
        item.state === "assigned"
        || (item.state === "delivery-uncertain" && delivery.reconcileUncertain))) {
      await drainHeldDeliveries(advanced.id, delivery, registry);
    }
  });
  await yieldToRuntime();
  const after = registry.readOnlySnapshot();
  await repairCommittedBoardSuccessions(
    Object.values(after.conversations),
    registry,
    options.remapBoardPaths ?? remapDurableBoardPaths,
    options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
  );
  const conversationsByIntent = new Map<string, RegistryConversation[]>();
  await forEachCooperatively(Object.values(after.conversations), (conversation) => {
    const intentId = conversation.migration?.intentId;
    if (!intentId) return;
    const owned = conversationsByIntent.get(intentId) ?? [];
    owned.push(conversation);
    conversationsByIntent.set(intentId, owned);
  });
  await forEachCooperatively(Object.values(after.migrationIntents), (intent) => {
    if (intent.state !== "draining") return;
    const owned = conversationsByIntent.get(intent.id) ?? [];
    if (!owned.length || owned.every((conversation) => ["committed", "rolled-back", "failed-recoverable"].includes(conversation.migration?.phase ?? ""))) {
      registry.setMigrationIntentState(intent.id, "complete");
      /* A conversation-scoped reseat (issue #97) settles one thread: it must
         not book an engine-wide balance outcome nor start the auto-balance
         cooldown that would suppress a real engine drain. */
      if (intent.scope === "conversation") return;
      const outcome = owned.some((conversation) => conversation.migration?.phase === "failed-recoverable") ? "failed-partial" : "complete";
      registry.recordAutoBalanceOutcome(intent.engine, outcome, intent.evidence, new Date(Date.now() + AUTO_BALANCE_COOLDOWN_MS).toISOString());
    }
  });
}

export function deliveryFence(conversation: RegistryConversation): "deliver" | "held" | "recoverable" {
  if (!conversation.migration) return "deliver";
  if (["waiting-turn", "requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase)) return "held";
  if (conversation.migration.phase === "failed-recoverable") return "recoverable";
  return "deliver";
}
