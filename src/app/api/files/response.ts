import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { listFilesWithProjectCatalog, pinnedPathsFor } from "@/lib/scanner";
import { overlayBridgeAsks } from "@/lib/bridge/asks";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { bridgeAsksForSeats } from "@/lib/bridge/service";
import { pinnedIdentityEntries } from "@/lib/scanner/pinRideAlong";
import { identityAlive, livenessProbe } from "@/lib/agent/accountLiveness";
import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  supersedenceChainTail,
  type AgentRegistryEntry,
} from "@/lib/agent/registry";
import { projectLaunchConversations } from "@/lib/agent/spawnProjection";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { repositoryForProjectRoot } from "@/lib/flows/git";
import { reviewOutcomeFor } from "@/lib/flows/reviewOutcome";
import { overlayPromptDisplayTitles, projectDisplayName } from "@/lib/displayNames";
import { projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { isCanonicalProjectId, isRepositoryProjectId, projectIdentityFromRepositoryRoot, UNRESOLVED_PROJECT, UNRESOLVED_PROJECT_NAME } from "@/lib/projects/identity";
import { projectRestoredFlows } from "@/lib/flows/visibility";
import { reconcileEmbeddedReviewFlows } from "@/lib/pipelines/engine";
import type { Pipeline } from "@/lib/pipelines/types";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { projectSupersededTaskHandoffs } from "@/lib/tasks/supersedence";
import { reportRunIdFromAttemptId, TELEGRAM_REPORT_PROJECT } from "@/lib/telegram/reportLineage";
import { cachedLimitsProvenance } from "@/lib/limits";
import { projectRateLimitReadModel } from "@/lib/rateLimit";
import { readAuthorshipEvidence } from "@/lib/reaperAuthorship";
import { projectStructuredFileLiveness } from "@/lib/runtime/livenessProjection";
import { overlayLineageProjectAffinity } from "@/lib/session/projectAffinity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { overlayRoleSessionTitles } from "@/lib/session/roleTitles";
import { overlaySessionTitles, registryProjectionForSnapshot } from "@/lib/session/titleProjection";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { projectInfoFromCwd, projectRootForCwd } from "@/lib/scanner/describe";
import { projectDirectoryFallbacks } from "@/lib/scanner/projectDirectories";
import type { FilesResponse, ProjectCatalogEntry } from "@/lib/types";
import { filesResponseDependencies } from "./dependencies";

interface FilesRouteDependencies {
  listFilesWithProjectCatalog: (
    selectedProject: string | undefined,
    pinnedPath: string | undefined,
  ) => Promise<Awaited<ReturnType<typeof listFilesWithProjectCatalog>> & { pinOverlayPaths?: string[] }>;
}

function projectedProjectCatalog(
  fallback: ProjectCatalogEntry[],
  snapshot: ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>,
): ProjectCatalogEntry[] {
  const source = conversationCatalogSnapshot();
  if (!source.length) return fallback;
  /* The same per-conversation attribution the title projection computes; the
     shared per-revision projection replaces a second sweep over every
     conversation (issue #798). */
  const { projectByPath, projectMetadataByPath, archivedPaths } = registryProjectionForSnapshot(snapshot);
  const groups = new Map<string, ProjectCatalogEntry>();
  const fallbackMetadata = new Map(fallback.map((entry) => [entry.project, entry] as const));
  for (const entry of source) {
    if (archivedPaths.has(entry.path)) continue;
    const project = projectByPath.get(entry.path) ?? entry.project;
    const metadata = fallbackMetadata.get(project) ?? fallbackMetadata.get(entry.project);
    const projectedMetadata = projectMetadataByPath.get(entry.path);
    const group = groups.get(project) ?? {
      project,
      displayName: projectedMetadata?.displayName ?? metadata?.displayName ?? entry.projectName,
      smt: 0,
      conversations: 0,
    };
    group.smt = Math.max(group.smt, entry.mtime);
    group.conversations += 1;
    const projectRoot = projectedMetadata?.projectRoot ?? metadata?.projectRoot;
    if (!group.projectRoot && projectRoot) group.projectRoot = projectRoot;
    groups.set(project, group);
  }
  return [...groups.values()].sort((left, right) => right.smt - left.smt || left.project.localeCompare(right.project));
}

function resolveCatalogAlias(
  project: string,
  aliases: Readonly<Record<string, string>>,
): string {
  let current = project;
  if (!aliases[current] && !current.startsWith("-") && aliases[`-${current}`]) {
    current = `-${current}`;
  }
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return seen.has(current) ? project : current;
}

export function consolidateProjectCatalogByRepository(
  entries: readonly ProjectCatalogEntry[],
  aliases: Readonly<Record<string, string>> = {},
  displayNames: Readonly<Record<string, string>> = {},
  stabilize = true,
): {
  projectCatalog: ProjectCatalogEntry[];
  projectRemap: Map<string, string>;
} {
  const repositoryProjects = new Map<string, string>();
  const repositoryProjectsByDisplayName = new Map<string, Set<string>>();
  for (const entry of entries) {
    const identity = entry.projectRoot ? projectIdentityFromRepositoryRoot(entry.projectRoot) : null;
    const aliasedProject = resolveCatalogAlias(entry.project, aliases);
    /* Only repository-shaped identities participate in binding/display-name
       convergence — a directory group must never absorb (or be absorbed by)
       a repository project through a shared binding. */
    const displayCandidate = identity?.project
      ?? (isRepositoryProjectId(aliasedProject) ? aliasedProject : null);
    if (displayCandidate) {
      const displayName = (identity?.displayName
        ?? displayNames[displayCandidate]
        ?? entry.displayName
        ?? projectDisplayName(displayCandidate))
        .trim()
        .toLocaleLowerCase();
      const projects = repositoryProjectsByDisplayName.get(displayName) ?? new Set<string>();
      projects.add(displayCandidate);
      repositoryProjectsByDisplayName.set(displayName, projects);
    }
    if (!entry.repository) continue;
    const repository = entry.repository.toLowerCase();
    const candidate = identity?.project
      ?? (isRepositoryProjectId(aliasedProject) ? aliasedProject : null);
    if (candidate && (identity || !repositoryProjects.has(repository))) {
      repositoryProjects.set(repository, candidate);
    }
  }
  const uniqueRepositoryProjectByDisplayName = new Map(
    [...repositoryProjectsByDisplayName]
      .filter(([, projects]) => projects.size === 1)
      .map(([displayName, projects]) => [displayName, [...projects][0]!] as const),
  );
  const groups = new Map<string, Array<{ entry: ProjectCatalogEntry; aliasedProject: string }>>();
  for (const entry of entries) {
    const aliasedProject = resolveCatalogAlias(entry.project, aliases);
    const repository = entry.repository?.toLowerCase();
    const repositoryProject = repository ? repositoryProjects.get(repository) : null;
    const displayName = (displayNames[aliasedProject] ?? entry.displayName ?? projectDisplayName(aliasedProject))
      .trim()
      .toLocaleLowerCase();
    const displayNameProject = displayName === UNRESOLVED_PROJECT_NAME.toLocaleLowerCase()
      ? null
      : uniqueRepositoryProjectByDisplayName.get(displayName);
    /* A directory-derived project is a standing group of unrelated sessions
       that merely share a folder. One member carrying a repository binding
       (an MCP-bound session working on some repo) must never drag the whole
       folder group into that repository's project — the operator's entire
       home-directory history once vanished into the repo it was administering
       this way. Directory groups therefore always keep their own key; only
       repository-shaped identities converge through bindings. */
    const key = aliasedProject.startsWith("dir-")
      ? `project:${aliasedProject}`
      : repositoryProject || displayNameProject
        ? `project:${repositoryProject ?? displayNameProject}`
        : repository
          ? `repository:${repository}`
          : `project:${aliasedProject}`;
    const group = groups.get(key) ?? [];
    group.push({ entry, aliasedProject });
    groups.set(key, group);
  }
  const projectRemap = new Map<string, string>();
  const projectCatalog: ProjectCatalogEntry[] = [];
  for (const group of groups.values()) {
    /* A directory group keeps its directory identity even when a member's
       registry metadata carries a repository checkout as projectRoot (a
       session in a plain folder administering a repo records that root) —
       letting that root's identity name the group re-absorbs the folder
       into the repository project past the grouping-key guard above. */
    const directoryProject = group
      .find(({ aliasedProject }) => aliasedProject.startsWith("dir-") && isCanonicalProjectId(aliasedProject))
      ?.aliasedProject;
    const repositoryIdentity = directoryProject ? null : group
      .map(({ entry }) => entry.projectRoot ? projectIdentityFromRepositoryRoot(entry.projectRoot) : null)
      .find((identity) => identity !== null);
    const canonical = directoryProject
      ?? repositoryIdentity?.project
      ?? group.find(({ aliasedProject }) => isCanonicalProjectId(aliasedProject))?.aliasedProject
      ?? group[0]!.aliasedProject;
    for (const { entry } of group) projectRemap.set(entry.project, canonical);
    const preferred = group.find(({ aliasedProject }) => aliasedProject === canonical)?.entry ?? group[0]!.entry;
    const fallbackDisplayName = preferred.displayName === "Unresolved project" && canonical !== "project_unresolved"
      ? projectDisplayName(canonical)
      : preferred.displayName;
    projectCatalog.push({
      ...preferred,
      project: canonical,
      displayName: repositoryIdentity?.displayName ?? displayNames[canonical] ?? fallbackDisplayName,
      smt: Math.max(...group.map(({ entry }) => entry.smt)),
      conversations: group.reduce((total, { entry }) => total + entry.conversations, 0),
      projectRoot: preferred.projectRoot ?? group.find(({ entry }) => entry.projectRoot)?.entry.projectRoot,
      repository: preferred.repository ?? group.find(({ entry }) => entry.repository)?.entry.repository ?? null,
    });
  }
  projectCatalog.sort((left, right) => right.smt - left.smt || left.project.localeCompare(right.project));
  if (stabilize) {
    /* A persisted projection can recover a canonical repo key/root during the
       first pass. Legacy rows sharing that newly recovered display identity
       become provably mergeable only after that metadata exists. One bounded
       second pass reaches the fixed point without turning catalog projection
       into an unbounded alias walk. */
    const stabilized = consolidateProjectCatalogByRepository(projectCatalog, aliases, displayNames, false);
    for (const [source, target] of projectRemap) {
      projectRemap.set(source, stabilized.projectRemap.get(target) ?? target);
    }
    for (const [source, target] of stabilized.projectRemap) {
      if (!projectRemap.has(source)) projectRemap.set(source, target);
    }
    return { projectCatalog: stabilized.projectCatalog, projectRemap };
  }
  return { projectCatalog, projectRemap };
}

export async function buildFilesResponse(request: Request, dependencies: FilesRouteDependencies): Promise<NextResponse> {
  const routeDependencies = filesResponseDependencies();
  const timings: string[] = [];
  let timingMark = performance.now();
  let traceMark = timingMark;
  const traceStep = (name: string) => {
    if (process.env.LLV_FILES_RESPONSE_TRACE !== "1") return;
    const now = performance.now();
    console.error(`[files projection trace] ${name} ${(now - traceMark).toFixed(1)}ms`);
    traceMark = now;
  };
  const markTiming = (name: string) => {
    const now = performance.now();
    const duration = now - timingMark;
    timings.push(`${name};dur=${duration.toFixed(1)}`);
    if (process.env.LLV_FILES_RESPONSE_TRACE === "1") {
      console.error(`[files projection] ${name} ${duration.toFixed(1)}ms`);
    }
    timingMark = now;
  };
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const pinnedPath = url.searchParams.get("path")?.trim() || undefined;
  const { files, projectCatalog, pinOverlayPaths } = await dependencies.listFilesWithProjectCatalog(selectedProject, pinnedPath);
  markTiming("files-source");
  const responsePinOverlayPaths = new Set(pinOverlayPaths ?? []);
  const visibilityPinnedPaths = new Set([...pinnedPathsFor(pinnedPath), ...responsePinOverlayPaths]);
  // A scan is a read model. Runtime reconciliation and notifications belong to
  // the external scheduler, keeping repeated GETs byte-stable for state files.
  const registry = agentRegistry();
  const registrySnapshot = registry.readOnlySnapshot();
  traceStep("registry-snapshot");
  /* Ride-along identity for an explicit pin (#950). The scheme window is
     a board budget, so a conversation outside it — an older project, whatever
     the transcript's size — has no scanned row, and the «All conversations»
     click that asked for it BY PATH would find no card and report nothing. The
     pin sheds payload detail, never identity: these rows carry path, project,
     title, engine and activity, and the conversation id is attached with every
     other row's below. The pinned scan still runs and replaces them.

     This runs BEFORE the launch read-model below, so a pinned conversation
     that also carries a launch receipt is a materialized row by the time the
     projection asks: the launch folds into it as chips, exactly as it would
     for a scanned row, instead of projecting a second `spawn:` card beside it. */
  for (const entry of pinnedIdentityEntries(visibilityPinnedPaths, new Set(files.map((file) => file.path)))) {
    files.push(entry);
    responsePinOverlayPaths.add(entry.path);
  }
  traceStep("pin-ride-along");
  /* One launch read-model (issue #569): a launch either projects the
     conversation window itself (nothing materialized yet) or folds into the
     live conversation as transient chips — never both. */
  const launchProjection = projectLaunchConversations(files, registrySnapshot);
  traceStep("launch-projection");
  files.push(...launchProjection.cards);
  for (const file of files) {
    const launch = launchProjection.facts.get(file.path);
    if (launch) file.launch = launch;
  }
  const conversationLookup = readOnlyConversationLookupFromSnapshot(registrySnapshot);
  traceStep("conversation-lookup");
  const conversationForPath = (pathname: string) => conversationLookup.conversationForPath(pathname);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (let index = 0; index < files.length; index += 1) {
    const child = files[index]!;
    const childConversation = conversationForPath(child.path);
    const current = childConversation?.generations.at(-1);
    if (!childConversation || current?.path !== child.path) continue;
    const rawParentId = registrySnapshot.lineageEdges[childConversation.id]?.parentConversationId
      ?? current.launchProfile.parentConversationId;
    if (!rawParentId) continue;
    const parentId = conversationLookup.canonicalConversationId(rawParentId);
    const parentConversation = registrySnapshot.conversations[parentId];
    const parentGeneration = parentConversation?.generations.at(-1);
    const parentPath = parentGeneration?.path;
    if (!parentConversation || !parentGeneration || !parentPath || filesByPath.has(parentPath)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(parentPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const rootPath = parentConversation.engine === "codex"
      ? codexSessionRootFor(parentPath)
      : claudeProjectRootFor(parentPath);
    const placeholder = {
      path: parentPath,
      root: parentConversation.engine === "codex" ? "codex-sessions" as const : "claude-projects" as const,
      name: rootPath ? path.relative(rootPath, parentPath) : path.basename(parentPath),
      /* Cross-project lineage stub: the foreign parent groups under ITS owning
         project (ownership → canonical cwd → profile hint), falling back to
         the child's project only when the parent has no attribution at all. */
      project: resolveProjectAttribution({
        projectOwnership: parentConversation.projectOwnership,
        cwd: parentGeneration.launchProfile.cwd,
        launchProfileProject: parentGeneration.launchProfile.project,
        fallbackProject: child.project,
      }).project ?? child.project,
      ...(parentConversation.projectOwnership ? { projectOwnership: { ...parentConversation.projectOwnership } } : {}),
      cwd: parentGeneration.launchProfile.cwd,
      projectRoot: parentGeneration.launchProfile.cwd ? projectRootForCwd(parentGeneration.launchProfile.cwd) : null,
      title: parentGeneration.launchProfile.title ?? path.basename(parentPath, path.extname(parentPath)),
      engine: parentConversation.engine,
      kind: "session",
      fmt: parentConversation.engine,
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "idle" as const,
      activityReason: "lineage_placeholder",
      proc: null,
      pid: null,
      model: parentGeneration.launchProfile.model,
      launchModel: parentGeneration.launchProfile.model,
      effort: parentGeneration.launchProfile.effort,
      pendingQuestion: null,
      plan: parentGeneration.launchProfile.plan,
      goal: parentGeneration.launchProfile.goal,
      waitingInput: null,
    };
    files.push(placeholder);
    filesByPath.set(parentPath, placeholder);
    if (responsePinOverlayPaths.has(child.path)) responsePinOverlayPaths.add(parentPath);
  }
  traceStep("parent-closure");
  const scannedPaths = new Set(files.map((file) => file.path));
  /* Receipt-owned conversations (issue #339): a Viewer launch persists a spawn
     receipt against the conversation it created. Those carry `viewer`
     provenance even when the root has no parent edge. Computed once per
     response so the per-file projection stays O(1). */
  const receiptOwnedConversationIds = new Set<string>();
  /* The durable Telegram report-run marker (issue #1091) rides on the same
     receipts: the attempt id spells the run id, so a report run is recognisable
     from registry storage alone — no Daily Reports history file involved. */
  const telegramReportRuns = new Map<string, string>();
  for (const receipt of Object.values(registrySnapshot.receipts)) {
    const conversationId = conversationLookup.canonicalConversationId(receipt.conversationId);
    receiptOwnedConversationIds.add(conversationId);
    const reportRunId = reportRunIdFromAttemptId(receipt.clientAttemptId);
    if (reportRunId) telegramReportRuns.set(conversationId, reportRunId);
  }
  traceStep("receipt-owners");
  /* Supersedence lineage (issue #383): the reverse edge map gives each chain
     tail its immediate predecessor and its round number (chain depth + 1),
     bounded so a malformed chain can never hang the scan. */
  const supersedencePredecessors = new Map<string, string>();
  for (const candidate of Object.values(registrySnapshot.conversations)) {
    if (!candidate.supersededBy) continue;
    const successorId = conversationLookup.canonicalConversationId(candidate.supersededBy.conversationId);
    if (successorId !== candidate.id && !supersedencePredecessors.has(successorId)) {
      supersedencePredecessors.set(successorId, candidate.id);
    }
  }
  traceStep("supersedence-index");
  const supersedenceRound = (conversationId: string): number => {
    let round = 1;
    const seen = new Set<string>([conversationId]);
    let current = supersedencePredecessors.get(conversationId);
    while (current && !seen.has(current) && round < 64) {
      seen.add(current);
      round += 1;
      current = supersedencePredecessors.get(current);
    }
    return round;
  };
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    if (file.spawn) continue;
    const conversation = conversationForPath(file.path);
    if (!conversation || conversation.engine !== file.engine) continue;
    const generation = conversation.generations.find((item) => item.path === file.path);
    const generationIndex = conversation.generations.findIndex((item) => item.path === file.path);
    const latest = conversation.generations.at(-1);
    file.conversationId = conversation.id;
    if (generationIndex >= 0) file.generation = generationIndex + 1;
    if (generation && latest && generation.path !== latest.path) file.migratedTo = latest.path;
    if (!generation && latest && conversation.continuityPaths.includes(file.path)) file.migratedTo = latest.path;
    if (latest?.path === file.path && conversation.generations.length > 1) {
      const predecessor = conversation.generations.at(-2);
      file.predecessorPath = predecessor?.path;
      file.predecessorLabel = predecessor?.accountId ?? undefined;
    }
    if (latest?.path === file.path) {
      const registryEntry = generation
        ? registrySnapshot.entries[`${file.engine}:${generation.id}`]
        : undefined;
      if (registryEntry?.status === "dead" && file.pid === null) {
        file.activity = Date.now() / 1000 - file.mtime < 900 ? "recent" : "idle";
        file.activityReason = "registry_terminal";
        file.proc = "killed";
        file.authoritativeTurn = {
          state: "terminal",
          source: "lifecycle",
          terminalAt: registryEntry.updatedAt,
        };
      }
      /* Terminal supersedence demotion (issue #383): a retired round never
         projects working/waiting or a stale attention signal — it folds into
         round history while the successor carries the live card. Fail-open:
         with no materialized successor generation the card keeps today's
         dead-host rendering instead of hiding behind a dangling link. */
      if (conversation.supersededBy) {
        const successorId = conversationLookup.canonicalConversationId(conversation.supersededBy.conversationId);
        const successorGeneration = successorId !== conversation.id
          ? registrySnapshot.conversations[successorId]?.generations.at(-1)
          : undefined;
        if (successorGeneration) {
          /* Primary navigation resolves the live chain END (A→B→C opens C)
             while the immediate edge stays the round history. A tail without a
             materialized generation falls back to the immediate successor so
             the affordance never points at a dangling round. */
          const tailId = supersedenceChainTail(registrySnapshot, conversation.id);
          const tailGeneration = tailId !== successorId
            ? registrySnapshot.conversations[tailId]?.generations.at(-1)
            : successorGeneration;
          file.supersededBy = {
            conversationId: successorId,
            path: successorGeneration.path,
            at: conversation.supersededBy.at,
            reason: conversation.supersededBy.reason,
            tailConversationId: tailGeneration ? tailId : successorId,
            tailPath: tailGeneration ? tailGeneration.path : successorGeneration.path,
          };
          file.activity = "idle";
          file.activityReason = "superseded";
          file.proc = "killed";
          file.authoritativeTurn = {
            state: "terminal",
            source: "lifecycle",
            terminalAt: conversation.supersededBy.at,
          };
          file.pendingQuestion = null;
          file.waitingInput = null;
          delete file.rateLimit;
        }
      } else {
        const predecessorId = supersedencePredecessors.get(conversation.id);
        if (predecessorId) {
          file.continues = {
            conversationId: predecessorId,
            path: registrySnapshot.conversations[predecessorId]?.generations.at(-1)?.path ?? null,
            round: supersedenceRound(conversation.id),
          };
        }
      }
      const profile = latest.launchProfile;
      file.title = profile.title ?? file.title;
      const telegramReportRunId = telegramReportRuns.get(conversation.id);
      const attributed = resolveProjectAttribution({
        projectOwnership: conversation.projectOwnership,
        cwd: profile.cwd,
        launchProfileProject: profile.project,
        fallbackProject: file.project,
      });
      /* The durable report-run marker groups the run (#1091). A report run has
         no repository: it works in a neutral scratch directory, which every
         path below ownership would read as a project of its own, so the marker
         is what keeps the runs collected under the Telegram project — from
         registry evidence alone, with no Daily Reports history file involved.
         An explicit ownership record still outranks it: an operator who moved
         the card moved it. */
      file.project = attributed.source === "ownership" || !telegramReportRunId
        ? attributed.project ?? file.project
        : TELEGRAM_REPORT_PROJECT;
      if (conversation.projectOwnership) file.projectOwnership = { ...conversation.projectOwnership };
      file.launchModel = profile.model ?? file.launchModel;
      file.effort = profile.effort ?? file.effort;
      file.goal = profile.goal ?? file.goal;
      file.plan = profile.plan ?? file.plan;
      const durableEdge = registrySnapshot.lineageEdges[conversation.id];
      /* Board provenance (issue #339): engine-native edges mark `engine`;
         viewer-spawn edges and receipt-owned roots mark `viewer`. Unattributed
         external roots stay undefined. */
      if (durableEdge?.source === "engine-native") {
        file.spawnOrigin = "engine";
      } else if (durableEdge?.source === "viewer-spawn" || receiptOwnedConversationIds.has(conversation.id)) {
        file.spawnOrigin = "viewer";
      }
      if (telegramReportRunId) file.telegramReport = { runId: telegramReportRunId };
      const memberships = registrySnapshot.memberships[conversation.id] ?? [];
      if (durableEdge || memberships.length) {
        file.durableLineage = {
          kind: durableEdge?.kind ?? "spawn",
          role: conversation.agentRole ?? durableEdge?.role ?? null,
          depth: conversation.delegationDepth,
          parentConversationId: durableEdge?.parentConversationId ?? profile.parentConversationId,
          /* Alias-canonical review subject (issue #325): an edge recorded
             against a provisional id must still resolve to the reviewed
             conversation's current card after registry alias repair. */
          reviewsConversationId: durableEdge?.reviewsConversationId
            ? conversationLookup.canonicalConversationId(durableEdge.reviewsConversationId)
            : null,
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
        };
      }
      /* Terminal verdict of a one-shot reviewer, parsed from its transcript
         tail (issue #325): direct reviews have no flow engine watching them, so
         the deck projection reads the verdict from this read-model field. */
      if (file.durableLineage?.role === "reviewer" && file.durableLineage.reviewsConversationId) {
        const outcome = reviewOutcomeFor(file);
        if (outcome) file.review = outcome;
      }
      const parentConversationId = durableEdge?.parentConversationId ?? profile.parentConversationId;
      if (parentConversationId) {
        const canonicalParentId = conversationLookup.canonicalConversationId(parentConversationId);
        const parentPath = registrySnapshot.conversations[canonicalParentId]?.generations.at(-1)?.path ?? null;
        if (parentPath && scannedPaths.has(parentPath)) {
          file.parent = parentPath;
          delete file.parentRemoved;
        } else if (!parentPath || !fs.existsSync(parentPath)) {
          file.parent = null;
          file.parentRemoved = { conversationId: canonicalParentId, path: parentPath };
        }
      }
    }
    if (conversation.migration && conversation.migration.phase !== "committed") {
      const intent = registrySnapshot.migrationIntents[conversation.migration.intentId];
      const source = conversation.generations.at(-1);
      file.migration = {
        intentId: conversation.migration.intentId,
        trigger: intent?.origin === "auto" ? "quota" : "manual",
        phase: conversation.migration.phase,
        targetAccountId: conversation.migration.targetId,
        targetLabel: conversation.migration.targetId,
        sourceLabel: source?.accountId ?? undefined,
        heldDeliveries: Object.values(registrySnapshot.heldDeliveries).filter((delivery) =>
          delivery.conversationId === conversation.id && delivery.state !== "delivered").length,
        failure: conversation.migration.error,
        revision: conversation.migration.revision,
      };
    }
  }
  await projectStructuredFileLiveness(files, registry, registrySnapshot);
  traceStep("file-turn-liveness");
  traceStep("file-registry-overlay");
  markTiming("files-registry");
  /* Custom session titles (issue #33) are the last word on `title`. The shared
     projection runs after the registry has stamped `conversationId` and the
     launch profile, so an override filed under the stable conversation identity
     wins over the launch-profile title, the derived title, and everything
     downstream (cards, lists, attention, push). The pre-override title survives
     on `autoTitle`; the `renamable` flag is projected too so the client never
     imports the Node-only store. */
  const flowsStartedAt = performance.now();
  /* The scanner rows already carry canonical project roots/display names.
     Re-resolving every historical worktree cwd here costs tens of seconds on a
     cold worker and cannot improve this request-level metadata. */
  overlaySessionTitles(files, registrySnapshot, false);
  markTiming("files-session-titles");
  /* Durable project affinity: a Viewer-launched family whose root transcript
     recorded a bare directory above the repository its lineage works in (an
     orchestrator opened from a project board with cwd=$HOME) regroups under
     that repository's project. Pure over scan + registry lineage, so the
     grouping survives every refresh without rewriting transcripts; sessions
     with no such lineage are untouched. */
  overlayLineageProjectAffinity(files);
  markTiming("files-project-affinity");
  const storedFlows = routeDependencies.loadFlows();
  markTiming("files-flow-store");
  const flows = projectRestoredFlows(storedFlows, files, {
    pinnedPaths: visibilityPinnedPaths,
    memberships: registrySnapshot.memberships,
  });
  markTiming("files-flow-restore");
  const storedTasks = routeDependencies.loadTasks();
  markTiming("files-task-store");
  /* Human-authorship pin for the board's worker-class auto-collapse (issue
     #112): the reaper's sticky evidence (PR #125) marks any transcript that
     carries a real user message. Both authorship and fail-closed freshness span
     the WHOLE stable conversation — every native generation and continuity path,
     not just the current transcript and one predecessor. After a migration
     A → B → C a user message recorded on A must still pin C, and an unscanned
     predecessor must hold C unverified, or the owner's message would be lost the
     moment the historical entries leave the rendered board.
     `authorshipUnverified` fails the exemption CLOSED — a claude/codex worker the
     reaper has not scanned since its latest write (fresh owner message, cold
     start, or an unstamped generation) is pinned until a cycle confirms it, so a
     just-finished reviewer never collapses on stale evidence. The freshness is
     PATH-SCOPED (`scannedAt[path]`), not a single global cycle timestamp: a
     global stamp advances every cycle regardless of which paths were scanned, so
     a worker that exited before the reaper ever reached it would be falsely
     certified clean. A generation with no stamp stays unverified; an archived
     (out-of-scan) generation is immutable, so any stamp certifies it. */
  const conversationByPath = new Map<string, (typeof registrySnapshot.conversations)[keyof typeof registrySnapshot.conversations]>();
  for (const conversation of Object.values(registrySnapshot.conversations)) {
    for (const generation of conversation.generations) conversationByPath.set(generation.path, conversation);
    for (const continuityPath of conversation.continuityPaths) conversationByPath.set(continuityPath, conversation);
  }
  const { userAuthoredPaths, scannedAt } = readAuthorshipEvidence();
  /* Live on-disk mtime probe, memoized per request. A clean stamp must be
     checked against the LIVE filesystem, not the scan snapshot's mtime: the
     files scan is a cache that a GET may reuse (scanCache) while a user appends a
     message, so a stamp taken before the append would look fresh against the
     stale cached mtime and falsely certify a now-owner-authored transcript. A
     `mtime` probe sees the append and re-pins it unverified. A CONFIRMED absence
     (ENOENT) means the transcript is gone — immutable and off the board — so the
     snapshot mtime stands. Any OTHER stat error (EACCES, EIO, transient
     exhaustion) leaves freshness UNKNOWN, and the hard exemption fails closed:
     unknown → unverified. Bounded — only paths that carry a stamp reach here. */
  type MtimeProbe = { kind: "mtime"; value: number } | { kind: "gone" } | { kind: "uncertain" };
  const mtimeProbes = new Map<string, MtimeProbe>();
  const probeMtime = (pathname: string): MtimeProbe => {
    const cached = mtimeProbes.get(pathname);
    if (cached) return cached;
    let probe: MtimeProbe;
    try {
      probe = { kind: "mtime", value: fs.statSync(pathname).mtimeMs / 1000 };
    } catch (error) {
      probe = (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "uncertain" };
    }
    mtimeProbes.set(pathname, probe);
    return probe;
  };
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    const conversation = conversationByPath.get(file.path);
    const lineage = new Set<string>([file.path]);
    if (file.predecessorPath) lineage.add(file.predecessorPath);
    if (conversation) {
      for (const generation of conversation.generations) lineage.add(generation.path);
      for (const continuityPath of conversation.continuityPaths) lineage.add(continuityPath);
    }
    if ([...lineage].some((pathname) => userAuthoredPaths.has(pathname))) {
      file.userAuthored = true;
      continue;
    }
    const unverified = [...lineage].some((pathname) => {
      const stamp = scannedAt.get(pathname);
      if (stamp === undefined) return true;
      const probe = probeMtime(pathname);
      if (probe.kind === "uncertain") return true; // fail closed on an unreadable transcript
      if (probe.kind === "mtime") return stamp < probe.value;
      /* Confirmed gone: immutable, so the last-known snapshot mtime certifies it. */
      const cachedMtime = filesByPath.get(pathname)?.mtime;
      return cachedMtime !== undefined && stamp < cachedMtime;
    });
    if (unverified) file.authorshipUnverified = true;
  }
  markTiming("files-authorship");
  const tasks = reconcileTasks(files, storedTasks, {
    pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
    panePidAlive: pidAlive,
    conversationIdForPath: (pathname) => conversationLookup.conversationForPath(pathname)?.id ?? null,
    canonicalConversationId: (conversationId) => conversationId.startsWith("conversation_")
      ? conversationLookup.canonicalConversationId(conversationId as `conversation_${string}`)
      : null,
    pathForConversationId: (conversationId) => conversationId.startsWith("conversation_")
      ? conversationLookup.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? null
      : null,
  });
  /* Task-deck absorption for supersedence chains (issue #383): tasks assigned
     to a retired round also project a handoff assignment for the live chain
     end, so the successor joins the same deck. Read-model overlay only — the
     durable task store is never mutated by a scan. */
  tasks.tasks = projectSupersededTaskHandoffs(
    tasks.tasks,
    registrySnapshot.conversations,
    (conversationId) => conversationId.startsWith("conversation_")
      ? conversationLookup.canonicalConversationId(conversationId as `conversation_${string}`)
      : conversationId,
  );
  let workflows = routeDependencies.filterWorkflowsForFileScan(routeDependencies.loadWorkflows(), files);
  /* The pipelines store fails closed on malformed or future-schema state
     (both viewer instances share one config dir, so skew is a normal
     condition) — that must degrade to "pipelines unavailable", never take
     the whole files poll down with it. */
  let pipelines: Pipeline[] = [];
  let pipelinesError: string | undefined;
  try {
    /* A GET never takes the pipeline lock and never persists (issue #798).
       The embedded review flow sync is applied to this request's read copy as
       an overlay against the same flow read above, so the deck and its parent
       share one request-level generation; the durable claim/sync persists on
       the controller reconcile pass instead of the request path. */
    const loaded = routeDependencies.loadPipelinesForProjection();
    reconcileEmbeddedReviewFlows(loaded, storedFlows);
    pipelines = routeDependencies.filterPipelinesForFileScan(loaded, files, {
      pinnedPaths: visibilityPinnedPaths,
      memberships: registrySnapshot.memberships,
    });
  } catch (error) {
    pipelinesError = error instanceof Error ? error.message : "pipeline registry unreadable";
    console.error("[files] pipelines store unreadable; serving without pipelines", error);
  }
  /* Role titles (issue #325) and the returned flow read model consume the same
     request-level flow read as the pipeline sync overlay above. A controller
     advance during the earlier scan can therefore never mix deck/annotation
     generation N with parent generation N+1. Explicit user titles keep final
     precedence. */
  overlayRoleSessionTitles({ files, flows, tasks: storedTasks, conversationAliases: registrySnapshot.conversationAliases });
  overlayPromptDisplayTitles(files);
  markTiming("files-role-titles");
  timings.push(`files-flows;dur=${(performance.now() - flowsStartedAt).toFixed(1)}`);
  markTiming("files-stores");
  const projectsStartedAt = performance.now();
  const hostProbe = livenessProbe();
  const projected = projectRateLimitReadModel(
    files,
    flows,
    registrySnapshot,
    Date.now(),
    cachedLimitsProvenance,
    (entry) => {
      const fullEntry = entry as AgentRegistryEntry;
      return identityAlive(fullEntry.host?.agent, hostProbe)
        || identityAlive(fullEntry.host?.panePid, hostProbe)
        || identityAlive(fullEntry.structuredHost?.process, hostProbe);
    },
  );
  markTiming("files-project-rate-limits");
  let effectiveProjectCatalog = projectedProjectCatalog(projectCatalog, registrySnapshot);
  const projectAliases = projectAliasSnapshot();
  /* Operator-created projects (rail "create project"): catalog rows with zero
     conversations until real sessions land in their root, at which point the
     scanned entry carries the same minted identity and wins this guard. */
  const curation = projectCurationSnapshot();
  {
    const known = new Set(effectiveProjectCatalog.map((entry) => resolveCatalogAlias(entry.project, projectAliases.aliases)));
    for (const manual of curation.manualProjects) {
      const project = resolveCatalogAlias(manual.project, projectAliases.aliases);
      if (known.has(project)) continue;
      known.add(project);
      effectiveProjectCatalog.push({
        project,
        displayName: manual.displayName,
        projectRoot: manual.root,
        smt: manual.createdAt,
        conversations: 0,
      });
    }
  }
  /* GitHub repository identity for readiness issue links (issue #290): cached
     per project root from local .git/config, nullable on any failure. */
  for (const entry of effectiveProjectCatalog) {
    entry.repository = entry.projectRoot ? repositoryForProjectRoot(entry.projectRoot) : null;
  }
  const consolidated = consolidateProjectCatalogByRepository(
    effectiveProjectCatalog,
    projectAliases.aliases,
    projectAliases.displayNames,
  );
  effectiveProjectCatalog = consolidated.projectCatalog;
  const remapProject = (project: string): string => consolidated.projectRemap.get(project) ?? project;
  projected.files = projected.files.map((file) => ({ ...file, project: remapProject(file.project) }));
  projected.flows = projected.flows.map((flow) => ({ ...flow, project: remapProject(flow.project) }));
  pipelines = pipelines.map((pipeline) => ({ ...pipeline, project: remapProject(pipeline.project) }));
  workflows = workflows.map((workflow) => ({ ...workflow, project: remapProject(workflow.project) }));
  tasks.tasks = tasks.tasks.map((task) => ({ ...task, project: remapProject(task.project) }));
  const projectNames = new Map(effectiveProjectCatalog.map((entry) => [entry.project, entry.displayName] as const));
  for (const file of projected.files) {
    file.projectName = projectNames.get(file.project) ?? file.projectName;
    if (file.project === "project_unresolved") file.projectUnresolved = true;
  }
  markTiming("files-project-catalog");
  /* The orchestrator seat's open decision request (issue #1168). The bridge
     report log had exactly one reader — the voice gateway — so a `blocked` or
     `question` report reached the operator only if that channel happened to be
     up. Stamped here, on the seat's own row, it becomes an ordinary hard block
     in the attention queue. `bridgeAsksForSeats` fails closed on its own, so an
     unreadable log costs the ask and never this poll. */
  overlayBridgeAsks(
    projected.files,
    bridgeAsksForSeats({
      canonicalConversationId: seatIdentityResolver(conversationLookup.canonicalConversationId),
    }),
  );
  markTiming("files-bridge-asks");
  const visibleProjects = [
    ...projected.files.map((file) => file.project),
    ...effectiveProjectCatalog.map((entry) => entry.project),
    ...projected.flows.map((flow) => flow.project),
    ...pipelines.map((pipeline) => pipeline.project),
    ...workflows.map((workflow) => workflow.project),
    ...tasks.tasks.map((task) => task.project),
  ];
  /* Explicit project attribution can leave a foreign repository root on a
     catalog row. Keep roots the scanner resolves back into that project. */
  const projectCwds = Object.fromEntries(
    effectiveProjectCatalog
      .filter((entry): entry is ProjectCatalogEntry & { projectRoot: string } =>
        typeof entry.projectRoot === "string" && projectInfoFromCwd(entry.projectRoot)?.project === entry.project)
      .map((entry) => [entry.project, entry.projectRoot]),
  );
  const missingProjectCwds = [...new Set(visibleProjects)].filter((project) => !projectCwds[project]);
  if (missingProjectCwds.length) {
    Object.assign(projectCwds, projectDirectoryFallbacks(missingProjectCwds));
  }
  markTiming("files-project-cwds");
  const projectsFinishedAt = performance.now();
  timings.push(`files-projects;dur=${(projectsFinishedAt - projectsStartedAt).toFixed(1)}`);
  timingMark = projectsFinishedAt;
  const registryDiagnostics = registry.storageDiagnostics();
  const registryHealth = {
    backendMode: registryDiagnostics.backendMode,
    revision: registryDiagnostics.revision,
    mirrorRevision: registryDiagnostics.mirrorRevision,
    transactionCount: registryDiagnostics.transactionCount,
    writerWaitP95Ms: registryDiagnostics.writerWaitP95Ms,
    transactionP95Ms: registryDiagnostics.transactionP95Ms,
    mirrorCheckpointAtMs: registryDiagnostics.mirrorCheckpointAtMs,
    mirrorDirty: registryDiagnostics.mirrorDirty,
  };
  const effectiveProjectAliases = { ...projectAliases.aliases };
  for (const [source, target] of consolidated.projectRemap) {
    delete effectiveProjectAliases[target];
    if (source !== target) effectiveProjectAliases[source] = target;
  }
  const projectDisplayNames = { ...projectAliases.displayNames };
  for (const entry of effectiveProjectCatalog) {
    if (entry.displayName?.trim()) projectDisplayNames[entry.project] = entry.displayName;
  }
  for (const file of projected.files) {
    const projectName = file.projectName?.trim();
    if (projectName && (projectName !== UNRESOLVED_PROJECT_NAME || file.project === UNRESOLVED_PROJECT)) {
      projectDisplayNames[file.project] = projectName;
    }
  }
  for (const [project, cwd] of Object.entries(projectCwds)) {
    const info = projectInfoFromCwd(cwd);
    if (info?.project === project) projectDisplayNames[project] = info.displayName;
  }
  /* The operator's chosen name outlives every derived label, including the
     repository-derived one once sessions exist in the created project. */
  for (const manual of curation.manualProjects) {
    projectDisplayNames[remapProject(resolveCatalogAlias(manual.project, projectAliases.aliases))] = manual.displayName;
  }
  const crownedProjects = [...new Set(
    curation.crowned.map((project) => remapProject(resolveCatalogAlias(project, projectAliases.aliases))),
  )];
  const body = JSON.stringify({
    files: projected.files,
    ...(responsePinOverlayPaths.size ? { pinOverlayPaths: [...responsePinOverlayPaths] } : {}),
    projectCatalog: effectiveProjectCatalog,
    projectAliases: effectiveProjectAliases,
    projectDisplayNames,
    ...(crownedProjects.length ? { crownedProjects } : {}),
    ...(Object.keys(projectCwds).length ? { projectCwds } : {}),
    flows: projected.flows,
    pipelines,
    workflows,
    tasks: tasks.tasks,
    systemHealth: { tmux: routeDependencies.tmuxEndpointHealth(), registry: registryHealth },
    conversationAliases: registrySnapshot.conversationAliases,
    ...(Object.keys(launchProjection.routes).length ? { launchRoutes: launchProjection.routes } : {}),
    ...(pipelinesError ? { pipelinesError } : {}),
  } satisfies FilesResponse);
  /* The client re-polls every 10 s and this ~410 KB payload is usually
     identical between polls; a strong ETag over the exact bytes lets an
     unchanged response come back as a bodyless 304. force-dynamic still holds
     — the body is recomputed every request, only its transfer is skipped. */
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  markTiming("files-json");
  const responseHeaders = { ETag: etag, "server-timing": timings.join(", ") };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: responseHeaders });
  }
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json", ...responseHeaders },
  });
}
