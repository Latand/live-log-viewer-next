import crypto from "node:crypto";

import { accountManager } from "@/lib/accounts/manager";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { agentRegistry, type AgentRegistry, type ConversationObservation, type MigrationScope, type RegistryConversation } from "@/lib/agent/registry";
import { headCwd, headSessionStartedAt } from "@/lib/agent/transcript";
import {
  remapBoardPaths as remapDurableBoardPaths,
  transferBoardPathPlacements as transferDurableBoardPathPlacements,
} from "@/lib/board/store";
import { listFiles } from "@/lib/scanner";
import { tailRecords } from "@/lib/scanner/activity";
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
import { turnStateFromRecords } from "./turnState";
import { AUTO_BALANCE_COOLDOWN_MS } from "./quotaPolicy";

export interface MigrationPreview {
  targetId: string;
  targetLabel: string;
  counts: { total: number; idle: number; busy: number; deferred: number; alreadyTarget: number };
  previewRevision: number;
}

export interface HeldDeliveryPort {
  deliver(input: { delivery: HeldDelivery; path: string; clientMessageId: string }): Promise<"delivered" | "failed" | "delivery-uncertain" | "held">;
}

function engineOf(entry: FileEntry): MigrationEngine | null {
  return entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null;
}

function inventory(files: FileEntry[], registry: AgentRegistry): ConversationObservation[] {
  const snapshot = registry.snapshot();
  const conversationByPath = new Map<string, RegistryConversation>();
  const launchProfileByPath = new Map<string, RegistryConversation["generations"][number]["launchProfile"]>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) {
      if (!conversationByPath.has(generation.path)) conversationByPath.set(generation.path, conversation);
      if (!launchProfileByPath.has(generation.path)) launchProfileByPath.set(generation.path, generation.launchProfile);
    }
    const current = conversation.generations.at(-1);
    for (const pathname of conversation.continuityPaths) {
      if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation);
      if (current && !launchProfileByPath.has(pathname)) launchProfileByPath.set(pathname, current.launchProfile);
    }
  }
  for (const receipt of Object.values(snapshot.receipts)) {
    if (receipt.artifactPath && !launchProfileByPath.has(receipt.artifactPath)) {
      launchProfileByPath.set(receipt.artifactPath, receipt.launchProfile);
    }
  }
  return files.flatMap((entry) => {
    const engine = engineOf(entry);
    if (!engine) return [];
    const existing = conversationByPath.get(entry.path) ?? null;
    const parentConversation = entry.parent ? conversationByPath.get(entry.parent) ?? null : null;
    const owner = accountManager.resolveTranscriptOwner(engine, entry.path);
    const parsed = turnStateFromRecords(tailRecords(entry.path, entry.size), engine === "codex", true);
    const turn = parsed.state !== "terminal" && (entry.activity === "idle" || entry.activity === "recent")
      ? { state: "idle" as const, source: "empty" as const, terminalAt: null }
      : parsed;
    const currentProfile = launchProfileByPath.get(entry.path)
      ?? existing?.generations.find((generation) => generation.path === entry.path)?.launchProfile;
    const configuredRoot = process.env.LLV_ROOT_CONVERSATION_ID;
    return [{
      engine,
      path: entry.path,
      accountId: owner?.accountId ?? null,
      launchProfile: emptyLaunchProfile({
        cwd: currentProfile?.cwd || headCwd(entry.path, { maxLines: 40 }) || "",
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
      startedAt: headSessionStartedAt(entry.path),
      observedAt: new Date(Math.max(entry.mtime * 1000, Date.now())).toISOString(),
    }];
  });
}

export async function reconcileMigrationInventory(registry: AgentRegistry = agentRegistry(), files?: FileEntry[]): Promise<ReturnType<AgentRegistry["snapshot"]>> {
  const entries = files ?? await listFiles();
  return registry.reconcileConversations(inventory(entries, registry));
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

function repairCommittedBoardSuccessions(
  conversations: readonly RegistryConversation[],
  registry: AgentRegistry,
  remapPaths: typeof remapDurableBoardPaths,
  transferPlacements: typeof transferDurableBoardPathPlacements,
): void {
  const plans = conversations.flatMap((conversation) => {
    const plan = boardRepairPlan(conversation);
    return plan ? [plan] : [];
  });
  const placementTransfers = plans.flatMap((plan) => plan.previousProject && plan.previousProject !== plan.project
    ? [{ fromProject: plan.previousProject, toProject: plan.project, paths: plan.placementPaths }]
    : []);
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
  for (const plan of plans) {
    byProject.set(plan.project, [...(byProject.get(plan.project) ?? []), plan]);
  }
  const converged: { id: ViewerConversationId; operationId: string; project: string }[] = [];
  for (const [project, plans] of byProject) {
    try {
      const repaired = remapPaths(
        project,
        plans.flatMap((plan) => plan.pairs),
        { provisionalManual: [...new Set(plans.flatMap((plan) => plan.provisionalManual))] },
      );
      const aliases = repaired.pathAliases ?? {};
      if (!plans.every((plan) => plan.pairs.every(({ from, to }) => aliases[from] === to))) {
        throw new Error("board continuity aliases did not converge");
      }
      converged.push(...plans.map((plan) => ({ id: plan.conversationId, operationId: plan.operationId, project })));
    } catch (error) {
      console.warn("[account-migration] board continuity repair deferred", {
        project,
        conversations: plans.length,
        error: safeProviderDiagnostic(error),
      });
    }
  }
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
    if (conversation.turn.state !== "terminal" && conversation.turn.state !== "idle") return conversation;
    if (registry.pendingDeliveries(conversation.id).some((delivery) => delivery.state === "delivery-uncertain")) return conversation;
    conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["waiting-turn"], { phase: "requested" });
    migration = conversation.migration!;
  }
  if (migration.phase === "committed") {
    if (!options.deferBoardRepair) repairCommittedBoardSuccessions(
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
      if (migration.phase === "requested") {
        conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["requested"], { phase: "preparing" });
        migration = conversation.migration!;
      }
      if (migration.phase === "preparing") {
        conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["preparing"], { phase: "successor-starting" });
        migration = conversation.migration!;
      }
      const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
        ?? conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
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
    const committed = registry.commitSuccessor(conversation.id, {
      id: receipt.nativeId,
      path: receipt.path,
      accountId: migration.targetId,
      launchProfile: source.launchProfile,
      historyHash: receipt.historyHash,
      host: receipt.host,
    }, migration.revision);
    if (!options.deferBoardRepair) repairCommittedBoardSuccessions(
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
      if (!options.deferBoardRepair) repairCommittedBoardSuccessions(
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
  for (const item of registry.pendingDeliveries(conversationId)) {
    if (item.state !== "assigned" || item.generationId !== current.id) continue;
    if (item.payloadKind !== "text") {
      registry.recordDeliveryOutcome(item.id, "failed", "request-local delivery requires client retry");
      continue;
    }
    const claimed = registry.beginDeliveryAttempt(item.id, current.id);
    if (!claimed) continue;
    const clientMessageId = claimed.clientMessageId ?? `migration:${claimed.id}`;
    try {
      const outcome = await delivery.deliver({ delivery: claimed, path: current.path, clientMessageId });
      if (outcome === "held") registry.requeueUnactuatedDelivery(claimed.id);
      else registry.recordDeliveryOutcome(claimed.id, outcome, outcome === "failed" ? "delivery failed and remains recoverable" : null);
    } catch {
      registry.recordDeliveryOutcome(claimed.id, "delivery-uncertain", "delivery result is uncertain and remains recoverable");
    }
  }
}

export async function reconcileMigrations(
  provider: SuccessorProviderPort,
  delivery: HeldDeliveryPort,
  registry: AgentRegistry = agentRegistry(),
  options: MigrationCoordinatorOptions = {},
): Promise<void> {
  const before = registry.snapshot();
  for (const pending of Object.values(before.pendingSuccessorCleanups)) {
    const owner = registry.conversation(pending.conversationId);
    if (owner) await cleanupDiscardedSuccessor(provider, pending.receipt, owner, registry);
  }
  const pendingDeliveries = new Set(Object.values(before.heldDeliveries)
    .filter((item) => item.state !== "delivered" && item.state !== "delivery-uncertain")
    .map((item) => item.conversationId));
  for (const conversation of Object.values(before.conversations)) {
    if (!conversation.migration || conversation.migration.phase === "rolled-back") {
      if (pendingDeliveries.has(conversation.id)) await drainHeldDeliveries(conversation.id, delivery, registry);
      continue;
    }
    if (conversation.migration.phase === "committed") {
      if (pendingDeliveries.has(conversation.id)) await drainHeldDeliveries(conversation.id, delivery, registry);
      continue;
    }
    const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
      ?? conversation.generations.at(-1);
    if (source?.accountId === null && !conversation.migration.providerReceipt) {
      registry.rollbackConversationMigration(conversation.id, conversation.migration.revision);
      continue;
    }
    const advanced = await advanceConversationMigration(conversation.id, registry, provider, { ...options, deferBoardRepair: true });
    if (advanced.migration?.phase === "committed" && pendingDeliveries.has(advanced.id)) await drainHeldDeliveries(advanced.id, delivery, registry);
  }
  const after = registry.snapshot();
  repairCommittedBoardSuccessions(
    Object.values(after.conversations),
    registry,
    options.remapBoardPaths ?? remapDurableBoardPaths,
    options.transferBoardPathPlacements ?? transferDurableBoardPathPlacements,
  );
  for (const intent of Object.values(after.migrationIntents)) {
    if (intent.state !== "draining") continue;
    const owned = Object.values(after.conversations).filter((conversation) => conversation.migration?.intentId === intent.id);
    if (!owned.length || owned.every((conversation) => ["committed", "rolled-back", "failed-recoverable"].includes(conversation.migration?.phase ?? ""))) {
      registry.setMigrationIntentState(intent.id, "complete");
      const outcome = owned.some((conversation) => conversation.migration?.phase === "failed-recoverable") ? "failed-partial" : "complete";
      registry.recordAutoBalanceOutcome(intent.engine, outcome, intent.evidence, new Date(Date.now() + AUTO_BALANCE_COOLDOWN_MS).toISOString());
    }
  }
}

export function deliveryFence(conversation: RegistryConversation): "deliver" | "held" | "recoverable" {
  if (!conversation.migration) return "deliver";
  if (["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration.phase)) return "held";
  if (conversation.migration.phase === "failed-recoverable") return "recoverable";
  return "deliver";
}
