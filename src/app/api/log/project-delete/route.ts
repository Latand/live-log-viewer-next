import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { catalogEntryToFileEntry, conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { ownerTranscriptMayExist, transcriptDeletionBlocker } from "@/lib/scanner/deleteSafety";
import { removeProjectTranscriptsFromDisk } from "@/lib/scanner/deleteTranscript";
import { refreshConversationCatalog } from "@/lib/scanner/discover";
import { agentProcesses } from "@/lib/scanner/process";
import { pathAllowed } from "@/lib/scanner/roots";
import { claudeSubagentOwnerPath, transcriptProcessMayBeRunning } from "@/lib/scanner/transcripts";
import { overlaySessionProjects } from "@/lib/session/titleProjection";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROJECT_PATHS = 10_000;

export function projectDeletionMembershipMatches(expected: ReadonlySet<string>, current: readonly { path: string }[]): boolean {
  return expected.size === current.length && current.every((entry) => expected.has(entry.path));
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; deleted: number } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const project = (body as { project?: unknown } | null)?.project;
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (typeof project !== "string" || !project || !Array.isArray(paths) || !paths.length || paths.length > MAX_PROJECT_PATHS
    || paths.some((target) => typeof target !== "string" || !target || target.length > 16_384)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const targets = [...new Set(paths as string[])];
  await refreshConversationCatalog();
  const catalog = conversationCatalogSnapshot().map(catalogEntryToFileEntry);
  overlaySessionProjects(catalog);
  const current = catalog.filter((entry) => entry.project === project);
  if (!projectDeletionMembershipMatches(new Set(targets), current)) {
    return NextResponse.json({ error: "project changed — refresh and try again" }, { status: 409 });
  }
  for (const target of targets) {
    let stat;
    try { stat = await fs.stat(target); } catch { stat = null; }
    if (!stat?.isFile() || !pathAllowed(target)) return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const ownerExists = new Map<string, boolean>();
  for (const target of targets) {
    const owner = claudeSubagentOwnerPath(target);
    if (owner && !ownerExists.has(owner)) ownerExists.set(owner, await ownerTranscriptMayExist(owner, fs.stat));
  }
  const entries = await listFiles({ pins: [...targets, ...ownerExists.keys()] });
  const processes = agentProcesses(true);
  const dependencies = {
    list: async () => entries,
    ownerPath: claudeSubagentOwnerPath,
    ownerExists: async (owner: string) => ownerExists.get(owner) ?? false,
    processMayBeRunning: (entry: (typeof entries)[number]) => transcriptProcessMayBeRunning(entry, processes),
  };
  for (const target of targets) {
    const blocker = await transcriptDeletionBlocker(target, dependencies);
    if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  }
  /* The catalog and process checks above can take time on a large project.
     Repeat both immediately at the reversible staging boundary so a transcript
     or agent that appeared during validation blocks the whole commit. */
  await refreshConversationCatalog();
  const commitCatalog = conversationCatalogSnapshot().map(catalogEntryToFileEntry);
  overlaySessionProjects(commitCatalog);
  const commitCurrent = commitCatalog.filter((entry) => entry.project === project);
  if (!projectDeletionMembershipMatches(new Set(targets), commitCurrent)) {
    return NextResponse.json({ error: "project changed — refresh and try again" }, { status: 409 });
  }
  const commitOwnerExists = new Map<string, boolean>();
  for (const target of targets) {
    const owner = claudeSubagentOwnerPath(target);
    if (owner && !commitOwnerExists.has(owner)) commitOwnerExists.set(owner, await ownerTranscriptMayExist(owner, fs.stat));
  }
  const commitEntries = await listFiles({ pins: [...targets, ...commitOwnerExists.keys()] });
  const commitProcesses = agentProcesses(true);
  const commitDependencies = {
    list: async () => commitEntries,
    ownerPath: claudeSubagentOwnerPath,
    ownerExists: async (owner: string) => commitOwnerExists.get(owner) ?? false,
    processMayBeRunning: (entry: (typeof commitEntries)[number]) => transcriptProcessMayBeRunning(entry, commitProcesses),
  };
  for (const target of targets) {
    const blocker = await transcriptDeletionBlocker(target, commitDependencies);
    if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  }
  try {
    await removeProjectTranscriptsFromDisk(targets);
  } catch {
    return NextResponse.json({ error: "could not delete project" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: targets.length });
}
