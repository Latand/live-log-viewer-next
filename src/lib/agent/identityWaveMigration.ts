import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { semanticTitle } from "@/lib/title";

import type { RegistryFile, SpawnLineageEdge } from "./registry";

export const IDENTITY_WAVE_MIGRATION = "identity-wave-a-d-913";

export interface IdentityWaveSeat {
  project: string;
  seatEpoch: number;
  conversationId: string | null;
  predecessorConversationId: string | null;
  designatedAt: string;
  activatedAt: string | null;
}

export interface IdentityWaveMigrationInput {
  dryRun?: boolean;
  now: string;
  transcriptTitle(pathname: string, engine: "claude" | "codex"): string | null;
  sharedPathForLegacy(pathname: string): string | null;
  orchestratorSeats: readonly IdentityWaveSeat[];
}

export interface IdentityWaveMigrationResult {
  dryRun: boolean;
  alreadyCompleted: boolean;
  retitled: number;
  rekeyed: number;
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

function safeSharedPath(input: IdentityWaveMigrationInput, pathname: string): string | null {
  try {
    const candidate = input.sharedPathForLegacy(pathname);
    return candidate && candidate !== pathname ? candidate : null;
  } catch {
    return null;
  }
}

function safeTranscriptTitle(
  input: IdentityWaveMigrationInput,
  pathname: string,
  engine: "claude" | "codex",
): string | null {
  try {
    return semanticEvidence(input.transcriptTitle(pathname, engine));
  } catch {
    return null;
  }
}

function stampOrchestratorLineage(
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
      parentConversationId: predecessor ? predecessorId : null,
      runtime: null,
      createdAt,
    });
    changed = true;
  }
  if (conversation.agentRole === null) {
    conversation.agentRole = "orchestrator";
    changed = true;
  }
  if (conversation.delegationDepth === null) {
    conversation.delegationDepth = 0;
    changed = true;
  }
  if (predecessor && !file.lineageEdges[conversationId]) {
    const generation = conversation.generations.at(-1);
    const parentGeneration = predecessor.generations.at(-1);
    const edge: SpawnLineageEdge = {
      childConversationId: conversationId,
      parentConversationId: predecessorId!,
      childSessionKey: generation ? sessionKeyFromTranscript(conversation.engine, generation.path) : null,
      parentSessionKey: parentGeneration ? sessionKeyFromTranscript(predecessor.engine, parentGeneration.path) : null,
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

export function applyIdentityWaveMigration(
  source: RegistryFile,
  input: IdentityWaveMigrationInput,
): IdentityWaveMigrationResult {
  const dryRun = input.dryRun === true;
  const file = dryRun ? structuredClone(source) : source;
  if (file.identityMigrations[IDENTITY_WAVE_MIGRATION]) {
    return { dryRun, alreadyCompleted: true, retitled: 0, rekeyed: 0, edgesStamped: 0 };
  }

  const titlesByReceipt = receiptTitles(file);
  const changedEngines = new Set<"claude" | "codex">();
  let retitled = 0;
  let rekeyed = 0;
  let edgesStamped = 0;

  for (const conversation of Object.values(file.conversations)) {
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    let conversationChanged = false;
    const sharedPath = safeSharedPath(input, generation.path);
    if (sharedPath) {
      const legacyPath = generation.path;
      if (!conversation.continuityPaths.includes(legacyPath)) conversation.continuityPaths.push(legacyPath);
      conversation.continuityPaths = conversation.continuityPaths.filter((pathname) => pathname !== sharedPath);
      generation.path = sharedPath;
      for (const entry of Object.values(file.entries)) {
        if (entry.artifactPath === legacyPath) entry.artifactPath = sharedPath;
      }
      rekeyed += 1;
      conversationChanged = true;
    }

    const currentTitle = generation.launchProfile.title;
    if (currentTitle !== null && semanticTitle(currentTitle) === null) {
      const replacement = titlesByReceipt.get(conversation.id)
        ?? safeTranscriptTitle(input, generation.path, conversation.engine);
      for (const ownedGeneration of conversation.generations) {
        if (ownedGeneration.launchProfile.title !== null
          && semanticTitle(ownedGeneration.launchProfile.title) === null) {
          ownedGeneration.launchProfile.title = replacement;
        }
      }
      const ownedPaths = new Set(conversation.generations.map((ownedGeneration) => ownedGeneration.path));
      for (const entry of Object.values(file.entries)) {
        if (ownedPaths.has(entry.artifactPath)
          && entry.launchProfile
          && entry.launchProfile.title !== null
          && semanticTitle(entry.launchProfile.title) === null) {
          entry.launchProfile.title = replacement;
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
    if (!stamped.changed || !stamped.engine) continue;
    edgesStamped += 1;
    changedEngines.add(stamped.engine);
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
  return { dryRun, alreadyCompleted: false, retitled, rekeyed, edgesStamped };
}
