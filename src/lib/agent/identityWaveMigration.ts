import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { durableSemanticTitle, semanticTitle } from "@/lib/title";

import type { RegistryConversation, RegistryFile, SpawnLineageEdge } from "./registry";

export const IDENTITY_WAVE_MIGRATION = "identity-wave-a-d-913";

export interface IdentityWaveSeat {
  project: string;
  seatEpoch: number;
  conversationId: string | null;
  predecessorConversationId: string | null;
  designatedAt: string;
  activatedAt: string | null;
  path?: string | null;
}

export interface IdentityWavePathRekey {
  legacyPath: string;
  sharedPath: string;
}

export interface IdentityWaveMigrationInput {
  dryRun?: boolean;
  now: string;
  transcriptTitle(pathname: string, engine: "claude" | "codex"): string | null;
  sharedPathForLegacy(pathname: string): string | null;
  orchestratorSeats: readonly IdentityWaveSeat[];
  commitExternalPathRekeys?(rekeys: readonly IdentityWavePathRekey[]): void;
}

export interface IdentityWaveMigrationResult {
  dryRun: boolean;
  alreadyCompleted: boolean;
  retitled: number;
  rekeyed: number;
  /** Rekey pairs skipped because the shared path is already owned elsewhere.
      Reported, never silently dropped: each one is a duplicate-identity repair
      the wave cannot make on its own evidence. */
  quarantinedRekeys: number;
  edgesStamped: number;
}

function canonicalConversationId(file: RegistryFile, conversationId: string): ViewerConversationId | null {
  if (!conversationId.startsWith("conversation_")) return null;
  let current = conversationId as ViewerConversationId;
  const seen = new Set<string>();
  while (file.conversationAliases[current] && !seen.has(current)) {
    seen.add(current);
    current = file.conversationAliases[current]!;
  }
  return seen.has(current) ? null : current;
}

function semanticEvidence(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const firstNonEmptyLine = value.split(/\r?\n/).find((line) => line.trim());
  return semanticTitle(firstNonEmptyLine, 120);
}

function receiptTitles(file: RegistryFile): Map<ViewerConversationId, string> {
  const titles = new Map<ViewerConversationId, string>();
  const receipts = Object.values(file.receipts)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const receipt of receipts) {
    const conversationId = canonicalConversationId(file, receipt.conversationId);
    const title = semanticEvidence(receipt.launchDisplay?.prompt);
    if (conversationId && title && !titles.has(conversationId)) titles.set(conversationId, title);
  }
  return titles;
}

type EvidenceResolution<T> =
  | { kind: "found"; value: T }
  | { kind: "absent" }
  | { kind: "failed"; error: unknown };

interface ConversationEvidence {
  conversationTitle: string | null;
  needsTitleCleanup: boolean;
  pathRekeys: IdentityWavePathRekey[];
  transcriptTitle: string | null;
}

function placeholderTitle(value: string | null | undefined): boolean {
  return typeof value === "string" && semanticTitle(value) === null;
}

function newestSemanticConversationTitle(conversation: RegistryConversation): string | null {
  for (let index = conversation.generations.length - 1; index >= 0; index -= 1) {
    const title = durableSemanticTitle(conversation.generations[index]!.launchProfile.title);
    if (title) return title;
  }
  return null;
}

function conversationNeedsTitleCleanup(file: RegistryFile, conversation: RegistryConversation): boolean {
  if (conversation.generations.some((generation) => placeholderTitle(generation.launchProfile.title))) return true;
  const ownedPaths = new Set(conversation.generations.map((generation) => generation.path));
  if (Object.values(file.entries).some((entry) => ownedPaths.has(entry.artifactPath)
    && placeholderTitle(entry.launchProfile?.title))) return true;
  return Object.values(file.receipts).some((receipt) => canonicalConversationId(file, receipt.conversationId) === conversation.id
    && placeholderTitle(receipt.launchProfile.title));
}

function safeSharedPath(input: IdentityWaveMigrationInput, pathname: string): EvidenceResolution<string> {
  try {
    const candidate = input.sharedPathForLegacy(pathname);
    return candidate && candidate !== pathname
      ? { kind: "found", value: candidate }
      : { kind: "absent" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function safeTranscriptTitle(
  input: IdentityWaveMigrationInput,
  pathname: string,
  engine: "claude" | "codex",
): EvidenceResolution<string> {
  try {
    const title = semanticEvidence(input.transcriptTitle(pathname, engine));
    return title ? { kind: "found", value: title } : { kind: "absent" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function evidenceValue<T>(resolution: EvidenceResolution<T>): T | null {
  if (resolution.kind === "failed") throw resolution.error;
  return resolution.kind === "found" ? resolution.value : null;
}

function resolveConversationEvidence(
  file: RegistryFile,
  input: IdentityWaveMigrationInput,
  titlesByReceipt: ReadonlyMap<ViewerConversationId, string>,
): Map<ViewerConversationId, ConversationEvidence> {
  const evidence = new Map<ViewerConversationId, ConversationEvidence>();
  for (const conversation of Object.values(file.conversations)) {
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    const conversationTitle = newestSemanticConversationTitle(conversation);
    const needsTitleCleanup = conversationNeedsTitleCleanup(file, conversation);
    const pathRekeys = conversation.generations.flatMap((ownedGeneration) => {
      const sharedPath = evidenceValue(safeSharedPath(input, ownedGeneration.path));
      return sharedPath ? [{ legacyPath: ownedGeneration.path, sharedPath }] : [];
    });
    const transcriptPath = pathRekeys.find((rekey) => rekey.legacyPath === generation.path)?.sharedPath
      ?? generation.path;
    const needsTranscriptTitle = needsTitleCleanup
      && conversationTitle === null
      && !titlesByReceipt.has(conversation.id);
    const transcriptTitle = needsTranscriptTitle
      ? evidenceValue(safeTranscriptTitle(input, transcriptPath, conversation.engine))
      : null;
    evidence.set(conversation.id, { conversationTitle, needsTitleCleanup, pathRekeys, transcriptTitle });
  }
  return evidence;
}

/** Drops the rekey pairs whose shared path is claimed by another conversation
    (or by a second legacy path) and keeps the rest. A collision is durable data
    state — two registry rows describing one transcript — so aborting the wave on
    it would never converge on retry and would strand every clean rekey and every
    placeholder retitle behind it. Quarantining is per pair, counted, and
    reported by the caller; evidence *read* failures still abort the whole wave,
    because those genuinely can succeed on a later startup. */
function resolveRekeyOwnership(
  file: RegistryFile,
  evidence: Map<ViewerConversationId, ConversationEvidence>,
): { rekeys: IdentityWavePathRekey[]; quarantined: number } {
  const owners = new Map<string, Set<ViewerConversationId>>();
  const generationPaths = new Map<string, Set<ViewerConversationId>>();
  const rememberOwner = (map: Map<string, Set<ViewerConversationId>>, pathname: string, conversationId: ViewerConversationId) => {
    const pathOwners = map.get(pathname) ?? new Set<ViewerConversationId>();
    pathOwners.add(conversationId);
    map.set(pathname, pathOwners);
  };
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) {
      rememberOwner(owners, generation.path, conversation.id);
      rememberOwner(generationPaths, generation.path, conversation.id);
    }
    for (const pathname of conversation.continuityPaths) rememberOwner(owners, pathname, conversation.id);
  }

  const targetSources = new Map<string, string>();
  const rekeys: IdentityWavePathRekey[] = [];
  let quarantined = 0;
  for (const [conversationId, conversationEvidence] of evidence) {
    const owned: IdentityWavePathRekey[] = [];
    for (const rekey of conversationEvidence.pathRekeys) {
      const pathOwners = owners.get(rekey.sharedPath);
      const sourceOwners = owners.get(rekey.legacyPath);
      const generationOwners = generationPaths.get(rekey.sharedPath);
      const priorSource = targetSources.get(rekey.sharedPath);
      if (!sourceOwners || sourceOwners.size !== 1 || !sourceOwners.has(conversationId)
        || (pathOwners && [...pathOwners].some((owner) => owner !== conversationId))
        || (generationOwners && rekey.sharedPath !== rekey.legacyPath)
        || (priorSource && priorSource !== rekey.legacyPath)) {
        quarantined += 1;
        continue;
      }
      targetSources.set(rekey.sharedPath, rekey.legacyPath);
      owned.push(rekey);
      rekeys.push(rekey);
    }
    conversationEvidence.pathRekeys = owned;
  }
  return { rekeys, quarantined };
}

function rekeyProviderReceipt(
  receipt: { path: string; continuityPaths: string[] },
  legacyPath: string,
  sharedPath: string,
): void {
  if (receipt.path === legacyPath) receipt.path = sharedPath;
  receipt.continuityPaths = [...new Set(receipt.continuityPaths.map((pathname) => (
    pathname === legacyPath ? sharedPath : pathname
  )))];
}

function rekeyArtifactReferences(file: RegistryFile, legacyPath: string, sharedPath: string): void {
  for (const entry of Object.values(file.entries)) {
    if (entry.artifactPath === legacyPath) entry.artifactPath = sharedPath;
  }
  for (const receipt of Object.values(file.receipts)) {
    if (receipt.artifactPath === legacyPath) receipt.artifactPath = sharedPath;
    if (receipt.resumeSourcePath === legacyPath) receipt.resumeSourcePath = sharedPath;
  }
  for (const edge of Object.values(file.lineageEdges)) {
    if (edge.childArtifactPath === legacyPath) edge.childArtifactPath = sharedPath;
    if (edge.parentArtifactPath === legacyPath) edge.parentArtifactPath = sharedPath;
  }
  for (const delivery of Object.values(file.heldDeliveries)) {
    delivery.artifactPaths = [...new Set(delivery.artifactPaths.map((pathname) => (
      pathname === legacyPath ? sharedPath : pathname
    )))];
  }
  for (const conversation of Object.values(file.conversations)) {
    const migration = conversation.migration;
    if (!migration) continue;
    if (migration.providerReceipt) rekeyProviderReceipt(migration.providerReceipt, legacyPath, sharedPath);
    migration.pendingContinuityPaths = [...new Set(migration.pendingContinuityPaths.map((pathname) => (
      pathname === legacyPath ? sharedPath : pathname
    )))];
  }
  for (const pending of Object.values(file.pendingSuccessorCleanups)) {
    rekeyProviderReceipt(pending.receipt, legacyPath, sharedPath);
  }
  const resumePane = file.legacyResumePanes.panes[legacyPath];
  if (resumePane) {
    file.legacyResumePanes.panes[sharedPath] ??= resumePane;
    delete file.legacyResumePanes.panes[legacyPath];
  }
}

export function stampOrchestratorLineage(
  file: RegistryFile,
  seat: IdentityWaveSeat,
  createdAt: string,
): { changed: boolean; engine: "claude" | "codex" | null } {
  const conversationId = seat.conversationId
    ? canonicalConversationId(file, seat.conversationId)
    : null;
  const conversation = conversationId ? file.conversations[conversationId] : null;
  if (!conversationId || !conversation) return { changed: false, engine: null };

  const predecessorId = seat.predecessorConversationId
    ? canonicalConversationId(file, seat.predecessorConversationId)
    : null;
  const predecessor = predecessorId && predecessorId !== conversationId
    ? file.conversations[predecessorId]
    : null;
  const lineageWouldCycle = predecessorId && predecessor
    ? wouldCreateLineageCycle(file, conversationId, predecessorId)
    : false;
  const lineagePredecessorId = lineageWouldCycle ? null : predecessorId;
  const lineagePredecessor = lineageWouldCycle ? null : predecessor;
  const rows = file.memberships[conversationId] ??= [];
  let changed = false;

  if (!rows.some((row) => row.kind === "orchestrator"
    && row.containerId === seat.project
    && row.slot === `seat:${seat.seatEpoch}`)) {
    rows.push({
      conversationId,
      kind: "orchestrator",
      containerId: seat.project,
      role: "orchestrator",
      slot: `seat:${seat.seatEpoch}`,
      stageId: null,
      stageOrder: null,
      round: null,
      parentConversationId: lineagePredecessor ? lineagePredecessorId : null,
      runtime: null,
      createdAt,
    });
    changed = true;
  }
  if (conversation.agentRole !== "orchestrator") {
    conversation.agentRole = "orchestrator";
    changed = true;
  }
  if (conversation.delegationDepth !== 0) {
    conversation.delegationDepth = 0;
    changed = true;
  }
  if (lineagePredecessor && !file.lineageEdges[conversationId]) {
    const generation = conversation.generations.at(-1);
    const parentGeneration = lineagePredecessor.generations.at(-1);
    const edge: SpawnLineageEdge = {
      childConversationId: conversationId,
      parentConversationId: lineagePredecessorId!,
      childSessionKey: generation ? sessionKeyFromTranscript(conversation.engine, generation.path) : null,
      parentSessionKey: parentGeneration
        ? sessionKeyFromTranscript(lineagePredecessor.engine, parentGeneration.path)
        : null,
      childArtifactPath: generation?.path ?? null,
      parentArtifactPath: parentGeneration?.path ?? null,
      kind: "spawn",
      role: "orchestrator",
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: null, clientAttemptId: null, parentSource: null },
      createdAt,
    };
    file.lineageEdges[conversationId] = edge;
    changed = true;
  }
  if (changed) conversation.updatedAt = createdAt;
  return { changed, engine: conversation.engine };
}

function stampPendingOrchestratorLineage(
  file: RegistryFile,
  seat: IdentityWaveSeat,
): { changed: boolean; engine: "claude" | "codex" | null } {
  const conversationId = seat.conversationId
    ? canonicalConversationId(file, seat.conversationId)
    : null;
  if (!conversationId || file.conversations[conversationId]) return { changed: false, engine: null };
  const receipt = Object.values(file.receipts).find((candidate) => (
    canonicalConversationId(file, candidate.conversationId) === conversationId
  ));
  if (!receipt) return { changed: false, engine: null };
  const pending: IdentityWaveSeat = {
    project: seat.project,
    seatEpoch: seat.seatEpoch,
    conversationId,
    predecessorConversationId: seat.predecessorConversationId
      ? canonicalConversationId(file, seat.predecessorConversationId)
      : null,
    designatedAt: seat.designatedAt,
    activatedAt: seat.activatedAt,
    path: seat.path ?? null,
  };
  if (JSON.stringify(receipt.pendingOrchestratorSeatIdentity) === JSON.stringify(pending)) {
    return { changed: false, engine: receipt.engine };
  }
  receipt.pendingOrchestratorSeatIdentity = pending;
  return { changed: true, engine: receipt.engine };
}

function wouldCreateLineageCycle(
  file: RegistryFile,
  childConversationId: ViewerConversationId,
  parentConversationId: ViewerConversationId,
): boolean {
  const visited = new Set<ViewerConversationId>();
  let cursor: ViewerConversationId | null = parentConversationId;
  while (cursor) {
    if (cursor === childConversationId || visited.has(cursor)) return true;
    visited.add(cursor);
    const parent: ViewerConversationId | null | undefined = file.lineageEdges[cursor]?.parentConversationId;
    cursor = parent ? canonicalConversationId(file, parent) : null;
  }
  return false;
}

export function applyIdentityWaveMigration(
  source: RegistryFile,
  input: IdentityWaveMigrationInput,
): IdentityWaveMigrationResult {
  const dryRun = input.dryRun === true;
  const file = dryRun ? structuredClone(source) : source;
  if (file.identityMigrations[IDENTITY_WAVE_MIGRATION]) {
    return { dryRun, alreadyCompleted: true, retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0 };
  }

  const titlesByReceipt = receiptTitles(file);
  // Resolve every fallible evidence read before mutating the registry. A failed
  // read aborts the transaction and leaves the durable completion marker open
  // for a later startup retry.
  const evidenceByConversation = resolveConversationEvidence(file, input, titlesByReceipt);
  const ownership = resolveRekeyOwnership(file, evidenceByConversation);
  if (!dryRun && ownership.rekeys.length > 0) {
    input.commitExternalPathRekeys?.(ownership.rekeys);
  }
  const changedEngines = new Set<"claude" | "codex">();
  let retitled = 0;
  let rekeyed = 0;
  let edgesStamped = 0;

  for (const conversation of Object.values(file.conversations)) {
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    let conversationChanged = false;
    const evidence = evidenceByConversation.get(conversation.id);
    const pathRekeys = evidence?.pathRekeys ?? [];
    if (pathRekeys.length > 0) {
      for (const { legacyPath, sharedPath } of pathRekeys) {
        if (!conversation.continuityPaths.includes(legacyPath)) conversation.continuityPaths.push(legacyPath);
        conversation.continuityPaths = conversation.continuityPaths.filter((pathname) => pathname !== sharedPath);
        for (const ownedGeneration of conversation.generations) {
          if (ownedGeneration.path === legacyPath) ownedGeneration.path = sharedPath;
        }
        rekeyArtifactReferences(file, legacyPath, sharedPath);
      }
      rekeyed += 1;
      conversationChanged = true;
    }

    if (evidence?.needsTitleCleanup) {
      const replacement = evidence.conversationTitle
        ?? titlesByReceipt.get(conversation.id)
        ?? evidence?.transcriptTitle
        ?? null;
      for (const ownedGeneration of conversation.generations) {
        if (placeholderTitle(ownedGeneration.launchProfile.title)) {
          ownedGeneration.launchProfile.title = replacement;
        }
      }
      const ownedPaths = new Set(conversation.generations.map((ownedGeneration) => ownedGeneration.path));
      for (const entry of Object.values(file.entries)) {
        if (ownedPaths.has(entry.artifactPath)
          && entry.launchProfile
          && placeholderTitle(entry.launchProfile.title)) {
          entry.launchProfile.title = replacement;
        }
      }
      for (const receipt of Object.values(file.receipts)) {
        if (canonicalConversationId(file, receipt.conversationId) === conversation.id
          && placeholderTitle(receipt.launchProfile.title)) {
          receipt.launchProfile.title = replacement;
          if (replacement) receipt.identityWaveTitleBackfill = true;
        }
      }
      if (replacement) retitled += 1;
      conversationChanged = true;
    }
    if (conversationChanged) {
      conversation.updatedAt = input.now;
      changedEngines.add(conversation.engine);
    }
  }

  for (const seat of input.orchestratorSeats) {
    const stamped = stampOrchestratorLineage(file, seat, seat.activatedAt ?? seat.designatedAt ?? input.now);
    const pending = stamped.engine ? { changed: false, engine: null } : stampPendingOrchestratorLineage(file, seat);
    const changed = stamped.changed || pending.changed;
    const engine = stamped.engine ?? pending.engine;
    if (!changed || !engine) continue;
    edgesStamped += 1;
    changedEngines.add(engine);
  }

  for (const engine of changedEngines) {
    file.conversationRevision[engine] += 1;
  }
  if (!dryRun) {
    file.identityMigrations[IDENTITY_WAVE_MIGRATION] = {
      completedAt: input.now,
      retitled,
      rekeyed,
      edgesStamped,
    };
  }
  return {
    dryRun,
    alreadyCompleted: false,
    retitled,
    rekeyed,
    quarantinedRekeys: ownership.quarantined,
    edgesStamped,
  };
}
