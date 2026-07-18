import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { listFilesWithProjectCatalog, pinnedPathsFor } from "@/lib/scanner";
import { agentRegistry, conversationLookupFromSnapshot } from "@/lib/agent/registry";
import { preallocatedStructuredSpawnCards } from "@/lib/agent/spawnProjection";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { loadFlows } from "@/lib/flows/store";
import { reviewOutcomeFor } from "@/lib/flows/reviewOutcome";
import { projectRestoredFlows } from "@/lib/flows/visibility";
import { loadPipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { filterPipelinesForFileScan } from "@/lib/pipelines/visibility";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { loadTasks } from "@/lib/tasks/store";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import { projectRateLimitReadModel } from "@/lib/rateLimit";
import { readAuthorshipEvidence } from "@/lib/reaperAuthorship";
import { overlayLineageProjectAffinity } from "@/lib/session/projectAffinity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { overlayRoleSessionTitles } from "@/lib/session/roleTitles";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { tmuxEndpointHealth } from "@/lib/tmux";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { projectRootForCwd } from "@/lib/scanner/describe";
import { projectDirectoryFallbacks } from "@/lib/scanner/projectDirectories";
import type { FilesResponse, ProjectCatalogEntry } from "@/lib/types";

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
  const projectByPath = new Map<string, string>();
  const archivedPaths = new Set<string>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const latest = conversation.generations.at(-1);
    if (!latest) continue;
    const { project } = resolveProjectAttribution({
      projectOwnership: conversation.projectOwnership,
      cwd: latest.launchProfile.cwd,
      launchProfileProject: latest.launchProfile.project,
    });
    if (project) projectByPath.set(latest.path, project);
    for (const generation of conversation.generations) {
      if (generation.path !== latest.path) archivedPaths.add(generation.path);
    }
    for (const pathname of conversation.continuityPaths) {
      if (pathname !== latest.path) archivedPaths.add(pathname);
    }
  }
  const groups = new Map<string, ProjectCatalogEntry>();
  const fallbackRoots = new Map(fallback.map((entry) => [entry.project, entry.projectRoot] as const));
  for (const entry of source) {
    if (archivedPaths.has(entry.path)) continue;
    const project = projectByPath.get(entry.path) ?? entry.project;
    const group = groups.get(project) ?? { project, smt: 0, conversations: 0 };
    group.smt = Math.max(group.smt, entry.mtime);
    group.conversations += 1;
    const projectRoot = fallbackRoots.get(entry.project);
    if (!group.projectRoot && projectRoot) group.projectRoot = projectRoot;
    groups.set(project, group);
  }
  return [...groups.values()].sort((left, right) => right.smt - left.smt || left.project.localeCompare(right.project));
}

export async function buildFilesResponse(request: Request, dependencies: FilesRouteDependencies): Promise<NextResponse> {
  const timings: string[] = [];
  let timingMark = performance.now();
  const markTiming = (name: string) => {
    const now = performance.now();
    timings.push(`${name};dur=${(now - timingMark).toFixed(1)}`);
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
  files.push(...preallocatedStructuredSpawnCards(files, registrySnapshot));
  const conversationLookup = conversationLookupFromSnapshot(registrySnapshot);
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
  const scannedPaths = new Set(files.map((file) => file.path));
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
      const profile = latest.launchProfile;
      file.title = profile.title ?? file.title;
      file.project = resolveProjectAttribution({
        projectOwnership: conversation.projectOwnership,
        cwd: profile.cwd,
        launchProfileProject: profile.project,
        fallbackProject: file.project,
      }).project ?? file.project;
      if (conversation.projectOwnership) file.projectOwnership = { ...conversation.projectOwnership };
      file.launchModel = profile.model ?? file.launchModel;
      file.effort = profile.effort ?? file.effort;
      file.goal = profile.goal ?? file.goal;
      file.plan = profile.plan ?? file.plan;
      const durableEdge = registrySnapshot.lineageEdges[conversation.id];
      const memberships = registrySnapshot.memberships[conversation.id] ?? [];
      if (durableEdge || memberships.length) {
        file.durableLineage = {
          kind: durableEdge?.kind ?? "spawn",
          role: durableEdge?.role ?? null,
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
  markTiming("files-registry");
  /* Custom session titles (issue #33) are the last word on `title`. The shared
     projection runs after the registry has stamped `conversationId` and the
     launch profile, so an override filed under the stable conversation identity
     wins over the launch-profile title, the derived title, and everything
     downstream (cards, lists, attention, push). The pre-override title survives
     on `autoTitle`; the `renamable` flag is projected too so the client never
     imports the Node-only store. */
  const flowsStartedAt = performance.now();
  overlaySessionTitles(files);
  markTiming("files-session-titles");
  /* Durable project affinity: a Viewer-launched family whose root transcript
     recorded a bare directory above the repository its lineage works in (an
     orchestrator opened from a project board with cwd=$HOME) regroups under
     that repository's project. Pure over scan + registry lineage, so the
     grouping survives every refresh without rewriting transcripts; sessions
     with no such lineage are untouched. */
  overlayLineageProjectAffinity(files);
  markTiming("files-project-affinity");
  const storedFlows = loadFlows();
  markTiming("files-flow-store");
  const flows = projectRestoredFlows(storedFlows, files, {
    pinnedPaths: visibilityPinnedPaths,
    memberships: registrySnapshot.memberships,
  });
  markTiming("files-flow-restore");
  const storedTasks = loadTasks();
  markTiming("files-task-store");
  /* Role titles (issue #325): a Viewer-spawned worker whose scan/launch title
     is machine boilerplate («Codex session», the spawn prompt head) presents
     its durable identity instead — task subject + role for builders, reviewed
     subject + round for reviewers. Runs after overlaySessionTitles so an
     explicit user rename keeps final precedence (the role title becomes its
     Reset base), and never rewrites native transcripts. */
  overlayRoleSessionTitles({ files, flows, tasks: storedTasks, conversationAliases: registrySnapshot.conversationAliases });
  markTiming("files-role-titles");
  timings.push(`files-flows;dur=${(performance.now() - flowsStartedAt).toFixed(1)}`);
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
  const workflows = filterWorkflowsForFileScan(loadWorkflows(), files);
  /* The pipelines store fails closed on malformed or future-schema state
     (both viewer instances share one config dir, so skew is a normal
     condition) — that must degrade to "pipelines unavailable", never take
     the whole files poll down with it. */
  let pipelines: Pipeline[] = [];
  let pipelinesError: string | undefined;
  try {
    pipelines = filterPipelinesForFileScan(loadPipelines(), files, {
      pinnedPaths: visibilityPinnedPaths,
      memberships: registrySnapshot.memberships,
    });
  } catch (error) {
    pipelinesError = error instanceof Error ? error.message : "pipeline registry unreadable";
    console.error("[files] pipelines store unreadable; serving without pipelines", error);
  }
  markTiming("files-stores");
  const projectsStartedAt = performance.now();
  const projected = projectRateLimitReadModel(files, flows, registrySnapshot);
  markTiming("files-project-rate-limits");
  const effectiveProjectCatalog = projectedProjectCatalog(projectCatalog, registrySnapshot);
  markTiming("files-project-catalog");
  const projectCwds = projectDirectoryFallbacks([
    ...projected.files.map((file) => file.project),
    ...effectiveProjectCatalog.map((entry) => entry.project),
    ...projected.flows.map((flow) => flow.project),
    ...pipelines.map((pipeline) => pipeline.project),
    ...workflows.map((workflow) => workflow.project),
    ...tasks.tasks.map((task) => task.project),
  ]);
  markTiming("files-project-cwds");
  const projectsFinishedAt = performance.now();
  timings.push(`files-projects;dur=${(projectsFinishedAt - projectsStartedAt).toFixed(1)}`);
  timingMark = projectsFinishedAt;
  const body = JSON.stringify({
    files: projected.files,
    ...(responsePinOverlayPaths.size ? { pinOverlayPaths: [...responsePinOverlayPaths] } : {}),
    projectCatalog: effectiveProjectCatalog,
    ...(Object.keys(projectCwds).length ? { projectCwds } : {}),
    flows: projected.flows,
    pipelines,
    workflows,
    tasks: tasks.tasks,
    systemHealth: { tmux: tmuxEndpointHealth() },
    conversationAliases: registrySnapshot.conversationAliases,
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
