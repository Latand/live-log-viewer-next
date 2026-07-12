import { createHash } from "node:crypto";
import fs from "node:fs";

import { NextResponse } from "next/server";

import { listFilesWithProjectCatalog } from "@/lib/scanner";
import { agentRegistry } from "@/lib/agent/registry";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { loadFlows } from "@/lib/flows/store";
import { loadPipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { filterPipelinesForFileScan } from "@/lib/pipelines/visibility";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { loadTasks } from "@/lib/tasks/store";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import { projectRateLimitReadModel } from "@/lib/rateLimit";
import { readAuthorshipEvidence } from "@/lib/reaperAuthorship";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { tmuxEndpointHealth } from "@/lib/tmux";
import type { FilesResponse } from "@/lib/types";

interface FilesRouteDependencies {
  listFilesWithProjectCatalog: (
    selectedProject: string | undefined,
    pinnedPath: string | undefined,
  ) => ReturnType<typeof listFilesWithProjectCatalog>;
}

export async function buildFilesResponse(request: Request, dependencies: FilesRouteDependencies): Promise<NextResponse> {
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const pinnedPath = url.searchParams.get("path")?.trim() || undefined;
  const { files, projectCatalog } = await dependencies.listFilesWithProjectCatalog(selectedProject, pinnedPath);
  // A scan is a read model. Runtime reconciliation and notifications belong to
  // the external scheduler, keeping repeated GETs byte-stable for state files.
  const registry = agentRegistry();
  const registrySnapshot = registry.snapshot();
  const ownsPath = (conversation: (typeof registrySnapshot.conversations)[keyof typeof registrySnapshot.conversations], pathname: string) =>
    conversation.generations.some((generation) => generation.path === pathname)
    || conversation.continuityPaths.includes(pathname);
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    const conversation = Object.values(registrySnapshot.conversations).find((candidate) =>
      candidate.engine === file.engine && ownsPath(candidate, file.path));
    if (!conversation) continue;
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
      const profile = latest.launchProfile;
      file.title = profile.title ?? file.title;
      file.project = profile.project ?? file.project;
      file.launchModel = profile.model ?? file.launchModel;
      file.effort = profile.effort ?? file.effort;
      file.goal = profile.goal ?? file.goal;
      file.plan = profile.plan ?? file.plan;
      const parentConversationId = registrySnapshot.lineageEdges[conversation.id]?.parentConversationId ?? profile.parentConversationId;
      if (parentConversationId) {
        file.parent = registrySnapshot.conversations[parentConversationId]?.generations.at(-1)?.path ?? file.parent;
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
  /* Custom session titles (issue #33) are the last word on `title`. The shared
     projection runs after the registry has stamped `conversationId` and the
     launch profile, so an override filed under the stable conversation identity
     wins over the launch-profile title, the derived title, and everything
     downstream (cards, lists, attention, push). The pre-override title survives
     on `autoTitle`; the `renamable` flag is projected too so the client never
     imports the Node-only store. */
  overlaySessionTitles(files);
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
  const filesByPath = new Map(files.map((file) => [file.path, file] as const));
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
  const tasks = reconcileTasks(files, loadTasks(), {
    pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
    panePidAlive: pidAlive,
    conversationIdForPath: (pathname) => Object.values(registrySnapshot.conversations).find((conversation) =>
      ownsPath(conversation, pathname))?.id ?? null,
    canonicalConversationId: (conversationId) => conversationId.startsWith("conversation_")
      ? registry.canonicalConversationId(conversationId as `conversation_${string}`)
      : null,
    pathForConversationId: (conversationId) => conversationId.startsWith("conversation_")
      ? registry.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? null
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
    pipelines = filterPipelinesForFileScan(loadPipelines(), files);
  } catch (error) {
    pipelinesError = error instanceof Error ? error.message : "pipeline registry unreadable";
    console.error("[files] pipelines store unreadable; serving without pipelines", error);
  }
  const projected = projectRateLimitReadModel(files, loadFlows(), registrySnapshot);
  const body = JSON.stringify({
    files: projected.files,
    projectCatalog,
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
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json", ETag: etag },
  });
}
