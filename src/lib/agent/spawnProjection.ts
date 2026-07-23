import fs from "node:fs";
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

/** The initial launch prompt still recoverable from the queued initial delivery
    (issue #614). The held delivery carries the operator's launch text until it is
    delivered, after which the registry clears it (the transcript then echoes it),
    so this returns a value only during the pre-transcript window — exactly when a
    surface that did not run the composer would otherwise show an empty feed. */
function launchPromptOf(delivery: ReturnType<typeof initialDelivery>): { prompt: string; promptImages: number } | null {
  if (!delivery) return null;
  const promptImages = delivery.runtimeImages.length;
  if (!delivery.text.trim() && !promptImages) return null;
  return { prompt: delivery.text, promptImages };
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
    state = receipt.completionMode === "route-recovered" ? "live-late-success" : "recovered";
    initialMessage = "delivered";
  } else if (delivery?.state === "delivery-uncertain" && delivery.error?.startsWith("structured initial message")) {
    state = "recoverable-timeout";
    initialMessage = "queued";
  } else if (delivery?.state === "delivery-uncertain") {
    state = "reconciling";
    initialMessage = "queued";
  } else if (queued) {
    state = "queued";
    initialMessage = "queued";
  } else if (binding) {
    state = "binding";
  }
  const launchPrompt = launchPromptOf(delivery);
  return {
    launchId: receipt.launchId,
    clientAttemptId: receipt.clientAttemptId,
    accountId: receipt.accountId,
    state,
    initialMessage,
    retrySafe: receipt.state === "failed",
    error: receipt.error,
    ...(launchPrompt
      ? { prompt: launchPrompt.prompt, promptImages: launchPrompt.promptImages, promptAt: Date.parse(receipt.createdAt) || undefined }
      : {}),
  };
}

/** The scanned transcript entry that already represents a launch's conversation.
    A `spawn:` placeholder is never itself an answer here — it IS the projection
    this lookup decides against. Resolution runs off the durable conversation
    record (its generations, newest first) so it works before `/api/files`
    annotates `conversationId` onto scanned entries, with the receipt's own
    artifact path and an already-annotated id as fallbacks. */
function materializedEntry(
  byPath: ReadonlyMap<string, FileEntry>,
  files: readonly FileEntry[],
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
): FileEntry | null {
  const generations = snapshot.conversations[receipt.conversationId]?.generations ?? [];
  for (let index = generations.length - 1; index >= 0; index -= 1) {
    const candidate = byPath.get(generations[index]!.path);
    if (candidate && !isSpawnPlaceholderPath(candidate.path)) return candidate;
  }
  if (receipt.artifactPath) {
    const candidate = byPath.get(receipt.artifactPath);
    if (candidate && !isSpawnPlaceholderPath(candidate.path)) return candidate;
  }
  return files.find((file) => file.conversationId === receipt.conversationId && !isSpawnPlaceholderPath(file.path)) ?? null;
}

/** A projected launch placeholder path (`spawn:<launchId>`). */
export function isSpawnPlaceholderPath(pathname: string): boolean {
  return pathname.startsWith("spawn:");
}

/** Every structured launch receipt still retained in the registry. */
function allLaunchReceipts(snapshot: RegistryFile): SpawnReceipt[] {
  return Object.values(snapshot.receipts).filter(
    (receipt) => receipt.transport === "structured" && receipt.purpose === "launch",
  );
}

/**
 * Durable launch routes (`spawn:<launchId>` → conversation id) for EVERY
 * retained launch receipt (round-1 P1#5). Routing is not subject to the card /
 * chip freshness rules: a second launch to the same conversation must not
 * invalidate the earlier `spawn:<launchId>` link, and an aged terminal receipt's
 * link must still resolve. Freshness affects only what RENDERS (cards/facts),
 * never what a deep link RESOLVES to.
 */
function allLaunchRoutes(snapshot: RegistryFile): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const receipt of allLaunchReceipts(snapshot)) {
    routes[`spawn:${receipt.launchId}`] = receipt.conversationId;
  }
  return routes;
}

/** The newest launch receipt per conversation, minus receipts aged out of the
    board entirely. Materialization is NOT filtered here: the caller decides
    whether a receipt projects a placeholder card (no live transcript) or
    annotates the live conversation with transient launch facts (issue #569).
    This governs CARDS and CHIPS only — routing spans every retained receipt via
    {@link allLaunchRoutes}. */
function newestLaunchReceipts(snapshot: RegistryFile, nowMs: number): SpawnReceipt[] {
  const byConversation = new Map<string, SpawnReceipt>();
  for (const receipt of allLaunchReceipts(snapshot)) {
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

/** Launch/delivery facts stop being news once the launch has been terminal for
    {@link TERMINAL_SPAWN_RECENT_MS}: the chips inside the conversation window
    are transient status, not permanent chrome (issue #569). */
function transientLaunchFact(spawn: StructuredSpawnCardState, createdAt: string, nowMs: number): boolean {
  const terminal = spawn.state === "failed" || spawn.state === "recovered" || spawn.state === "live-late-success";
  if (!terminal) return true;
  const createdMs = Date.parse(createdAt);
  return !Number.isFinite(createdMs) || nowMs - createdMs < TERMINAL_SPAWN_RECENT_MS;
}

/** The pre-adoption grace (issue #614): a launch whose transcript inventory
    already materialized but which THIS scan did not carry stays projected only
    while it is this recent — long enough to cover a project-scoped or
    cache-lagged poll before the live transcript reaches the same view, short
    enough that an aged materialized receipt whose transcript legitimately lives
    outside a scoped scan folds into history instead of resurrecting a phantom
    placeholder. */
function withinAdoptionGrace(receipt: SpawnReceipt, nowMs: number): boolean {
  const createdMs = Date.parse(receipt.createdAt);
  return !Number.isFinite(createdMs) || nowMs - createdMs < TERMINAL_SPAWN_RECENT_MS;
}

/** Disk existence of a materialized artifact, the discriminator between the
    #614 pre-adoption gap (the transcript exists but this scan omitted it — keep
    the window) and a deleted transcript (gone — retire the window). Injected so
    the projection stays a deterministic read model in tests. */
function artifactOnDisk(pathname: string): boolean {
  try {
    return fs.existsSync(pathname);
  } catch {
    return false;
  }
}

/**
 * The one launch read-model (issue #569). Every structured launch receipt
 * resolves to exactly ONE conversation surface:
 *
 * - `facts` — the live transcript already represents this conversation, so the
 *   launch contributes transient status chips INSIDE that conversation window.
 *   It never projects a second board entry.
 * - `cards` — nothing has materialized yet, so the launch itself projects the
 *   conversation window in its earliest state.
 * - `routes` — `spawn:<launchId>` → canonical conversation id, so a refresh or
 *   a copied launch deep link resolves to the live conversation for as long as
 *   the receipt is board history at all.
 *
 * Pure read model: repeated calls over an unchanged registry are byte-stable.
 */
export interface LaunchProjection {
  cards: FileEntry[];
  facts: Map<string, StructuredSpawnCardState>;
  routes: Record<string, string>;
}

export function projectLaunchConversations(
  files: readonly FileEntry[],
  snapshot: RegistryFile,
  nowMs = Date.now(),
  artifactExists: (pathname: string) => boolean = artifactOnDisk,
): LaunchProjection {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const scannedPaths = new Set(byPath.keys());
  const receipts = newestLaunchReceipts(snapshot, nowMs);
  const cards: FileEntry[] = [];
  const facts = new Map<string, StructuredSpawnCardState>();
  /* Routes span EVERY retained launch receipt (round-1 P1#5); cards/facts below
     apply the freshness rules to only the newest per conversation. */
  const routes = allLaunchRoutes(snapshot);
  for (const receipt of receipts) {
    const spawn = cardState(snapshot, receipt);
    /* The materialized live conversation immediately retires the duplicate
       spawn projection (#569/#614): the launch folds into that window as chips.
       Retirement happens ONLY here — when the adopted live conversation is
       available in the SAME response — so the window never blinks out before its
       transcript reaches the view. */
    const live = materializedEntry(byPath, files, snapshot, receipt);
    if (live) {
      if (transientLaunchFact(spawn, receipt.createdAt, nowMs)) facts.set(live.path, spawn);
      continue;
    }
    /* No live transcript in this payload: the launch still owns the window
       across every pre-adoption state (starting/queued/reconciling/delivering).
       A receipt whose artifact inventory already materialized keeps its window
       only while the transcript still exists on disk (a project-scoped or
       cache-lagged scan that simply did not carry it — issue #614) and the
       launch is still recent; a gone transcript, or an aged materialized receipt
       whose transcript legitimately lives outside a scoped scan, retires instead
       of resurrecting a phantom placeholder. A still-`pending` launch always
       projects — inventory has never materialized its artifact. */
    if (receipt.artifactLifecycle !== "pending") {
      const present = Boolean(receipt.artifactPath && artifactExists(receipt.artifactPath));
      if (!present || !withinAdoptionGrace(receipt, nowMs)) continue;
    }
    cards.push(spawnCard(snapshot, receipt, spawn, scannedPaths, nowMs));
  }
  return { cards, facts, routes };
}

export function preallocatedStructuredSpawnCards(
  files: readonly FileEntry[],
  snapshot: RegistryFile,
  nowMs = Date.now(),
): FileEntry[] {
  return projectLaunchConversations(files, snapshot, nowMs).cards;
}

function spawnCard(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
  spawn: StructuredSpawnCardState,
  scannedPaths: ReadonlySet<string>,
  nowMs: number,
): FileEntry {
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
}
