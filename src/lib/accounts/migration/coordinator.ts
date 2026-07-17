import crypto from "node:crypto";
import fs from "node:fs";

import { accountManager } from "@/lib/accounts/manager";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { agentRegistry, type AgentRegistry, type ConversationObservation, type MigrationScope, type RegistryConversation } from "@/lib/agent/registry";
import { headCwd, headSessionStartedAt } from "@/lib/agent/transcript";
import {
  remapBoardPaths as remapDurableBoardPaths,
  transferBoardPathPlacements as transferDurableBoardPathPlacements,
} from "@/lib/board/store";
import { forEachCooperatively, yieldToRuntime } from "@/lib/cooperative";
import { listFiles } from "@/lib/scanner";
import { recordTranscriptComposerRelease, transcriptTurnResult } from "@/lib/scanner/activity";
import type { FileEntry } from "@/lib/types";

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
  type ViewerConversationId,
} from "./contracts";
import { CodexForkOutcomeUnknownError, RegisteredSuccessorProvider, SuccessorPendingError } from "./provider";
import { safeProviderDiagnostic, sanitizeProviderError } from "./safeHistoryCopy";
import { AUTO_BALANCE_COOLDOWN_MS } from "./quotaPolicy";

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

function engineOf(entry: FileEntry): MigrationEngine | null {
  return entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null;
}

function projectedInventoryTurn(
  entry: FileEntry,
  parsed: ConversationObservation["turn"] | null,
  existing: RegistryConversation | null,
): ConversationObservation["turn"] {
  if (!parsed) {
    if (existing && (existing.turn.state === "busy" || existing.turn.state === "unknown")) {
      return { state: existing.turn.state, source: existing.turn.source, terminalAt: existing.turn.terminalAt };
    }
    return { state: "unknown", source: "empty", terminalAt: null };
  }

  const activityComplete = entry.derivationComplete !== false;
  if (parsed.state === "busy" && activityComplete && entry.activityReason === "pane_at_composer") {
    return { state: "idle", source: "empty", terminalAt: null };
  }
  if (parsed.state === "unknown" && activityComplete && (entry.activity === "idle" || entry.activity === "recent")) {
    return { state: "idle", source: "empty", terminalAt: null };
  }
  return parsed;
}

async function inventory(files: FileEntry[], registry: AgentRegistry): Promise<ConversationObservation[]> {
  const inventoryStartedAt = Date.now();
  const snapshot = registry.snapshot();
  const conversationByPath = new Map<string, RegistryConversation>();
  const launchProfileByPath = new Map<string, RegistryConversation["generations"][number]["launchProfile"]>();
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
  const observations: ConversationObservation[] = [];
  await forEachCooperatively(files, (entry) => {
    const engine = engineOf(entry);
    if (!engine) return;
    const existing = conversationByPath.get(entry.path) ?? null;
    const parentConversation = entry.parent ? conversationByPath.get(entry.parent) ?? null : null;
    const owner = accountManager.resolveTranscriptOwner(engine, entry.path);
    const mtimeMs = entry.mtime * 1000;
    const observedTurn = transcriptTurnResult(entry.path, entry.size, mtimeMs, engine === "codex");
    const parsed = observedTurn.complete ? observedTurn.turn : null;
    if (observedTurn.complete && entry.derivationComplete !== false && entry.activityReason === "pane_at_composer") {
      recordTranscriptComposerRelease(entry.path, entry.size, mtimeMs, engine === "codex");
    }
    const turn = projectedInventoryTurn(entry, parsed, existing);
    const currentProfile = launchProfileByPath.get(entry.path)
      ?? existing?.generations.find((generation) => generation.path === entry.path)?.launchProfile;
    const configuredRoot = process.env.LLV_ROOT_CONVERSATION_ID;
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
      expectedTurnObservedAt: existing?.turn.observedAt ?? null,
      startedAt: entry.sessionStartedAt ?? headSessionStartedAt(entry.path, transcriptIdentity),
      observedAt: !observedTurn.complete && existing?.turn.observedAt
        ? existing.turn.observedAt
        : new Date(Math.max(entry.mtime * 1000, inventoryStartedAt)).toISOString(),
    });
  });
  return observations;
}

export async function reconcileMigrationInventory(registry: AgentRegistry = agentRegistry(), files?: FileEntry[]): Promise<ReturnType<AgentRegistry["snapshot"]>> {
  const entries = files ?? await listFiles();
  return registry.reconcileConversations(await inventory(entries, registry));
}

function previewFromSnapshot(engine: MigrationEngine, targetId: string, registry: AgentRegistry): MigrationPreview {
  const snapshot = registry.snapshot();
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
  if (conversation.turn.state !== "terminal" && conversation.turn.state !== "idle") return false;
  return !registry.pendingDeliveries(conversation.id).some((delivery) => delivery.state === "delivery-uncertain");
}

function completeProviderTurnObservation(
  conversation: RegistryConversation,
  source: RegistryConversation["generations"][number],
  virtualSource: boolean,
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
  return observed.turn.state === "terminal" || observed.composerReleased;
}

export interface MigrationCoordinatorOptions {
  remapBoardPaths?: typeof remapDurableBoardPaths;
  transferBoardPathPlacements?: typeof transferDurableBoardPathPlacements;
  deferBoardRepair?: boolean;
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

export async function advanceConversationMigration(
  conversationId: ViewerConversationId,
  registry: AgentRegistry = agentRegistry(),
  provider: SuccessorProviderPort | HistoryCopyPort = productionProvider(),
  options: MigrationCoordinatorOptions = {},
): Promise<RegistryConversation> {
  let conversation = registry.conversation(conversationId);
  if (!conversation?.migration) throw new Error("conversation has no migration");
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
      if (!completeProviderTurnObservation(conversation, source, successorProvider.virtualSource === true)) return conversation;
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
      if (!completeProviderTurnObservation(conversation, source, successorProvider.virtualSource === true)) return restoreCreationFence(conversation);
      const conversationId = conversation.id;
      receipt = await successorProvider.create({
        engine: conversation.engine,
        operationId: migration.operationId,
        conversationId,
        source,
        targetAccountId: migration.targetId,
        recordContinuityPath(pathname) {
          conversation = registry.recordConversationContinuityPath(conversationId, pathname);
        },
      });
      if (receipt.operationId !== migration.operationId) throw new Error("successor receipt operation does not match");
      conversation = registry.persistMigrationProviderReceipt(conversation.id, migration.revision, migration.operationId, receipt);
      migration = conversation.migration!;
      receipt = migration.providerReceipt ?? receipt;
    }
    const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
      ?? conversation.generations.at(-1);
    if (!source) throw new Error("conversation has no source generation");
    if (!receipt || receipt.operationId !== migration.operationId) throw new Error("persisted successor receipt operation does not match");
    await successorProvider.verify(receipt, { engine: conversation.engine, targetAccountId: migration.targetId, launchProfile: source.launchProfile });
    await successorProvider.publishHost?.(receipt, {
      engine: conversation.engine,
      conversationId: conversation.id,
      targetAccountId: migration.targetId,
      launchProfile: source.launchProfile,
    });
    const committed = registry.commitSuccessor(conversation.id, {
      id: receipt.nativeId,
      path: receipt.path,
      accountId: migration.targetId,
      launchProfile: source.launchProfile,
      historyHash: receipt.historyHash,
      host: receipt.host,
    }, migration.revision);
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
    if (item.payloadKind !== "text") {
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
  const before = registry.snapshot();
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
    if (!conversation.migration || conversation.migration.phase === "rolled-back") {
      if (pendingDeliveries.has(conversation.id)) await drainHeldDeliveries(conversation.id, delivery, registry);
      return;
    }
    if (conversation.migration.phase === "committed") {
      if (pendingDeliveries.has(conversation.id)) await drainHeldDeliveries(conversation.id, delivery, registry);
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
    if (advanced.migration?.phase === "committed" && pendingDeliveries.has(advanced.id)) await drainHeldDeliveries(advanced.id, delivery, registry);
  });
  await yieldToRuntime();
  const after = registry.snapshot();
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
      const outcome = owned.some((conversation) => conversation.migration?.phase === "failed-recoverable") ? "failed-partial" : "complete";
      registry.recordAutoBalanceOutcome(intent.engine, outcome, intent.evidence, new Date(Date.now() + AUTO_BALANCE_COOLDOWN_MS).toISOString());
    }
  });
}

export function deliveryFence(conversation: RegistryConversation): "deliver" | "held" | "recoverable" {
  if (!conversation.migration) return "deliver";
  if (["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase)) return "held";
  if (conversation.migration.phase === "failed-recoverable") return "recoverable";
  return "deliver";
}
