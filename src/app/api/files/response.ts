import { createHash } from "node:crypto";

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
