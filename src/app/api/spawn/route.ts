import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { headCwd } from "@/lib/agent/transcript";
import { persistHandoffLineage, rememberHandoffChild, rememberHandoffPane } from "@/lib/handoffLineage";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { ROOTS } from "@/lib/scanner/roots";
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
  return (["claude-projects", "codex-sessions"] as const).some((key) => {
    try {
      return real.startsWith(fs.realpathSync(ROOTS[key]) + path.sep);
    } catch {
      return false;
    }
  });
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

export async function POST(req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown; src?: unknown; effort?: unknown; fast?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });

  const reasoning = reasoningFromBody(engine, body);
  if (reasoning.error) return NextResponse.json({ error: reasoning.error }, { status: 400 });

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
    const spec = freshSpecFor(engine, cwd, { effort: reasoning.effort, fast: reasoning.fast });
    const pane = await spawnAgentWithPrompt(spec, bundle.payload);
    /* Handoff spawn: remember which conversation the new agent descends from,
       so the scanner links its transcript into the source's tree. A claude
       spec knows its transcript path up front; a codex rollout is matched
       later through the pane pid in its /proc ancestry. */
    const src = typeof body.src === "string" ? body.src : "";
    if (src && transcriptAllowed(src)) {
      if (spec.transcript) rememberHandoffChild(spec.transcript, src);
      if (pane.panePid) rememberHandoffPane(pane.panePid, src);
      persistHandoffLineage();
    }
    return NextResponse.json({ ok: true, target: pane.display, path: spec.transcript ?? null });
  } catch (error) {
    deleteInboxImages(imagePaths);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
