import path from "node:path";

import type { RegistryFile, SpawnReceipt } from "./registry";
import { projectRootForCwd } from "@/lib/scanner/describe";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";

const TERMINAL_SPAWN_RECENT_MS = 15 * 60 * 1_000;

/* Placeholder retirement (#342): a terminal receipt older than this bound is
   pure history — it stops projecting a board FileEntry entirely. A pure
   read-model rule: the durable receipt is never mutated or deleted, repeated
   scans stay byte-stable, and restart changes nothing. Non-terminal receipts
   always project (the #334 convergence pass turns dead-evidence launches
   terminal, after which they age through the same tiers: prominent card for
   15 min, launch-history strip until 24 h, retired after). Mirrored by
   LAUNCH_HISTORY_RETIREMENT_MS in components/launchHistoryModel.ts. */
export const PLACEHOLDER_RETIREMENT_MS = 24 * 60 * 60 * 1_000;

function retiredTerminalReceipt(receipt: SpawnReceipt, nowMs: number): boolean {
  const terminal = receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted";
  if (!terminal) return false;
  const createdMs = Date.parse(receipt.createdAt);
  return Number.isFinite(createdMs) && nowMs - createdMs >= PLACEHOLDER_RETIREMENT_MS;
}

function initialDelivery(snapshot: RegistryFile, receipt: SpawnReceipt) {
  return Object.values(snapshot.heldDeliveries).find((delivery) =>
    delivery.conversationId === receipt.conversationId
      && delivery.clientMessageId === `spawn_${receipt.launchId}`) ?? null;
}

function cardState(snapshot: RegistryFile, receipt: SpawnReceipt): StructuredSpawnCardState {
  const delivery = initialDelivery(snapshot, receipt);
  const failed = receipt.state === "failed" || receipt.state === "conflicted";
  const delivered = delivery?.state === "delivered" || receipt.state === "completed";
  const queued = Boolean(delivery)
    || receipt.state === "prompt-delivered";
  const binding = receipt.state === "pane-bound"
    || receipt.state === "host-verified"
    || Boolean(receipt.key || receipt.artifactPath);
  let state: StructuredSpawnCardState["state"] = "starting";
  let initialMessage: StructuredSpawnCardState["initialMessage"] = "pending";
  if (failed) {
    state = "failed";
    initialMessage = "failed";
  } else if (delivered) {
    state = "recovered";
    initialMessage = "delivered";
  } else if (queued) {
    state = "queued";
    initialMessage = "queued";
  } else if (binding) {
    state = "binding";
  }
  return {
    launchId: receipt.launchId,
    clientAttemptId: receipt.clientAttemptId,
    accountId: receipt.accountId,
    state,
    initialMessage,
    retrySafe: receipt.state === "failed",
    error: receipt.error,
  };
}

function newestUnscannedReceipts(files: readonly FileEntry[], snapshot: RegistryFile, nowMs: number): SpawnReceipt[] {
  const scannedConversations = new Set(files.flatMap((file) => file.conversationId ? [file.conversationId] : []));
  const scannedPaths = new Set(files.map((file) => file.path));
  const byConversation = new Map<string, SpawnReceipt>();
  for (const receipt of Object.values(snapshot.receipts)) {
    if (receipt.transport !== "structured" || receipt.purpose !== "launch") continue;
    if (receipt.artifactLifecycle !== "pending") continue;
    if (scannedConversations.has(receipt.conversationId)) continue;
    if (receipt.artifactPath && scannedPaths.has(receipt.artifactPath)) continue;
    const current = byConversation.get(receipt.conversationId);
    if (!current || current.createdAt < receipt.createdAt) byConversation.set(receipt.conversationId, receipt);
  }
  return [...byConversation.values()].filter((receipt) => !retiredTerminalReceipt(receipt, nowMs));
}

function projectedActivity(spawn: StructuredSpawnCardState, createdAt: string, nowMs: number): FileEntry["activity"] {
  const terminal = spawn.state === "failed" || spawn.state === "recovered";
  const createdMs = Date.parse(createdAt);
  if (terminal && Number.isFinite(createdMs) && nowMs - createdMs >= TERMINAL_SPAWN_RECENT_MS) return "idle";
  if (spawn.state === "failed") return "stalled";
  if (spawn.state === "recovered") return "recent";
  return "live";
}

export function preallocatedStructuredSpawnCards(
  files: readonly FileEntry[],
  snapshot: RegistryFile,
  nowMs = Date.now(),
): FileEntry[] {
  const scannedPaths = new Set(files.map((file) => file.path));
  return newestUnscannedReceipts(files, snapshot, nowMs).map((receipt) => {
    const spawn = cardState(snapshot, receipt);
    /* Pre-admission cards honor the explicit operator project the moment the
       receipt exists; once admitted, the conversation record is authoritative. */
    const projectOwnership = snapshot.conversations[receipt.conversationId]?.projectOwnership
      ?? (receipt.explicitProject
        ? { project: receipt.explicitProject, source: "operator" as const, setAt: receipt.createdAt, operationId: receipt.launchId }
        : null);
    const attribution = resolveProjectAttribution({
      projectOwnership,
      cwd: receipt.cwd,
      launchProfileProject: receipt.launchProfile.project,
      fallbackProject: path.basename(receipt.cwd),
    });
    const edge = snapshot.lineageEdges[receipt.conversationId];
    const parentConversationId = edge?.parentConversationId ?? receipt.parentConversationId;
    const parentPath = parentConversationId
      ? snapshot.conversations[parentConversationId]?.generations.at(-1)?.path ?? null
      : null;
    const memberships = snapshot.memberships[receipt.conversationId] ?? [];
    return {
      path: `spawn:${receipt.launchId}`,
      root: receipt.engine === "codex" ? "codex-sessions" : "claude-projects",
      name: `spawn:${receipt.launchId}`,
      project: attribution.project ?? path.basename(receipt.cwd),
      ...(projectOwnership ? { projectOwnership } : {}),
      cwd: receipt.cwd,
      projectRoot: projectRootForCwd(receipt.cwd) ?? null,
      ...(attribution.worktree ? { worktree: attribution.worktree } : {}),
      title: receipt.launchProfile.title ?? (receipt.engine === "codex" ? "Codex" : "Claude"),
      engine: receipt.engine,
      kind: "session",
      fmt: receipt.engine,
      // A preallocated card is by definition a Viewer launch (issue #339).
      spawnOrigin: "viewer",
      parent: parentPath && scannedPaths.has(parentPath) ? parentPath : null,
      ...(parentPath && scannedPaths.has(parentPath) ? { handoff: true } : {}),
      mtime: Date.parse(receipt.createdAt) / 1000,
      size: 0,
      activity: projectedActivity(spawn, receipt.createdAt, nowMs),
      activityReason: `structured_spawn_${spawn.state}`,
      proc: null,
      pid: null,
      model: receipt.launchProfile.model,
      launchModel: receipt.launchProfile.model,
      effort: receipt.launchProfile.effort,
      fast: receipt.launchProfile.fast,
      pendingQuestion: null,
      plan: receipt.launchProfile.plan,
      goal: receipt.launchProfile.goal,
      waitingInput: null,
      conversationId: receipt.conversationId,
      ...(edge || memberships.length ? {
        durableLineage: {
          kind: edge?.kind ?? "spawn",
          role: receipt.agentRole ?? edge?.role ?? null,
          depth: receipt.delegationDepth,
          parentConversationId: edge?.parentConversationId ?? receipt.parentConversationId,
          reviewsConversationId: edge?.reviewsConversationId ?? null,
          memberships: memberships.map((membership) => ({
            kind: membership.kind,
            containerId: membership.containerId,
            role: membership.role,
            slot: membership.slot,
            stageId: membership.stageId,
            stageOrder: membership.stageOrder,
            round: membership.round,
            parentConversationId: membership.parentConversationId,
          })),
        },
      } : {}),
      spawn,
    };
  });
}
