import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { ROOTS } from "@/lib/scanner/roots";
import {
  buildImagePayload,
  collectImagePayloads,
  deleteInboxImages,
  freshSpecFor,
  spawnAgentWithPrompt,
  type AgentEngine,
} from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;
const HEAD_BYTES = 8192;

interface SuggestResponse {
  dirs: string[];
  /** Working directory of the `src` transcript when one was requested. */
  cwd: string | null;
}

interface SpawnResponse {
  ok: true;
  target: string;
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

/** Working directory from the head of a transcript, without reading the whole file. */
function headCwd(pathname: string): string | null {
  let head: string;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of head.split("\n").slice(0, 20)) {
    try {
      const obj = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof obj.cwd === "string" ? obj.cwd : typeof obj.payload?.cwd === "string" ? obj.payload.cwd : null;
      if (cwd && fs.existsSync(cwd)) return cwd;
    } catch {
      /* partial or non-JSON head row */
    }
  }
  return null;
}

/** Recent real working directories to prefill the spawn dialog; the current
    project's transcripts rank first so its directory lands on top. `src` names
    a transcript whose own cwd must win — the handoff card inherits it. */
export async function GET(req: NextRequest): Promise<NextResponse<SuggestResponse>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  const src = req.nextUrl.searchParams.get("src");
  const srcCwd = src && transcriptAllowed(src) ? headCwd(src) : null;
  const conversations = (await listFiles())
    .filter((entry) => entry.path.endsWith(".jsonl") && (entry.root === "claude-projects" || entry.root === "codex-sessions"))
    .filter((entry) => !entry.path.includes(path.sep + "subagents" + path.sep))
    .sort((a, b) => Number(b.project === project) - Number(a.project === project) || b.mtime - a.mtime)
    .slice(0, SUGGEST_SCAN_LIMIT);

  const dirs: string[] = srcCwd ? [srcCwd] : [];
  for (const entry of conversations) {
    if (dirs.length >= SUGGEST_MAX) break;
    const cwd = headCwd(entry.path);
    if (cwd && !dirs.includes(cwd)) dirs.push(cwd);
  }
  if (!dirs.length) dirs.push(os.homedir());
  return NextResponse.json({ dirs, cwd: srcCwd });
}

export async function POST(req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown };
  try {
    body = (await req.json()) as { engine?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine має бути claude або codex" }, { status: 400 });

  const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!rawCwd) return NextResponse.json({ error: "потрібна робоча директорія" }, { status: 400 });
  const cwd = path.resolve(rawCwd === "~" || rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(1)) : rawCwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: `директорії не існує: ${cwd}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `не директорія: ${cwd}` }, { status: 400 });
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
    const pane = await spawnAgentWithPrompt(freshSpecFor(engine, cwd), bundle.payload);
    return NextResponse.json({ ok: true, target: pane.display });
  } catch (error) {
    deleteInboxImages(imagePaths);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
