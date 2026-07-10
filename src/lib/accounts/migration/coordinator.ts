import crypto from "node:crypto";

import { accountManager } from "@/lib/accounts/manager";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { agentRegistry, type AgentRegistry, type ConversationObservation, type RegistryConversation } from "@/lib/agent/registry";
import { headCwd } from "@/lib/agent/transcript";
import { listFiles } from "@/lib/scanner";
import { tailRecords } from "@/lib/scanner/activity";
import type { FileEntry } from "@/lib/types";

import {
  DisabledSuccessorProviderPort,
  emptyLaunchProfile,
  type HistoryCopyPort,
  type HeldDelivery,
  type MigrationEngine,
  type MigrationIntent,
  type MigrationOrigin,
  type ProviderReceipt,
  type SuccessorProviderPort,
  type ViewerConversationId,
} from "./contracts";
import { accountMigrationActivationEnabled, RegisteredSuccessorProvider } from "./provider";
import { sanitizeProviderError } from "./safeHistoryCopy";
import { turnStateFromRecords } from "./turnState";
import { AUTO_BALANCE_COOLDOWN_MS } from "./quotaPolicy";

export interface MigrationPreview {
  targetId: string;
  targetLabel: string;
  counts: { total: number; idle: number; busy: number; alreadyTarget: number; excludedRoots: number };
  excludedRoots: Array<{ conversationId: ViewerConversationId; title: string | null }>;
  rootWarning: boolean;
  previewRevision: number;
}

export interface HeldDeliveryPort {
  deliver(input: { delivery: HeldDelivery; path: string; clientMessageId: string }): Promise<"delivered" | "failed" | "delivery-uncertain">;
}

function engineOf(entry: FileEntry): MigrationEngine | null {
  return entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null;
}

function inventory(files: FileEntry[], registry: AgentRegistry): ConversationObservation[] {
  return files.flatMap((entry) => {
    const engine = engineOf(entry);
    if (!engine) return [];
    const existing = registry.conversationForPath(entry.path);
    const parentConversation = entry.parent ? registry.conversationForPath(entry.parent) : null;
    const owner = accountManager.resolveTranscriptOwner(engine, entry.path);
    const parsed = turnStateFromRecords(tailRecords(entry.path, entry.size), engine === "codex", true);
    const turn = parsed.state !== "terminal" && (entry.activity === "idle" || entry.activity === "recent")
      ? { state: "idle" as const, source: "empty" as const, terminalAt: null }
      : parsed;
    const currentProfile = registry.launchProfileForPath(entry.path)
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
  let idle = 0;
  let busy = 0;
  let alreadyTarget = 0;
  const excludedRoots: MigrationPreview["excludedRoots"] = [];
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.engine !== engine) continue;
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    if (generation.launchProfile.role === "root") {
      excludedRoots.push({ conversationId: conversation.id, title: generation.launchProfile.title });
      continue;
    }
    if (generation.accountId === targetId) { alreadyTarget += 1; continue; }
    if (conversation.turn.state === "busy" || conversation.turn.state === "unknown") busy += 1;
    else idle += 1;
  }
  return {
    targetId,
    targetLabel,
    counts: { total: idle + busy, idle, busy, alreadyTarget, excludedRoots: excludedRoots.length },
    excludedRoots,
    rootWarning: excludedRoots.length > 0,
    previewRevision: snapshot.engineRouting[engine].revision,
  };
}

export async function previewMigration(
  engine: MigrationEngine,
  targetId: string,
  registry: AgentRegistry = agentRegistry(),
  files?: FileEntry[],
): Promise<MigrationPreview> {
  await reconcileMigrationInventory(registry, files);
  return previewFromSnapshot(engine, targetId, registry);
}

export async function createMigrationIntent(
  engine: MigrationEngine,
  targetId: string,
  origin: MigrationOrigin,
  requestId: string = crypto.randomUUID(),
  previewRevision?: number,
  registry: AgentRegistry = agentRegistry(),
  files?: FileEntry[],
  evidence: MigrationIntent["evidence"] = null,
): Promise<{ intent: MigrationIntent; preview: MigrationPreview }> {
  await reconcileMigrationInventory(registry, files);
  const preview = previewFromSnapshot(engine, targetId, registry);
  const intent = registry.commitMigrationIntent({
    engine,
    targetId,
    origin,
    requestId,
    expectedRevision: previewRevision ?? preview.previewRevision,
    evidence,
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
        historyHash: "legacy-copy-port",
        host: { kind: "tmux", identity: "legacy-copy-port", epoch: 1, verifiedAt: new Date().toISOString() },
      };
    },
    async verify() {},
  };
}

function productionProvider(): SuccessorProviderPort {
  return accountMigrationActivationEnabled() ? new RegisteredSuccessorProvider() : new DisabledSuccessorProviderPort();
}

export async function advanceConversationMigration(
  conversationId: ViewerConversationId,
  registry: AgentRegistry = agentRegistry(),
  provider: SuccessorProviderPort | HistoryCopyPort = productionProvider(),
): Promise<RegistryConversation> {
  let conversation = registry.conversation(conversationId);
  if (!conversation?.migration) throw new Error("conversation has no migration");
  let migration = conversation.migration;
  if (migration.phase === "waiting-turn") {
    if (conversation.turn.state !== "terminal" && conversation.turn.state !== "idle") return conversation;
    conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["waiting-turn"], { phase: "requested" });
    migration = conversation.migration!;
  }
  if (migration.phase === "committed" || migration.phase === "rolled-back" || migration.phase === "failed-recoverable") return conversation;
  const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
    ?? conversation.generations.at(-1);
  if (!source) throw new Error("conversation has no source generation");
  const successorProvider = isCopyOnly(provider) ? copyAdapter(provider) : provider;
  try {
    let receipt: ProviderReceipt;
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
      receipt = await successorProvider.create({
        engine: conversation.engine,
        operationId: migration.operationId,
        conversationId: conversation.id,
        source,
        targetAccountId: migration.targetId,
      });
      if (receipt.operationId !== migration.operationId) throw new Error("successor receipt operation does not match");
      conversation = registry.transitionConversationMigration(conversation.id, migration.revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });
      migration = conversation.migration!;
    }
    if (receipt.operationId !== migration.operationId) throw new Error("persisted successor receipt operation does not match");
    await successorProvider.verify(receipt, { engine: conversation.engine, targetAccountId: migration.targetId, launchProfile: source.launchProfile });
    return registry.commitSuccessor(conversation.id, {
      id: receipt.nativeId,
      path: receipt.path,
      accountId: migration.targetId,
      launchProfile: source.launchProfile,
      historyHash: receipt.historyHash,
      host: receipt.host,
    }, migration.revision);
  } catch (error) {
    const latest = registry.conversation(conversation.id);
    if (latest?.migration && (latest.migration.revision !== migration.revision || latest.migration.operationId !== migration.operationId)) {
      return latest;
    }
    const safe = sanitizeProviderError(error);
    return registry.transitionConversationMigration(conversation.id, migration.revision, ["requested", "preparing", "successor-starting", "verifying"], {
      phase: "failed-recoverable",
      error: safe.message,
      errorCode: safe.code,
    });
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
    const claimed = registry.beginDeliveryAttempt(item.id, current.id);
    if (!claimed) continue;
    const clientMessageId = claimed.clientMessageId ?? `migration:${claimed.id}`;
    try {
      const outcome = await delivery.deliver({ delivery: claimed, path: current.path, clientMessageId });
      registry.recordDeliveryOutcome(claimed.id, outcome, outcome === "failed" ? "delivery failed and remains recoverable" : null);
    } catch {
      registry.recordDeliveryOutcome(claimed.id, "delivery-uncertain", "delivery result is uncertain and remains recoverable");
    }
  }
}

export async function reconcileMigrations(
  provider: SuccessorProviderPort,
  delivery: HeldDeliveryPort,
  registry: AgentRegistry = agentRegistry(),
): Promise<void> {
  const before = registry.snapshot();
  for (const conversation of Object.values(before.conversations)) {
    if (!conversation.migration || conversation.migration.phase === "committed" || conversation.migration.phase === "rolled-back") continue;
    const advanced = await advanceConversationMigration(conversation.id, registry, provider);
    if (advanced.migration?.phase === "committed") await drainHeldDeliveries(advanced.id, delivery, registry);
  }
  const after = registry.snapshot();
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
