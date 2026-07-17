import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { deliverAnswer, DeliveryError, type AnswerInput, type PaneIo } from "@/lib/answer/driver";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { pendingQuestionFor, recordedToolResult } from "@/lib/scanner/questions";
import { screenTail } from "@/lib/status";
import { paneScreen, resolveTarget, sendKeys, sendText } from "@/lib/tmux";
import type { ApiError, FileEntry, PendingQuestion } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIRM_MS = 10_000;
const CONFIRM_POLL_MS = 500;

/** Real pane access for the answer driver; tests inject fixtures instead. */
const paneIo: PaneIo = { paneScreen, sendKeys, sendText };

interface AnswerBody extends AnswerInput {
  transcriptPath?: unknown;
  toolUseId?: unknown;
  kind?: unknown;
}

interface AnswerResponse {
  ok: true;
  answer: string;
}

interface SupersededResponse {
  error: string;
  answer: string;
  superseded: true;
}

type RouteResponse = AnswerResponse | SupersededResponse | ApiError;

const locks = new Map<string, Promise<NextResponse<RouteResponse>>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshEntry(entry: FileEntry): FileEntry | null {
  try {
    const st = fs.statSync(entry.path);
    return { ...entry, size: st.size, mtime: st.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

function transcriptResult(entry: FileEntry, toolUseId: string): string | null {
  const fresh = freshEntry(entry);
  if (!fresh) return null;
  return recordedToolResult(fresh.path, fresh.size, fresh.mtime * 1000, toolUseId);
}

async function knownState(pathname: string, toolUseId: string): Promise<{ entry: FileEntry; pending: PendingQuestion | null; result: string | null } | null> {
  const entry = (await listFiles()).find((item) => item.path === pathname);
  if (!entry || entry.proc !== "running" || entry.pid === null) return null;
  const fresh = freshEntry(entry);
  if (!fresh) return null;
  const result = recordedToolResult(fresh.path, fresh.size, fresh.mtime * 1000, toolUseId);
  if (result) return { entry: fresh, pending: null, result };
  const pending = pendingQuestionFor(fresh);
  return { entry: fresh, pending: pending?.toolUseId === toolUseId ? pending : null, result: null };
}

async function confirmAnswered(entry: FileEntry, toolUseId: string): Promise<string | null> {
  const deadline = Date.now() + CONFIRM_MS;
  while (Date.now() < deadline) {
    const result = transcriptResult(entry, toolUseId);
    if (result) return result;
    await sleep(CONFIRM_POLL_MS);
  }
  return null;
}

async function deliver(body: AnswerBody): Promise<NextResponse<RouteResponse>> {
  const transcriptPath = typeof body.transcriptPath === "string" ? body.transcriptPath : "";
  const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId : "";
  if (!transcriptPath || !toolUseId) return NextResponse.json({ error: "transcriptPath and toolUseId are required" }, { status: 400 });

  const state = await knownState(transcriptPath, toolUseId);
  if (!state) return NextResponse.json({ error: "transcript is unknown or the agent is not running" }, { status: 403 });
  if (state.result) {
    return NextResponse.json(
      { error: "question already has an answer", answer: state.result, superseded: true },
      { status: 409 },
    );
  }
  if (state.pending === null) return NextResponse.json({ error: "question is no longer active" }, { status: 409 });
  const pending = state.pending;
  const target = await resolveTarget(state.entry.pid!);
  if (target === null) return NextResponse.json({ error: "no active tmux pane for answering", noPane: true }, { status: 409 });

  try {
    const label = await deliverAnswer(paneIo, target, pending, body);
    const recorded = await confirmAnswered(state.entry, toolUseId);
    if (recorded) return NextResponse.json({ ok: true, answer: recorded || label });
    return NextResponse.json({ error: `answer was sent, but the transcript did not confirm it: ${screenTail(await paneScreen(target))}` }, { status: 502 });
  } catch (error) {
    if (error instanceof DeliveryError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<RouteResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const transcriptPath = typeof body.transcriptPath === "string" ? body.transcriptPath : "";
  const key = transcriptPath || "unknown";
  const previous = locks.get(key) ?? Promise.resolve(NextResponse.json({ ok: true, answer: "" }));
  const current = previous.catch(() => NextResponse.json({ ok: true, answer: "" })).then(() => deliver(body));
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
