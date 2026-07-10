import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { listFilesWithProjectCatalog } from "@/lib/scanner";
import { agentRegistry } from "@/lib/agent/registry";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { loadFlows } from "@/lib/flows/store";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { loadTasks } from "@/lib/tasks/store";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import type { FilesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const { files, projectCatalog } = await listFilesWithProjectCatalog(selectedProject, { persist: false });
  // A scan is a read model. Runtime reconciliation and notifications belong to
  // the external scheduler, keeping repeated GETs byte-stable for state files.
  const registry = agentRegistry();
  const registrySnapshot = registry.snapshot();
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    const conversation = Object.values(registrySnapshot.conversations).find((candidate) =>
      candidate.engine === file.engine && candidate.generations.some((generation) => generation.path === file.path));
    if (!conversation) continue;
    const generation = conversation.generations.find((item) => item.path === file.path);
    const generationIndex = conversation.generations.findIndex((item) => item.path === file.path);
    const latest = conversation.generations.at(-1);
    file.conversationId = conversation.id;
    if (generationIndex >= 0) file.generation = generationIndex + 1;
    if (generation && latest && generation.path !== latest.path) file.migratedTo = latest.path;
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
        heldDeliveries: Object.values(registrySnapshot.heldDeliveries).filter((delivery) => delivery.conversationId === conversation.id).length,
        failure: conversation.migration.error,
        revision: conversation.migration.revision,
      };
    }
  }
  const tasks = reconcileTasks(files, loadTasks(), {
    pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
    panePidAlive: pidAlive,
    conversationIdForPath: (pathname) => Object.values(registrySnapshot.conversations).find((conversation) =>
      conversation.generations.some((generation) => generation.path === pathname))?.id ?? null,
    pathForConversationId: (conversationId) => conversationId.startsWith("conversation_")
      ? registrySnapshot.conversations[conversationId as `conversation_${string}`]?.generations.at(-1)?.path ?? null
      : null,
  });
  const workflows = filterWorkflowsForFileScan(loadWorkflows(), files);
  const body = JSON.stringify({ files, projectCatalog, flows: loadFlows(), workflows, tasks: tasks.tasks } satisfies FilesResponse);
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
