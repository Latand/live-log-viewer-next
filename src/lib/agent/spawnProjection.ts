import fs from "node:fs";
import path from "node:path";

import { readOnlyConversationLookupFromSnapshot, type RegistryFile, type SpawnReceipt } from "./registry";
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

function launchIdentity(snapshot: RegistryFile, receipt: SpawnReceipt): { conversationId: string; generation?: number } {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversationId = lookup.canonicalConversationId(receipt.conversationId);
  const conversation = lookup.conversation(conversationId);
  const generationIndex = receipt.key
    ? conversation?.generations.findIndex((generation) => generation.id === receipt.key?.sessionId) ?? -1
    : -1;
  if (generationIndex >= 0) return { conversationId, generation: generationIndex + 1 };
  /* A fresh launch allocates generation one before the provider gives it a
     native id. Any receipt that already has a key, or targets a conversation
     with existing generations, is ambiguous when that key cannot be located and
     therefore projects no generation for the client join. */
  if (!receipt.key && (!conversation || conversation.generations.length === 0)) {
    return { conversationId, generation: 1 };
  }
  return { conversationId };
}

function initialDelivery(snapshot: RegistryFile, receipt: SpawnReceipt) {
  const launch = launchIdentity(snapshot, receipt);
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return Object.values(snapshot.heldDeliveries).find((delivery) =>
    lookup.canonicalConversationId(delivery.conversationId) === launch.conversationId
      && delivery.clientMessageId === `spawn_${receipt.launchId}`
      && delivery.command.operationId === `spawn_message_${receipt.launchId}`) ?? null;
}

/** The launch DISPLAY payload projected as the conversation's first user bubble
    (issue #614/#615). The durable `receipt.launchDisplay`, captured at receipt
    birth, is the authority: it is available across the WHOLE pre-transcript
    lifecycle — `starting` before any deferred delivery exists, and the
    delivered-but-scan-lagged interval after the held-delivery text is scrubbed.
    A legacy receipt with no durable payload falls back to the queued delivery
    text (its own echo identity), preserving the earlier behavior. */
function launchPromptOf(
  receipt: SpawnReceipt,
  delivery: ReturnType<typeof initialDelivery>,
): { prompt: string; promptImages: number; promptEcho: string } | null {
  const display = receipt.launchDisplay;
  if (display && (display.prompt.trim() || display.echo.trim() || display.images > 0)) {
    return { prompt: display.prompt, promptImages: display.images, promptEcho: display.echo };
  }
  if (delivery && (delivery.text.trim() || delivery.runtimeImages.length)) {
    return { prompt: delivery.text, promptImages: delivery.runtimeImages.length, promptEcho: delivery.text };
  }
  return null;
}

function cardState(snapshot: RegistryFile, receipt: SpawnReceipt): StructuredSpawnCardState {
  const delivery = initialDelivery(snapshot, receipt);
  const identity = launchIdentity(snapshot, receipt);
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
  const launchPrompt = launchPromptOf(receipt, delivery);
  /* The receipt time the initial message reached the agent (issue #648). Prefer
     the held delivery's own `deliveredAt`; a launch that completed without a
     retained delivery record (its text already scrubbed) falls back to the
     receipt creation time, which still bounds the delivered TTL. */
  const deliveredAt = delivered
    ? (Date.parse(delivery?.deliveredAt ?? "") || Date.parse(receipt.createdAt) || undefined)
    : undefined;
  return {
    launchId: receipt.launchId,
    clientAttemptId: receipt.clientAttemptId,
    accountId: receipt.accountId,
    accountPin: receipt.accountPin,
    conversationId: identity.conversationId,
    ...(identity.generation !== undefined ? { generation: identity.generation } : {}),
    state,
    initialMessage,
    retrySafe: receipt.state === "failed",
    error: receipt.error,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(launchPrompt
      ? {
          promptImages: launchPrompt.promptImages,
          promptAt: Date.parse(receipt.createdAt) || undefined,
          promptEcho: launchPrompt.promptEcho, prompt: launchPrompt.prompt,
        }
      : {}),
  };
}

/** The launch facts INSIDE an adopted live conversation window (issue #615): the
    transcript now renders the operator's message itself, so the launch stops
    contributing a prompt bubble in the same response — only its transient status
    chips remain. Strips every prompt-display field from the state. */
function launchFactsWithoutPrompt(spawn: StructuredSpawnCardState): StructuredSpawnCardState {
  if (spawn.prompt === undefined && spawn.promptEcho === undefined && spawn.promptImages === undefined && spawn.promptAt === undefined) {
    return spawn;
  }
  const facts = { ...spawn };
  delete facts.prompt;
  delete facts.promptImages;
  delete facts.promptAt;
  delete facts.promptEcho;
  return facts;
}

type ArtifactProbeResult = Pick<fs.Stats, "mtimeMs" | "size"> | boolean | null;

type MaterializedEntry = {
  entry: FileEntry | null;
  projected: boolean;
  artifactPresent: boolean;
};

/** One authoritative artifact path for this launch. The exact registered
    generation wins, followed by the runtime registry entry and receipt path.
    Every candidate is correlated to this receipt; an unrelated newest
    conversation generation can never retire a fresh placeholder. Selecting
    once bounds projection to one disk probe. */
function authoritativeArtifactPath(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
): string | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversationId = lookup.canonicalConversationId(receipt.conversationId);
  const generations = lookup.conversation(conversationId)?.generations ?? [];
  const exactGeneration = receipt.key
    ? generations.find((generation) => generation.id === receipt.key?.sessionId)
    : undefined;
  const runtimeEntry = receipt.key
    ? snapshot.entries[`${receipt.key.engine}:${receipt.key.sessionId}`]
    : undefined;
  return exactGeneration?.path
    ?? runtimeEntry?.artifactPath
    ?? receipt.artifactPath
    ?? null;
}

function scannerCompatibleActivity(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
  mtimeMs: number,
  nowMs: number,
): Pick<FileEntry, "activity" | "activityReason"> {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversationId = lookup.canonicalConversationId(receipt.conversationId);
  const observedTurn = lookup.conversation(conversationId)?.turn;
  const turnObservedAtMs = Date.parse(observedTurn?.observedAt ?? "");
  /* Conversation turn state can lag an actively growing artifact between
     inventory passes. Reuse it only when its observation covers this stat;
     otherwise the scanner's mtime tiers are the shared bounded fallback. */
  const turn = Number.isFinite(turnObservedAtMs) && turnObservedAtMs >= Math.trunc(mtimeMs)
    ? observedTurn
    : null;
  const age = (nowMs - mtimeMs) / 1_000;
  if (turn?.state === "busy") {
    return age < 180
      ? { activity: "live", activityReason: "jsonl_turn_open" }
      : { activity: "stalled", activityReason: "jsonl_turn_stalled" };
  }
  if (turn?.state === "terminal") {
    return {
      activity: age < 900 ? "recent" : "idle",
      activityReason: "jsonl_turn_completed",
    };
  }
  if (age < 20) return { activity: "live", activityReason: "mtime_fresh" };
  if (age < 900) return { activity: "recent", activityReason: "mtime_recent" };
  return { activity: "idle", activityReason: "mtime_old" };
}

/** Minimal transcript identity used during scanner lag. Scanner-derived fields
    replace these values when its row arrives; conversation identity, generation,
    launch activity, project placement, and lineage remain stable throughout. */
function projectedTranscriptEntry(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
  spawn: StructuredSpawnCardState,
  scannedPaths: ReadonlySet<string>,
  nowMs: number,
  artifactPath: string,
  probe: ArtifactProbeResult,
): FileEntry {
  const entry = spawnCard(snapshot, receipt, spawn, scannedPaths, nowMs);
  entry.path = artifactPath;
  entry.name = path.basename(artifactPath);
  delete entry.spawn;
  if (probe && typeof probe === "object") {
    entry.mtime = probe.mtimeMs / 1000;
    entry.size = probe.size;
    Object.assign(entry, scannerCompatibleActivity(snapshot, receipt, probe.mtimeMs, nowMs));
  }
  return entry;
}

/** The receipt-correlated transcript entry for a launch. A `spawn:` placeholder
    is never itself an answer here. A scanned row wins when its path matches the
    receipt's authoritative evidence; during scanner lag, one readable-file
    probe creates the same transcript identity immediately. */
function materializedEntry(
  byPath: ReadonlyMap<string, FileEntry>,
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
  spawn: StructuredSpawnCardState,
  scannedPaths: ReadonlySet<string>,
  nowMs: number,
  artifactProbe: (pathname: string) => ArtifactProbeResult,
): MaterializedEntry {
  const artifactPath = authoritativeArtifactPath(snapshot, receipt);
  if (artifactPath && !isSpawnPlaceholderPath(artifactPath)) {
    const scanned = byPath.get(artifactPath);
    if (scanned && !isSpawnPlaceholderPath(scanned.path)) {
      return { entry: scanned, projected: false, artifactPresent: true };
    }
    const probe = artifactProbe(artifactPath);
    if (probe) {
      const projectsTranscript = receipt.artifactLifecycle === "pending" || withinAdoptionGrace(receipt, nowMs);
      if (!projectsTranscript) return { entry: null, projected: false, artifactPresent: true };
      return {
        entry: projectedTranscriptEntry(snapshot, receipt, spawn, scannedPaths, nowMs, artifactPath, probe),
        projected: true,
        artifactPresent: true,
      };
    }
  }
  return { entry: null, projected: false, artifactPresent: false };
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
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const routes: Record<string, string> = {};
  for (const receipt of allLaunchReceipts(snapshot)) {
    routes[`spawn:${receipt.launchId}`] = lookup.canonicalConversationId(receipt.conversationId);
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
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const byConversation = new Map<string, SpawnReceipt>();
  for (const receipt of allLaunchReceipts(snapshot)) {
    const conversationId = lookup.canonicalConversationId(receipt.conversationId);
    const current = byConversation.get(conversationId);
    if (!current || current.createdAt < receipt.createdAt) byConversation.set(conversationId, receipt);
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

/** A real assistant turn this launch produced, read from the live transcript
    row the projection already holds (issue #1138). `lastAssistantMessageAt` is
    the scanner's visible-acknowledgment evidence — synthetic no-op and tool-only
    records do not count — so a number at or after the launch proves the agent
    answered. `null` (the scanned tail carried none) and `undefined` (no
    derivation ran, or a projected scanner-lag row) are both "no evidence yet". */
function assistantTurnObserved(live: FileEntry | null, launchedMs: number): boolean {
  const observedMs = live?.lastAssistantMessageAt;
  if (typeof observedMs !== "number") return false;
  return !Number.isFinite(launchedMs) || observedMs >= launchedMs;
}

/** Launch/delivery facts stop being news once the launch stops being news: the
    chips inside the conversation window are transient status, not permanent
    chrome (issue #569).

    A SUCCEEDED launch (`recovered` / `live-late-success`) retires on evidence —
    the conversation's own first assistant turn says everything the chips did, at
    any age (issue #1138). The {@link TERMINAL_SPAWN_RECENT_MS} bound stays as
    the fallback while no such evidence exists, and `failed` keeps that bound as
    its only rule: its error and retry are the point of the row. */
function transientLaunchFact(
  spawn: StructuredSpawnCardState,
  createdAt: string,
  nowMs: number,
  live: FileEntry | null,
): boolean {
  const succeeded = spawn.state === "recovered" || spawn.state === "live-late-success";
  if (!succeeded && spawn.state !== "failed") return true;
  const createdMs = Date.parse(createdAt);
  if (succeeded && assistantTurnObserved(live, createdMs)) return false;
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

/** One stat plus a read-access check verifies the authoritative artifact and
    captures the minimal metadata for its temporary transcript row. */
function readableArtifact(pathname: string): ArtifactProbeResult {
  try {
    const stat = fs.statSync(pathname);
    fs.accessSync(pathname, fs.constants.R_OK);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

/**
 * The one launch read-model (issue #569). Every structured launch receipt
 * resolves to exactly ONE conversation surface:
 *
 * - `facts` — the live transcript already represents this conversation, so the
 *   launch contributes transient status chips INSIDE that conversation window.
 *   It never projects a second board entry.
 * - `cards` — projection-owned rows: the launch placeholder while no readable
 *   artifact exists, then a minimal real-path row until the scanner carries it.
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
  artifactProbe: (pathname: string) => ArtifactProbeResult = readableArtifact,
): LaunchProjection {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  /* Scanner linking precedes the registry overlay in /api/files. Clear legacy
     operator-handoff compatibility evidence from materialized container members
     here, where the same response already has the durable membership snapshot. */
  for (const file of files) {
    const conversation = lookup.conversationForPath(file.path);
    if (conversation && (snapshot.memberships[conversation.id]?.length ?? 0) > 0) delete file.handoff;
  }
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
    const materialized = materializedEntry(
      byPath,
      snapshot,
      receipt,
      spawn,
      scannedPaths,
      nowMs,
      artifactProbe,
    );
    if (materialized.entry) {
      if (materialized.projected) cards.push(materialized.entry);
      if (transientLaunchFact(spawn, receipt.createdAt, nowMs, materialized.entry)) {
        facts.set(materialized.entry.path, launchFactsWithoutPrompt(spawn));
      }
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
      if (!materialized.artifactPresent || !withinAdoptionGrace(receipt, nowMs)) continue;
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
  const conversationId = spawn.conversationId ?? receipt.conversationId;
  /* Pre-admission cards honor the explicit operator project the moment the
     receipt exists; once admitted, the conversation record is authoritative. */
  const projectOwnership = snapshot.conversations[conversationId]?.projectOwnership
    ?? (receipt.explicitProject
      ? { project: receipt.explicitProject, source: "operator" as const, setAt: receipt.createdAt, operationId: receipt.launchId }
      : null);
  const attribution = resolveProjectAttribution({
    projectOwnership,
    cwd: receipt.cwd,
    launchProfileProject: receipt.launchProfile.project,
    fallbackProject: path.basename(receipt.cwd),
  });
  const edge = snapshot.lineageEdges[conversationId];
  const parentConversationId = edge?.parentConversationId ?? receipt.parentConversationId;
  const parentPath = parentConversationId
    ? snapshot.conversations[parentConversationId]?.generations.at(-1)?.path ?? null
    : null;
  const memberships = snapshot.memberships[conversationId] ?? [];
  /* Container-owned launches carry their durable flow/pipeline lineage. The
     handoff marker is reserved for an operator continuation from the composer. */
  const operatorHandoff = Boolean(parentPath && scannedPaths.has(parentPath) && memberships.length === 0);
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
    ...(operatorHandoff ? { handoff: true } : {}),
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
    conversationId,
    generation: spawn.generation,
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
