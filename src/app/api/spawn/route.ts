import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { UnknownAccountError } from "@/lib/accounts/codex";
import { UnknownClaudeAccountError } from "@/lib/accounts/claude";
import { accountManager } from "@/lib/accounts/manager";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { agentRegistry } from "@/lib/agent/registry";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { modelFromBody } from "@/lib/agent/models";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { persistHandoffLineage, rememberHandoffChild, rememberHandoffPane } from "@/lib/handoffLineage";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { runtimeHostClient } from "@/lib/runtime/client";
import { newOperationId, runtimeScope, viewerConversationId } from "@/lib/runtime/contracts";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { buildImagePayload, collectImagePayloads, deleteInboxImages, spawnAgentWithPrompt } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;
const PROJECT_DIR_ROOTS = ["Projects", path.join(".agents", "tools")];

interface SuggestResponse {
  dirs: string[];
  /** Working directory of the `src` transcript when one was requested. */
  cwd: string | null;
}

interface SpawnResponse {
  ok: true;
  target: string;
  /** Transcript path the fresh session will write, when knowable (claude);
      the draft pane waits for exactly this file to appear in the scanner. */
  path: string | null;
}

/** Security gate for `?src=`: the resolved real path must be a regular .jsonl
    transcript inside one of the two conversation roots — the server-side
    mirror of the client's canHandoff gate. */
function transcriptAllowed(candidate: string): boolean {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(candidate);
    stat = fs.statSync(real);
  } catch {
    return false;
  }
  if (!stat.isFile() || !real.endsWith(".jsonl")) return false;
  if (codexSessionRootFor(real)) return true;
  return Boolean(claudeProjectRootFor(real));
}

function addDir(dirs: string[], cwd: string | null, project: string): void {
  if (!cwd || dirs.includes(cwd)) return;
  if (project && projectForCwd(cwd) !== project) return;
  dirs.push(cwd);
}

function projectDirCandidates(project: string): string[] {
  if (!project) return [];
  const candidates: string[] = [];
  for (const rel of PROJECT_DIR_ROOTS) {
    const root = path.join(os.homedir(), rel);
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const cwd = path.join(root, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(cwd);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      addDir(candidates, cwd, project);
      if (candidates.length >= SUGGEST_MAX) return candidates;
    }
  }
  return candidates;
}

/** Recent real working directories to prefill the spawn dialog; the current
    project's transcripts rank first so its directory lands on top. `src` names
    a transcript whose own cwd must win — the handoff card inherits it. */
export async function GET(req: NextRequest): Promise<NextResponse<SuggestResponse>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  const src = req.nextUrl.searchParams.get("src");
  const srcCwd = src && transcriptAllowed(src) ? headCwd(src, { requireDir: true }) : null;
  const conversations = (await listFiles())
    .filter((entry) => entry.path.endsWith(".jsonl") && (entry.root === "claude-projects" || entry.root === "codex-sessions"))
    .filter((entry) => !entry.path.includes(path.sep + "subagents" + path.sep))
    .sort((a, b) => Number(b.project === project) - Number(a.project === project) || b.mtime - a.mtime)
    .slice(0, SUGGEST_SCAN_LIMIT);

  const dirs: string[] = srcCwd ? [srcCwd] : [];
  if (!srcCwd) {
    for (const cwd of projectDirCandidates(project)) addDir(dirs, cwd, project);
  }
  for (const entry of conversations) {
    if (dirs.length >= SUGGEST_MAX) break;
    if (project && entry.project !== project) continue;
    const cwd = headCwd(entry.path, { requireDir: true });
    addDir(dirs, cwd, project);
  }
  if (!dirs.length) dirs.push(os.homedir());
  return NextResponse.json({ dirs, cwd: srcCwd });
}

function parentFromBody(body: { src?: unknown; parent?: unknown }): string {
  if (typeof body.parent === "string") return body.parent;
  return typeof body.src === "string" ? body.src : "";
}

function conversationForTranscript(transcript: string): string {
  return viewerConversationId(codexSessionRootFor(transcript) ? "codex" : "claude", transcript);
}

export async function POST(req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown; src?: unknown; parent?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });
  if (body.accountId !== undefined && typeof body.accountId !== "string") return NextResponse.json({ error: "accountId must be a string" }, { status: 400 });

  const reasoning = reasoningFromBody(engine, body);
  if (reasoning.error) return NextResponse.json({ error: reasoning.error }, { status: 400 });
  const selectedModel = modelFromBody(body);
  if (selectedModel.error) return NextResponse.json({ error: selectedModel.error }, { status: 400 });

  const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!rawCwd) return NextResponse.json({ error: "working directory is required" }, { status: 400 });
  const cwd = path.resolve(rawCwd === "~" || rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(1)) : rawCwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: `directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `not a directory: ${cwd}` }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }

  /* Saved paths stay visible to the catch: a failed spawn deletes them so a
     retry cannot pile duplicates into the inbox. */
  let imagePaths: string[] = [];
  try {
    /* Pasted images land in the inbox and reach the fresh agent as file paths
       appended to its first prompt — the same contract the pane composer uses. */
    const bundle = buildImagePayload(prompt, images);
    imagePaths = bundle.imagePaths;
    const account = accountManager.resolveSpawn(engine, body.accountId);
    let runtimeClient = runtimeEventsEnabled() ? runtimeHostClient() : null;
    const operationId = runtimeClient ? newOperationId() : null;
    const src = parentFromBody(body);
    if (runtimeClient && operationId) {
      try {
        await runtimeClient.operation({
          scope: runtimeScope("operation", operationId),
          kind: "spawn.intent",
          operationId,
          producerKey: `viewer-spawn:${operationId}`,
          payload: { engine, cwd, accountId: account.accountId, parentConversationId: src && transcriptAllowed(src) ? conversationForTranscript(src) : null },
        });
      } catch {
        console.warn("[runtime] spawn bookkeeping unavailable; continuing through the legacy spawn path");
        runtimeClient = null;
      }
    }
    const spec = freshSpecFor(engine, cwd, {
      model: selectedModel.model,
      effort: reasoning.effort,
      fast: reasoning.fast,
      codexHome: engine === "codex" ? account.home : null,
      claudeConfigDir: engine === "claude" ? account.home : null,
      claudeProjectsDir: engine === "claude" ? account.transcriptRoot : null,
    });
    const startedAtMs = Date.now();
    const pane = await spawnAgentWithPrompt(spec, bundle.payload);
    const childPath = await resolveSpawnedTranscriptPath({
      engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd,
      startedAtMs,
      codexSessionsDir: engine === "codex" ? account.transcriptRoot : null,
    });
    const key = childPath ? sessionKeyFromTranscript(engine, childPath) : null;
    if (!childPath || !key || !pane.receipt) {
      if (pane.receipt) agentRegistry().failSpawn(pane.receipt.launchId, "spawned transcript could not be identified");
      throw new Error("spawned transcript could not be identified safely");
    }
    {
      agentRegistry().completeSpawn(pane.receipt.launchId, {
        key,
        artifactPath: childPath,
        cwd,
        accountId: account.accountId,
        status: "starting",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: "spawn",
      });
    }
    if (runtimeClient && operationId) {
      const childConversationId = viewerConversationId(engine, childPath);
      try {
        await runtimeClient.append({
          scope: runtimeScope("edge", operationId),
          kind: "edge.created",
          producerKey: `viewer-spawn-edge:${operationId}`,
          payload: {
            edge: "viewer_spawn",
            childConversationId,
            parentConversationId: src && transcriptAllowed(src) ? conversationForTranscript(src) : null,
            operationId,
          },
        });
      } catch {
        console.warn("[runtime] spawned agent is healthy; lineage bookkeeping will reconcile later");
      }
    }
    if (src && transcriptAllowed(src)) {
      if (childPath) rememberHandoffChild(childPath, src);
      if (pane.panePid) rememberHandoffPane(pane.panePid, src);
      persistHandoffLineage();
    }
    return NextResponse.json({ ok: true, target: pane.display, path: childPath });
  } catch (error) {
    deleteInboxImages(imagePaths);
    if (error instanceof UnknownAccountError || error instanceof UnknownClaudeAccountError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
